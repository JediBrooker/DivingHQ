// Integration tests for the Stripe Connect payment flow (routes +
// webhook) against a real Postgres (Migration 066). A FAKE Stripe is
// injected so no network/keys are needed — we're testing OUR money
// logic + DB transitions, not Stripe's API.
//
// Self-skips when Postgres is unreachable or Migration 066 hasn't been
// applied, mirroring the other *.integration.test.js files. Seeds its
// own org/event/user with unique slugs and tears them down after.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const createPaymentsRouter = require("../routes/payments");
const createStripeWebhook = require("../routes/stripe-webhook");

const silentLogger = { warn() {}, error() {}, info() {} };
const suffix = crypto.randomUUID().slice(0, 8);

let pool;
let ready = false;
let server;
let base;
let orgId;
let userId;
let eventId;
let clubId;
let meetId;
let lateEventId;
let lastRefundArgs = null;
let lastExpireArgs = null;

// Fake Stripe — captures args, returns canned objects.
const fakePayments = {
  enabled: true,
  createConnectedAccount: async () => ({ id: "acct_test" }),
  createOnboardingLink: async () => ({ url: "https://stripe.test/onboard" }),
  retrieveAccount: async () => ({
    configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } },
  }),
  createCheckoutSession: async () => ({ id: "cs_" + crypto.randomUUID().slice(0, 8), url: "https://stripe.test/pay" }),
  expireCheckoutSession: async (args) => { lastExpireArgs = args; return { status: "expired" }; },
  createRefund: async (args) => { lastRefundArgs = args; return { amount: args.amountCents }; },
  // Tests POST a JSON body; treat it as the already-verified event.
  constructWebhookEvent: (raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : raw),
};

// Stub auth: every request acts as our seeded user, who holds the roles
// the routes require. requireEventManager loads req.event like the real
// gate does.
function buildApp() {
  const TEST_USER = () => ({
    id: userId, org_id: orgId,
    org_roles: ["org_admin", "meet_manager", "diver"],
    is_system_admin: false, email: "diver@test.local",
  });
  const setUser = (req, _res, next) => { req.user = TEST_USER(); next(); };
  const verifyToken = setUser;
  const optionalAuth = setUser;
  const requireOrgRole = () => setUser;
  const requireEventManager = () => async (req, res, next) => {
    req.user = TEST_USER();
    const r = await pool.query("SELECT id, org_id FROM events WHERE id = $1", [req.params.id || req.body.eventId]);
    req.event = r.rows[0];
    next();
  };
  // Meet-fee endpoints (Phase 1b) gate on requireMeetEditor — in prod an
  // array guard, here a passthrough that sets req.user. Must be a real
  // function or Express throws "argument handler must be a function" when
  // the router registers the route (the bug that broke CI on PR #83).
  const requireMeetEditor = setUser;
  // Club-payer endpoints (affiliation/accreditation) gate on
  // requireClubAdmin — stash req.club like the real guard so handlers can
  // read req.club.org_id.
  const requireClubAdmin = () => async (req, res, next) => {
    req.user = TEST_USER();
    const r = await pool.query("SELECT id, org_id FROM clubs WHERE id = $1", [req.params.id || req.body.clubId]);
    req.club = r.rows[0];
    next();
  };

  const app = express();
  app.use((req, res, next) =>
    req.path === "/webhooks/stripe" ? next() : express.json()(req, res, next));
  app.use(createPaymentsRouter({
    pool, verifyToken, optionalAuth, requireOrgRole, requireEventManager, requireMeetEditor, requireClubAdmin,
    logger: silentLogger, payments: fakePayments,
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
    if (!r.rows[0].t) { console.warn("[skip] payments table missing — apply migration 066"); return; }
  } catch (err) {
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  orgId = (await pool.query(
    `INSERT INTO organisations (name, slug, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled)
     VALUES ($1, $2, 'GBP', 1500, 'acct_test', true) RETURNING id`,
    [`Test Fed ${suffix}`, `test-fed-${suffix}`],
  )).rows[0].id;
  userId = (await pool.query(
    "INSERT INTO users (username, full_name, org_id) VALUES ($1, $2, $3) RETURNING id",
    [`diver-${suffix}`, "Test Diver", orgId],
  )).rows[0].id;
  eventId = (await pool.query(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, '10m Platform', 'Male', 5) RETURNING id",
    [orgId],
  )).rows[0].id;
  clubId = (await pool.query(
    "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, $2, 'TC') RETURNING id",
    [orgId, `Test Club ${suffix}`],
  )).rows[0].id;
  meetId = (await pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, $2) RETURNING id",
    [orgId, `Test Meet ${suffix}`],
  )).rows[0].id;
  // Separate event for late-fee tests; deadline starts in the future so the
  // surcharge is dormant, then a test moves it into the past.
  lateEventId = (await pool.query(
    `INSERT INTO events (org_id, name, gender, number_of_judges, entries_close_at)
     VALUES ($1, '3m Springboard (late-test)', 'Female', 5, now() + interval '1 day') RETURNING id`,
    [orgId],
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
    await pool.query("DELETE FROM club_affiliations WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM official_accreditations WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM memberships WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM fee_prices WHERE fee_definition_id IN (SELECT id FROM fee_definitions WHERE org_id = $1)", [orgId]);
    await pool.query("DELETE FROM fee_definitions WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM meets WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM events WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]);
  }
  if (pool) await pool.end();
});

test("federation sets an entry fee with member + standard variants", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/events/${eventId}/fee`, {
    currency: "GBP",
    prices: [
      { label: "standard", amount_cents: 5000, audience: "all" },
      { label: "member", amount_cents: 3500, audience: "member" },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.id);
});

test("a non-member sees the standard £50 price", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/events/${eventId}/fee`);
  const body = await res.json();
  assert.equal(body.fee.is_member, false);
  assert.equal(body.fee.price.amount_cents, 5000);
  assert.equal(body.fee.currency, "GBP");
});

