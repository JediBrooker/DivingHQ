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
let lastCheckoutArgs = null;
let retrieveCheckoutSessionImpl = async (args) => ({ id: args.sessionId, status: "open", url: "https://stripe.test/resume" });
let expireCheckoutSessionImpl = async (args) => { lastExpireArgs = args; return { status: "expired" }; };

// Fake Stripe — captures args, returns canned objects.
const fakePayments = {
  enabled: true,
  createConnectedAccount: async () => ({ id: "acct_test" }),
  createOnboardingLink: async () => ({ url: "https://stripe.test/onboard" }),
  retrieveAccount: async () => ({
    configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } },
  }),
  // REAL Checkout Session ids are ~66 chars ("cs_live_" + 58); the fake
  // matches that length so the schema can never regress to a column too
  // narrow for production ids (the varchar(64) bug migration 079 fixed —
  // short fake ids were exactly why the suite missed it).
  createCheckoutSession: async (args) => {
    lastCheckoutArgs = args;
    return {
      id: ("cs_test_" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")).slice(0, 66),
      url: "https://stripe.test/pay",
    };
  },
  expireCheckoutSession: (...a) => expireCheckoutSessionImpl(...a),
  // Blocking-checkout lookups: default to a still-OPEN session so a second
  // checkout attempt RESUMES the first (returns its url) rather than
  // retiring it — mirrors the common real-world case and keeps this
  // order-dependent suite's payment rows stable across tests.
  retrieveCheckoutSession: async (args) => retrieveCheckoutSessionImpl(args),
  createRefund: async (args) => { lastRefundArgs = args; return { amount: args.amountCents }; },
  // --- Connect payouts (recipient accounts + transfers) ---
  createRecipientAccount: async () => ({ id: "acct_test_" + crypto.randomUUID().slice(0, 8) }),
  createOnboardingLink: async () => "https://connect.stripe.test/setup/xyz",
  retrieveAccountStatus: async () => ({ payoutsEnabled: true, capabilityStatus: "active", requirementsCollected: true }),
  // Transfer succeeds by default; a test can swap createTransferImpl to
  // simulate a Stripe rejection (the guard path).
  createTransfer: (...a) => createTransferImpl(...a),
  // Tests POST a JSON body; treat it as the already-verified event.
  constructWebhookEvent: (raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : raw),
};
let createTransferImpl = async (args) => { lastTransferArgs = args; return { id: "tr_" + crypto.randomUUID().slice(0, 8) }; };
let lastTransferArgs = null;

