// Integration tests for the payment-aware deletion guards on the meet
// and event routes, plus stripe_charge_id backfill in the webhook
// handler.
//
// Heads up: self-skips if Postgres isn't reachable or the payments
// table hasn't been created yet (same pattern as payments.integration.test.js).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const createMeetsRouter = require("../routes/meets");
const createEventsRouter = require("../routes/events");
const createStripeWebhook = require("../routes/stripe-webhook");

const silentLogger = { warn() {}, error() {}, info() {} };
const suffix = crypto.randomUUID().slice(0, 8);

let pool;
let ready = false;
let server;
let base;
let orgId;
let userId;

let expireCheckoutSessionImpl = async () => ({ status: "expired" });
let retrieveCheckoutSessionImpl = async (args) => ({ id: args.sessionId, status: "open" });
let retrievePaymentIntentImpl = async (args) => ({
  id: args.paymentIntentId,
  latest_charge: "ch_test_" + crypto.randomUUID().slice(0, 8),
});

const fakePayments = {
  enabled: true,
  createCheckoutSession: async () => ({
    id: ("cs_test_" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")).slice(0, 66),
    url: "https://stripe.test/pay",
  }),
  expireCheckoutSession: (...a) => expireCheckoutSessionImpl(...a),
  retrieveCheckoutSession: async (args) => retrieveCheckoutSessionImpl(args),
  retrievePaymentIntent: async (args) => retrievePaymentIntentImpl(args),
  createRefund: async () => ({}),
  constructWebhookEvent: (raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : raw),
};

function buildApp() {
  const TEST_USER = () => ({
    id: userId,
    org_id: orgId,
    org_roles: ["org_admin", "meet_manager"],
    is_system_admin: true,
    email: "admin@test.local",
  });
  const setUser = (req, _res, next) => { req.user = TEST_USER(); next(); };
  const optionalAuth = setUser;
  const requireOrgAdmin = setUser;
  const requireOrgRole = () => setUser;
  const requireMeetEditor = setUser;
  const requireEventManager = () => setUser;

  const app = express();
  app.use((req, res, next) =>
    req.path === "/webhooks/stripe" ? next() : express.json()(req, res, next));
  app.use(createMeetsRouter({
    pool,
    optionalAuth,
    requireMeetEditor,
    requireEventManager,
    payments: fakePayments,
  }));
  app.use(createEventsRouter({
    pool,
    JWT_SECRET: "test",
    optionalAuth,
    io: { to: () => ({ emit() {} }) },
    verifyToken: setUser,
    requireOrgAdmin,
    requireOrgRole,
    requireEventManager,
    sendEventStartedEmails: () => {},
    sendEventResultsEmails: () => {},
    activeDivers: { get: () => null },
    meetHolds: new Map(),
    payments: fakePayments,
  }));
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }),
    createStripeWebhook({ pool, logger: silentLogger, payments: fakePayments }));
  return app;
}

