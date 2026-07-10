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
const createClubChangesRouter = require("../routes/club-changes");

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
  app.use(createClubChangesRouter({ pool, verifyToken }));
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
    // payments first: its org_id / payer_user_id FKs are ON DELETE
    // RESTRICT, so nothing else drops while a payment row points at it.
    await pool.query("DELETE FROM payments WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM fines WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM entry_charges WHERE org_id = $1", [orgId]).catch(() => {});
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

// === Guardian pays a dependent's charges and fines ===
//
// A parent who registers only to pay for their child is a 'spectator',
// because that's the single role routes/auth.js grants on sign-up. None
// of these endpoints may depend on holding a diver role.

let minorFineId;
let minorChargeId;
let guardianFineId;
let scratchFeeId;

test("seed a fine and an entry charge against the minor", async (t) => {
  if (!ready) return t.skip();

  minorFineId = (await pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, event_id, amount_cents, currency, reason, status)
     VALUES ($1, $2, $3, $4, 5000, 'GBP', 'Late to the briefing', 'owed') RETURNING id`,
    [orgId, minorUserId, guardianUserId, eventId],
  )).rows[0].id;

  // A fine the guardian owes in their own right, so we can prove the
  // payer/liable split didn't break paying for yourself.
  guardianFineId = (await pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, event_id, amount_cents, currency, reason, status)
     VALUES ($1, $2, $2, $3, 1500, 'GBP', 'Parked in the officials bay', 'owed') RETURNING id`,
    [orgId, guardianUserId, eventId],
  )).rows[0].id;

  scratchFeeId = (await pool.query(
    `INSERT INTO fee_definitions (org_id, scope, name, currency, fee_payer, refund_policy, active, event_id)
     VALUES ($1, 'scratch', 'Late scratch', 'GBP', 'absorb', 'none', true, $2) RETURNING id`,
    [orgId, eventId],
  )).rows[0].id;

  minorChargeId = (await pool.query(
    `INSERT INTO entry_charges (org_id, event_id, entrant_user_id, kind, fee_definition_id, amount_cents, status)
     VALUES ($1, $2, $3, 'scratch', $4, 2500, 'owed') RETURNING id`,
    [orgId, eventId, minorUserId, scratchFeeId],
  )).rows[0].id;

  assert.ok(minorFineId && minorChargeId && guardianFineId);
});

test("GET /api/me/charges?subject_user_id returns the dependent's charges", async (t) => {
  if (!ready) return t.skip();
  const r = await api("GET", `/api/me/charges?subject_user_id=${minorUserId}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.charges.length, 1);
  assert.equal(body.charges[0].id, minorChargeId);
});

test("GET /api/me/charges without a subject still returns only my own", async (t) => {
  if (!ready) return t.skip();
  const r = await api("GET", "/api/me/charges");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.charges.filter((c) => c.id === minorChargeId).length, 0);
});

test("GET /api/me/fines?subject_user_id returns the dependent's fines", async (t) => {
  if (!ready) return t.skip();
  const r = await api("GET", `/api/me/fines?subject_user_id=${minorUserId}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.fines.some((f) => f.id === minorFineId));
  assert.ok(!body.fines.some((f) => f.id === guardianFineId), "must not leak my own fines into the dependent view");
});

test("reading a non-dependent's charges is refused", async (t) => {
  if (!ready) return t.skip();
  const r = await api("GET", `/api/me/charges?subject_user_id=${adultUserId}`);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /guardian/i);
});

test("a malformed subject_user_id is a 403, not a 500", async (t) => {
  if (!ready) return t.skip();
  for (const bad of ["not-a-uuid", "1; DROP TABLE users", ""]) {
    const r = await api("GET", `/api/me/fines?subject_user_id=${encodeURIComponent(bad)}`);
    // An empty value means "no subject", so that one falls through to self.
    assert.equal(r.status, bad === "" ? 200 : 403, `subject_user_id=${bad}`);
  }
});

test("guardian pays the dependent's fine; ledger splits payer from liable", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", `/api/fines/${minorFineId}/checkout`, {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.url);

  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [body.payment_id])).rows[0];
  assert.equal(row.payer_user_id, guardianUserId, "guardian paid");
  assert.equal(row.liable_user_id, minorUserId, "minor owed it");
  assert.equal(row.subject_user_id, minorUserId, "paid on the minor's behalf");
});