// Fake operator-notification mailer — captures the last failed-payout email.
let lastPayoutFailedEmail = null;
const fakeEmail = { sendPayoutFailedEmail: (args) => { lastPayoutFailedEmail = args; } };

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

  // The payout back-office is platform-operator-only in prod; the stub
  // grants is_system_admin so those routes are testable here.
  const requireSystemAdmin = (req, _res, next) => {
    req.user = { ...TEST_USER(), is_system_admin: true };
    next();
  };

  const app = express();
  app.use((req, res, next) =>
    req.path === "/webhooks/stripe" ? next() : express.json()(req, res, next));
  app.use(createPaymentsRouter({
    pool, verifyToken, optionalAuth, requireOrgRole, requireEventManager, requireMeetEditor, requireClubAdmin,
    requireSystemAdmin,
    logger: silentLogger, payments: fakePayments, email: fakeEmail,
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

test("a second checkout for the same event resumes the still-open session", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/events/${eventId}/checkout`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.url, "https://stripe.test/resume", "payer is sent back into the SAME session, not charged a second slot");
  assert.equal(body.payment_id, paymentId, "no new payment row was created");
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

test("a second club affiliation checkout resumes the still-open session", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/clubs/${clubId}/affiliation/checkout`, { kind: "affiliation" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "https://stripe.test/resume", "same session resumed, no duplicate slot");
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

test("a second accreditation checkout for the same role resumes the still-open session", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/orgs/${orgId}/official-accreditation/checkout?role_type=judge`, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "https://stripe.test/resume", "same session resumed, no duplicate slot");
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

test("a second purchase of the same access resumes the still-open session", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/meets/${meetId}/access/checkout?kind=spectator_ticket`, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "https://stripe.test/resume", "same session resumed, no duplicate slot");
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

test("a second bundle purchase for the same meet resumes the still-open session", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/meets/${meetId}/bundle/checkout`, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "https://stripe.test/resume", "same session resumed, no duplicate slot");
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

test("Connect onboarding creates a recipient account and status reflects readiness", async (t) => {
  if (!ready) return t.skip();
  // First onboard call creates the recipient account (fake acct_test_…).
  let res = await api("POST", `/api/orgs/${orgId}/connect/onboard`, {});
  assert.equal(res.status, 200);
  assert.match((await res.json()).url, /connect\.stripe/);
  // Status refresh (fake retrieveAccountStatus → payoutsEnabled true) flips
  // the cached flag, so the org reads as connected + payouts-ready.
  res = await api("GET", `/api/orgs/${orgId}/payments/status`);
  const s = await res.json();
  assert.equal(s.enabled, true);
  assert.equal(s.connected, true);
  assert.equal(s.payouts_ready, true);
  assert.equal(typeof s.balance_cents, "number");
  assert.ok(s.balance_cents >= 0);
  // A second onboard reuses the SAME account (doesn't create a new one).
  const acctBefore = (await pool.query("SELECT stripe_account_id FROM organisations WHERE id = $1", [orgId])).rows[0].stripe_account_id;
  res = await api("POST", `/api/orgs/${orgId}/connect/onboard`, {});
  assert.equal(res.status, 200);
  const acctAfter = (await pool.query("SELECT stripe_account_id FROM organisations WHERE id = $1", [orgId])).rows[0].stripe_account_id;
  assert.equal(acctAfter, acctBefore, "onboarding again reuses the existing recipient account");
});

test("partial refund prorates the platform fee in the payout balance", async (t) => {
  if (!ready) return t.skip();
  const before = (await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json()).balance_cents;
  // A £100 payment, 15% (£15) fee, £40 refunded → £60 retained. The federation is
  // owed £60 minus the fee PRORATED to the retained portion (£15 × 60% = £9) =
  // £51 — NOT £60 − the full £15 = £45 (the over-deduction this guards against).
  await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, subject_type, amount_cents, platform_fee_cents, currency, status, refunded_amount_cents)
     VALUES ($1, $2, 'donation', 10000, 1500, 'GBP', 'partially_refunded', 4000)`,
    [orgId, userId],
  );
  const after = (await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json()).balance_cents;
  assert.equal(after - before, 5100);
});

test("a class_enrolment (club-recipient) payment never counts toward the federation's balance", async (t) => {
  if (!ready) return t.skip();
  const before = (await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json()).balance_cents;
  // A class + enrolment row to satisfy the payments_chk_class_enrolment
  // constraint (class_enrolment_id + club_id NOT NULL).
  const cls = (await pool.query(
    "INSERT INTO classes (club_id, org_id, name) VALUES ($1, $2, 'Balance Test Class') RETURNING id",
    [clubId, orgId],
  )).rows[0].id;
  const enr = (await pool.query(
    `INSERT INTO class_enrolments (class_id, diver_user_id, club_id, org_id, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [cls, userId, clubId, orgId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payments
        (org_id, payer_user_id, payer_type, subject_type, club_id, recipient_type,
         class_enrolment_id, amount_cents, platform_fee_cents, currency, status)
     VALUES ($1, $2, 'user', 'class_enrolment', $3, 'club', $4, 9000, 1350, 'GBP', 'paid')`,
    [orgId, userId, clubId, enr],
  );
  const after = (await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json()).balance_cents;
  assert.equal(after, before, "the federation's balance is unchanged by a club-recipient payment");
});

test("auto-withdraw settings save and reflect in status", async (t) => {
  if (!ready) return t.skip();
  let res = await api("PUT", `/api/orgs/${orgId}/withdrawal-settings`, { auto_withdraw_enabled: true, auto_withdraw_min_cents: 5000 });
  assert.equal(res.status, 200);
  let s = await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json();
  assert.equal(s.auto_withdraw_enabled, true);
  assert.equal(s.auto_withdraw_min_cents, 5000);
  // Enabling without a usable threshold is rejected.
  res = await api("PUT", `/api/orgs/${orgId}/withdrawal-settings`, { auto_withdraw_enabled: true, auto_withdraw_min_cents: 10 });
  assert.equal(res.status, 400);
  // Disabling clears the stored threshold.
  res = await api("PUT", `/api/orgs/${orgId}/withdrawal-settings`, { auto_withdraw_enabled: false });
  assert.equal(res.status, 200);
  s = await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json();
  assert.equal(s.auto_withdraw_enabled, false);
  assert.equal(s.auto_withdraw_min_cents, null);
});

test("withdrawing executes a Stripe transfer, settles 'paid', and zeroes the balance", async (t) => {
  if (!ready) return t.skip();
  lastTransferArgs = null;
  const before = await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json();
  assert.ok(before.balance_cents > 0, "expected a positive balance from earlier paid payments");
  const res = await api("POST", `/api/orgs/${orgId}/withdrawals`, {});
  assert.equal(res.status, 201);
  const payouts = await res.json();
  assert.equal(payouts.length, 1, "single-currency org yields one payout");
  assert.equal(payouts[0].amount_cents, before.balance_cents);
  assert.equal(payouts[0].status, "paid", "the transfer succeeded → settled paid");
  assert.ok(payouts[0].stripe_transfer_id, "the Stripe transfer id is recorded");
  assert.equal(lastTransferArgs.amountCents, before.balance_cents, "the transfer was for the balance");
  assert.equal(lastTransferArgs.idempotencyKey, payouts[0].id, "payout id used as the idempotency key");
  const after = await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json();
  assert.equal(after.balance_cents, 0);
  assert.equal(after.balances.length, 0);
  const list = await (await api("GET", `/api/orgs/${orgId}/withdrawals`)).json();
  assert.ok(list.some((w) => w.id === payouts[0].id && w.status === "paid"), "new payout shows in history as paid");
});

test("withdrawing with no balance is rejected", async (t) => {
  if (!ready) return t.skip();
  // Balance was fully withdrawn by the previous test.
  const res = await api("POST", `/api/orgs/${orgId}/withdrawals`, {});
  assert.equal(res.status, 409);
});

test("withdrawal creates + transfers one payout per currency (no cross-currency mixing)", async (t) => {
  if (!ready) return t.skip();
  // Two paid payments in different currencies for the same org.
  await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, subject_type, amount_cents, platform_fee_cents, currency, status)
     VALUES ($1, $2, 'donation', 10000, 1500, 'GBP', 'paid'),
            ($1, $2, 'donation', 20000, 3000, 'USD', 'paid')`,
    [orgId, userId],
  );
  const status = await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json();
  const byCur = Object.fromEntries(status.balances.map((b) => [b.currency.trim(), b.cents]));
  assert.equal(byCur.GBP, 8500);   // 10000 - 15%
  assert.equal(byCur.USD, 17000);  // 20000 - 15%
  const res = await api("POST", `/api/orgs/${orgId}/withdrawals`, {});
  assert.equal(res.status, 201);
  const payouts = await res.json();
  assert.equal(payouts.length, 2, "one payout per currency");
  assert.ok(payouts.every((p) => p.status === "paid"), "each currency transferred + settled paid");
  const pByCur = Object.fromEntries(payouts.map((p) => [p.currency.trim(), p.amount_cents]));
  assert.equal(pByCur.GBP, 8500);
  assert.equal(pByCur.USD, 17000);
  const after = await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json();
  assert.equal(after.balances.length, 0, "both currencies fully withdrawn");
});

test("GET /api/me/payments returns the caller's payments (incl. accreditation) and excludes others", async (t) => {
  if (!ready) return t.skip();
  // An official_accreditation the caller paid — payer_user_id is set, so it
  // must appear in their history.
  await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, payer_type, payer_role_type, subject_type, amount_cents, platform_fee_cents, currency, status)
     VALUES ($1, $2, 'official_role', 'judge', 'official_accreditation', 3000, 450, 'GBP', 'paid')`,
    [orgId, userId],
  );
  // Another user's donation — must NOT appear in the caller's history.
  const other = (await pool.query(
    "INSERT INTO users (username, full_name, org_id) VALUES ($1, $2, $3) RETURNING id",
    [`ph-other-${suffix}`, "PH Other", orgId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, subject_type, amount_cents, platform_fee_cents, currency, status)
     VALUES ($1, $2, 'donation', 1234, 185, 'GBP', 'paid')`,
    [orgId, other],
  );
  const res = await api("GET", "/api/me/payments");
  assert.equal(res.status, 200);
  const { payments: list } = await res.json();
  assert.ok(Array.isArray(list) && list.length > 0);
  const acc = list.find((p) => p.subject_type === "official_accreditation");
  assert.ok(acc, "caller's accreditation payment is returned");
  for (const k of ["id", "created_at", "subject_type", "status", "amount_cents", "currency"]) {
    assert.ok(k in acc, `row missing ${k}`);
  }
  assert.ok(!list.some((p) => p.amount_cents === 1234), "excludes other users' payments");
});

// ---- Payout monitoring + transfer failure ----------------------------
// Withdrawals now fire automatic Stripe Connect transfers; the admin queue
// is read-only monitoring, and a failed transfer restores the balance.

const orgStatus = async () => await (await api("GET", `/api/orgs/${orgId}/payments/status`)).json();

test("admin payout monitoring queue lists paid payouts with their transfer ids (read-only)", async (t) => {
  if (!ready) return t.skip();
  // Earlier withdrawals settled 'paid' with transfer ids.
  const res = await api("GET", "/api/admin/payouts?status=paid");
  assert.equal(res.status, 200);
  const { payouts } = await res.json();
  const mine = payouts.filter((p) => p.org_id === orgId);
  assert.ok(mine.length >= 1, "this org's paid payouts are visible");
  assert.equal(mine[0].recipient_type, "org");
  assert.ok(mine[0].stripe_transfer_id, "the Stripe transfer id is exposed for reconciliation");
  // No bank details are ever exposed (they live at Stripe now).
  assert.ok(!("payout_account_name" in mine[0]) && !("payout_account_details" in mine[0]));
});

test("a failed transfer marks the payout 'failed', restores the balance, and alerts the operator", async (t) => {
  if (!ready) return t.skip();
  await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, subject_type, amount_cents, platform_fee_cents, currency, status)
     VALUES ($1, $2, 'donation', 10000, 1500, 'GBP', 'paid')`,
    [orgId, userId],
  );
  const before = (await orgStatus()).balance_cents;
  assert.ok(before >= 8500);
  // Simulate Stripe rejecting the transfer (e.g. onboarding lapsed).
  const prev = createTransferImpl;
  createTransferImpl = async () => { const e = new Error("insufficient_capabilities_for_transfer"); e.code = "insufficient_capabilities_for_transfer"; throw e; };
  lastPayoutFailedEmail = null;
  try {
    const res = await api("POST", `/api/orgs/${orgId}/withdrawals`, {});
    assert.equal(res.status, 201);
    const [payout] = await res.json();
    assert.equal(payout.status, "failed", "the payout is marked failed");
  } finally {
    createTransferImpl = prev;
  }
  assert.equal((await orgStatus()).balance_cents, before, "a failed transfer restores the balance");
  assert.equal(lastPayoutFailedEmail?.orgId, orgId, "the operator is alerted about the failed transfer");
});

test("auto-withdraw sweeper transfers only once the threshold is met", async (t) => {
  if (!ready) return t.skip();
  const { sweepOnce } = require("../lib/auto-withdraw");
  const bal = (await orgStatus()).balance_cents; // restored by the failed payout above
  assert.ok(bal > 0);
  // Threshold above the balance → the sweep must not touch it.
  await pool.query(
    "UPDATE organisations SET auto_withdraw_enabled = true, auto_withdraw_min_cents = $2 WHERE id = $1",
    [orgId, bal + 1],
  );
  await sweepOnce({ pool, payments: fakePayments, logger: silentLogger, email: fakeEmail });
  assert.equal((await orgStatus()).balance_cents, bal, "below-threshold balance is untouched");
  // Threshold met → the sweep transfers and zeroes the balance.
  await pool.query("UPDATE organisations SET auto_withdraw_min_cents = $2 WHERE id = $1", [orgId, bal]);
  await sweepOnce({ pool, payments: fakePayments, logger: silentLogger, email: fakeEmail });
  assert.equal((await orgStatus()).balance_cents, 0, "balance auto-withdrawn via transfer");
  const list = await (await api("GET", `/api/orgs/${orgId}/withdrawals`)).json();
  assert.ok(list.some((w) => w.note === "auto-withdrawal" && w.amount_cents === bal && w.status === "paid"), "auto payout recorded + paid");
  // Leave the flag off so this suite stays re-runnable.
  await pool.query("UPDATE organisations SET auto_withdraw_enabled = false, auto_withdraw_min_cents = NULL WHERE id = $1", [orgId]);
});

// ---- Pre-deploy hardening regressions (audit round 2) -----------------

test("validatePrices refuses sub-1.00 amounts (blank rows can't become winning £0 variants)", async (t) => {
  if (!ready) return t.skip();
  const res = await api("PUT", `/api/orgs/${orgId}/membership-fee`, {
    prices: [{ label: "oops", amount_cents: 50, audience: "all" }],
  });
  assert.equal(res.status, 400);
});

test("payer_total_cents quotes the pass_to_payer uplift the buyer is actually charged", async (t) => {
  if (!ready) return t.skip();
  await api("PUT", `/api/events/${eventId}/fee`, {
    fee_payer: "pass_to_payer",
    prices: [{ label: "standard", amount_cents: 10000, audience: "all" }],
  });
  const fee = (await (await api("GET", `/api/events/${eventId}/fee`)).json()).fee;
  assert.equal(fee.price.amount_cents, 10000);
  assert.equal(fee.payer_total_cents, 11500, "base + the org's 15% platform fee");
  // back to absorb so later tests see the original semantics
  await api("PUT", `/api/events/${eventId}/fee`, {
    fee_payer: "absorb",
    prices: [{ label: "standard", amount_cents: 10000, audience: "all" }],
  });
});

test("meet registration checkout works end-to-end and sends the right amount to Stripe", async (t) => {
  if (!ready) return t.skip();
  // The meet fee (4000, absorb) was configured earlier in the suite.
  lastCheckoutArgs = null;
  const res = await api("POST", `/api/meets/${meetId}/checkout`, {});
  assert.equal(res.status, 200, JSON.stringify(await res.clone?.().json?.() || {}));
  const body = await res.json();
  assert.ok(body.url && body.payment_id);
  assert.equal(lastCheckoutArgs.chargeAmountCents, 4000, "Stripe is asked for exactly the configured price");
  assert.equal(lastCheckoutArgs.applicationFeeCents, 600, "15% platform fee stamped for reconciliation");
  // Webhook settles it.
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_meet_reg", client_reference_id: body.payment_id, payment_intent: "pi_meet_reg" } },
  });
  const p = (await pool.query("SELECT status, meet_id, event_id FROM payments WHERE id = $1", [body.payment_id])).rows[0];
  assert.equal(p.status, "paid");
  assert.equal(p.meet_id, meetId);
  assert.equal(p.event_id, null, "meet-level registration carries meet_id, not event_id");
});

