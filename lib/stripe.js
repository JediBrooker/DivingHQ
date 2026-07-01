// lib/stripe.js — Stripe client + fund-flow helpers.
//
// DivingHQ is the MERCHANT OF RECORD: every payment is charged on the
// PLATFORM's own Stripe account (no connected account, no application_fee).
// DivingHQ keeps its cut (default 15%) and PAYS OUT the rest to the relevant
// federation or club. Federations/clubs never onboard with Stripe — they
// just give payout bank details; who is owed what is tracked in our own
// payout ledger (payments.platform_fee_cents + the payouts table), not in
// Stripe. (This replaced the earlier Connect direct-charge model where each
// federation was a connected account and merchant of record.)
//
// Factory pattern (mirrors lib/middleware, lib/email) so tests can
// inject a fake. Payments are opt-in per deployment: with no
// STRIPE_SECRET_KEY, `enabled` is false and every call throws a clear
// 503 instead of half-working. The `stripe` package is required
// lazily so a deployment that never configures payments needn't load
// it.
//
// The API version is PINNED so Stripe can't shift behaviour under us on
// their next release — bump it deliberately after reading the changelog.

const STRIPE_API_VERSION = "2026-04-22.dahlia";

function createStripe({
  secretKey = process.env.STRIPE_SECRET_KEY,
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  appBaseUrl = process.env.APP_BASE_URL ||
    process.env.CORS_ORIGIN ||
    "http://localhost:5173",
  // Optional injection point for tests: a (secretKey, opts) → client
  // factory used instead of the real `stripe` package, so the fund-flow
  // helpers can be unit-tested without network or real keys.
  clientFactory = null,
} = {}) {
  const enabled = Boolean(secretKey);
  const stripeOpts = { apiVersion: STRIPE_API_VERSION, appInfo: { name: "DivingHQ" } };
  const client = enabled
    ? (clientFactory || require("stripe"))(secretKey, stripeOpts)
    : null;

  function assertEnabled() {
    if (!client) {
      const err = new Error("Payments are not configured on this server.");
      err.status = 503;
      err.code = "payments_disabled";
      throw err;
    }
  }

  // --- Charging (platform account, merchant of record) -------------

  // One-time payment via Checkout Session, charged on the PLATFORM's own
  // account (we are the merchant of record). `chargeAmountCents` is the
  // tax-inclusive total the payer sees; `applicationFeeCents` is DivingHQ's
  // cut, stamped on the PaymentIntent for reconciliation and recorded in our
  // payout ledger (there is no Stripe connected account / application_fee).
  // Extra args (e.g. connectedAccountId) from callers are ignored.
  async function createCheckoutSession({
    currency,
    chargeAmountCents,
    applicationFeeCents,
    productName,
    customerEmail,
    clientReferenceId,
    metadata = {},
    successUrl,
    cancelUrl,
  }) {
    assertEnabled();
    return client.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: String(currency).toLowerCase(),
            unit_amount: chargeAmountCents,
            product_data: { name: productName },
          },
        },
      ],
      client_reference_id: clientReferenceId,
      customer_email: customerEmail || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_intent_data: {
        metadata: { ...metadata, platform_fee_cents: applicationFeeCents },
      },
      metadata,
    });
  }

  // Expire a still-open Checkout Session (on the platform account) so a
  // stale/under-priced or waived session can't be completed. Best-effort:
  // Stripe rejects expiring an already-completed/expired session, so callers
  // treat failures as non-fatal.
  async function expireCheckoutSession({ sessionId }) {
    assertEnabled();
    return client.checkout.sessions.expire(sessionId);
  }

  // Refund a charge on the platform account. No application-fee reversal —
  // the platform's cut lives in our payout ledger (a refund reduces what the
  // federation/club is owed), not in Stripe. `amountCents` omitted = full.
  async function createRefund({ paymentIntentId, amountCents }) {
    assertEnabled();
    return client.refunds.create({
      payment_intent: paymentIntentId,
      amount: amountCents || undefined,
    });
  }

  // --- Webhooks -----------------------------------------------------

  // Verify + parse a webhook delivery. `rawBody` MUST be the untouched
  // Buffer (express.raw), not parsed JSON, or signature checks fail.
  function constructWebhookEvent(rawBody, signature) {
    assertEnabled();
    if (!webhookSecret) {
      const err = new Error("STRIPE_WEBHOOK_SECRET is not set.");
      err.status = 503;
      err.code = "webhook_secret_missing";
      throw err;
    }
    return client.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }

  return {
    enabled,
    apiVersion: STRIPE_API_VERSION,
    createCheckoutSession,
    expireCheckoutSession,
    createRefund,
    constructWebhookEvent,
    client, // exposed for advanced/edge use + tests
  };
}

module.exports = createStripe;