const api = (method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: body !== undefined
      ? { "content-type": "application/json", ...(path === "/webhooks/stripe" ? { "stripe-signature": "t" } : {}) }
      : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

before(async () => {
  pool = new Pool({
    user: process.env.DB_USER || process.env.PGUSER,
    host: process.env.DB_HOST || process.env.PGHOST,
    database: process.env.DB_DATABASE || process.env.PGDATABASE,
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
    port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
  });
  try {
    const r = await pool.query("SELECT to_regclass('public.payments') AS t");
    if (!r.rows[0].t) { console.warn("[skip] payments table missing"); return; }
  } catch (err) {
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  orgId = (await pool.query(
    `INSERT INTO organisations (name, slug, default_currency, platform_fee_bps)
     VALUES ($1, $2, 'AUD', 1500) RETURNING id`,
    [`Del-Guard Fed ${suffix}`, `del-guard-${suffix}`],
  )).rows[0].id;
  userId = (await pool.query(
    "INSERT INTO users (username, full_name, org_id) VALUES ($1, $2, $3) RETURNING id",
    [`del-guard-${suffix}`, "Del Guard User", orgId],
  )).rows[0].id;

  server = http.createServer(buildApp());
  await new Promise((res) => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
  ready = true;
});

after(async () => {
  if (server) await new Promise((res) => server.close(res));
  if (orgId) {
    await pool.query("DELETE FROM payments WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM fee_definitions WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM meets WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM events WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]);
  }
  if (pool) await pool.end();
});

// ── Event deletion guards ─────────────────────────────────────────

test("event deletion is blocked when a paid payment references it", async (t) => {
  if (!ready) return t.skip();
  const eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, 'Guarded Event', 'Male', 5) RETURNING id",
    [orgId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payments (org_id, event_id, payer_user_id, subject_type, amount_cents, currency, status)
     VALUES ($1, $2, $3, 'event_entry', 5000, 'AUD', 'paid')`,
    [orgId, eventId, userId],
  );
  const res = await api("DELETE", `/api/events/${eventId}`);
  assert.equal(res.status, 409, "should refuse deletion with paid payments");
  const body = await res.json();
  assert.ok(body.paid_count >= 1);
  // sanity check: event must still exist
  const exists = (await pool.query("SELECT id FROM events WHERE id = $1", [eventId])).rowCount;
  assert.equal(exists, 1, "event was not deleted");
});

test("event deletion retires pending checkouts, then succeeds", async (t) => {
  if (!ready) return t.skip();
  const eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, 'Pending Event', 'Male', 5) RETURNING id",
    [orgId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payments (org_id, event_id, payer_user_id, subject_type, amount_cents, currency, status, stripe_checkout_session)
     VALUES ($1, $2, $3, 'event_entry', 3000, 'AUD', 'pending', 'cs_pending_test')`,
    [orgId, eventId, userId],
  );
  const res = await api("DELETE", `/api/events/${eventId}`);
  assert.equal(res.status, 200, "deletion should succeed after retiring pending");
  const exists = (await pool.query("SELECT id FROM events WHERE id = $1", [eventId])).rowCount;
  assert.equal(exists, 0, "event should be deleted");
});

test("event deletion is refused when a pending checkout turns out to be paid (race B)", async (t) => {
  if (!ready) return t.skip();
  const eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, 'Race B Event', 'Male', 5) RETURNING id",
    [orgId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payments (org_id, event_id, payer_user_id, subject_type, amount_cents, currency, status, stripe_checkout_session)
     VALUES ($1, $2, $3, 'event_entry', 4000, 'AUD', 'pending', 'cs_raceb_event')`,
    [orgId, eventId, userId],
  );
  const prevExpire = expireCheckoutSessionImpl;
  const prevRetrieve = retrieveCheckoutSessionImpl;
  expireCheckoutSessionImpl = async () => { throw new Error("Session already completed"); };
  retrieveCheckoutSessionImpl = async () => ({ status: "complete" });
  try {
    const res = await api("DELETE", `/api/events/${eventId}`);
    assert.equal(res.status, 409, "should refuse when checkout just completed");
  } finally {
    expireCheckoutSessionImpl = prevExpire;
    retrieveCheckoutSessionImpl = prevRetrieve;
  }
  const exists = (await pool.query("SELECT id FROM events WHERE id = $1", [eventId])).rowCount;
  assert.equal(exists, 1, "event must survive");
});

test("event deletion without payments proceeds normally", async (t) => {
  if (!ready) return t.skip();
  const eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, 'Clean Event', 'Male', 5) RETURNING id",
    [orgId],
  )).rows[0].id;
  const res = await api("DELETE", `/api/events/${eventId}`);
  assert.equal(res.status, 200);
  const exists = (await pool.query("SELECT id FROM events WHERE id = $1", [eventId])).rowCount;
  assert.equal(exists, 0);
});

// ── Meet deletion guards ──────────────────────────────────────────

test("meet deletion is blocked when a paid payment references the meet", async (t) => {
  if (!ready) return t.skip();
  const meetId = (await pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, 'Guarded Meet') RETURNING id",
    [orgId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payments (org_id, meet_id, payer_user_id, subject_type, amount_cents, currency, status)
     VALUES ($1, $2, $3, 'meet_bundle', 10000, 'AUD', 'paid')`,
    [orgId, meetId, userId],
  );
  const res = await api("DELETE", `/api/meets/${meetId}`);
  assert.equal(res.status, 409);
  const exists = (await pool.query("SELECT id FROM meets WHERE id = $1", [meetId])).rowCount;
  assert.equal(exists, 1);
});

test("meet deletion is blocked by payments on child events", async (t) => {
  if (!ready) return t.skip();
  const meetId = (await pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, 'Parent Meet') RETURNING id",
    [orgId],
  )).rows[0].id;
  const eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges, meet_id) VALUES ($1, 'Child Event', 'Male', 5, $2) RETURNING id",
    [orgId, meetId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payments (org_id, event_id, payer_user_id, subject_type, amount_cents, currency, status)
     VALUES ($1, $2, $3, 'event_entry', 5000, 'AUD', 'paid')`,
    [orgId, eventId, userId],
  );
  const res = await api("DELETE", `/api/meets/${meetId}`);
  assert.equal(res.status, 409, "meet with paid child-event payments must be refused");
  const exists = (await pool.query("SELECT id FROM meets WHERE id = $1", [meetId])).rowCount;
  assert.equal(exists, 1);
});

test("meet deletion retires pending checkouts and succeeds", async (t) => {
  if (!ready) return t.skip();
  const meetId = (await pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, 'Pending Meet') RETURNING id",
    [orgId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payments (org_id, meet_id, payer_user_id, subject_type, amount_cents, currency, status, stripe_checkout_session)
     VALUES ($1, $2, $3, 'spectator_ticket', 2000, 'AUD', 'pending', 'cs_meet_pending')`,
    [orgId, meetId, userId],
  );
  const res = await api("DELETE", `/api/meets/${meetId}`);
  assert.equal(res.status, 200);
  const exists = (await pool.query("SELECT id FROM meets WHERE id = $1", [meetId])).rowCount;
  assert.equal(exists, 0);
});