test("an abandoned (expired) checkout is retired and retried instead of 409ing for 24h", async (t) => {
  if (!ready) return t.skip();
  // A pending accreditation payment exists? Create a fresh referee-fee flow:
  await api("PUT", `/api/orgs/${orgId}/official-fee`, {
    role_type: "referee", prices: [{ label: "annual", amount_cents: 2500, audience: "all" }],
  });
  const first = await api("POST", `/api/orgs/${orgId}/official-accreditation/checkout?role_type=referee`, {});
  assert.equal(first.status, 200);
  const firstId = (await first.json()).payment_id;
  // The payer abandoned it and the session eventually EXPIRED at Stripe.
  const prevRetrieve = retrieveCheckoutSessionImpl;
  retrieveCheckoutSessionImpl = async (args) => ({ id: args.sessionId, status: "expired" });
  try {
    const second = await api("POST", `/api/orgs/${orgId}/official-accreditation/checkout?role_type=referee`, {});
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.url, "https://stripe.test/pay", "a FRESH session was created");
    assert.notEqual(body.payment_id, firstId, "a fresh payment row took the slot");
  } finally {
    retrieveCheckoutSessionImpl = prevRetrieve;
  }
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [firstId])).rows[0].status, "failed",
    "the dead attempt was retired");
});