let paymentId;
test("checkout records a pending payment with the 15% application fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/events/${eventId}/checkout`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.url);
  paymentId = body.payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(row.status, "pending");
  assert.equal(row.amount_cents, 5000);
  assert.equal(row.platform_fee_cents, 750);
  assert.equal(row.subject_type, "event_entry");
});

test("a second checkout for the same event is blocked while one is live", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/events/${eventId}/checkout`, {});
  assert.equal(res.status, 409);
});

test("webhook marks the payment paid, and is idempotent on re-delivery", async (t) => {
  if (!ready) return t.skip();
  const event = {
    type: "checkout.session.completed",
    data: { object: { id: "cs_done", client_reference_id: paymentId, payment_intent: "pi_done" } },
  };
  const first = await api("POST", "/webhooks/stripe", event);
  assert.equal(first.status, 200);
  let row = (await pool.query("SELECT * FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(row.status, "paid");
  assert.equal(row.stripe_payment_intent, "pi_done");
  assert.ok(row.paid_at);

  // Re-deliver — must stay paid, no error, no duplicate side effects.
  const second = await api("POST", "/webhooks/stripe", event);
  assert.equal(second.status, 200);
  row = (await pool.query("SELECT * FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(row.status, "paid");
});

test("the fee read now reports the diver's entry as paid (submit-then-pay)", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/events/${eventId}/fee`);
  const fee = (await res.json()).fee;
  assert.equal(fee.already_paid, true);
});

test("refund reverses the charge and the application fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/payments/${paymentId}/refund`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "refunded");
  assert.equal(body.refunded_amount_cents, 5000);
  // The route delegated to lib/stripe with the federation's account; the
  // lib pins refund_application_fee:true (asserted in stripe-lib.test.js).
  assert.equal(lastRefundArgs.connectedAccountId, "acct_test");
  assert.equal(lastRefundArgs.paymentIntentId, "pi_done");
  const row = (await pool.query("SELECT status FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(row.status, "refunded");
});

test("membership purchase grants membership and unlocks member pricing", async (t) => {
  if (!ready) return t.skip();
  // Federation sets a membership fee.
  let res = await api("PUT", `/api/orgs/${orgId}/membership-fee`, {
    currency: "GBP", membership_period: "annual",
    prices: [{ label: "standard", amount_cents: 2000, audience: "all" }],
  });
  assert.equal(res.status, 200);

  // User checks out membership.
  res = await api("POST", `/api/orgs/${orgId}/membership/checkout`, {});
  assert.equal(res.status, 200);
  const memPaymentId = (await res.json()).payment_id;

  // Webhook completes it → membership row created.
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_mem", client_reference_id: memPaymentId, payment_intent: "pi_mem" } },
  });
  const mem = (await pool.query(
    "SELECT * FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
    [orgId, userId],
  )).rows;
  assert.equal(mem.length, 1);
  assert.ok(new Date(mem[0].period_end) > new Date(mem[0].period_start));

  // The same diver now resolves to the member entry price.
  res = await api("GET", `/api/events/${eventId}/fee`);
  const fee = (await res.json()).fee;
  assert.equal(fee.is_member, true);
  assert.equal(fee.price.amount_cents, 3500);
});