test("meet deletion without payments proceeds normally", async (t) => {
  if (!ready) return t.skip();
  const meetId = (await pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, 'Clean Meet') RETURNING id",
    [orgId],
  )).rows[0].id;
  const res = await api("DELETE", `/api/meets/${meetId}`);
  assert.equal(res.status, 200);
  const exists = (await pool.query("SELECT id FROM meets WHERE id = $1", [meetId])).rowCount;
  assert.equal(exists, 0);
});

// ── stripe_charge_id backfill ─────────────────────────────────────

test("checkout.session.completed backfills stripe_charge_id from the PaymentIntent", async (t) => {
  if (!ready) return t.skip();
  const eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, 'Charge ID Event', 'Male', 5) RETURNING id",
    [orgId],
  )).rows[0].id;
  const paymentId = (await pool.query(
    `INSERT INTO payments (org_id, event_id, payer_user_id, subject_type, amount_cents, currency, status)
     VALUES ($1, $2, $3, 'event_entry', 5000, 'AUD', 'pending') RETURNING id`,
    [orgId, eventId, userId],
  )).rows[0].id;
  const chargeId = "ch_backfill_" + crypto.randomUUID().slice(0, 8);
  const prevRetrievePI = retrievePaymentIntentImpl;
  retrievePaymentIntentImpl = async () => ({ id: "pi_test", latest_charge: chargeId });
  try {
    await api("POST", "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_charge_test", client_reference_id: paymentId, payment_intent: "pi_test", payment_status: "paid" } },
    });
  } finally {
    retrievePaymentIntentImpl = prevRetrievePI;
  }
  const row = (await pool.query("SELECT stripe_charge_id, status FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(row.status, "paid");
  assert.equal(row.stripe_charge_id, chargeId, "charge ID should be backfilled");
});

test("stripe_charge_id backfill failure does not block payment fulfilment", async (t) => {
  if (!ready) return t.skip();
  const eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, 'Charge Fail Event', 'Male', 5) RETURNING id",
    [orgId],
  )).rows[0].id;
  const paymentId = (await pool.query(
    `INSERT INTO payments (org_id, event_id, payer_user_id, subject_type, amount_cents, currency, status)
     VALUES ($1, $2, $3, 'event_entry', 6000, 'AUD', 'pending') RETURNING id`,
    [orgId, eventId, userId],
  )).rows[0].id;
  const prevRetrievePI = retrievePaymentIntentImpl;
  retrievePaymentIntentImpl = async () => { throw new Error("Stripe unreachable"); };
  try {
    const res = await api("POST", "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_charge_fail", client_reference_id: paymentId, payment_intent: "pi_fail", payment_status: "paid" } },
    });
    assert.equal(res.status, 200, "webhook should still succeed");
  } finally {
    retrievePaymentIntentImpl = prevRetrievePI;
  }
  const row = (await pool.query("SELECT status, stripe_charge_id FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(row.status, "paid", "payment should still be marked paid");
  assert.equal(row.stripe_charge_id, null, "charge ID stays null on failure");
});
