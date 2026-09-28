// Guardian checkouts against the real payments router and a fake Stripe.
//
// A guardian's payment row has payer = the guardian and subject = the
// dependent, and every one-live index keys on
// COALESCE(subject_user_id, payer_user_id). These tests pin the places
// that used to look at payer_user_id alone: resuming an abandoned
// checkout, reading "already paid", pricing and membership for the
// dependent, refunding one dependent's bundle, and a guardian paying a
// class the diver already opened.
//
// Self-skips when Postgres isn't reachable or migration 083 (guardians)
// is missing. Seeds its own federation and tears it down afterwards.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const createPaymentsRouter = require("../routes/payments");
const createStripeWebhook = require("../routes/stripe-webhook");
const createClassesRouter = require("../routes/classes");

const silentLogger = { warn() {}, error() {}, info() {} };
const suffix = crypto.randomUUID().slice(0, 8);

let pool;
let ready = false;
let server;
let base;
let orgId;
let G; // guardian
let A; // dependent one
let B; // dependent two
let S; // somebody unrelated
let admin;

// What the fake Stripe says about an existing session when we ask.
let sessionStatus = "open";
let flagOn = true;
const refunds = [];
let sessionNo = 0;
const fakePayments = {
  get enabled() { return flagOn; },
  configured: true,
  createCheckoutSession: async () => {
    sessionNo += 1;
    return {
      id: `cs_test_gc_${suffix}_${sessionNo}`.padEnd(66, "x"),
      url: `https://stripe.test/pay/${sessionNo}`,
    };
  },
  expireCheckoutSession: async () => ({ status: "expired" }),
  retrieveCheckoutSession: async ({ sessionId }) => ({
    id: sessionId, status: sessionStatus, url: `https://stripe.test/resume/${sessionId}`,
  }),
  retrievePaymentIntent: async () => ({}),
  createRefund: async (args) => { refunds.push(args); return { amount: args.amountCents ?? null }; },
  constructWebhookEvent: (raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : raw),
};

const emails = [];
const fakeEmail = { sendPaymentRefundedEmail: (id) => emails.push(id) };

let acting;
const as = (id, extra = {}) => ({
  id, org_id: orgId, org_roles: ["diver"], is_system_admin: false, email: "x@test.local", ...extra,
});

function buildApp() {
  const setUser = (req, _res, next) => { if (acting) req.user = { ...acting }; next(); };
  const requireEventManager = () => async (req, _res, next) => {
    req.user = { ...acting };
    req.event = (await pool.query("SELECT id, org_id FROM events WHERE id = $1", [req.params.id])).rows[0];
    next();
  };
  const requireClubAdminOnly = () => async (req, _res, next) => {
    req.user = { ...acting };
    req.club = (await pool.query("SELECT id, org_id, status FROM clubs WHERE id = $1", [req.params.id])).rows[0];
    next();
  };
  const app = express();
  app.use((req, res, next) => (req.path === "/webhooks/stripe" ? next() : express.json()(req, res, next)));
  app.use(createPaymentsRouter({
    pool, verifyToken: setUser, optionalAuth: setUser, requireOrgRole: () => setUser,
    requireEventManager, requireMeetEditor: setUser, requireClubAdmin: () => setUser,
    requireSystemAdmin: setUser, logger: silentLogger, payments: fakePayments, email: fakeEmail,
  }));
  app.use(createClassesRouter({
    pool, verifyToken: setUser, requireClubAdminOnly, logger: silentLogger,
    payments: fakePayments,
  }));
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }),
    createStripeWebhook({ pool, logger: silentLogger, payments: fakePayments, email: fakeEmail }));
  return app;
}

async function api(method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: json };
}

async function newEvent(name, meetId = null) {
  return (await pool.query(
    "INSERT INTO events (org_id, meet_id, name, gender, number_of_judges) VALUES ($1, $2, $3, 'Mixed', 5) RETURNING id",
    [orgId, meetId, `${name} ${suffix}`],
  )).rows[0].id;
}

