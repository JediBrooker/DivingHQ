// Feature-flag unit tests (migration 085).
//
// No Postgres and no Stripe key: lib/features takes an injected pool and
// lib/stripe takes an injected clientFactory, so both run anywhere. That
// matters because this file guards the two things most likely to be broken
// by a careless refactor:
//
//   1. Everything defaults OFF. A flag that fails open is a flag that takes
//      money on a launch day you meant to keep quiet.
//   2. Switching payments off must NOT stop the webhook, refunds, or session
//      expiry. Those run on `configured` (is there a Stripe client), never on
//      `enabled` (is the flag on). Collapse the two and in-flight checkouts
//      get stranded: card charged, nothing fulfilled.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const createFeatures = require("../lib/features");
const createStripe = require("../lib/stripe");

// ---- fakes ------------------------------------------------------

// Minimal pool: records every query, answers the two shapes lib/features
// actually issues (the SELECT on load/list, and everything else as a no-op).
function fakePool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/FROM feature_flags/i.test(text)) return { rows };
      return { rows: [] };
    },
  };
}

function fakeStripeClient(log = []) {
  return () => ({
    checkout: {
      sessions: {
        create: async () => { log.push("create"); return { id: "cs_1", url: "https://pay" }; },
        expire: async () => { log.push("expire"); return { status: "expired" }; },
        retrieve: async () => { log.push("retrieve"); return { status: "open" }; },
      },
    },
    paymentIntents: { retrieve: async () => { log.push("pi"); return {}; } },
    refunds: { create: async () => { log.push("refund"); return { amount: 100 }; } },
    transfers: { create: async () => { log.push("transfer"); return { id: "tr_1" }; } },
    webhooks: { constructEvent: () => { log.push("webhook"); return { type: "ping" }; } },
    v2: { core: {
      accounts: { create: async () => ({ id: "acct_1" }), retrieve: async () => ({}) },
      accountLinks: { create: async () => ({ url: "https://onboard" }) },
    } },
  });
}

// Build a stripe wrapper with a key present and a controllable flag.
function stripeWith(flagOn, log = []) {
  return createStripe({
    secretKey: "sk_test_x",
    webhookSecret: "whsec_x",
    clientFactory: fakeStripeClient(log),
    featureEnabled: () => (typeof flagOn === "function" ? flagOn() : flagOn),
  });
}

async function throws503(fn) {
  try {
    await fn();
  } catch (err) {
    return err.status === 503 && err.code === "payments_disabled";
  }
  return false;
}

// ---- lib/features -----------------------------------------------

test("features default to off when the table has no rows", async () => {
  const f = createFeatures({ pool: fakePool([]) });
  await f.load();
  assert.equal(f.enabled("payments"), false);
  assert.equal(f.enabled("classes"), false);
  assert.deepEqual(f.all(), { payments: false, classes: false });
});

test("features read as off before load() has ever run", () => {
  const f = createFeatures({ pool: fakePool([{ key: "payments", enabled: true }]) });
  // Deliberately no load(). A request that beats the boot read must not see
  // payments as live just because the row says so.
  assert.equal(f.enabled("payments"), false);
});

test("load() reflects the table, and unknown rows are ignored", async () => {
  const f = createFeatures({
    pool: fakePool([
      { key: "payments", enabled: true },
      { key: "classes", enabled: false },
      { key: "retired_thing", enabled: true },
    ]),
  });
  await f.load();
  assert.equal(f.enabled("payments"), true);
  assert.equal(f.enabled("classes"), false);
  assert.equal(f.KEYS.includes("retired_thing"), false);
});

test("enabled() throws on a key nobody registered", () => {
  const f = createFeatures({ pool: fakePool() });
  assert.throws(() => f.enabled("nope"), /Unknown feature flag/);
});

test("set() writes, updates the cache in the same tick, and audits", async () => {
  const pool = fakePool([]);
  const f = createFeatures({ pool });
  await f.load();
  assert.equal(f.enabled("classes"), false);

  await f.set("classes", true, { actorId: "user-1" });
  assert.equal(f.enabled("classes"), true, "cache must not wait for a reload");

  const upsert = pool.calls.find((c) => /INSERT INTO feature_flags/i.test(c.text));
  assert.ok(upsert, "expected an upsert");
  assert.deepEqual(upsert.params, ["classes", true, "user-1"]);

  const audit = pool.calls.find((c) => /INSERT INTO audit_log/i.test(c.text));
  assert.ok(audit, "expected an audit row");
  assert.equal(audit.params[5], "feature_flag.enabled");
});

test("set() coerces nothing: only a real true turns a flag on", async () => {
  const f = createFeatures({ pool: fakePool([]) });
  await f.load();
  await f.set("payments", "true");
  assert.equal(f.enabled("payments"), false, "the string 'true' must not enable payments");
});

