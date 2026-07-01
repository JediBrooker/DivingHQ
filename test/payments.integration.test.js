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
    await pool.query("DELETE FROM fines WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM entry_charges WHERE org_id = $1", [orgId]);
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

test("refund reverses the charge", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/payments/${paymentId}/refund`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "refunded");
  assert.equal(body.refunded_amount_cents, 5000);
  // The route delegated to lib/stripe (refund on the platform account).
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

test("a member-only / windowed club fee is coerced to a flat 'all' price", async (t) => {
  if (!ready) return t.skip();
  // A federation mis-configures the (accreditation) club fee with an audience
  // + a closed window; clubs are never "members", so the server must flatten
  // it or the fee would silently vanish at resolve time.
  const res = await api("PUT", `/api/orgs/${orgId}/club-fee`, {
    kind: "accreditation", currency: "GBP",
    prices: [{ label: "annual", amount_cents: 9000, audience: "member", starts_at: "2020-01-01", ends_at: "2020-02-01" }],
  });
  assert.equal(res.status, 200);
  // The club can still see the price despite the member/window input.
  const read = await api("GET", `/api/clubs/${clubId}/affiliation?kind=accreditation`);
  assert.equal((await read.json()).fee.price.amount_cents, 9000);
  // The stored variant was forced to audience 'all' with no window.
  const variant = (await pool.query(
    `SELECT fp.audience, fp.starts_at, fp.ends_at
       FROM fee_prices fp JOIN fee_definitions fd ON fd.id = fp.fee_definition_id
      WHERE fd.org_id = $1 AND fd.scope = 'club_accreditation' AND fd.active`,
    [orgId],
  )).rows[0];
  assert.equal(variant.audience, "all");
  assert.equal(variant.starts_at, null);
  assert.equal(variant.ends_at, null);
});

// ---- Scratch / no-show penalties (entry_charges) -------------------

test("federation sets a scratch penalty fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/events/${lateEventId}/penalty-fee`, {
    kind: "scratch", currency: "GBP",
    prices: [{ label: "scratch", amount_cents: 2500, audience: "all" }],
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
});

let scratchChargeId;
test("an admin issues a scratch charge against an entrant", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/events/${lateEventId}/entry-charges`, {
    entrant_user_id: userId, kind: "scratch",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  scratchChargeId = body.id;
  assert.equal(body.amount_cents, 2500);
  const row = (await pool.query("SELECT * FROM entry_charges WHERE id = $1", [scratchChargeId])).rows[0];
  assert.equal(row.status, "owed");
  assert.equal(row.entrant_user_id, userId);
  assert.equal(row.triggered_by, userId);
});

test("re-issuing the same scratch charge is blocked", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/events/${lateEventId}/entry-charges`, {
    entrant_user_id: userId, kind: "scratch",
  });
  assert.equal(res.status, 409);
});

test("the event's charge list shows the owed scratch", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/events/${lateEventId}/entry-charges`);
  const charges = (await res.json()).charges;
  const mine = charges.find((c) => c.id === scratchChargeId);
  assert.ok(mine);
  assert.equal(mine.kind, "scratch");
  assert.equal(mine.status, "owed");
  assert.equal(mine.amount_cents, 2500);
  assert.equal(mine.entrant_name, "Test Diver");
});

test("the diver sees the owed charge under /api/me/charges", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", "/api/me/charges");
  const charges = (await res.json()).charges;
  assert.ok(charges.some((c) => c.id === scratchChargeId && c.status === "owed"));
});

let chargePaymentId;
test("paying a charge records a scratch payment with the 15% fee and links it", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/entry-charges/${scratchChargeId}/checkout`, {});
  assert.equal(res.status, 200);
  chargePaymentId = (await res.json()).payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [chargePaymentId])).rows[0];
  assert.equal(row.subject_type, "scratch");
  assert.equal(row.payer_user_id, userId);
  assert.equal(row.event_id, lateEventId);
  assert.equal(row.amount_cents, 2500);
  assert.equal(row.platform_fee_cents, 375); // 15% of 2500
  const ec = (await pool.query("SELECT payment_id, status FROM entry_charges WHERE id = $1", [scratchChargeId])).rows[0];
  assert.equal(ec.payment_id, chargePaymentId);
  assert.equal(ec.status, "owed"); // not settled until the webhook
});