// Regression: meet-level event_entry (event_id NULL, meet_id set) was
// rejected by the stale fee_definitions_scope_event_check until migration
// 068 dropped it. This path had no test, which is how the bug shipped.
test("federation sets a meet registration fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/meets/${meetId}/fees`, {
    currency: "GBP",
    prices: [{ label: "standard", amount_cents: 4000, audience: "all" }],
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);

  const read = await api("GET", `/api/meets/${meetId}/fees`);
  const fee = (await read.json()).fee;
  assert.equal(fee.price.amount_cents, 4000);
  assert.equal(fee.currency, "GBP");
});

// ---- Late entry fee (surcharge after a deadline) -------------------

test("federation sets a base entry fee + a late fee on the late-test event", async (t) => {
  if (!ready) return t.skip();
  let res = await api("PUT", `/api/events/${lateEventId}/fee`, {
    currency: "GBP",
    prices: [{ label: "standard", amount_cents: 6000, audience: "all" }],
  });
  assert.equal(res.status, 200);
  res = await api("PUT", `/api/events/${lateEventId}/late-fee`, {
    currency: "GBP", late_fee_trigger: "entries_close_at",
    prices: [{ label: "late", amount_cents: 1500, audience: "all" }],
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
});

test("an invalid late_fee_trigger is rejected", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/events/${lateEventId}/late-fee`, {
    currency: "GBP", late_fee_trigger: "whenever",
    prices: [{ label: "late", amount_cents: 1500, audience: "all" }],
  });
  assert.equal(res.status, 400);
});

test("late fee is shown but NOT applied before the deadline", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/events/${lateEventId}/fee`);
  const fee = (await res.json()).fee;
  assert.equal(fee.price.amount_cents, 6000);
  assert.ok(fee.late_fee);
  assert.equal(fee.late_fee.applies, false);
  assert.equal(fee.late_fee.surcharge_cents, 1500);
  assert.equal(fee.total_cents, 6000);
});

let earlyPaymentId;
test("a diver who checks out before the deadline pays the base price only", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/events/${lateEventId}/checkout`, {});
  assert.equal(res.status, 200);
  earlyPaymentId = (await res.json()).payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [earlyPaymentId])).rows[0];
  assert.equal(row.amount_cents, 6000); // base only — deadline not reached
  assert.equal(row.status, "pending");
});

test("once entries close, a re-checkout retires the stale base session and charges base + late", async (t) => {
  if (!ready) return t.skip();
  await pool.query("UPDATE events SET entries_close_at = now() - interval '1 hour' WHERE id = $1", [lateEventId]);

  let res = await api("GET", `/api/events/${lateEventId}/fee`);
  const fee = (await res.json()).fee;
  assert.equal(fee.late_fee.applies, true);
  assert.equal(fee.total_cents, 7500);

  lastExpireArgs = null;
  res = await api("POST", `/api/events/${lateEventId}/checkout`, {});
  assert.equal(res.status, 200);
  const latePaymentId = (await res.json()).payment_id;
  assert.notEqual(latePaymentId, earlyPaymentId);

  // The stale, under-priced pending session was expired + failed...
  assert.ok(lastExpireArgs, "expireCheckoutSession should have been called");
  const stale = (await pool.query("SELECT status FROM payments WHERE id = $1", [earlyPaymentId])).rows[0];
  assert.equal(stale.status, "failed");
  // ...and the fresh row carries base + late with the 15% on the total.
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [latePaymentId])).rows[0];
  assert.equal(row.amount_cents, 7500);        // 6000 base + 1500 late
  assert.equal(row.platform_fee_cents, 1125);  // 15% of 7500
  assert.equal(row.subject_type, "event_entry");
});

test("a member-only / windowed late price is coerced to a flat 'all' surcharge", async (t) => {
  if (!ready) return t.skip();
  // A manager mis-configures the late fee with an audience + a closed window;
  // the server must flatten it so the surcharge can't silently vanish.
  const res = await api("PUT", `/api/events/${lateEventId}/late-fee`, {
    currency: "GBP", late_fee_trigger: "entries_close_at",
    prices: [{ label: "late", amount_cents: 2000, audience: "member", starts_at: "2020-01-01", ends_at: "2020-02-01" }],
  });
  assert.equal(res.status, 200);
  // Deadline is already in the past → the (flattened) surcharge still applies.
  const read = await api("GET", `/api/events/${lateEventId}/fee`);
  const fee = (await read.json()).fee;
  assert.equal(fee.late_fee.applies, true);
  assert.equal(fee.late_fee.surcharge_cents, 2000);
  // The stored variant was forced to audience 'all' with no window.
  const variant = (await pool.query(
    `SELECT fp.audience, fp.starts_at, fp.ends_at
       FROM fee_prices fp JOIN fee_definitions fd ON fd.id = fp.fee_definition_id
      WHERE fd.event_id = $1 AND fd.scope = 'late_entry' AND fd.active`,
    [lateEventId],
  )).rows[0];
  assert.equal(variant.audience, "all");
  assert.equal(variant.starts_at, null);
  assert.equal(variant.ends_at, null);
});

// ---- Club affiliation (federation charges the CLUB) ----------------

test("federation sets a club affiliation fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/orgs/${orgId}/club-fee`, {
    kind: "affiliation", currency: "GBP",
    prices: [{ label: "annual", amount_cents: 12000, audience: "all" }],
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
});