test("guardian pays the dependent's entry charge", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", `/api/entry-charges/${minorChargeId}/checkout`, {});
  assert.equal(r.status, 200);
  const body = await r.json();

  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [body.payment_id])).rows[0];
  assert.equal(row.payer_user_id, guardianUserId);
  assert.equal(row.liable_user_id, minorUserId);
  assert.equal(row.subject_user_id, minorUserId);
});

test("paying your own fine leaves subject_user_id null", async (t) => {
  if (!ready) return t.skip();
  const r = await api("POST", `/api/fines/${guardianFineId}/checkout`, {});
  assert.equal(r.status, 200);
  const body = await r.json();

  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [body.payment_id])).rows[0];
  assert.equal(row.payer_user_id, guardianUserId);
  assert.equal(row.liable_user_id, guardianUserId);
  assert.equal(row.subject_user_id, null, "not acting on anyone's behalf");
});

test("a stranger cannot pay someone else's fine", async (t) => {
  if (!ready) return t.skip();
  const previous = actingUser;
  actingUser = { ...previous, id: adultUserId, org_roles: ["diver"] };
  try {
    const fresh = (await pool.query(
      `INSERT INTO fines (org_id, liable_user_id, issued_by, event_id, amount_cents, currency, reason, status)
       VALUES ($1, $2, $3, $4, 900, 'GBP', 'Unrelated', 'owed') RETURNING id`,
      [orgId, minorUserId, guardianUserId, eventId],
    )).rows[0].id;
    const r = await api("POST", `/api/fines/${fresh}/checkout`, {});
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /guardian/i);
  } finally {
    actingUser = previous;
  }
});

test("a spectator-only guardian can still read and pay for their dependent", async (t) => {
  if (!ready) return t.skip();
  // The role registration actually hands out. Nothing in the payment
  // path may require 'diver'.
  const previous = actingUser;
  actingUser = { ...previous, org_roles: ["spectator"] };
  try {
    const read = await api("GET", `/api/me/charges?subject_user_id=${minorUserId}`);
    assert.equal(read.status, 200);

    const fresh = (await pool.query(
      `INSERT INTO entry_charges (org_id, event_id, entrant_user_id, kind, fee_definition_id, amount_cents, status)
       VALUES ($1, $2, $3, 'no_show', $4, 800, 'owed') RETURNING id`,
      [orgId, eventId, minorUserId, scratchFeeId],
    )).rows[0].id;
    const pay = await api("POST", `/api/entry-charges/${fresh}/checkout`, {});
    assert.equal(pay.status, 200, "a spectator guardian must be able to pay");
  } finally {
    actingUser = previous;
  }
});

// === Two bugs this change introduced, found in review, now closed ===

