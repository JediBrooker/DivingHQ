// Integration tests for guardian/dependent relationships (migration 083)
// and guardian-aware payment checkout. Self-skips when Postgres isn't
// reachable, or when migration 083 hasn't been applied yet.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const createUsersRouter = require("../routes/users");
const createPaymentsRouter = require("../routes/payments");
const createStripeWebhook = require("../routes/stripe-webhook");

const silentLogger = { warn() {}, error() {}, info() {} };
const suffix = crypto.randomUUID().slice(0, 8);

let pool;
let ready = false;
let server;
let base;
let orgId;
let guardianUserId;
let minorUserId;
let adultUserId;
let eventId;

// Fake Stripe
let lastCheckoutArgs = null;
const fakePayments = {
  enabled: true,
  createConnectedAccount: async () => ({ id: "acct_test" }),
  createOnboardingLink: async () => ({ url: "https://stripe.test/onboard" }),
  retrieveAccount: async () => ({
    configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } },
  }),
  createCheckoutSession: async (args) => {
    lastCheckoutArgs = args;
    return {
      id: ("cs_test_" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")).slice(0, 66),
      url: "https://stripe.test/pay",
    };
  },
  expireCheckoutSession: async () => ({ status: "expired" }),
  retrieveCheckoutSession: async () => ({ id: "cs_test", status: "open", url: "https://stripe.test/resume" }),
  createRefund: async () => ({ amount: 0 }),
  createRecipientAccount: async () => ({ id: "acct_test_r" }),
  createTransfer: async () => ({ id: "tr_test" }),
  retrieveAccountStatus: async () => ({ payoutsEnabled: true, capabilityStatus: "active", requirementsCollected: true }),
  constructWebhookEvent: (raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : raw),
};
const fakeEmail = { sendPayoutFailedEmail() {} };

// heads up: tests swap this out to simulate different callers
let actingUser;

function buildApp() {
  const setUser = (req, _res, next) => {
    req.user = { ...actingUser };
    next();
  };
  const verifyToken = setUser;
  const optionalAuth = setUser;
  const requireOrgRole = () => setUser;
  const requireOrgAdmin = setUser;
  const requireEventManager = () => async (req, res, next) => {
    req.user = { ...actingUser };
    const r = await pool.query("SELECT id, org_id FROM events WHERE id = $1", [req.params.id]);
    req.event = r.rows[0];
    next();
  };
  const requireMeetEditor = setUser;
  const requireClubAdmin = () => setUser;
  const requireSystemAdmin = setUser;

  const app = express();
  app.use((req, res, next) =>
    req.path === "/webhooks/stripe" ? next() : express.json()(req, res, next));
  app.use(createUsersRouter({
    pool, verifyToken, requireOrgAdmin, requireMeetEditor,
    bumpTokenVersion: () => {},
    sendRoleDecisionEmail: () => {},
    bulkWriteLimiter: (_req, _res, next) => next(),
    sendVerifyEmailEmail: () => {},
    sendPasswordResetEmail: () => {},
    hashFingerprint: (fp) => fp,
    JWT_SECRET: "test-secret",
  }));
  app.use(createPaymentsRouter({
    pool, verifyToken, optionalAuth, requireOrgRole, requireEventManager,
    requireMeetEditor, requireClubAdmin, requireSystemAdmin,
    logger: silentLogger, payments: fakePayments, email: fakeEmail,
  }));
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }),
    createStripeWebhook({ pool, logger: silentLogger, payments: fakePayments }));
  return app;
}

const api = (method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
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
    const r = await pool.query("SELECT to_regclass('public.guardians') AS t");
    if (!r.rows[0].t) { console.warn("[skip] guardians table missing — apply migration 083"); return; }
  } catch (err) {
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  orgId = (await pool.query(
    `INSERT INTO organisations (name, slug, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled)
     VALUES ($1, $2, 'GBP', 1500, $3, true) RETURNING id`,
    [`Guardian Fed ${suffix}`, `guardian-fed-${suffix}`, `acct_guardian_${suffix}`],
  )).rows[0].id;

  // minor, born 10 years ago
  const minorDob = new Date();
  minorDob.setFullYear(minorDob.getFullYear() - 10);
  minorUserId = (await pool.query(
    "INSERT INTO users (username, full_name, org_id, date_of_birth) VALUES ($1, $2, $3, $4) RETURNING id",
    [`minor-${suffix}`, "Test Minor", orgId, minorDob.toISOString().slice(0, 10)],
  )).rows[0].id;

  // Guardian (parent)
  guardianUserId = (await pool.query(
    "INSERT INTO users (username, full_name, org_id) VALUES ($1, $2, $3) RETURNING id",
    [`guardian-${suffix}`, "Test Guardian", orgId],
  )).rows[0].id;

  // Adult (over 18, for rejection test)
  const adultDob = new Date();
  adultDob.setFullYear(adultDob.getFullYear() - 25);
  adultUserId = (await pool.query(
    "INSERT INTO users (username, full_name, org_id, date_of_birth) VALUES ($1, $2, $3, $4) RETURNING id",
    [`adult-${suffix}`, "Test Adult", orgId, adultDob.toISOString().slice(0, 10)],
  )).rows[0].id;

  eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, '10m Platform', 'Male', 5) RETURNING id",
    [orgId],
  )).rows[0].id;

  actingUser = {
    id: guardianUserId,
    org_id: orgId,
    org_roles: ["org_admin", "diver"],
    is_system_admin: false,
    email: "guardian@test.local",
  };

  server = http.createServer(buildApp());
  await new Promise((res) => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
  ready = true;
});