test("the webhook settles the charge to paid", async (t) => {
  if (!ready) return t.skip();
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_charge", client_reference_id: chargePaymentId, payment_intent: "pi_charge" } },
  });
  const ec = (await pool.query("SELECT status FROM entry_charges WHERE id = $1", [scratchChargeId])).rows[0];
  assert.equal(ec.status, "paid");
  // It drops off the diver's outstanding list.
  const res = await api("GET", "/api/me/charges");
  assert.ok(!(await res.json()).charges.some((c) => c.id === scratchChargeId));
});

test("a full refund re-opens the paid charge as owed", async (t) => {
  if (!ready) return t.skip();
  await api("POST", "/webhooks/stripe", {
    type: "charge.refunded",
    data: { object: { payment_intent: "pi_charge", amount_refunded: 2500 } },
  });
  const p = (await pool.query("SELECT status FROM payments WHERE id = $1", [chargePaymentId])).rows[0];
  assert.equal(p.status, "refunded");
  const ec = (await pool.query("SELECT status FROM entry_charges WHERE id = $1", [scratchChargeId])).rows[0];
  assert.equal(ec.status, "owed");
});

test("waiving a charge with a checkout in flight kills the session and can't be paid", async (t) => {
  if (!ready) return t.skip();
  await api("PUT", `/api/events/${lateEventId}/penalty-fee`, {
    kind: "no_show", currency: "GBP",
    prices: [{ label: "no_show", amount_cents: 1000, audience: "all" }],
  });
  const issued = await api("POST", `/api/events/${lateEventId}/entry-charges`, {
    entrant_user_id: userId, kind: "no_show",
  });
  const chargeId = (await issued.json()).id;

  // Entrant opens checkout — a pending payment is linked to the charge.
  const co = await api("POST", `/api/entry-charges/${chargeId}/checkout`, {});
  assert.equal(co.status, 200);
  const payId = (await co.json()).payment_id;

  // Admin waives — the in-flight session must be expired + the payment failed.
  lastExpireArgs = null;
  const res = await api("POST", `/api/entry-charges/${chargeId}/waive`, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "waived");
  assert.ok(lastExpireArgs, "the open session should be expired on waive");
  const p = (await pool.query("SELECT status FROM payments WHERE id = $1", [payId])).rows[0];
  assert.equal(p.status, "failed");
  let ec = (await pool.query("SELECT status FROM entry_charges WHERE id = $1", [chargeId])).rows[0];
  assert.equal(ec.status, "waived");

  // A late webhook completion for the killed session is a no-op (payment is
  // failed, not pending), so the charge stays waived and money is never taken.
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_waived", client_reference_id: payId, payment_intent: "pi_waived" } },
  });
  ec = (await pool.query("SELECT status FROM entry_charges WHERE id = $1", [chargeId])).rows[0];
  assert.equal(ec.status, "waived");
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

// ---- Meet access (spectator ticket / livestream / programme) --------

test("federation sets a spectator ticket fee for a meet", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/meets/${meetId}/access-fee`, {
    kind: "spectator_ticket", currency: "GBP",
    prices: [{ label: "day", amount_cents: 1500, audience: "all" }],
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
});

test("an invalid access kind is rejected", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/meets/${meetId}/access-fee`, {
    kind: "vip_lounge", currency: "GBP",
    prices: [{ label: "x", amount_cents: 1000, audience: "all" }],
  });
  assert.equal(res.status, 400);
});

test("a buyer sees the spectator ticket price and not-yet-purchased", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/meets/${meetId}/access?kind=spectator_ticket`);
  assert.equal(res.status, 200);
  const fee = (await res.json()).fee;
  assert.equal(fee.kind, "spectator_ticket");
  assert.equal(fee.price.amount_cents, 1500);
  assert.equal(fee.already_paid, false);
});

let accessPaymentId;
test("buying meet access records a payment with meet_id and the 15% fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/meets/${meetId}/access/checkout?kind=spectator_ticket`, {});
  assert.equal(res.status, 200);
  accessPaymentId = (await res.json()).payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [accessPaymentId])).rows[0];
  assert.equal(row.subject_type, "spectator_ticket");
  assert.equal(row.meet_id, meetId);
  assert.equal(row.payer_user_id, userId);
  assert.equal(row.amount_cents, 1500);
  assert.equal(row.platform_fee_cents, 225); // 15% of 1500
});

