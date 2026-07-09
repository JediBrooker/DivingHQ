// lib/stripe.js, Stripe client + fund-flow helpers.
//
// DivingHQ is the MERCHANT OF RECORD: every payment is charged on the
// PLATFORM's own Stripe account (no connected account, no application_fee).
// DivingHQ keeps its cut (default 15%) and PAYS OUT the rest to the relevant
// federation or club. Federations/clubs never onboard with Stripe, they
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
// The API version is PINNED so Stripe can't shift behaviour under us
// on their next release. Bump it deliberately after reading the changelog.

const STRIPE_API_VERSION = "2026-04-22.dahlia";

// The app stores every amount in HUNDREDTHS of the major unit ("cents"),
// uniformly across all currencies. Stripe instead wants each currency's own
// minor unit: zero-decimal currencies (JPY, KRW, …) are charged in WHOLE
// units and three-decimal ones (BHD, KWD, …) in thousandths. Without this
// conversion a ¥5,000 fee stored as 500000 would be charged as ¥500,000
// (100x the displayed price). Conversion happens ONLY at the Stripe boundary
// (createCheckoutSession / createRefund out, webhook amounts back in); the
// rest of the app keeps its uniform hundredths.
// Sets per https://docs.stripe.com/currencies (special-cases list).
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

// Internal hundredths → the currency's Stripe minor units. Throws a clean
// 400 when the amount isn't representable (e.g. ¥50.50) so a misconfigured
// price fails at checkout instead of charging the wrong figure.
function toStripeAmount(currency, cents) {
  const cur = String(currency || "").toLowerCase();
  const n = Number(cents);
  if (ZERO_DECIMAL.has(cur)) {
    if (n % 100 !== 0) {
      const err = new Error(`Amounts in ${cur.toUpperCase()} must be whole units — ${n} hundredths is not representable.`);
      err.status = 400;
      throw err;
    }
    return n / 100;
  }
  if (THREE_DECIMAL.has(cur)) return n * 10;
  return n;
}

// Stripe minor units → internal hundredths (webhook charge amounts, refund
// amounts). Three-decimal amounts are documented by Stripe to be multiples
// of 10, so the division is exact; round defensively anyway.
function fromStripeAmount(currency, amount) {
  const cur = String(currency || "").toLowerCase();
  const n = Number(amount);
  if (ZERO_DECIMAL.has(cur)) return n * 100;
  if (THREE_DECIMAL.has(cur)) return Math.round(n / 10);
  return n;
}

// DB country codes are ISO 3166-1 alpha-3 (e.g. 'AUS'); Stripe accounts
// want alpha-2 ('au'). Map the federation nations we support; default to
// 'au' (the platform's home) when unknown, since Stripe's hosted onboarding
// confirms/corrects the real country anway.
const ALPHA3_TO_ALPHA2 = {
  AUS: "au", GBR: "gb", USA: "us", CAN: "ca", NZL: "nz", IRL: "ie",
  FRA: "fr", DEU: "de", ESP: "es", ITA: "it", NLD: "nl", SWE: "se",
  NOR: "no", DNK: "dk", CHE: "ch", AUT: "at", BEL: "be", PRT: "pt",
  ZAF: "za", JPN: "jp", SGP: "sg",
};
function toAlpha2(code) {
  if (!code) return "au";
  const c = String(code).toUpperCase();
  if (c.length === 2) return c.toLowerCase();
  return ALPHA3_TO_ALPHA2[c] || "au";
}