test("waiving a fine whose payment settles DURING the retire round-trip is refused (409), not silently waived", async (t) => {
  if (!ready) return t.skip();
  const fineId = (await pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, amount_cents, currency, reason, status)
     VALUES ($1, $2, $2, 3000, 'GBP', 'race test', 'owed') RETURNING id`,
    [orgId, userId],
  )).rows[0].id;
  const co = await api("POST", `/api/fines/${fineId}/checkout`, {});
  assert.equal(co.status, 200);
  const payId = (await co.json()).payment_id;
  // The webhook lands WHILE the waive's expire call is on the wire.
  const prevExpire = expireCheckoutSessionImpl;
  expireCheckoutSessionImpl = async () => {
    await api("POST", "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_fine_race2", client_reference_id: payId, payment_intent: "pi_fine_race2" } },
    });
    return { status: "expired" };
  };
  try {
    const waive = await api("POST", `/api/fines/${fineId}/waive`, {});
    assert.equal(waive.status, 409, "the waive must refuse a fine that just got paid");
  } finally {
    expireCheckoutSessionImpl = prevExpire;
  }
  assert.equal((await pool.query("SELECT status FROM fines WHERE id = $1", [fineId])).rows[0].status, "paid",
    "the fine stays paid — the money was captured");
});

test("delayed payment methods: completed(unpaid) holds; async_payment_succeeded fulfils; async_payment_failed frees", async (t) => {
  if (!ready) return t.skip();
  const mk = async () => (await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, subject_type, amount_cents, platform_fee_cents, currency, status)
     VALUES ($1, $2, 'donation', 7000, 1050, 'GBP', 'pending') RETURNING id`,
    [orgId, userId],
  )).rows[0].id;
  const a = await mk();
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_async_a", client_reference_id: a, payment_intent: "pi_async_a", payment_status: "unpaid" } },
  });
  let row = (await pool.query("SELECT status, stripe_payment_intent FROM payments WHERE id = $1", [a])).rows[0];
  assert.equal(row.status, "pending", "no fulfilment before the money actually arrives");
  assert.equal(row.stripe_payment_intent, "pi_async_a", "linkage stored for the follow-up event");
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.async_payment_succeeded",
    data: { object: { id: "cs_async_a", client_reference_id: a, payment_intent: "pi_async_a", payment_status: "paid" } },
  });
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [a])).rows[0].status, "paid");

  const b = await mk();
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.async_payment_failed",
    data: { object: { id: "cs_async_b", client_reference_id: b } },
  });
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [b])).rows[0].status, "failed");
});