test("a second purchase of the same access is blocked while one is live", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/meets/${meetId}/access/checkout?kind=spectator_ticket`, {});
  assert.equal(res.status, 409);
});

test("the webhook marks access paid and the read flips to purchased", async (t) => {
  if (!ready) return t.skip();
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_access", client_reference_id: accessPaymentId, payment_intent: "pi_access" } },
  });
  const row = (await pool.query("SELECT status FROM payments WHERE id = $1", [accessPaymentId])).rows[0];
  assert.equal(row.status, "paid");
  const res = await api("GET", `/api/meets/${meetId}/access?kind=spectator_ticket`);
  assert.equal((await res.json()).fee.already_paid, true);
});

// ---- Meet bundle (discounted whole-meet package) --------------------

let bundleEvA;
let bundleEvB;
let bundlePaymentId;
test("federation sets a meet bundle over two events", async (t) => {
  if (!ready) return t.skip();
  bundleEvA = (await pool.query(
    "INSERT INTO events (org_id, meet_id, name, gender, number_of_judges) VALUES ($1, $2, 'Bundle 1m', 'Male', 5) RETURNING id",
    [orgId, meetId],
  )).rows[0].id;
  bundleEvB = (await pool.query(
    "INSERT INTO events (org_id, meet_id, name, gender, number_of_judges) VALUES ($1, $2, 'Bundle 3m', 'Male', 5) RETURNING id",
    [orgId, meetId],
  )).rows[0].id;
  const res = await api("PUT", `/api/meets/${meetId}/bundle`, {
    currency: "GBP",
    event_ids: [bundleEvA, bundleEvB],
    prices: [{ label: "bundle", amount_cents: 9000, audience: "all" }],
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).event_ids.length, 2);
});

test("a bundle with no events is rejected", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/meets/${meetId}/bundle`, {
    currency: "GBP", event_ids: [], prices: [{ label: "x", amount_cents: 1000, audience: "all" }],
  });
  assert.equal(res.status, 400);
});

test("a buyer sees the bundle price and its events", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/meets/${meetId}/bundle`);
  const fee = (await res.json()).fee;
  assert.equal(fee.price.amount_cents, 9000);
  assert.equal(fee.events.length, 2);
  assert.equal(fee.already_paid, false);
});

test("buying the bundle records a meet_bundle payment with the 15% fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/meets/${meetId}/bundle/checkout`, {});
  assert.equal(res.status, 200);
  bundlePaymentId = (await res.json()).payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [bundlePaymentId])).rows[0];
  assert.equal(row.subject_type, "meet_bundle");
  assert.equal(row.meet_id, meetId);
  assert.equal(row.amount_cents, 9000);
  assert.equal(row.platform_fee_cents, 1350); // 15% of 9000
});

test("a second bundle purchase for the same meet is blocked while one is live", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/meets/${meetId}/bundle/checkout`, {});
  assert.equal(res.status, 409);
});

test("the webhook expands the bundle into a paid entry for each event", async (t) => {
  if (!ready) return t.skip();
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_bundle", client_reference_id: bundlePaymentId, payment_intent: "pi_bundle" } },
  });
  for (const evId of [bundleEvA, bundleEvB]) {
    const r = await pool.query(
      `SELECT amount_cents, status FROM payments
        WHERE event_id = $1 AND payer_user_id = $2 AND subject_type = 'event_entry' AND status = 'paid'`,
      [evId, userId],
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].amount_cents, 0); // granted by the bundle
  }
  const res = await api("GET", `/api/meets/${meetId}/bundle`);
  assert.equal((await res.json()).fee.already_paid, true);
});

test("refunding the bundle revokes the granted per-event entries", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/payments/${bundlePaymentId}/refund`, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "refunded");
  for (const evId of [bundleEvA, bundleEvB]) {
    const r = await pool.query(
      "SELECT status FROM payments WHERE event_id = $1 AND payer_user_id = $2 AND subject_type = 'event_entry' AND amount_cents = 0",
      [evId, userId],
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].status, "refunded"); // no longer counts as entered
  }
});

// ---- Donations ------------------------------------------------------

