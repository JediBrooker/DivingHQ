// Unit tests for lib/stripe.js, the platform fund-flow helpers.
//
// We inject a fake Stripe client (the `clientFactory` hook) and assert the
// helpers charge/refund on the PLATFORM's own account (DivingHQ is the
// merchant of record). No connected account, no application_fee; the 15%
// cut is stamped on the PaymentIntent for reconciliation only. No network.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const createStripe = require("../lib/stripe");

function fakeClient() {
  const calls = {};
  return {
    calls,
    v2: {
      core: {
        accounts: {
          create: async (p) => { calls.accountCreate = p; return { id: "acct_new" }; },
          retrieve: async (id, p) => { calls.accountRetrieve = { id, p }; return {}; },
        },
      },
    },
    accountLinks: { create: async (p) => { calls.link = p; return { url: "https://onboard" }; } },
    checkout: { sessions: { create: async (p, o) => { calls.session = { p, o }; return { id: "cs_1", url: "https://pay" }; } } },
    refunds: { create: async (p, o) => { calls.refund = { p, o }; return { amount: p.amount }; } },
    webhooks: { constructEvent: (raw, sig, secret) => ({ raw, sig, secret }) },
  };
}

function withFake() {
  let captured;
  const s = createStripe({
    secretKey: "sk_test_x",
    webhookSecret: "whsec_x",
    clientFactory: () => { captured = fakeClient(); return captured; },
  });
  return { s, calls: () => captured.calls };
}

test("disabled when no secret key; every call throws 503", async () => {
  const s = createStripe({ secretKey: "" });
  assert.equal(s.enabled, false);
  await assert.rejects(() => s.createRefund({}), (e) => e.status === 503 && e.code === "payments_disabled");
});

test("createRefund refunds on the platform account, no application-fee reversal", async () => {
  const { s, calls } = withFake();
  await s.createRefund({ paymentIntentId: "pi_9" });
  assert.equal(calls().refund.p.payment_intent, "pi_9");
  assert.equal(calls().refund.p.refund_application_fee, undefined); // platform is MoR
  assert.equal(calls().refund.o, undefined);                        // not on a connected account
});

test("createCheckoutSession charges on the platform account (no connected account / app fee)", async () => {
  const { s, calls } = withFake();
  await s.createCheckoutSession({
    currency: "GBP", chargeAmountCents: 5000,
    applicationFeeCents: 750, productName: "Entry", successUrl: "s", cancelUrl: "c",
  });
  const { p, o } = calls().session;
  assert.equal(o, undefined);                                          // platform account, no stripeAccount
  assert.equal(p.payment_intent_data.application_fee_amount, undefined);
  assert.equal(p.payment_intent_data.metadata.platform_fee_cents, 750); // stamped for reconciliation
  assert.equal(p.line_items[0].price_data.unit_amount, 5000);
  assert.equal(p.line_items[0].price_data.currency, "gbp");
});

test("secret key without webhook secret refuses to construct (boot guard)", () => {
  // A half-configured deployment would CHARGE payers while every completion
  // webhook 400s, money taken, nothing fulfilled. Fail at boot instead.
  assert.throws(
    () => createStripe({ secretKey: "sk_test_x", webhookSecret: "", clientFactory: () => fakeClient() }),
    /STRIPE_WEBHOOK_SECRET/,
  );
});

// ---- currency-unit conversion at the Stripe boundary ----------------
// The app stores hundredths uniformly, but Stripe wants each currency's own
// minor unit. Without conversion a ¥5,000 fee (stored 500000) would charge
// ¥500,000, yikes.

test("zero-decimal currencies convert hundredths → whole units on checkout", async () => {
  const { s, calls } = withFake();
  await s.createCheckoutSession({
    currency: "JPY", chargeAmountCents: 500000,
    applicationFeeCents: 75000, productName: "Entry", successUrl: "s", cancelUrl: "c",
  });
  assert.equal(calls().session.p.line_items[0].price_data.unit_amount, 5000); // ¥5,000
});

test("non-representable zero-decimal amounts are refused with a 400", async () => {
  const { s } = withFake();
  await assert.rejects(
    () => s.createCheckoutSession({
      currency: "JPY", chargeAmountCents: 500050, // ¥5,000.50 doesn't exist
      applicationFeeCents: 0, productName: "Entry", successUrl: "s", cancelUrl: "c",
    }),
    (e) => e.status === 400,
  );
});

test("createRefund converts partial amounts to Stripe units", async () => {
  const { s, calls } = withFake();
  await s.createRefund({ paymentIntentId: "pi_9", amountCents: 200000, currency: "JPY" });
  assert.equal(calls().refund.p.amount, 2000); // ¥2,000, not 200000
  await s.createRefund({ paymentIntentId: "pi_9", amountCents: 2000, currency: "GBP" });
  assert.equal(calls().refund.p.amount, 2000); // two-decimal: identity
});

test("toStripeAmount / fromStripeAmount round-trip per currency class", () => {
  assert.equal(createStripe.toStripeAmount("gbp", 12345), 12345);
  assert.equal(createStripe.fromStripeAmount("gbp", 12345), 12345);
  assert.equal(createStripe.toStripeAmount("jpy", 500000), 5000);
  assert.equal(createStripe.fromStripeAmount("jpy", 5000), 500000);
  assert.equal(createStripe.toStripeAmount("kwd", 12345), 123450);  // three-decimal ×10
  assert.equal(createStripe.fromStripeAmount("kwd", 123450), 12345);
  assert.throws(() => createStripe.toStripeAmount("jpy", 550), (e) => e.status === 400);
});