test("charge.refunded landing before checkout.session.completed still applies (metadata fallback)", async (t) => {
  if (!ready) return t.skip();
  const id = (await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, subject_type, amount_cents, platform_fee_cents, currency, status)
     VALUES ($1, $2, 'donation', 4200, 630, 'GBP', 'pending') RETURNING id`,
    [orgId, userId],
  )).rows[0].id;
  // Refund webhook first — the PI was never stored on the row.
  await api("POST", "/webhooks/stripe", {
    type: "charge.refunded",
    data: { object: { payment_intent: "pi_early_refund", currency: "gbp", amount_refunded: 4200, metadata: { payment_id: id } } },
  });
  let row = (await pool.query("SELECT status, refunded_amount_cents, stripe_payment_intent FROM payments WHERE id = $1", [id])).rows[0];
  assert.equal(row.status, "refunded");
  assert.equal(row.refunded_amount_cents, 4200);
  assert.equal(row.stripe_payment_intent, "pi_early_refund");
  // The straggling completed event must NOT resurrect or grant anything.
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_late_done", client_reference_id: id, payment_intent: "pi_early_refund" } },
  });
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [id])).rows[0].status, "refunded");
});

test("a LOST chargeback debits the ledger once (redelivery-safe) and reopens the debt", async (t) => {
  if (!ready) return t.skip();
  const before = (await orgStatus()).balance_cents;
  const payId = (await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, subject_type, amount_cents, platform_fee_cents, currency, status, stripe_payment_intent)
     VALUES ($1, $2, 'donation', 10000, 1500, 'GBP', 'paid', 'pi_dispute') RETURNING id`,
    [orgId, userId],
  )).rows[0].id;
  assert.equal((await orgStatus()).balance_cents, before + 8500);
  // Dispute opened: informational only — the ledger must NOT move yet.
  await api("POST", "/webhooks/stripe", {
    type: "charge.dispute.created",
    data: { object: { id: "dp_1", payment_intent: "pi_dispute", reason: "fraudulent", amount: 10000, currency: "gbp" } },
  });
  assert.equal((await orgStatus()).balance_cents, before + 8500);
  // Dispute LOST: refund semantics applied additively.
  const lost = {
    type: "charge.dispute.closed",
    data: { object: { id: "dp_1", payment_intent: "pi_dispute", status: "lost", amount: 10000, currency: "gbp" } },
  };
  await api("POST", "/webhooks/stripe", lost);
  const row = (await pool.query("SELECT status, refunded_amount_cents FROM payments WHERE id = $1", [payId])).rows[0];
  assert.equal(row.status, "refunded");
  assert.equal(row.refunded_amount_cents, 10000);
  assert.equal((await orgStatus()).balance_cents, before, "the recipient's credit is clawed back");
  // Stripe redelivers — the additive update must NOT double-debit.
  await api("POST", "/webhooks/stripe", lost);
  assert.equal((await orgStatus()).balance_cents, before, "redelivery is a no-op");
});

