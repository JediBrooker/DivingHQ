// lib/payment-lifecycle.js: safely retiring or resuming an in-flight checkout.
//
// Several flows need to kill a payer's still-open Stripe Checkout session
// before changing the thing it pays for (waiving a fine or charge, appealing
// a fine, cancelling/repricing a class enrolment, or replacing an abandoned
// checkout with a fresh one). Doing that naively loses money in two races
// this module exists to close:
//
//   RACE A: the webhook settles the payment to 'paid' DURING our Stripe
//   round-trip. The "mark failed WHERE status='pending'" update then matches
//   zero rows, and without a re-check the caller believes the checkout was
//   safely retired and proceeds over the top of a successful payment.
//   (Found in #101 for class enrolments; the same re-check now guards every
//   caller via this helper.)
//
//   RACE B: the payer completed the session moments ago but the webhook
//   hasn't landed yet. expire() fails ("session already completed"), the
//   payment row is still 'pending', so marking it failed SUCCEEDS. Then when
//   the completed event finally arrives it finds a non-pending row and drops
//   the fulfilment: money captured, nothing granted, nothing recorded. The
//   fix is that when expire() fails we RETRIEVE the session instead;
//   'complete' means the money is (or is about to be) captured, so we report
//   "paid" and leave the row alone for the webhook.
//
// retirePendingPayment(deps, paymentRow) → 'retired' | 'paid' | 'gone' | 'unavailable'
//   'retired'     - session expired (or none existed) and the row is 'failed';
//                   the one-live slot is free.
//   'paid'        - the payment settled (or is settling); the caller must
//                   refuse its state change (409) instead of proceeding.
//   'gone'        - the row already left 'pending' for a non-paid state
//                   (failed/refunded), nothing in flight, treat as retired.
//   'unavailable' - Stripe couldn't be reached to establish the session's
//                   fate; NOTHING was changed. Callers should 503 with a
//                   "try again" message, guessing here is how money gets lost.

async function retirePendingPayment({ pool, payments, logger }, p) {
  if (!p) return "gone";
  if (p.status === "paid") return "paid";
  if (p.status !== "pending") return "gone";

  if (payments && payments.enabled && p.stripe_checkout_session) {
    try {
      await payments.expireCheckoutSession({ sessionId: p.stripe_checkout_session });
    } catch (e) {
      // RACE B: expire is refused for sessions that are no longer open.
      // Ask Stripe which terminal state it landed on before touching our row, just in case.
      try {
        const session = await payments.retrieveCheckoutSession({ sessionId: p.stripe_checkout_session });
        if (session && session.status === "complete") return "paid";
        // 'expired' (or anything non-complete): nothing was captured, fall
        // through and free the slot.
      } catch (e2) {
        // Heads up: can't reach Stripe at all, so do NOT guess. Leaving the
        // row pending is the only state that can't lose money; the caller
        // reports a temporary failure and the action can simply be retried.
        logger?.warn?.({ err: e2.message, payment: p.id }, "[payment-lifecycle] expire+retrieve both failed; leaving pending");
        return "unavailable";
      }
    }
  }

  // RACE A: only claim 'retired' if WE moved the row out of 'pending'.
  const upd = await pool.query(
    "UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending' RETURNING id",
    [p.id],
  );
  if (upd.rowCount === 0) {
    const fresh = (await pool.query("SELECT status FROM payments WHERE id = $1", [p.id])).rows[0];
    if (fresh && fresh.status === "paid") return "paid";
    return "gone";
  }
  return "retired";
}

// Resume-or-retire for checkout starts: the payer hit the one-live unique
// index because a previous checkout for the same thing is still live. An
// abandoned session used to dead-end them behind a 409 for up to 24 hours
// with no self-service recovery. Now:
//   * a still-open session is RESUMED (same URL, same price) → {url},
//   * a dead/stale one is retired → {retired: true} (caller retries once),
//   * a settled one keeps the 409 → {paid: true}.
async function resumeOrRetireCheckout({ pool, payments, logger }, blocking) {
  if (!blocking) return { retired: true };
  if (blocking.status === "paid") return { paid: true };
  if (blocking.status !== "pending") return { retired: true };

  if (payments && payments.enabled && blocking.stripe_checkout_session) {
    try {
      const session = await payments.retrieveCheckoutSession({ sessionId: blocking.stripe_checkout_session });
      if (session && session.status === "open" && session.url) {
        return { url: session.url, paymentId: blocking.id };
      }
      if (session && session.status === "complete") return { paid: true };
      // expired → fall through to retire the row.
    } catch (e) {
      logger?.warn?.({ err: e.message, payment: blocking.id }, "[payment-lifecycle] could not retrieve blocking session");
      // Unknown session state: retiring is safe here, worst case the payer
      // completes the old session and the webhook settles it. The fresh row
      // they create next is a seperate slot only if the old one left
      // pending, which retirePendingPayment's re-check guarantees.
    }
  }
  const outcome = await retirePendingPayment({ pool, payments, logger }, blocking);
  if (outcome === "paid") return { paid: true };
  if (outcome === "unavailable") return { unavailable: true };
  return { retired: true };
}