test("a club sees its affiliation price and inactive status", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/clubs/${clubId}/affiliation?kind=affiliation`);
  assert.equal(res.status, 200);
  const fee = (await res.json()).fee;
  assert.equal(fee.kind, "affiliation");
  assert.equal(fee.price.amount_cents, 12000);
  assert.equal(fee.active, false);
});

let clubAffPaymentId;
test("club affiliation checkout records a pending CLUB payment with the 15% fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/clubs/${clubId}/affiliation/checkout`, { kind: "affiliation" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.url);
  clubAffPaymentId = body.payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [clubAffPaymentId])).rows[0];
  assert.equal(row.status, "pending");
  assert.equal(row.payer_type, "club");
  assert.equal(row.payer_club_id, clubId);
  assert.equal(row.payer_user_id, null);
  assert.equal(row.amount_cents, 12000);
  assert.equal(row.platform_fee_cents, 1800);
  assert.equal(row.subject_type, "club_affiliation");
});

test("a second club affiliation checkout is blocked while one is live", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/clubs/${clubId}/affiliation/checkout`, { kind: "affiliation" });
  assert.equal(res.status, 409);
});

test("webhook activates the club affiliation period and the read flips to active", async (t) => {
  if (!ready) return t.skip();
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_club", client_reference_id: clubAffPaymentId, payment_intent: "pi_club" } },
  });
  const aff = (await pool.query(
    "SELECT * FROM club_affiliations WHERE club_id = $1 AND kind = 'affiliation' AND status = 'active'",
    [clubId],
  )).rows;
  assert.equal(aff.length, 1);
  assert.ok(new Date(aff[0].period_end) > new Date(aff[0].period_start));

  const res = await api("GET", `/api/clubs/${clubId}/affiliation?kind=affiliation`);
  assert.equal((await res.json()).fee.active, true);
});

// ---- Official / coach accreditation --------------------------------

test("federation sets a judge accreditation fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/orgs/${orgId}/official-fee`, {
    role_type: "judge", currency: "GBP",
    prices: [{ label: "annual", amount_cents: 4000, audience: "all" }],
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
});

test("an invalid official role_type is rejected", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/orgs/${orgId}/official-fee`, {
    role_type: "wizard", currency: "GBP",
    prices: [{ label: "annual", amount_cents: 4000, audience: "all" }],
  });
  assert.equal(res.status, 400);
});

test("an official sees the accreditation price and inactive status", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/orgs/${orgId}/official-accreditation?role_type=judge`);
  assert.equal(res.status, 200);
  const fee = (await res.json()).fee;
  assert.equal(fee.role_type, "judge");
  assert.equal(fee.price.amount_cents, 4000);
  assert.equal(fee.active, false);
});

let officialPaymentId;
test("official accreditation checkout records an official_role payment with the 15% fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/orgs/${orgId}/official-accreditation/checkout?role_type=judge`, {});
  assert.equal(res.status, 200);
  officialPaymentId = (await res.json()).payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [officialPaymentId])).rows[0];
  assert.equal(row.status, "pending");
  assert.equal(row.payer_type, "official_role");
  assert.equal(row.payer_user_id, userId);
  assert.equal(row.payer_role_type, "judge");
  assert.equal(row.amount_cents, 4000);
  assert.equal(row.platform_fee_cents, 600);  // 15% of 4000
  assert.equal(row.subject_type, "official_accreditation");
});

test("a second accreditation checkout for the same role is blocked while one is live", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/orgs/${orgId}/official-accreditation/checkout?role_type=judge`, {});
  assert.equal(res.status, 409);
});

test("webhook activates the accreditation and the official read flips to active", async (t) => {
  if (!ready) return t.skip();
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_off", client_reference_id: officialPaymentId, payment_intent: "pi_off" } },
  });
  const acc = (await pool.query(
    "SELECT * FROM official_accreditations WHERE org_id = $1 AND user_id = $2 AND role_type = 'judge' AND status = 'active'",
    [orgId, userId],
  )).rows;
  assert.equal(acc.length, 1);
  assert.ok(new Date(acc[0].period_end) > new Date(acc[0].period_start));

  const res = await api("GET", `/api/orgs/${orgId}/official-accreditation?role_type=judge`);
  assert.equal((await res.json()).fee.active, true);
});