test("guardian cannot resume a payment the dependent already started", async (t) => {
  if (!ready) return t.skip();

  const fineId = (await pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, event_id, amount_cents, currency, reason, status)
     VALUES ($1, $2, $3, $4, 4200, 'GBP', 'Contested slot', 'owed') RETURNING id`,
    [orgId, minorUserId, guardianUserId, eventId],
  )).rows[0].id;

  // The dependent starts their own checkout, then wanders off.
  const previous = actingUser;
  actingUser = { ...previous, id: minorUserId, org_roles: ["diver"] };
  let minorPaymentId;
  try {
    const r = await api("POST", `/api/fines/${fineId}/checkout`, {});
    assert.equal(r.status, 200);
    minorPaymentId = (await r.json()).payment_id;
  } finally {
    actingUser = previous;
  }
  assert.equal(
    (await pool.query("SELECT payer_user_id FROM payments WHERE id = $1", [minorPaymentId])).rows[0].payer_user_id,
    minorUserId,
  );

  // The guardian now pays. They must NOT be handed the dependent's open
  // Stripe session: the ledger would credit the dependent for money that
  // came off the guardian's card.
  const r2 = await api("POST", `/api/fines/${fineId}/checkout`, {});
  assert.equal(r2.status, 200);
  const guardianPaymentId = (await r2.json()).payment_id;
  assert.notEqual(guardianPaymentId, minorPaymentId, "expected a fresh payment row, not a resume");

  const fresh = (await pool.query(
    "SELECT payer_user_id, liable_user_id, subject_user_id FROM payments WHERE id = $1",
    [guardianPaymentId],
  )).rows[0];
  assert.equal(fresh.payer_user_id, guardianUserId);
  assert.equal(fresh.liable_user_id, minorUserId);
  assert.equal(fresh.subject_user_id, minorUserId);

  // And the dependent's abandoned attempt was retired, not left live.
  assert.equal(
    (await pool.query("SELECT status FROM payments WHERE id = $1", [minorPaymentId])).rows[0].status,
    "failed",
  );
});

test("guardian authority does not follow a dependent across federations", async (t) => {
  if (!ready) return t.skip();

  const otherOrgId = (await pool.query(
    "INSERT INTO organisations (name, slug, default_currency) VALUES ($1, $2, 'GBP') RETURNING id",
    [`Other Fed ${suffix}`, `other-fed-${suffix}`],
  )).rows[0].id;
  const otherEventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, '3m', 'Male', 5) RETURNING id",
    [otherOrgId],
  )).rows[0].id;

  // The dependent transferred out. routes/club-changes.js moves
  // users.org_id and never touches the guardians row, so the approved
  // link stays pinned to the guardian's federation.
  const foreignFineId = (await pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, event_id, amount_cents, currency, reason, status)
     VALUES ($1, $2, $2, $3, 700, 'GBP', 'Fined by the new federation', 'owed') RETURNING id`,
    [otherOrgId, minorUserId, otherEventId],
  )).rows[0].id;

  try {
    const read = await api("GET", `/api/me/fines?subject_user_id=${minorUserId}`);
    assert.equal(read.status, 200);
    const body = await read.json();
    assert.ok(
      !body.fines.some((f) => f.id === foreignFineId),
      "a guardian must not see a dependent's fines from another federation",
    );

    const pay = await api("POST", `/api/fines/${foreignFineId}/checkout`, {});
    assert.equal(pay.status, 403, "nor pay them");
  } finally {
    await pool.query("DELETE FROM payments WHERE org_id = $1", [otherOrgId]).catch(() => {});
    await pool.query("DELETE FROM fines WHERE org_id = $1", [otherOrgId]).catch(() => {});
    await pool.query("DELETE FROM events WHERE org_id = $1", [otherOrgId]).catch(() => {});
    await pool.query("DELETE FROM organisations WHERE id = $1", [otherOrgId]).catch(() => {});
  }
});

