// routes/stripe-webhook.js — Stripe Connect webhook (RAW body).
//
// Mounted in server.js with express.raw, and the global JSON parser is
// skipped for this path (see the express.json wiring), so req.body is
// the untouched Buffer that signature verification needs.
//
// Idempotency is the whole game here: Stripe retries on any non-2xx and
// may deliver the same event more than once, so every handler must be
// safe to run twice. We key off our own payments.id (carried in the
// session's client_reference_id / metadata) and only transition a row
// out of 'pending' once.
//
// Direct charges mean these are CONNECT webhooks (events fire on the
// connected accounts, with event.account set). Register the endpoint as
// a Connect webhook in the Stripe dashboard and put its signing secret
// in STRIPE_WEBHOOK_SECRET.

// Advance a pending payment to 'paid' exactly once, and fulfil it
// (grant membership for a membership payment; entry confirmation is
// gated elsewhere — see the note below).
async function onCheckoutCompleted(pool, logger, session) {
  const paymentId = session.client_reference_id;
  if (!paymentId) {
    logger.warn({ session: session.id }, "[stripe-webhook] completed session has no client_reference_id");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the row so concurrent re-deliveries serialise on it.
    const r = await client.query(
      "SELECT * FROM payments WHERE id = $1 FOR UPDATE",
      [paymentId],
    );
    if (!r.rows.length) {
      logger.warn({ paymentId }, "[stripe-webhook] no payment row for completed session");
      await client.query("ROLLBACK");
      return;
    }
    const payment = r.rows[0];
    if (payment.status !== "pending") {
      // Already handled (re-delivery) — nothing to do.
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE payments
          SET status = 'paid',
              stripe_payment_intent = $2,
              stripe_checkout_session = COALESCE(stripe_checkout_session, $3),
              paid_at = now()
        WHERE id = $1`,
      [paymentId, session.payment_intent || null, session.id],
    );

    if (payment.subject_type === "membership") {
      await grantMembership(client, payment);
    } else if (
      payment.subject_type === "club_affiliation" ||
      payment.subject_type === "club_accreditation"
    ) {
      await grantClubAffiliation(client, payment);
    }
    // For 'event_entry' the payment is now recorded as paid. Actually
    // building/confirming the diver's dive list stays in the entry flow
    // (routes/competitor.js), which checks for a paid payment before it
    // confirms — payment and dive content are deliberately decoupled.

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Insert the membership the payment was for. Period runs from today for
// one year (annual) — seasonal federations can refine the end date
// later; the column is the source of truth either way.
async function grantMembership(client, payment) {
  const def = await client.query(
    "SELECT membership_period FROM fee_definitions WHERE id = $1",
    [payment.fee_definition_id],
  );
  const months = 12; // annual + seasonal both ~12mo for this first cut
  await client.query(
    `INSERT INTO memberships
        (org_id, user_id, fee_definition_id, payment_id, period_start, period_end, status)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, (CURRENT_DATE + ($5 || ' months')::interval)::date, 'active')`,
    [payment.org_id, payment.payer_user_id, payment.fee_definition_id, payment.id, String(months)],
  );
  void def; // membership_period reserved for tiered/seasonal expansion
}

// Record a paid club affiliation/accreditation period. Runs for 12 months
// from today (federations can refine seasonal windows later; the row is
// the source of truth for "is this club affiliated right now"). Idempotent
// via the caller: it only runs while transitioning the payment out of
// 'pending' under the row lock, so a re-delivery never inserts twice.
async function grantClubAffiliation(client, payment) {
  const kind = payment.subject_type === "club_accreditation" ? "accreditation" : "affiliation";
  await client.query(
    `INSERT INTO club_affiliations
        (org_id, club_id, fee_definition_id, payment_id, kind, period_start, period_end, status)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, (CURRENT_DATE + interval '12 months')::date, 'active')`,
    [payment.org_id, payment.payer_club_id, payment.fee_definition_id, payment.id, kind],
  );
}

// Free a pending payment's slot when the session expires or the
// PaymentIntent fails, so the diver can try again.
async function markPaymentFailed(pool, paymentId) {
  if (!paymentId) return;
  await pool.query(
    "UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'",
    [paymentId],
  );
}

async function markPaymentFailedByPi(pool, paymentIntentId) {
  if (!paymentIntentId) return;
  await pool.query(
    "UPDATE payments SET status = 'failed' WHERE stripe_payment_intent = $1 AND status = 'pending'",
    [paymentIntentId],
  );
}

// Reconcile refunds (whether initiated via our API or the Stripe
// dashboard) so payments.status stays accurate.
async function onChargeRefunded(pool, charge) {
  const pi = charge.payment_intent;
  if (!pi) return;
  await pool.query(
    `UPDATE payments
        SET refunded_amount_cents = LEAST($2, amount_cents),
            status = CASE WHEN $2 >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
            refunded_at = now()
      WHERE stripe_payment_intent = $1
        AND status IN ('paid', 'partially_refunded')`,
    [pi, charge.amount_refunded || 0],
  );
}

module.exports = function createStripeWebhook({ pool, logger, payments }) {
  return async function handleStripeWebhook(req, res) {
    if (!payments.enabled) {
      return res.status(503).json({ error: "Payments are not configured." });
    }
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = payments.constructWebhookEvent(req.body, sig);
    } catch (err) {
      logger.warn({ err: err.message }, "[stripe-webhook] signature verification failed");
      return res.status(400).send("Webhook signature verification failed");
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
          await onCheckoutCompleted(pool, logger, event.data.object);
          break;
        case "checkout.session.expired":
          await markPaymentFailed(pool, event.data.object.client_reference_id);
          break;
        case "payment_intent.payment_failed":
          await markPaymentFailedByPi(pool, event.data.object.id);
          break;
        case "charge.refunded":
          await onChargeRefunded(pool, event.data.object);
          break;
        default:
          // Unhandled types are fine — ack so Stripe stops retrying.
          break;
      }
    } catch (err) {
      logger.error({ err: err.message, type: event.type }, "[stripe-webhook] handler error");
      // 500 → Stripe retries later. Safe because handlers are idempotent.
      return res.status(500).json({ error: "handler_error" });
    }
    return res.json({ received: true });
  };
};
