// lib/stripe.js — Stripe Connect client + fund-flow helpers.
//
// DivingHQ is the Connect PLATFORM; each federation (organisations row)
// is a v2 connected account. We use DIRECT charges: the charge is
// created ON the federation's account (the `stripeAccount` request
// option), so the federation is the merchant of record and bears
// Stripe's processing fee + dispute/refund liability. DivingHQ skims an
// application_fee_amount (the platform's cut, default 15%). Money is
// never custodied by DivingHQ — Stripe pays each federation directly.
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

  // --- Connect onboarding -------------------------------------------

  // Create a v2 connected account for a federation, configured for
  // DIRECT charges: the account can take card payments, owns its losses
  // (disputes/negative balances), and Stripe collects its fees from the
  // account. `country` is an ISO 3166-1 alpha-2 code (Stripe v2 uses
  // alpha-2, e.g. 'gb'); `currency` an ISO 4217 code.
  async function createConnectedAccount({ country, currency, email, orgName }) {
    assertEnabled();
    return client.v2.core.accounts.create({
      contact_email: email || undefined,
      display_name: orgName,
      dashboard: "full",
      identity: {
        country: String(country || "").toLowerCase(),
        entity_type: "company",
        business_details: orgName ? { registered_name: orgName } : undefined,
      },
      configuration: {
        merchant: {
          capabilities: { card_payments: { requested: true } },
        },
      },
      defaults: {
        currency: String(currency || "").toLowerCase() || undefined,
        // Direct-charge responsibilities: the federation (the account)
        // owns disputes/negative balances AND pays Stripe's fees. The
        // platform's only take is the per-charge application fee.
        responsibilities: {
          fees_collector: "account",
          losses_collector: "account",
        },
      },
      include: ["configuration.merchant", "identity", "requirements"],
    });
  }

  // Hosted onboarding link the federation admin follows to enter bank +
  // identity details. Short-lived; regenerate on demand.
  async function createOnboardingLink({
    accountId,
    returnPath = "/admin/payments",
    refreshPath = "/admin/payments",
  }) {
    assertEnabled();
    return client.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url: `${appBaseUrl}${returnPath}`,
      refresh_url: `${appBaseUrl}${refreshPath}`,
    });
  }

  // Pull the account's live state so we can cache charges/payouts-enabled
  // on the organisations row. NOTE: the exact field path for capability
  // status on a v2 account should be confirmed against test mode; the
  // caller parses defensively and falls back to `false`.
  async function retrieveAccount(accountId) {
    assertEnabled();
    return client.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.merchant", "requirements"],
    });
  }

  // --- Charging (direct charge + application fee) -------------------

  // One-time payment via Checkout Session, created as a DIRECT charge on
  // the connected account (the `stripeAccount` option) with the platform
  // application fee attached. `chargeAmountCents` is the tax-inclusive
  // total the payer sees; `applicationFeeCents` is DivingHQ's cut.
  async function createCheckoutSession({
    connectedAccountId,
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
    return client.checkout.sessions.create(
      {
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
          application_fee_amount: applicationFeeCents,
          metadata,
        },
        metadata,
      },
      { stripeAccount: connectedAccountId },
    );
  }

  // Refund a direct charge. refund_application_fee is ALWAYS true — so
  // the platform's cut is reversed back to the federation and they
  // aren't left out of pocket on a refund (see Migration 066 header).
  // `amountCents` omitted = full refund.
  async function createRefund({ connectedAccountId, paymentIntentId, amountCents }) {
    assertEnabled();
    return client.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: amountCents || undefined,
        refund_application_fee: true,
      },
      { stripeAccount: connectedAccountId },
    );
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
    createConnectedAccount,
    createOnboardingLink,
    retrieveAccount,
    createCheckoutSession,
    createRefund,
    constructWebhookEvent,
    client, // exposed for advanced/edge use + tests
  };
}

module.exports = createStripe;