test("federation configures donations with preset amounts", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/orgs/${orgId}/donation`, {
    currency: "GBP", suggested_amounts: [500, 1000, 2500],
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).suggested_amounts, [500, 1000, 2500]);
});

test("the public donation read returns the presets", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/orgs/${orgId}/donation`);
  const d = (await res.json()).donation;
  assert.equal(d.currency, "GBP");
  assert.deepEqual(d.suggested_amounts, [500, 1000, 2500]);
  assert.equal(d.min_amount_cents, 100);
});

test("a tiny donation amount is rejected", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/orgs/${orgId}/donate/checkout`, { amount_cents: 50 });
  assert.equal(res.status, 400);
});

test("an oversized donation amount is rejected (not an int4-overflow 500)", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/orgs/${orgId}/donate/checkout`, { amount_cents: 3000000000 });
  assert.equal(res.status, 400);
});

test("donating a chosen amount records a donation payment with the 15% fee", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/orgs/${orgId}/donate/checkout`, { amount_cents: 3000 });
  assert.equal(res.status, 200);
  const payId = (await res.json()).payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [payId])).rows[0];
  assert.equal(row.subject_type, "donation");
  assert.equal(row.payer_user_id, userId);
  assert.equal(row.amount_cents, 3000);
  assert.equal(row.platform_fee_cents, 450); // 15% of 3000
});

// ---- Fines (disciplinary, appealable) -------------------------------

let fineId;
let finePaymentId;
test("a referee issues a fine", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", "/api/fines", { liable_user_id: userId, amount_cents: 5000, reason: "Unsporting conduct" });
  assert.equal(res.status, 200);
  fineId = (await res.json()).id;
  const row = (await pool.query("SELECT * FROM fines WHERE id = $1", [fineId])).rows[0];
  assert.equal(row.status, "owed");
  assert.equal(row.liable_user_id, userId);
  assert.equal(row.amount_cents, 5000);
  assert.equal(row.issued_by, userId);
});

test("a fine with no reason is rejected", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", "/api/fines", { liable_user_id: userId, amount_cents: 5000, reason: "   " });
  assert.equal(res.status, 400);
});

test("the person sees the fine under /api/me/fines", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", "/api/me/fines");
  assert.ok((await res.json()).fines.some((f) => f.id === fineId && f.status === "owed"));
});

test("the person appeals, and payment is then blocked", async (t) => {
  if (!ready) return t.skip();
  let res = await api("POST", `/api/fines/${fineId}/appeal`, { reason: "It wasn't me" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "appealed");
  res = await api("POST", `/api/fines/${fineId}/checkout`, {});
  assert.equal(res.status, 409); // can't pay a fine under appeal
});

test("an org admin dismisses the appeal, restoring 'owed'", async (t) => {
  if (!ready) return t.skip();
  // A real adjudicator isn't the issuer; detach the (test-user) issuer so the
  // separation-of-duties guard doesn't fire (that guard has its own test).
  await pool.query("UPDATE fines SET issued_by = NULL WHERE id = $1", [fineId]);
  const res = await api("POST", `/api/fines/${fineId}/appeal/review`, { decision: "dismissed" });
  assert.equal(res.status, 200);
  const row = (await pool.query("SELECT status, appeal_status FROM fines WHERE id = $1", [fineId])).rows[0];
  assert.equal(row.status, "owed");
  assert.equal(row.appeal_status, "dismissed");
});

test("the person pays the fine (15% fee, linked)", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/fines/${fineId}/checkout`, {});
  assert.equal(res.status, 200);
  finePaymentId = (await res.json()).payment_id;
  const row = (await pool.query("SELECT * FROM payments WHERE id = $1", [finePaymentId])).rows[0];
  assert.equal(row.subject_type, "fine");
  assert.equal(row.payer_user_id, userId);
  assert.equal(row.liable_user_id, userId);
  assert.equal(row.amount_cents, 5000);
  assert.equal(row.platform_fee_cents, 750); // 15% of 5000
  const f = (await pool.query("SELECT payment_id FROM fines WHERE id = $1", [fineId])).rows[0];
  assert.equal(f.payment_id, finePaymentId);
});

test("the webhook settles the fine to paid", async (t) => {
  if (!ready) return t.skip();
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_fine", client_reference_id: finePaymentId, payment_intent: "pi_fine" } },
  });
  const row = (await pool.query("SELECT status FROM fines WHERE id = $1", [fineId])).rows[0];
  assert.equal(row.status, "paid");
});

