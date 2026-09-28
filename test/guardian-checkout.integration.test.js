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
    requireEventManager, requireMeetEditor: setUser, requireClubAdmin: requireClubAdminOnly,
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

// B4-02: the membership card reads for whoever "Paying for" names.
test("the membership card answers for the dependent a guardian picked", async (t) => {
  if (!ready) return t.skip();
  acting = admin;
  const put = await api("PUT", `/api/orgs/${orgId}/membership-fee`, {
    prices: [{ amount_cents: 4000 }], currency: "GBP", tier: "card",
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  await pool.query(
    `INSERT INTO memberships (org_id, user_id, tier, period_start, period_end, status)
     VALUES ($1, $2, 'card', CURRENT_DATE, CURRENT_DATE + 300, 'active')`,
    [orgId, G],
  );
  acting = as(G);
  const forB = await api("GET", `/api/orgs/${orgId}/membership?tier=card&subject_user_id=${B}`);
  assert.equal(forB.status, 200, JSON.stringify(forB.body));
  assert.equal(forB.body.fee.already_member, false, "B isn't a member, whatever the guardian is");
  const own = await api("GET", `/api/orgs/${orgId}/membership?tier=card`);
  assert.equal(own.body.fee.already_member, true);

  acting = as(S);
  const probe = await api("GET", `/api/orgs/${orgId}/membership?tier=card&subject_user_id=${G}`);
  assert.equal(probe.status, 403, "not a way to look up somebody else's membership");
  acting = null;
  const anon = await api("GET", `/api/orgs/${orgId}/membership?tier=card&subject_user_id=${G}`);
  assert.equal(anon.status, 403);
  const junk = await api("GET", `/api/orgs/${orgId}/membership?tier=card&subject_user_id=nope`);
  assert.equal(junk.status, 403);
});

// B4-03: inside the last 30 days a grant can be renewed (the checkout
// allows it and the webhook extends from period_end), so the reads say so
// and the card keeps a Pay button next to "Member until".
test("membership, affiliation and accreditation reads flag the renewal window", async (t) => {
  if (!ready) return t.skip();
  acting = admin;
  assert.equal((await api("PUT", `/api/orgs/${orgId}/membership-fee`, {
    prices: [{ amount_cents: 4000 }], currency: "GBP", tier: "renew",
  })).status, 200);
  await pool.query(
    `INSERT INTO memberships (org_id, user_id, tier, period_start, period_end, status)
     VALUES ($1, $2, 'renew', CURRENT_DATE - 300, CURRENT_DATE + 10, 'active')`,
    [orgId, A],
  );
  await pool.query(
    `INSERT INTO memberships (org_id, user_id, tier, period_start, period_end, status)
     VALUES ($1, $2, 'renew', CURRENT_DATE, CURRENT_DATE + 200, 'active')`,
    [orgId, B],
  );
  acting = as(G);
  const soon = (await api("GET", `/api/orgs/${orgId}/membership?tier=renew&subject_user_id=${A}`)).body.fee;
  assert.equal(soon.already_member, true);
  assert.equal(soon.renewable, true, "ten days left: renewal is open");
  assert.ok(soon.period_end, "the card can say until when");
  const later = (await api("GET", `/api/orgs/${orgId}/membership?tier=renew&subject_user_id=${B}`)).body.fee;
  assert.equal(later.already_member, true);
  assert.equal(later.renewable, false);
  const none = (await api("GET", `/api/orgs/${orgId}/membership?tier=renew`)).body.fee;
  assert.equal(none.already_member, false);
  assert.equal(none.renewable, false);
  // And the checkout agrees with the flag.
  assert.equal((await api("POST", `/api/orgs/${orgId}/membership/checkout`, { subject_user_id: A, tier: "renew" })).status, 200);
  assert.equal((await api("POST", `/api/orgs/${orgId}/membership/checkout`, { subject_user_id: B, tier: "renew" })).status, 409);

  const club = (await pool.query(
    "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, $2, 'RNW') RETURNING id",
    [orgId, `Renew Club ${suffix}`],
  )).rows[0].id;
  acting = admin;
  assert.equal((await api("PUT", `/api/orgs/${orgId}/club-fee`, {
    kind: "affiliation", prices: [{ amount_cents: 10000 }], currency: "GBP",
  })).status, 200);
  await pool.query(
    `INSERT INTO club_affiliations (org_id, club_id, kind, period_start, period_end, status)
     VALUES ($1, $2, 'affiliation', CURRENT_DATE - 350, CURRENT_DATE + 5, 'active')`,
    [orgId, club],
  );
  const aff = (await api("GET", `/api/clubs/${club}/affiliation?kind=affiliation`)).body.fee;
  assert.equal(aff.active, true);
  assert.equal(aff.renewable, true);

  assert.equal((await api("PUT", `/api/orgs/${orgId}/official-fee`, {
    role_type: "judge", prices: [{ amount_cents: 3000 }], currency: "GBP",
  })).status, 200);
  await pool.query(
    `INSERT INTO official_accreditations (org_id, user_id, role_type, period_start, period_end, status)
     VALUES ($1, $2, 'judge', CURRENT_DATE - 100, CURRENT_DATE + 250, 'active')`,
    [orgId, S],
  );
  const acc = (await api("GET", `/api/orgs/${orgId}/official-accreditation?role_type=judge`)).body.fee;
  assert.equal(acc.active, true);
  assert.equal(acc.renewable, false, "months to go: not yet");
});

// B4-04: a refund gives back money already taken, so it runs on
// `configured`. Switching the payments flag off must not block it.
test("refunds still work with the payments flag switched off", async (t) => {
  if (!ready) return t.skip();
  const ev = await newEvent("Refund flag off");
  await setEntryFee(ev);
  acting = as(A);
  const co = await api("POST", `/api/events/${ev}/checkout`, {});
  assert.equal(co.status, 200, JSON.stringify(co.body));
  await completeWebhook(co.body.payment_id);

  flagOn = false;
  try {
    acting = admin;
    const r = await api("POST", `/api/payments/${co.body.payment_id}/refund`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "refunded");
    // New money still stops at the flag.
    acting = as(B);
    assert.equal((await api("POST", `/api/events/${ev}/checkout`, {})).status, 503);
  } finally {
    flagOn = true;
  }
});

// B4-11: "already paid" is about the beneficiary, and ?subject_user_id= is
// only for the beneficiary's guardian. A guardian's payment (payer =
// guardian, subject = child) never counted for the child, and anyone
// (anonymous too) could ask whether any user had paid.
test("already_paid counts a guardian's payment for the child, and nobody else can ask", async (t) => {
  if (!ready) return t.skip();
  const meet = (await pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, $2) RETURNING id", [orgId, `Paid meet ${suffix}`],
  )).rows[0].id;
  const ev = await newEvent("Paid 1m", meet);
  await setEntryFee(ev);
  acting = admin;
  assert.equal((await api("PUT", `/api/meets/${meet}/access-fee`, {
    kind: "programme", prices: [{ amount_cents: 500 }], currency: "GBP",
  })).status, 200);
  assert.equal((await api("PUT", `/api/meets/${meet}/bundle`, {
    event_ids: [ev], prices: [{ amount_cents: 3000 }], currency: "GBP",
  })).status, 200);
  acting = as(G);
  for (const [path, body] of [
    [`/api/events/${ev}/checkout`, { subject_user_id: A }],
    [`/api/meets/${meet}/access/checkout?kind=programme`, { subject_user_id: A }],
    [`/api/meets/${meet}/bundle/checkout`, { subject_user_id: A }],
  ]) {
    const co = await api("POST", path, body);
    assert.equal(co.status, 200, `${path} ${JSON.stringify(co.body)}`);
    await completeWebhook(co.body.payment_id);
  }
  const reads = [
    `/api/events/${ev}/fee`,
    `/api/meets/${meet}/access?kind=programme`,
    `/api/meets/${meet}/bundle`,
  ];
  const withSubject = (path, id) => `${path}${path.includes("?") ? "&" : "?"}subject_user_id=${id}`;
  for (const path of reads) {
    acting = as(G);
    const forA = await api("GET", withSubject(path, A));
    assert.equal(forA.status, 200, `${path} ${JSON.stringify(forA.body)}`);
    assert.equal(forA.body.fee.already_paid, true, `${path}: the guardian paid for A`);
    acting = as(A);
    assert.equal((await api("GET", path)).body.fee.already_paid, true, `${path}: A's own view`);
    acting = as(G);
    assert.equal((await api("GET", withSubject(path, B))).body.fee.already_paid, false, `${path}: B hasn't`);

    acting = as(S);
    assert.equal((await api("GET", withSubject(path, A))).status, 403, `${path}: not S's business`);
    acting = null;
    assert.equal((await api("GET", withSubject(path, A))).status, 403, `${path}: nor an anonymous caller's`);
    acting = as(G);
    assert.equal((await api("GET", withSubject(path, "not-a-uuid"))).status, 403, `${path}: malformed is a 403`);
  }
});

