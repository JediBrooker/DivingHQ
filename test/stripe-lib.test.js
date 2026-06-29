// Unit tests for lib/stripe.js — the Connect fund-flow helpers.
//
// We inject a fake Stripe client (the `clientFactory` hook) and assert
// the helpers build the right calls — most importantly that refunds
// ALWAYS carry refund_application_fee:true (so a federation is never
// left short DivingHQ's cut) and that checkout is a DIRECT charge on the
// connected account with an application fee. No network, no real keys.

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

test("createRefund ALWAYS sets refund_application_fee:true on the connected account", async () => {
  const { s, calls } = withFake();
  await s.createRefund({ connectedAccountId: "acct_9", paymentIntentId: "pi_9" });
  assert.equal(calls().refund.p.refund_application_fee, true);
  assert.equal(calls().refund.p.payment_intent, "pi_9");
  assert.deepEqual(calls().refund.o, { stripeAccount: "acct_9" });
});

test("createCheckoutSession is a direct charge with an application fee", async () => {
  const { s, calls } = withFake();
  await s.createCheckoutSession({
    connectedAccountId: "acct_9", currency: "GBP", chargeAmountCents: 5000,
    applicationFeeCents: 750, productName: "Entry", successUrl: "s", cancelUrl: "c",
  });
  const { p, o } = calls().session;
  assert.equal(o.stripeAccount, "acct_9");                       // direct charge on the federation
  assert.equal(p.payment_intent_data.application_fee_amount, 750); // our 15%
  assert.equal(p.line_items[0].price_data.unit_amount, 5000);
  assert.equal(p.line_items[0].price_data.currency, "gbp");
});

test("createConnectedAccount requests direct-charge responsibilities", async () => {
  const { s, calls } = withFake();
  await s.createConnectedAccount({ country: "GB", currency: "GBP", orgName: "Fed" });
  const p = calls().accountCreate;
  assert.equal(p.identity.country, "gb");
  assert.equal(p.defaults.responsibilities.losses_collector, "account");
  assert.equal(p.defaults.responsibilities.fees_collector, "account");
  assert.equal(p.configuration.merchant.capabilities.card_payments.requested, true);
});

test("constructWebhookEvent requires a webhook secret", () => {
  const s = createStripe({ secretKey: "sk_test_x", clientFactory: () => fakeClient() });
  assert.throws(() => s.constructWebhookEvent(Buffer.from("{}"), "sig"),
    (e) => e.code === "webhook_secret_missing");
});
