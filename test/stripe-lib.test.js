// Unit tests for lib/stripe.js — the platform fund-flow helpers.
//
// We inject a fake Stripe client (the `clientFactory` hook) and assert the
// helpers charge/refund on the PLATFORM's own account (DivingHQ is the
// merchant of record) — no connected account, no application_fee; the 15%
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

test("constructWebhookEvent requires a webhook secret", () => {
  const s = createStripe({ secretKey: "sk_test_x", clientFactory: () => fakeClient() });
  assert.throws(() => s.constructWebhookEvent(Buffer.from("{}"), "sig"),
    (e) => e.code === "webhook_secret_missing");
});