test("the entry price on a guardian's card is the dependent's, not the guardian's", async (t) => {
  if (!ready) return t.skip();
  const ev = await newEvent("Member price 3m");
  acting = admin;
  assert.equal((await api("PUT", `/api/events/${ev}/fee`, {
    prices: [{ amount_cents: 3000, audience: "non_member", label: "standard" }, { amount_cents: 2000, audience: "member", label: "member" }],
    currency: "GBP",
  })).status, 200);
  // The guardian is a member (earlier tests), this child isn't.
  const C = (await pool.query(
    "INSERT INTO users (username, full_name, org_id, date_of_birth) VALUES ($1, 'Kid C', $2, '2015-05-05') RETURNING id",
    [`gc-kidc-${suffix}`, orgId],
  )).rows[0].id;
  await pool.query(
    "INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status) VALUES ($1, $2, $3, 'approved')",
    [orgId, G, C],
  );
  acting = as(G);
  const own = (await api("GET", `/api/events/${ev}/fee`)).body.fee;
  assert.equal(own.price.amount_cents, 2000);
  const forC = (await api("GET", `/api/events/${ev}/fee?subject_user_id=${C}`)).body.fee;
  assert.equal(forC.is_member, false);
  assert.equal(forC.price.amount_cents, 3000, "what C's checkout will charge");
  const co = await api("POST", `/api/events/${ev}/checkout`, { subject_user_id: C });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  const amount = (await pool.query("SELECT amount_cents FROM payments WHERE id = $1", [co.body.payment_id])).rows[0].amount_cents;
  assert.equal(amount, 3000);
});