function createStripe({
  secretKey = process.env.STRIPE_SECRET_KEY,
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET,
  // Optional injection point for tests: a (secretKey, opts) → client
  // factory used instead of the real `stripe` package, so the fund-flow
  // helpers can be unit-tested without network or real keys.
  clientFactory = null,
} = {}) {
  const enabled = Boolean(secretKey);
  // Heads up: refuse the half-configured state outright. With a secret
  // key but no webhook secret, checkouts would happily CHARGE while every
  // completion webhook 400s, money taken, nothing ever fulfilled. Failing
  // at boot is the only safe behaviour, so set both vars or neither.
  if (enabled && !webhookSecret) {
    throw new Error(
      "STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not. " +
      "Refusing to start: checkouts would charge payers but no payment could ever be fulfilled. " +
      "Register the webhook endpoint in the Stripe dashboard and set STRIPE_WEBHOOK_SECRET, or unset STRIPE_SECRET_KEY.",
    );
  }
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
            // App-internal hundredths → this currency's Stripe minor units
            // (zero-decimal currencies would otherwise charge 100x).
            unit_amount: toStripeAmount(currency, chargeAmountCents),
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
  // stale/under-priced or waived session can't be completed. Stripe rejects
  // expiring an already-completed/expired session, so callers must then
  // retrieveCheckoutSession to learn WHICH: a completed session means the
  // money was captured and the payment must be treated as paid, not failed.
  async function expireCheckoutSession({ sessionId }) {
    assertEnabled();
    return client.checkout.sessions.expire(sessionId);
  }

  // Fetch a Checkout Session's current state. Used (a) after a failed
  // expire, to distinguish "already completed: money captured" from
  // "already expired: nothing happened", and (b) to RESUME a payer's
  // still-open session (session.url stays valid while status === 'open')
  // instead of dead-ending them behind a 409 until it expires.
  async function retrieveCheckoutSession({ sessionId }) {
    assertEnabled();
    return client.checkout.sessions.retrieve(sessionId);
  }

  // Refund a charge on the platform account. No application-fee reversal:
  // the platform's cut lives in our payout ledger (a refund reduces what the
  // federation/club is owed), not in Stripe. `amountCents` (app-internal
  // hundredths) omitted = full. Pass `currency` so partial amounts convert
  // to the currency's Stripe minor units; the returned refund's `amount`
  // comes back in STRIPE units, so use fromStripeAmount() before storing it.
  async function retrievePaymentIntent({ paymentIntentId }) {
    assertEnabled();
    return client.paymentIntents.retrieve(paymentIntentId);
  }

  async function createRefund({ paymentIntentId, amountCents, currency }) {
    assertEnabled();
    return client.refunds.create({
      payment_intent: paymentIntentId,
      amount: amountCents ? toStripeAmount(currency, amountCents) : undefined,
    });
  }

  // --- Connect payouts (recipient accounts + transfers) ------------
  //
  // Clubs/federations receive their balance via Stripe Connect TRANSFERS
  // to a recipient-only connected account (Accounts v2). They onboard once
  // through Stripe-hosted onboarding, the app never sees or stores bank
  // details. The platform stays merchant of record; these accounts can
  // only RECEIVE, never charge.

  // Create a recipient-only connected account. `country` is the recipient's
  // own country (alpha-2). fees/losses sit with the platform; no dashboard.
  async function createRecipientAccount({ country, email, name, currency }) {
    assertEnabled();
    return client.v2.core.accounts.create({
      display_name: name || undefined,
      contact_email: email || undefined,
      identity: { country: String(country || "au").toLowerCase() },
      configuration: {
        recipient: {
          capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
        },
      },
      defaults: {
        responsibilities: { fees_collector: "application", losses_collector: "application" },
        ...(currency ? { currency: String(currency).toLowerCase() } : {}),
      },
      dashboard: "none",
    });
  }

  // A hosted-onboarding link the recipient follows to add their bank
  // account + verify identity. Short-lived; regenerate on demand.
  async function createOnboardingLink({ accountId, returnUrl, refreshUrl }) {
    assertEnabled();
    const link = await client.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["recipient"],
          return_url: returnUrl,
          refresh_url: refreshUrl,
        },
      },
    });
    return link.url;
  }

  // Current readiness of a recipient account: can we transfer to it yet?
  // `payoutsEnabled` is true once the stripe_transfers capability is active
  // (onboarding complete + verified). `requirementsDue` surfaces what's
  // still outstanding so the UI can nudge.
  async function retrieveAccountStatus({ accountId }) {
    assertEnabled();
    const a = await client.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.recipient", "requirements"],
    });
    const cap = a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers;
    return {
      payoutsEnabled: cap?.status === "active",
      capabilityStatus: cap?.status || "restricted",
      requirementsCollected: a.requirements?.collected ?? false,
      account: a,
    };
  }

  // Transfer collected funds from the platform balance to a recipient
  // account. `amountCents` is app-internal hundredths → the currency's
  // Stripe minor units. An idempotency key (the payout row id) makes a
  // retried withdrawal safe, Stripe returns the original transfer instead
  // of a second one.
  async function createTransfer({ accountId, amountCents, currency, idempotencyKey, description }) {
    assertEnabled();
    return client.transfers.create(
      {
        destination: accountId,
        amount: toStripeAmount(currency, amountCents),
        currency: String(currency).toLowerCase(),
        description: description || undefined,
      },
      idempotencyKey ? { idempotencyKey } : undefined,
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
    createCheckoutSession,
    expireCheckoutSession,
    retrieveCheckoutSession,
    retrievePaymentIntent,
    createRefund,
    createRecipientAccount,
    createOnboardingLink,
    retrieveAccountStatus,
    createTransfer,
    constructWebhookEvent,
    toStripeAmount,
    fromStripeAmount,
    client, // exposed for advanced/edge use + tests
  };
}

module.exports = createStripe;
module.exports.toStripeAmount = toStripeAmount;
module.exports.fromStripeAmount = fromStripeAmount;
module.exports.toAlpha2 = toAlpha2;