test("membership renewal: blocked while active (outside the window), allowed near expiry, and the grant EXTENDS", async (t) => {
  if (!ready) return t.skip();
  // Earlier in the suite the webhook granted a 12-month membership — a fresh
  // purchase must be refused as premature.
  let res = await api("POST", `/api/orgs/${orgId}/membership/checkout`, {});
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /renewals open/i);
  // Bring the membership inside the 30-day renewal window.
  await pool.query(
    `UPDATE memberships SET period_start = CURRENT_DATE - interval '355 days',
            period_end = (CURRENT_DATE + interval '10 days')::date
      WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
    [orgId, userId],
  );
  const oldEnd = (await pool.query(
    "SELECT MAX(period_end) AS pe FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
    [orgId, userId],
  )).rows[0].pe;
  res = await api("POST", `/api/orgs/${orgId}/membership/checkout`, {});
  assert.equal(res.status, 200, JSON.stringify(await res.clone?.().json?.() || {}));
  const payId = (await res.json()).payment_id;
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_renewal", client_reference_id: payId, payment_intent: "pi_renewal" } },
  });
  const rows = (await pool.query(
    "SELECT period_start, period_end, payment_id FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active' ORDER BY period_end DESC",
    [orgId, userId],
  )).rows;
  assert.equal(rows.length, 2, "renewal adds a second active period");
  assert.equal(String(rows[0].period_start).slice(0, 10), String(oldEnd).slice(0, 10),
    "the renewal starts where the current period ends — early renewal loses no paid-for days");

  // Refunding the RENEWAL revokes exactly that grant.
  const refund = await api("POST", `/api/payments/${payId}/refund`, {});
  assert.equal(refund.status, 200);
  const after = (await pool.query(
    "SELECT status FROM memberships WHERE payment_id = $1", [payId],
  )).rows[0];
  assert.equal(after.status, "cancelled", "a refunded membership no longer grants anything");
});

test("partial refunds are capped at the remaining refundable amount", async (t) => {
  if (!ready) return t.skip();
  const payId = (await pool.query(
    `INSERT INTO payments (org_id, payer_user_id, subject_type, amount_cents, platform_fee_cents, currency, status, stripe_payment_intent)
     VALUES ($1, $2, 'donation', 6000, 900, 'GBP', 'paid', 'pi_partial_cap') RETURNING id`,
    [orgId, userId],
  )).rows[0].id;
  let res = await api("POST", `/api/payments/${payId}/refund`, { amount_cents: 4000 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "partially_refunded");
  // Only 2000 remains — asking for 3000 must be a clean 400, not a Stripe error.
  res = await api("POST", `/api/payments/${payId}/refund`, { amount_cents: 3000 });
  assert.equal(res.status, 400);
  res = await api("POST", `/api/payments/${payId}/refund`, { amount_cents: 2000 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "refunded");
});

test("club-recipient payments cannot be refunded by the federation — only the club's own admins", async (t) => {
  if (!ready) return t.skip();
  const cls = (await pool.query(
    "INSERT INTO classes (club_id, org_id, name) VALUES ($1, $2, 'Refund Authz Class') RETURNING id",
    [clubId, orgId],
  )).rows[0].id;
  const enr = (await pool.query(
    `INSERT INTO class_enrolments (class_id, diver_user_id, club_id, org_id, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [cls, userId, clubId, orgId],
  )).rows[0].id;
  const payId = (await pool.query(
    `INSERT INTO payments
        (org_id, payer_user_id, payer_type, subject_type, club_id, recipient_type,
         class_enrolment_id, amount_cents, platform_fee_cents, currency, status, stripe_payment_intent)
     VALUES ($1, $2, 'user', 'class_enrolment', $3, 'club', $4, 5000, 750, 'GBP', 'paid', 'pi_club_refund')
     RETURNING id`,
    [orgId, userId, clubId, enr],
  )).rows[0].id;
  // The stubbed caller is an org_admin/meet_manager in this org but NOT a
  // club admin — the club-private boundary must hold.
  let res = await api("POST", `/api/payments/${payId}/refund`, {});
  assert.equal(res.status, 403, "federation admins cannot touch a club's class revenue");
  // Grant the caller club-admin status → the club CAN refund its own revenue.
  await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [clubId, userId, orgId]);
  res = await api("POST", `/api/payments/${payId}/refund`, {});
  assert.equal(res.status, 200, JSON.stringify(await res.clone?.().json?.() || {}));
  await pool.query("DELETE FROM club_admins WHERE club_id = $1 AND user_id = $2", [clubId, userId]);
});