// B4-12: refunding one child's bundle un-grants that child's per-event
// entries, not every entry the same guardian bought with that bundle fee.
test("a full refund of one dependent's bundle leaves the sibling's entries alone", async (t) => {
  if (!ready) return t.skip();
  const meet = (await pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, $2) RETURNING id", [orgId, `Bundle refund ${suffix}`],
  )).rows[0].id;
  const e1 = await newEvent("Bundle 1m", meet);
  const e2 = await newEvent("Bundle 3m", meet);
  acting = admin;
  assert.equal((await api("PUT", `/api/meets/${meet}/bundle`, {
    event_ids: [e1, e2], prices: [{ amount_cents: 4000 }], currency: "GBP",
  })).status, 200);
  const bought = {};
  for (const who of [A, B, G]) {
    acting = as(G);
    const co = await api("POST", `/api/meets/${meet}/bundle/checkout`, who === G ? {} : { subject_user_id: who });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    await completeWebhook(co.body.payment_id);
    bought[who] = co.body.payment_id;
  }
  const entries = async () => (await pool.query(
    `SELECT COALESCE(subject_user_id, payer_user_id) AS who, status FROM payments
      WHERE event_id = ANY($1::uuid[]) AND subject_type = 'event_entry' AND amount_cents = 0`,
    [[e1, e2]],
  )).rows.reduce((m, r) => ({ ...m, [r.who]: [...(m[r.who] || []), r.status].sort() }), {});
  assert.deepEqual(await entries(), { [A]: ["paid", "paid"], [B]: ["paid", "paid"], [G]: ["paid", "paid"] });

  acting = admin;
  const rf = await api("POST", `/api/payments/${bought[A]}/refund`, {});
  assert.equal(rf.status, 200, JSON.stringify(rf.body));
  assert.deepEqual(await entries(), {
    [A]: ["refunded", "refunded"], [B]: ["paid", "paid"], [G]: ["paid", "paid"],
  });
});

// B4-13: the class checkout resumed whatever session was open for the
// enrolment. A guardian paying after the diver had opened checkout got the
// diver's session: the guardian's card paid a row naming the diver.
test("a guardian paying a class the diver opened checkout for gets their own session", async (t) => {
  if (!ready) return t.skip();
  const club = (await pool.query(
    "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, $2, 'CLS') RETURNING id",
    [orgId, `Class Club ${suffix}`],
  )).rows[0].id;
  const cls = (await pool.query(
    "INSERT INTO classes (club_id, org_id, name) VALUES ($1, $2, 'Squad') RETURNING id", [club, orgId],
  )).rows[0].id;
  const enrol = (await pool.query(
    `INSERT INTO class_enrolments (class_id, diver_user_id, club_id, org_id, status, amount_cents, currency)
     VALUES ($1, $2, $3, $4, 'pending', 6000, 'GBP') RETURNING id`,
    [cls, A, club, orgId],
  )).rows[0].id;

  acting = as(A);
  const kid = await api("POST", `/api/me/class-enrolments/${enrol}/checkout`, {});
  assert.equal(kid.status, 200, JSON.stringify(kid.body));
  // The same person again resumes, as before.
  const kidAgain = await api("POST", `/api/me/class-enrolments/${enrol}/checkout`, {});
  assert.equal(kidAgain.body.payment_id, kid.body.payment_id);

  acting = as(G);
  const parent = await api("POST", `/api/me/class-enrolments/${enrol}/checkout`, {});
  assert.equal(parent.status, 200, JSON.stringify(parent.body));
  assert.notEqual(parent.body.payment_id, kid.body.payment_id);
  assert.ok(!parent.body.resumed);
  const rows = (await pool.query(
    "SELECT payer_user_id, subject_user_id, status FROM payments WHERE class_enrolment_id = $1 ORDER BY created_at", [enrol],
  )).rows;
  assert.deepEqual(rows.map((r) => [r.payer_user_id, r.subject_user_id, r.status]), [[A, null, "failed"], [G, A, "pending"]]);

  // Once it's paid, nobody opens another.
  await completeWebhook(parent.body.payment_id);
  acting = as(A);
  assert.equal((await api("POST", `/api/me/class-enrolments/${enrol}/checkout`, {})).status, 409);
});