test("FEATURE_FLAGS_ON forces a key on over the table, and only forces ON", async () => {
  const prev = process.env.FEATURE_FLAGS_ON;
  process.env.FEATURE_FLAGS_ON = "classes";
  try {
    const f = createFeatures({ pool: fakePool([{ key: "classes", enabled: false }]) });
    await f.load();
    assert.equal(f.enabled("classes"), true, "the override must beat a false row");
    assert.equal(f.enabled("payments"), false, "an unlisted key is untouched");
  } finally {
    if (prev === undefined) delete process.env.FEATURE_FLAGS_ON;
    else process.env.FEATURE_FLAGS_ON = prev;
  }
});

test("no FEATURE_FLAGS_ON means no override", async () => {
  const prev = process.env.FEATURE_FLAGS_ON;
  delete process.env.FEATURE_FLAGS_ON;
  try {
    const f = createFeatures({ pool: fakePool([{ key: "classes", enabled: false }]) });
    await f.load();
    assert.equal(f.enabled("classes"), false);
  } finally {
    if (prev !== undefined) process.env.FEATURE_FLAGS_ON = prev;
  }
});

test("requireFeature() 503s when off and calls next() when on", async () => {
  const f = createFeatures({ pool: fakePool([{ key: "classes", enabled: false }]) });
  await f.load();
  const gate = f.requireFeature("classes");

  let status = null; let body = null; let nexted = false;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };

  gate({}, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(status, 503);
  assert.equal(body.code, "feature_disabled");
  assert.equal(body.feature, "classes");

  await f.set("classes", true);
  gate({}, res, () => { nexted = true; });
  assert.equal(nexted, true);
});

// ---- lib/stripe: configured vs enabled --------------------------

test("no secret key: neither configured nor enabled, everything 503s", async () => {
  const p = createStripe({ secretKey: "", webhookSecret: "" });
  assert.equal(p.configured, false);
  assert.equal(p.enabled, false);
  assert.ok(await throws503(() => p.createCheckoutSession({ currency: "aud" })));
  assert.ok(await throws503(() => p.createRefund({ paymentIntentId: "pi_1" })));
  assert.ok(await throws503(() => p.constructWebhookEvent(Buffer.from("{}"), "sig")));
});

test("flag off with a key present: configured true, enabled false", () => {
  const p = stripeWith(false);
  assert.equal(p.configured, true);
  assert.equal(p.enabled, false);
});

test("flag off blocks NEW money: checkout, onboarding, transfers", async () => {
  const p = stripeWith(false);
  assert.ok(await throws503(() => p.createCheckoutSession({ currency: "aud", chargeAmountCents: 100 })));
  assert.ok(await throws503(() => p.createRecipientAccount({ country: "AUS" })));
  assert.ok(await throws503(() => p.createOnboardingLink({ accountId: "acct_1" })));
  assert.ok(await throws503(() => p.createTransfer({ accountId: "acct_1", amountCents: 100, currency: "aud" })));
});

test("flag off still lets in-flight money settle", async () => {
  const log = [];
  const p = stripeWith(false, log);

  // The whole point of the configured/enabled split. If any of these throw,
  // switching payments off after go-live strands every open checkout.
  await p.createRefund({ paymentIntentId: "pi_1", currency: "aud" });
  await p.expireCheckoutSession({ sessionId: "cs_1" });
  await p.retrieveCheckoutSession({ sessionId: "cs_1" });
  await p.retrievePaymentIntent({ paymentIntentId: "pi_1" });
  p.constructWebhookEvent(Buffer.from("{}"), "sig");

  assert.deepEqual(log, ["refund", "expire", "retrieve", "pi", "webhook"]);
});

test("enabled is a live getter, not a boot-time snapshot", async () => {
  let on = false;
  const p = stripeWith(() => on);
  assert.equal(p.enabled, false);
  on = true;
  assert.equal(p.enabled, true, "a toggle must land without a restart");
  await p.createCheckoutSession({ currency: "aud", chargeAmountCents: 100 });
});

test("callers that pass no featureEnabled behave exactly as before", () => {
  // Every pre-flag call site, and the whole existing test suite, relies on
  // `enabled` meaning nothing more than "the key is set".
  const p = createStripe({
    secretKey: "sk_test_x",
    webhookSecret: "whsec_x",
    clientFactory: fakeStripeClient(),
  });
  assert.equal(p.enabled, true);
});

test("a secret key without a webhook secret still refuses to construct", () => {
  assert.throws(
    () => createStripe({ secretKey: "sk_test_x", webhookSecret: "", clientFactory: fakeStripeClient() }),
    /STRIPE_WEBHOOK_SECRET/,
  );
});