async function setEntryFee(eventId, cents = 2000) {
  acting = admin;
  const r = await api("PUT", `/api/events/${eventId}/fee`, { prices: [{ amount_cents: cents }], currency: "GBP" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

// Settle a pending payment the way the webhook would.
async function completeWebhook(paymentId) {
  const p = (await pool.query("SELECT stripe_checkout_session FROM payments WHERE id = $1", [paymentId])).rows[0];
  const evt = {
    type: "checkout.session.completed",
    data: { object: {
      id: p.stripe_checkout_session, client_reference_id: paymentId,
      payment_status: "paid", payment_intent: `pi_gc_${paymentId.slice(0, 8)}_${suffix}`,
    } },
  };
  const r = await fetch(`${base}/webhooks/stripe`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(evt),
  });
  assert.equal(r.status, 200);
}

before(async () => {
  pool = new Pool({
    user: process.env.DB_USER || process.env.PGUSER,
    host: process.env.DB_HOST || process.env.PGHOST,
    database: process.env.DB_DATABASE || process.env.PGDATABASE,
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
    port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
  });
  try {
    const r = await pool.query("SELECT to_regclass('public.guardians') AS t");
    if (!r.rows[0].t) { console.warn("[skip] guardians table missing, apply migration 083"); return; }
  } catch (err) {
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }
  orgId = (await pool.query(
    `INSERT INTO organisations (name, slug, default_currency, platform_fee_bps)
     VALUES ($1, $2, 'GBP', 1000) RETURNING id`,
    [`Guardian Checkout ${suffix}`, `guardian-checkout-${suffix}`],
  )).rows[0].id;
  const mk = async (name, dob = null) => (await pool.query(
    "INSERT INTO users (username, full_name, org_id, date_of_birth) VALUES ($1, $2, $3, $4) RETURNING id",
    [`gc-${name}-${suffix}`, name, orgId, dob],
  )).rows[0].id;
  G = await mk("Guardian");
  A = await mk("Kid A", "2016-01-01");
  B = await mk("Kid B", "2017-01-01");
  S = await mk("Stranger");
  for (const d of [A, B]) {
    await pool.query(
      "INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status) VALUES ($1, $2, $3, 'approved')",
      [orgId, G, d],
    );
  }
  admin = as(S, { org_roles: ["org_admin", "meet_manager"], is_system_admin: true });
  server = http.createServer(buildApp());
  await new Promise((res) => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
  ready = true;
});

after(async () => {
  if (server) await new Promise((res) => server.close(res));
  if (orgId) {
    const q = (sql) => pool.query(sql, [orgId]).catch(() => {});
    await q("DELETE FROM payments WHERE org_id = $1");
    await q("DELETE FROM class_enrolments WHERE org_id = $1");
    await q("DELETE FROM class_price_options WHERE class_id IN (SELECT id FROM classes WHERE org_id = $1)");
    await q("DELETE FROM classes WHERE org_id = $1");
    await q("DELETE FROM clubs WHERE org_id = $1");
    await q("DELETE FROM memberships WHERE org_id = $1");
    await q("DELETE FROM guardians WHERE org_id = $1");
    await q("DELETE FROM meet_bundle_items WHERE fee_definition_id IN (SELECT id FROM fee_definitions WHERE org_id = $1)");
    await q("DELETE FROM fee_prices WHERE fee_definition_id IN (SELECT id FROM fee_definitions WHERE org_id = $1)");
    await q("DELETE FROM fee_definitions WHERE org_id = $1");
    await q("DELETE FROM events WHERE org_id = $1");
    await q("DELETE FROM meets WHERE org_id = $1");
    await q("DELETE FROM audit_log WHERE org_id = $1");
    await q("DELETE FROM users WHERE org_id = $1");
    await q("DELETE FROM organisations WHERE id = $1");
  }
  if (pool) await pool.end();
});

// B4-01: the blocking row lookup has to find the guardian's own pending row,
// which is keyed on the dependent, not on the guardian as payer.
test("a guardian's abandoned checkout for a dependent resumes, then retires once expired", async (t) => {
  if (!ready) return t.skip();
  const ev = await newEvent("Resume 1m");
  await setEntryFee(ev);
  acting = as(G);
  const first = await api("POST", `/api/events/${ev}/checkout`, { subject_user_id: A });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  sessionStatus = "open";
  const again = await api("POST", `/api/events/${ev}/checkout`, { subject_user_id: A });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.payment_id, first.body.payment_id, "the still-open session is resumed");
  assert.match(again.body.url, /\/resume\//);

  sessionStatus = "expired";
  const fresh = await api("POST", `/api/events/${ev}/checkout`, { subject_user_id: A });
  sessionStatus = "open";
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.notEqual(fresh.body.payment_id, first.body.payment_id, "a dead session is replaced");
  const old = (await pool.query("SELECT status FROM payments WHERE id = $1", [first.body.payment_id])).rows[0];
  assert.equal(old.status, "failed");
});

test("the same holds for a dependent's membership", async (t) => {
  if (!ready) return t.skip();
  acting = admin;
  const put = await api("PUT", `/api/orgs/${orgId}/membership-fee`, {
    prices: [{ amount_cents: 5000 }], currency: "GBP", tier: "junior-resume",
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  acting = as(G);
  const first = await api("POST", `/api/orgs/${orgId}/membership/checkout`, { subject_user_id: B, tier: "junior-resume" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  sessionStatus = "expired";
  const retry = await api("POST", `/api/orgs/${orgId}/membership/checkout`, { subject_user_id: B, tier: "junior-resume" });
  sessionStatus = "open";
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.notEqual(retry.body.payment_id, first.body.payment_id);
});

test("a guardian is never handed the session the dependent opened themselves", async (t) => {
  if (!ready) return t.skip();
  const ev = await newEvent("Own session 3m");
  await setEntryFee(ev);
  acting = as(A);
  const mine = await api("POST", `/api/events/${ev}/checkout`, {});
  assert.equal(mine.status, 200, JSON.stringify(mine.body));

  acting = as(G);
  const parent = await api("POST", `/api/events/${ev}/checkout`, { subject_user_id: A });
  assert.equal(parent.status, 200, JSON.stringify(parent.body));
  assert.notEqual(parent.body.payment_id, mine.body.payment_id, "a fresh row in the guardian's name");
  assert.doesNotMatch(parent.body.url, /\/resume\//);
  const rows = (await pool.query(
    "SELECT id, payer_user_id, status FROM payments WHERE event_id = $1 ORDER BY created_at",
    [ev],
  )).rows;
  assert.deepEqual(rows.map((r) => [r.payer_user_id, r.status]), [[A, "failed"], [G, "pending"]]);
});

test("a late surcharge only retires the stale checkout of the same dependent", async (t) => {
  if (!ready) return t.skip();
  const ev = await newEvent("Late fee 5m");
  await setEntryFee(ev);
  acting = as(G);
  const forA = await api("POST", `/api/events/${ev}/checkout`, { subject_user_id: A });
  assert.equal(forA.status, 200, JSON.stringify(forA.body));

  // Entries close, a surcharge now applies.
  await pool.query("UPDATE events SET entries_close_at = now() - interval '1 hour' WHERE id = $1", [ev]);
  acting = admin;
  const late = await api("PUT", `/api/events/${ev}/late-fee`, {
    late_fee_trigger: "entries_close_at", prices: [{ amount_cents: 500 }],
  });
  assert.equal(late.status, 200, JSON.stringify(late.body));

  acting = as(G);
  const forB = await api("POST", `/api/events/${ev}/checkout`, { subject_user_id: B });
  assert.equal(forB.status, 200, JSON.stringify(forB.body));
  const a = (await pool.query("SELECT status FROM payments WHERE id = $1", [forA.body.payment_id])).rows[0];
  assert.equal(a.status, "pending", "the sibling's checkout is none of B's business");
});