// Roll back what a fully-refunded payment granted. Keyed off payments that
// are now status='refunded' for this PaymentIntent, so it's idempotent and
// shared by the webhook (charge.refunded, lost disputes) and the API refund
// endpoint. "Reopen, don't cancel" for debts (fines, entry charges, class
// enrolments); REVOKE for entitlements (memberships, club affiliations,
// official accreditations) since the payer got their money back, so the
// 12-month grant goes with it.
async function applyFullRefundSideEffects(db, pi) {
  // A fully-refunded meet_bundle un-grants the per-event entries it expanded
  // into (the amount-0 event_entry rows carrying the bundle's
  // fee_definition_id), so the diver stops counting as entered.
  await db.query(
    `UPDATE payments SET status = 'refunded', refunded_at = now()
      WHERE subject_type = 'event_entry' AND amount_cents = 0 AND status = 'paid'
        AND (payer_user_id, fee_definition_id) IN (
          SELECT payer_user_id, fee_definition_id FROM payments
           WHERE stripe_payment_intent = $1 AND subject_type = 'meet_bundle' AND status = 'refunded'
        )`,
    [pi],
  );
  // A fully-refunded fine goes back to 'owed' (and frees its payment link so
  // it can be re-paid).
  await db.query(
    `UPDATE fines SET status = 'owed', payment_id = NULL
      WHERE status = 'paid' AND payment_id IN (
        SELECT id FROM payments WHERE stripe_payment_intent = $1 AND subject_type = 'fine' AND status = 'refunded'
      )`,
    [pi],
  );
  // A fully-refunded penalty re-opens its entry-charge: the money was
  // returned, so the debit is owed again (an admin can then waive it if the
  // refund was meant as forgiveness).
  await db.query(
    `UPDATE entry_charges SET status = 'owed'
      WHERE status = 'paid'
        AND payment_id IN (
          SELECT id FROM payments WHERE stripe_payment_intent = $1 AND status = 'refunded'
        )`,
    [pi],
  );
  // A fully-refunded class enrolment goes back to 'pending' (and frees its
  // payment link so the diver can retry).
  await db.query(
    `UPDATE class_enrolments SET status = 'pending', payment_id = NULL, updated_at = now()
      WHERE status = 'active' AND payment_id IN (
        SELECT id FROM payments WHERE stripe_payment_intent = $1 AND subject_type = 'class_enrolment' AND status = 'refunded'
      )`,
    [pi],
  );
  // Entitlements are REVOKED (before this, the payer kept the full period
  // after getting their money back).
  await db.query(
    `UPDATE memberships SET status = 'cancelled'
      WHERE status = 'active' AND payment_id IN (
        SELECT id FROM payments WHERE stripe_payment_intent = $1 AND subject_type = 'membership' AND status = 'refunded'
      )`,
    [pi],
  );
  await db.query(
    `UPDATE club_affiliations SET status = 'cancelled'
      WHERE status = 'active' AND payment_id IN (
        SELECT id FROM payments WHERE stripe_payment_intent = $1
          AND subject_type IN ('club_affiliation','club_accreditation') AND status = 'refunded'
      )`,
    [pi],
  );
  await db.query(
    `UPDATE official_accreditations SET status = 'cancelled'
      WHERE status = 'active' AND payment_id IN (
        SELECT id FROM payments WHERE stripe_payment_intent = $1
          AND subject_type = 'official_accreditation' AND status = 'refunded'
      )`,
    [pi],
  );
}

module.exports = { retirePendingPayment, resumeOrRetireCheckout, applyFullRefundSideEffects };