test("an upheld appeal waives the fine", async (t) => {
  if (!ready) return t.skip();
  const issued = await api("POST", "/api/fines", { liable_user_id: userId, amount_cents: 2000, reason: "Late" });
  const id2 = (await issued.json()).id;
  await api("POST", `/api/fines/${id2}/appeal`, { reason: "Traffic" });
  await pool.query("UPDATE fines SET issued_by = NULL WHERE id = $1", [id2]);
  const res = await api("POST", `/api/fines/${id2}/appeal/review`, { decision: "upheld" });
  assert.equal(res.status, 200);
  const row = (await pool.query("SELECT status, appeal_status FROM fines WHERE id = $1", [id2])).rows[0];
  assert.equal(row.status, "waived");
  assert.equal(row.appeal_status, "upheld");
});

test("a referee can waive an owed fine", async (t) => {
  if (!ready) return t.skip();
  const issued = await api("POST", "/api/fines", { liable_user_id: userId, amount_cents: 1500, reason: "Misconduct" });
  const id3 = (await issued.json()).id;
  const res = await api("POST", `/api/fines/${id3}/waive`, {});
  assert.equal(res.status, 200);
  const row = (await pool.query("SELECT status FROM fines WHERE id = $1", [id3])).rows[0];
  assert.equal(row.status, "waived");
});

test("cannot appeal/pay a fine you're not liable for, nor review your own", async (t) => {
  if (!ready) return t.skip();
  // A fine against SOMEONE ELSE, issued by the test user.
  const other = (await pool.query(
    "INSERT INTO users (username, full_name, org_id) VALUES ($1, $2, $3) RETURNING id",
    [`other-${suffix}`, "Other Person", orgId],
  )).rows[0].id;
  const issued = await api("POST", "/api/fines", { liable_user_id: other, amount_cents: 2500, reason: "Conduct" });
  const id = (await issued.json()).id;
  // The (stubbed) caller is NOT the liable person: can't appeal or pay it.
  let res = await api("POST", `/api/fines/${id}/appeal`, { reason: "not me" });
  assert.equal(res.status, 403);
  res = await api("POST", `/api/fines/${id}/checkout`, {});
  assert.equal(res.status, 403);
  // Separation of duties: the issuer (the caller) can't review its appeal.
  await pool.query("UPDATE fines SET status = 'appealed', appeal_status = 'pending' WHERE id = $1", [id]);
  res = await api("POST", `/api/fines/${id}/appeal/review`, { decision: "dismissed" });
  assert.equal(res.status, 403);
});

test("appealing a fine with a checkout in flight kills the session; a late webhook can't pay it", async (t) => {
  if (!ready) return t.skip();
  const issued = await api("POST", "/api/fines", { liable_user_id: userId, amount_cents: 4000, reason: "Race" });
  const id = (await issued.json()).id;
  const co = await api("POST", `/api/fines/${id}/checkout`, {});
  const payId = (await co.json()).payment_id;
  lastExpireArgs = null;
  const res = await api("POST", `/api/fines/${id}/appeal`, { reason: "changed my mind" });
  assert.equal(res.status, 200);
  assert.ok(lastExpireArgs, "the open session should be expired on appeal");
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [payId])).rows[0].status, "failed");
  // A late completion for the killed session is a no-op (payment failed).
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_race", client_reference_id: payId, payment_intent: "pi_race" } },
  });
  assert.equal((await pool.query("SELECT status FROM fines WHERE id = $1", [id])).rows[0].status, "appealed");
});

// ---- Payouts (platform is merchant of record) -----------------------

test("saving payout details and reading status + balance", async (t) => {
  if (!ready) return t.skip();
  let res = await api("PUT", `/api/orgs/${orgId}/payout-details`, { account_name: "Test Fed", account_details: "GB00 TEST 0000" });
  assert.equal(res.status, 200);
  res = await api("GET", `/api/orgs/${orgId}/payments/status`);
  const s = await res.json();
  assert.equal(s.enabled, true);
  assert.equal(s.payout_details_set, true);
  assert.equal(s.account_name, "Test Fed");
  // Balance = net (amount - our 15%) of paid payments minus payouts; the suite
  // has several paid payments, so it's a non-negative number.
  assert.equal(typeof s.balance_cents, "number");
  assert.ok(s.balance_cents >= 0);
});

test("empty payout details are rejected", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/orgs/${orgId}/payout-details`, { account_name: "", account_details: "" });
  assert.equal(res.status, 400);
});