test("your own cross-federation fines stay visible after a transfer", async (t) => {
  if (!ready) return t.skip();
  // The org clamp applies only to a dependent's list. A diver who moves
  // federations still owes the old one and must be able to settle up.
  const oldOrgId = (await pool.query(
    "INSERT INTO organisations (name, slug, default_currency) VALUES ($1, $2, 'GBP') RETURNING id",
    [`Old Fed ${suffix}`, `old-fed-${suffix}`],
  )).rows[0].id;
  const oldFineId = (await pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, amount_cents, currency, reason, status)
     VALUES ($1, $2, $2, 1100, 'GBP', 'Owed to my former federation', 'owed') RETURNING id`,
    [oldOrgId, guardianUserId],
  )).rows[0].id;
  try {
    const r = await api("GET", "/api/me/fines");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.fines.some((f) => f.id === oldFineId), "must still see my own old-federation fine");
  } finally {
    await pool.query("DELETE FROM fines WHERE org_id = $1", [oldOrgId]).catch(() => {});
    await pool.query("DELETE FROM organisations WHERE id = $1", [oldOrgId]).catch(() => {});
  }
});

// === Guardian links vs federation transfers ===

test("my-dependents lists only dependents inside my own federation", async (t) => {
  if (!ready) return t.skip();

  const otherOrgId = (await pool.query(
    "INSERT INTO organisations (name, slug, default_currency) VALUES ($1, $2, 'GBP') RETURNING id",
    [`Foreign Fed ${suffix}`, `foreign-fed-${suffix}`],
  )).rows[0].id;
  const dob = new Date();
  dob.setFullYear(dob.getFullYear() - 9);
  const foreignMinor = (await pool.query(
    "INSERT INTO users (username, full_name, org_id, date_of_birth) VALUES ($1, $2, $3, $4) RETURNING id",
    [`foreign-minor-${suffix}`, "Foreign Minor", otherOrgId, dob.toISOString().slice(0, 10)],
  )).rows[0].id;
  // An approved link, but pinned to a federation the guardian has no
  // standing in. Exactly the shape an old org transfer used to leave behind.
  await pool.query(
    `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status, reviewed_at)
     VALUES ($1, $2, $3, 'approved', now())`,
    [otherOrgId, guardianUserId, foreignMinor],
  );

  try {
    const r = await api("GET", "/api/guardians/my-dependents");
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.ok(rows.some((d) => d.id === minorUserId), "my own federation's dependent is still listed");
    assert.ok(
      !rows.some((d) => d.id === foreignMinor),
      "a dependent in another federation must not appear in the Paying for picker",
    );
  } finally {
    await pool.query("DELETE FROM guardians WHERE org_id = $1", [otherOrgId]).catch(() => {});
    await pool.query("DELETE FROM users WHERE org_id = $1", [otherOrgId]).catch(() => {});
    await pool.query("DELETE FROM organisations WHERE id = $1", [otherOrgId]).catch(() => {});
  }
});

test("an approved org transfer revokes the guardian links the mover leaves behind", async (t) => {
  if (!ready) return t.skip();

  // A second minor, linked to our guardian, in our own federation.
  const dob = new Date();
  dob.setFullYear(dob.getFullYear() - 11);
  const mover = (await pool.query(
    "INSERT INTO users (username, full_name, org_id, date_of_birth) VALUES ($1, $2, $3, $4) RETURNING id",
    [`mover-${suffix}`, "Mover Minor", orgId, dob.toISOString().slice(0, 10)],
  )).rows[0].id;
  const linkId = (await pool.query(
    `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status, reviewed_at)
     VALUES ($1, $2, $3, 'approved', now()) RETURNING id`,
    [orgId, guardianUserId, mover],
  )).rows[0].id;

  const targetOrgId = (await pool.query(
    "INSERT INTO organisations (name, slug, default_currency) VALUES ($1, $2, 'GBP') RETURNING id",
    [`Target Fed ${suffix}`, `target-fed-${suffix}`],
  )).rows[0].id;

  const previous = actingUser;
  try {
    // The picker sees them before the move.
    const before = await (await api("GET", "/api/guardians/my-dependents")).json();
    assert.ok(before.some((d) => d.id === mover), "linked before the transfer");

    // Diver opens the request themselves; that stamps diver_confirmed_at.
    actingUser = { ...previous, id: mover, org_id: orgId, org_roles: ["diver"] };
    const create = await api("POST", "/api/club-change-requests", { to_org_id: targetOrgId });
    assert.equal(create.status, 201, JSON.stringify(await create.clone().json()));
    const requestId = (await create.json()).id;

    // Source federation releases them.
    actingUser = { ...previous, id: guardianUserId, org_id: orgId, org_roles: ["org_admin"] };
    const src = await api("POST", `/api/club-change-requests/${requestId}/review`, { decision: "approved" });
    assert.equal(src.status, 200);

    // Receiving federation accepts them; that completes the handshake.
    actingUser = { ...previous, id: guardianUserId, org_id: targetOrgId, org_roles: ["org_admin"] };
    const tgt = await api("POST", `/api/club-change-requests/${requestId}/review`, { decision: "approved" });
    assert.equal(tgt.status, 200);
    assert.equal((await tgt.json()).finalised, true, "the transfer should have finalised");

    // The user really moved...
    const moved = (await pool.query("SELECT org_id FROM users WHERE id = $1", [mover])).rows[0];
    assert.equal(moved.org_id, targetOrgId);

    // ...and the guardian link they left behind is closed, not stranded.
    const link = (await pool.query("SELECT status FROM guardians WHERE id = $1", [linkId])).rows[0];
    assert.equal(link.status, "revoked");

    actingUser = previous;
    const after = await (await api("GET", "/api/guardians/my-dependents")).json();
    assert.ok(!after.some((d) => d.id === mover), "gone from the picker once the link is revoked");
    assert.ok(after.some((d) => d.id === minorUserId), "the untouched dependent survives");

    // And the guardian was told, rather than silently losing access.
    const notes = await pool.query(
      "SELECT title FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
      [guardianUserId],
    ).catch(() => ({ rows: [] }));
    if (notes.rows.length) {
      assert.ok(
        notes.rows.some((n) => /guardian link was ended/i.test(n.title)),
        "the guardian gets a notification",
      );
    }
  } finally {
    actingUser = previous;
    await pool.query("DELETE FROM club_change_requests WHERE user_id = $1", [mover]).catch(() => {});
    await pool.query("DELETE FROM guardians WHERE dependent_user_id = $1", [mover]).catch(() => {});
    await pool.query("DELETE FROM user_org_roles WHERE user_id = $1", [mover]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [mover]).catch(() => {});
    await pool.query("DELETE FROM organisations WHERE id = $1", [targetOrgId]).catch(() => {});
  }
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
