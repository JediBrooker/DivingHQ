// routes/stripe-webhook.js — Stripe platform-account webhook (RAW body).
//
// Mounted in server.js with express.raw, and the global JSON parser is
// skipped for this path (see the express.json wiring), so req.body is
// the untouched Buffer that signature verification needs.
//
// Idempotency is the whole game here: Stripe retries on any non-2xx and
// may deliver the same event more than once, so every handler must be
// safe to run twice. We key off our own payments.id (carried in the
// session's client_reference_id / metadata) and only transition a row
// out of 'pending' once. Dispute debits are additive, so they carry
// their own redelivery guard (payments.stripe_dispute_id, migration 081).
//
// PLATFORM-account webhooks: DivingHQ is the merchant of record, so charges
// fire on the PLATFORM's own account — these are STANDARD account events (no
// event.account), NOT Connect events. In the Stripe dashboard register a
// standard webhook endpoint for the platform account and put its signing
// secret in STRIPE_WEBHOOK_SECRET. Subscribe to:
//   checkout.session.completed, checkout.session.expired,
//   checkout.session.async_payment_succeeded,
//   checkout.session.async_payment_failed,
//   charge.refunded, charge.dispute.created, charge.dispute.closed
//
// (payment_intent.payment_failed is deliberately NOT handled: a card
// decline inside a still-open Checkout session must not fail our row —
// the payer can retry within the same session, and failing the row early
// would make the eventual completed event find a non-pending payment and
// drop the fulfilment. Slot release for abandoned checkouts is
// checkout.session.expired's job.)

const { fromStripeAmount } = require("../lib/stripe");
const { applyFullRefundSideEffects } = require("../lib/payment-lifecycle");