test("GET /api/me/fines includes resolved fines so appeal outcomes stay visible", async (t) => {
  if (!ready) return t.skip();
  const fineId = (await pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, amount_cents, currency, reason, status, appeal_status)
     VALUES ($1, $2, $2, 1500, 'GBP', 'visibility test', 'waived', 'upheld') RETURNING id`,
    [orgId, userId],
  )).rows[0].id;
  const { fines } = await (await api("GET", "/api/me/fines")).json();
  const mine = fines.find((f) => f.id === fineId);
  assert.ok(mine, "waived fines are returned");
  assert.equal(mine.status, "waived");
  assert.equal(mine.appeal_status, "upheld");
});

test("retire when the session already COMPLETED at Stripe (expire fails): the action is refused, nothing is clobbered", async (t) => {
  if (!ready) return t.skip();
  const fineId = (await pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, amount_cents, currency, reason, status)
     VALUES ($1, $2, $2, 2200, 'GBP', 'race b test', 'owed') RETURNING id`,
    [orgId, userId],
  )).rows[0].id;
  const co = await api("POST", `/api/fines/${fineId}/checkout`, {});
  const payId = (await co.json()).payment_id;
  // Stripe refuses to expire a completed session; retrieve reveals it is
  // 'complete' — the money is captured, the webhook just hasn't landed yet.
  const prevExpire = expireCheckoutSessionImpl;
  const prevRetrieve = retrieveCheckoutSessionImpl;
  expireCheckoutSessionImpl = async () => { const e = new Error("Session is already complete"); throw e; };
  retrieveCheckoutSessionImpl = async (args) => ({ id: args.sessionId, status: "complete" });
  try {
    const waive = await api("POST", `/api/fines/${fineId}/waive`, {});
    assert.equal(waive.status, 409, "waive must refuse — the payer's money is captured");
  } finally {
    expireCheckoutSessionImpl = prevExpire;
    retrieveCheckoutSessionImpl = prevRetrieve;
  }
  // The payment row was left PENDING for the webhook to settle — never
  // force-failed, which used to drop the fulfilment and strand the money.
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [payId])).rows[0].status, "pending");
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_raceb", client_reference_id: payId, payment_intent: "pi_raceb" } },
  });
  assert.equal((await pool.query("SELECT status FROM fines WHERE id = $1", [fineId])).rows[0].status, "paid",
    "the late webhook settles normally — money and roster agree");
});