after(async () => {
  if (server) await new Promise((res) => server.close(res));
  if (orgId) {
    await pool.query("DELETE FROM payments WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM guardians WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM memberships WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM fee_prices WHERE fee_definition_id IN (SELECT id FROM fee_definitions WHERE org_id = $1)", [orgId]).catch(() => {});
    await pool.query("DELETE FROM fee_definitions WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM events WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]).catch(() => {});
  }
  if (pool) await pool.end();
});

// === Guardian CRUD ===

test("POST /api/guardians/request rejects self-link", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", "/api/guardians/request", { dependent_user_id: guardianUserId });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /yourself/i);
});

test("POST /api/guardians/request rejects adults", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", "/api/guardians/request", { dependent_user_id: adultUserId });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /under 18/i);
});

let guardianLinkId;

test("POST /api/guardians/request creates a pending link for a minor", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", "/api/guardians/request", { dependent_user_id: minorUserId });
  assert.equal(r.status, 201);

  const row = (await pool.query(
    "SELECT * FROM guardians WHERE guardian_user_id = $1 AND dependent_user_id = $2",
    [guardianUserId, minorUserId],
  )).rows[0];
  assert.ok(row);
  assert.equal(row.status, "pending");
  guardianLinkId = row.id;
});

test("POST /api/guardians/request rejects duplicate pending link", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", "/api/guardians/request", { dependent_user_id: minorUserId });
  assert.equal(r.status, 409);
});

test("GET /api/guardian-requests lists pending for org admin", async (t) => {
  if (!ready) return t.skip();
  const r = await api("GET", "/api/guardian-requests");
  assert.equal(r.status, 200);
  const rows = await r.json();
  assert.ok(Array.isArray(rows));
  const found = rows.find((g) => g.id === guardianLinkId);
  assert.ok(found);
  assert.equal(found.guardian_name, "Test Guardian");
  assert.equal(found.dependent_name, "Test Minor");
});

test("GET /api/guardians/my-dependents returns nothing while pending", async (t) => {
  if (!ready) return t.skip();
  const r = await api("GET", "/api/guardians/my-dependents");
  assert.equal(r.status, 200);
  const rows = await r.json();
  assert.equal(rows.filter((d) => d.id === minorUserId).length, 0);
});

test("POST /api/guardian-requests/:id/review approves the link", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", `/api/guardian-requests/${guardianLinkId}/review`, { decision: "approved" });
  assert.equal(r.status, 200);

  const row = (await pool.query("SELECT status FROM guardians WHERE id = $1", [guardianLinkId])).rows[0];
  assert.equal(row.status, "approved");
});

test("GET /api/guardians/my-dependents returns approved minor", async (t) => {
  if (!ready) return t.skip();
  const r = await api("GET", "/api/guardians/my-dependents");
  assert.equal(r.status, 200);
  const rows = await r.json();
  const dep = rows.find((d) => d.id === minorUserId);
  assert.ok(dep, "minor should appear in dependents");
  assert.equal(dep.full_name, "Test Minor");
  assert.ok(dep.guardian_link_id);
});

// === Guardian-aware checkout ===

test("set up event entry fee for guardian checkout tests", async (t) => {
  if (!ready) return t.skip();
  const r = await api("PUT", `/api/events/${eventId}/fee`, {
    currency: "GBP",
    prices: [{ label: "standard", amount_cents: 2000, audience: "all" }],
  });
  assert.equal(r.status, 200);
});

test("event checkout with subject_user_id for approved dependent succeeds", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", `/api/events/${eventId}/checkout`, { subject_user_id: minorUserId });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.url, "should return Stripe checkout URL");

  // sanity check that the payment row has subject_user_id set
  if (body.payment_id) {
    const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [body.payment_id])).rows[0];
    assert.equal(row.payer_user_id, guardianUserId, "payer should be guardian");
    assert.equal(row.subject_user_id, minorUserId, "subject should be minor");
  }
});

test("event checkout with subject_user_id for non-dependent is rejected", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", `/api/events/${eventId}/checkout`, { subject_user_id: adultUserId });
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.match(body.error, /not.*guardian|approved/i);
});

// === Revoke ===

test("POST /api/guardians/:id/revoke by guardian succeeds", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", `/api/guardians/${guardianLinkId}/revoke`);
  assert.equal(r.status, 200);

  const row = (await pool.query("SELECT status FROM guardians WHERE id = $1", [guardianLinkId])).rows[0];
  assert.equal(row.status, "revoked");
});

test("checkout for revoked guardian is rejected", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", `/api/events/${eventId}/checkout`, { subject_user_id: minorUserId });
  assert.equal(r.status, 403);
});