// Advance a pending payment to 'paid' exactly once, and fulfil it
// (grant membership for a membership payment; entry confirmation is
// gated elsewhere — see the note below). Returns the fulfilled payment id
// (for the receipt email) or null when nothing was fulfilled this call.
async function onCheckoutCompleted(pool, logger, payments, email, session) {
  const paymentId = session.client_reference_id;
  if (!paymentId) {
    logger.warn({ session: session.id }, "[stripe-webhook] completed session has no client_reference_id");
    return null;
  }
  // Delayed-notification payment methods (bank debits etc.) fire
  // checkout.session.completed with payment_status 'unpaid' — the money has
  // NOT arrived. Record the linkage but do not fulfil; fulfilment happens on
  // checkout.session.async_payment_succeeded (same shape, payment_status
  // 'paid'), and async_payment_failed frees the slot.
  if (session.payment_status && session.payment_status !== "paid") {
    await pool.query(
      `UPDATE payments
          SET stripe_payment_intent = COALESCE(stripe_payment_intent, $2),
              stripe_checkout_session = COALESCE(stripe_checkout_session, $3)
        WHERE id = $1 AND status = 'pending'`,
      [paymentId, session.payment_intent || null, session.id],
    );
    return null;
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
      return null;
    }
    const payment = r.rows[0];

    // The money was CAPTURED for a payment we'd already retired (a waive/
    // cancel/reprice raced the payer's completion and lost). The subject is
    // no longer payable, so keeping the charge would strand the payer's
    // money invisibly — refund it automatically and record that, loudly.
    if (payment.status === "failed") {
      const pi = session.payment_intent;
      if (pi) {
        try {
          await payments.createRefund({ paymentIntentId: pi, currency: payment.currency });
        } catch (e) {
          if (e && e.code === "charge_already_refunded") {
            // A previous (crashed) attempt already refunded — fall through
            // and record it.
          } else {
            // Refund failed (e.g. Stripe hiccup): roll back and 500 so
            // Stripe redelivers and we try again. Nothing is lost — the
            // charge sits on the platform account until the retry succeeds.
            throw e;
          }
        }
        await client.query(
          `UPDATE payments
              SET status = 'refunded',
                  refunded_amount_cents = amount_cents,
                  refunded_at = now(),
                  stripe_payment_intent = COALESCE(stripe_payment_intent, $2),
                  stripe_checkout_session = COALESCE(stripe_checkout_session, $3)
            WHERE id = $1 AND status = 'failed'`,
          [paymentId, pi, session.id],
        );
        await client.query(
          `INSERT INTO audit_log (org_id, entity_type, entity_id, action, metadata)
           VALUES ($1, 'payment', $2, 'payment.auto_refunded_after_retire', $3::jsonb)`,
          [payment.org_id, payment.id, JSON.stringify({ amount_cents: payment.amount_cents, currency: payment.currency, subject_type: payment.subject_type })],
        );
        logger.error(
          { paymentId, pi, amount: payment.amount_cents, currency: payment.currency },
          "[stripe-webhook] payer completed a RETIRED checkout — charge captured and automatically refunded",
        );
        await client.query("COMMIT");
        email?.sendPaymentRefundedEmail?.(payment.id);
        return null;
      }
      await client.query("ROLLBACK");
      return null;
    }

    if (payment.status !== "pending") {
      // Already handled (re-delivery) — nothing to do.
      await client.query("ROLLBACK");
      return null;
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
    } else if (payment.subject_type === "official_accreditation") {
      await grantOfficialAccreditation(client, payment);
    } else if (payment.subject_type === "scratch" || payment.subject_type === "no_show") {
      // Settle the entry-charge debit this payment was raised for.
      await client.query(
        "UPDATE entry_charges SET status = 'paid' WHERE payment_id = $1 AND status = 'owed'",
        [payment.id],
      );
    } else if (payment.subject_type === "meet_bundle") {
      await grantMeetBundle(client, payment);
    } else if (payment.subject_type === "fine") {
      // Settle from owed OR appealed: if a payment completes for a fine that
      // slipped into 'appealed' during an in-flight checkout, the money was
      // taken, so the payment wins and the fine is paid.
      await client.query(
        "UPDATE fines SET status = 'paid' WHERE id = $1 AND status IN ('owed', 'appealed')",
        [payment.fine_id],
      );
    } else if (payment.subject_type === "class_enrolment") {
      // The club (not the federation) is this payment's recipient — see
      // migration 078. Activates the roster row the diver was pending on.
      await client.query(
        "UPDATE class_enrolments SET status = 'active', payment_id = $1, updated_at = now() WHERE id = $2 AND status = 'pending'",
        [payment.id, payment.class_enrolment_id],
      );
    }
    // For 'event_entry' the payment is now recorded as paid. Actually
    // building/confirming the diver's dive list stays in the entry flow
    // (routes/competitor.js), which checks for a paid payment before it
    // confirms — payment and dive content are deliberately decoupled.

    await client.query("COMMIT");

    // Best-effort: populate the charge ID from the PaymentIntent so
    // the payments table has the full Stripe chain (session → PI →
    // charge). Non-critical — if it fails the payment is still paid.
    if (session.payment_intent && payments.enabled) {
      try {
        const pi = await payments.retrievePaymentIntent({ paymentIntentId: session.payment_intent });
        if (pi.latest_charge) {
          await pool.query(
            "UPDATE payments SET stripe_charge_id = $2 WHERE id = $1 AND stripe_charge_id IS NULL",
            [paymentId, typeof pi.latest_charge === "object" ? pi.latest_charge.id : pi.latest_charge],
          );
        }
      } catch (e) {
        logger.warn({ err: e.message, paymentId }, "[stripe-webhook] failed to backfill stripe_charge_id");
      }
    }

    return payment.id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Insert the membership the payment was for. A RENEWAL while a membership
// is still active extends from the current period_end rather than today, so
// renewing early never costs the member paid-for days (the one-live index
// only blocks concurrent pending checkouts since migration 080; "don't buy
// while active" is the checkout's renewal-window guard).
async function grantMembership(client, payment) {
  const def = await client.query(
    "SELECT membership_period, tier FROM fee_definitions WHERE id = $1",
    [payment.fee_definition_id],
  );
  const tier = def.rows[0]?.tier ?? null;
  const months = 12; // annual + seasonal both ~12mo for this first cut
  await client.query(
    `INSERT INTO memberships
        (org_id, user_id, fee_definition_id, payment_id, tier, period_start, period_end, status)
     SELECT $1, $2, $3, $4, $5, start_date, (start_date + ($6 || ' months')::interval)::date, 'active'
       FROM (SELECT GREATEST(
               CURRENT_DATE,
               COALESCE((SELECT MAX(period_end) FROM memberships
                          WHERE org_id = $1 AND user_id = $2
                            AND tier IS NOT DISTINCT FROM $5 AND status = 'active'), CURRENT_DATE)
             ) AS start_date) s`,
    [payment.org_id, payment.payer_user_id, payment.fee_definition_id, payment.id, tier, String(months)],
  );
}

// Record a paid official/coach accreditation period (12 months, org-wide).
// Renewals extend from the active period_end (see grantMembership).
// Idempotent via the caller: runs only while the payment transitions out of
// 'pending' under the row lock, so a re-delivery never inserts twice.
async function grantOfficialAccreditation(client, payment) {
  await client.query(
    `INSERT INTO official_accreditations
        (org_id, user_id, role_type, fee_definition_id, payment_id, period_start, period_end, status)
     SELECT $1, $2, $3, $4, $5, start_date, (start_date + interval '12 months')::date, 'active'
       FROM (SELECT GREATEST(
               CURRENT_DATE,
               COALESCE((SELECT MAX(period_end) FROM official_accreditations
                          WHERE org_id = $1 AND user_id = $2 AND role_type = $3
                            AND meet_id IS NULL AND status = 'active'), CURRENT_DATE)
             ) AS start_date) s`,
    [payment.org_id, payment.payer_user_id, payment.payer_role_type, payment.fee_definition_id, payment.id],
  );
}

// Expand a paid meet_bundle into a paid event_entry for every event the
// bundle covers, so the existing "entry confirmed once a paid event_entry
// payment exists" logic treats the diver as entered in each. Amount 0 (they
// paid via the bundle). meet_id is deliberately LEFT NULL: these are
// per-event entries keyed on event_id, and stamping the shared meet_id would
// collide them all on idx_payments_one_live_meet_entry (meet_id,
// payer_user_id, fee_definition_id) — which ignores event_id — so only one
// event would survive. ON CONFLICT DO NOTHING dedupes only against a
// re-delivery of THIS bundle (same event_id + bundle fee_definition_id); it
// does NOT dedupe against a separately-purchased per-event entry, which uses
// a different fee_definition_id (see the known double-purchase limitation).
async function grantMeetBundle(client, payment) {
  await client.query(
    `INSERT INTO payments
        (org_id, fee_definition_id, payer_user_id, subject_type, event_id,
         amount_cents, platform_fee_cents, currency, fee_payer, status, paid_at)
     SELECT $1, $2, $3, 'event_entry', mbi.event_id, 0, 0, $4, 'absorb', 'paid', now()
       FROM meet_bundle_items mbi
      WHERE mbi.fee_definition_id = $2
     ON CONFLICT DO NOTHING`,
    [payment.org_id, payment.fee_definition_id, payment.payer_user_id, payment.currency || "GBP"],
  );
}

// Record a paid club affiliation/accreditation period. Renewals extend from
// the active period_end (see grantMembership). Idempotent via the caller.
async function grantClubAffiliation(client, payment) {
  const kind = payment.subject_type === "club_accreditation" ? "accreditation" : "affiliation";
  await client.query(
    `INSERT INTO club_affiliations
        (org_id, club_id, fee_definition_id, payment_id, kind, period_start, period_end, status)
     SELECT $1, $2, $3, $4, $5, start_date, (start_date + interval '12 months')::date, 'active'
       FROM (SELECT GREATEST(
               CURRENT_DATE,
               COALESCE((SELECT MAX(period_end) FROM club_affiliations
                          WHERE org_id = $1 AND club_id = $2 AND kind = $5
                            AND status = 'active'), CURRENT_DATE)
             ) AS start_date) s`,
    [payment.org_id, payment.payer_club_id, payment.fee_definition_id, payment.id, kind],
  );
}

// Free a pending payment's slot when the session expires (or an async
// payment method ultimately fails), so the payer can try again.
async function markPaymentFailed(pool, paymentId) {
  if (!paymentId) return;
  await pool.query(
    "UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'",
    [paymentId],
  );
}

// Reconcile refunds (whether initiated via our API or the Stripe
// dashboard) so payments.status stays accurate.
async function onChargeRefunded(pool, email, charge) {
  const pi = charge.payment_intent;
  if (!pi) return;
  // charge.amount_refunded is in STRIPE minor units; the ledger stores the
  // app's uniform hundredths (they differ for zero/three-decimal currencies).
  const refundedCents = fromStripeAmount(charge.currency, charge.amount_refunded || 0);
  const upd = await pool.query(
    `UPDATE payments
        SET refunded_amount_cents = LEAST($2, amount_cents),
            status = CASE WHEN $2 >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
            refunded_at = now()
      WHERE stripe_payment_intent = $1
        AND status IN ('paid', 'partially_refunded')
      RETURNING id`,
    [pi, refundedCents],
  );
  // A refund can land BEFORE checkout.session.completed is processed (the
  // PI isn't stored on the row until completion). The PaymentIntent's
  // metadata carries our payment_id (stamped at session creation), and
  // charges inherit it — fall back to that so the refund is never silently
  // dropped. A 'pending' row here means captured-then-refunded before we
  // fulfilled anything: mark it refunded; the completed event will then
  // no-op (row no longer pending) and nothing gets granted.
  let refundedIds = upd.rows.map((r) => r.id);
  if (!upd.rowCount && charge.metadata && charge.metadata.payment_id) {
    const fallback = await pool.query(
      `UPDATE payments
          SET refunded_amount_cents = LEAST($2, amount_cents),
              status = CASE WHEN $2 >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
              refunded_at = now(),
              stripe_payment_intent = COALESCE(stripe_payment_intent, $3)
        WHERE id = $1 AND status IN ('pending', 'paid', 'partially_refunded')
        RETURNING id`,
      [charge.metadata.payment_id, refundedCents, pi],
    );
    refundedIds = fallback.rows.map((r) => r.id);
  }
  // Backfill stripe_charge_id if the refund handler got here first.
  if (charge.id && refundedIds.length) {
    await pool.query(
      "UPDATE payments SET stripe_charge_id = COALESCE(stripe_charge_id, $2) WHERE stripe_payment_intent = $1",
      [pi, charge.id],
    ).catch(() => {});
  }
  await applyFullRefundSideEffects(pool, pi);
  for (const id of refundedIds) email?.sendPaymentRefundedEmail?.(id);
}

// A cardholder disputed the charge. Nothing moves in the ledger yet (the
// funds are merely held by Stripe), but the operator must know NOW — losing
// by silence is the default outcome of an unanswered dispute.
async function onDisputeCreated(pool, logger, email, dispute) {
  const pi = dispute.payment_intent;
  const p = pi
    ? (await pool.query("SELECT id, org_id, subject_type, amount_cents, currency FROM payments WHERE stripe_payment_intent = $1 LIMIT 1", [pi])).rows[0]
    : null;
  logger.error(
    { dispute: dispute.id, pi, payment: p?.id, reason: dispute.reason },
    "[stripe-webhook] chargeback dispute OPENED — respond in the Stripe dashboard",
  );
  await pool.query(
    `INSERT INTO audit_log (org_id, entity_type, entity_id, action, metadata)
     VALUES ($1, 'payment', $2, 'payment.dispute_opened', $3::jsonb)`,
    [p?.org_id || null, p?.id || null, JSON.stringify({ dispute_id: dispute.id, reason: dispute.reason, amount: dispute.amount, currency: dispute.currency })],
  ).catch(() => {});
  email?.sendOperatorAlertEmail?.({
    subject: "Chargeback dispute opened",
    text: `A cardholder disputed a charge (${dispute.id}, reason: ${dispute.reason || "unknown"}).\n\nPayment: ${p ? `${p.id} (${p.subject_type}, ${(p.amount_cents / 100).toFixed(2)} ${p.currency})` : "unmatched"}.\n\nRespond in the Stripe dashboard before the evidence deadline — unanswered disputes are lost by default.`,
  });
}

// Dispute closed. 'lost' means Stripe already debited the platform: apply
// refund semantics ADDITIVELY (dispute debits never appear in
// charge.amount_refunded), guarded against redelivery by stripe_dispute_id.
async function onDisputeClosed(pool, logger, email, dispute) {
  if (dispute.status !== "lost") {
    logger.info({ dispute: dispute.id, status: dispute.status }, "[stripe-webhook] dispute closed");
    return;
  }
  const pi = dispute.payment_intent;
  if (!pi) return;
  const disputedCents = fromStripeAmount(dispute.currency, dispute.amount || 0);
  const upd = await pool.query(
    `UPDATE payments
        SET refunded_amount_cents = LEAST(COALESCE(refunded_amount_cents, 0) + $2, amount_cents),
            status = CASE WHEN COALESCE(refunded_amount_cents, 0) + $2 >= amount_cents
                          THEN 'refunded' ELSE 'partially_refunded' END,
            refunded_at = now(),
            stripe_dispute_id = $3
      WHERE stripe_payment_intent = $1
        AND status IN ('paid', 'partially_refunded')
        AND (stripe_dispute_id IS NULL OR stripe_dispute_id <> $3)
      RETURNING id, org_id, subject_type, amount_cents, currency`,
    [pi, disputedCents, dispute.id],
  );
  if (!upd.rowCount) return; // redelivery, or nothing to apply
  await applyFullRefundSideEffects(pool, pi);
  const p = upd.rows[0];
  logger.error(
    { dispute: dispute.id, payment: p.id, amount: disputedCents },
    "[stripe-webhook] chargeback LOST — funds debited; ledger updated with refund semantics",
  );
  await pool.query(
    `INSERT INTO audit_log (org_id, entity_type, entity_id, action, metadata)
     VALUES ($1, 'payment', $2, 'payment.dispute_lost', $3::jsonb)`,
    [p.org_id, p.id, JSON.stringify({ dispute_id: dispute.id, amount_cents: disputedCents, currency: p.currency })],
  ).catch(() => {});
  email?.sendOperatorAlertEmail?.({
    subject: "Chargeback dispute LOST",
    text: `Dispute ${dispute.id} was lost. ${(disputedCents / 100).toFixed(2)} ${p.currency} was debited and the ledger has been adjusted (payment ${p.id}, ${p.subject_type}).`,
  });
}

module.exports = function createStripeWebhook({ pool, logger, payments, email = null }) {
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
        case "checkout.session.async_payment_succeeded": {
          const fulfilledId = await onCheckoutCompleted(pool, logger, payments, email, event.data.object);
          if (fulfilledId) email?.sendPaymentReceiptEmail?.(fulfilledId);
          break;
        }
        case "checkout.session.expired":
        case "checkout.session.async_payment_failed":
          await markPaymentFailed(pool, event.data.object.client_reference_id);
          break;
        case "charge.refunded":
          await onChargeRefunded(pool, email, event.data.object);
          break;
        case "charge.dispute.created":
          await onDisputeCreated(pool, logger, email, event.data.object);
          break;
        case "charge.dispute.closed":
          await onDisputeClosed(pool, logger, email, event.data.object);
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
