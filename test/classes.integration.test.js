// Integration tests for club training-classes (routes/classes.js) against a
// real Postgres. Uses the REAL middleware (createMiddleware) + real JWTs so
// the CLUB-PRIVATE access control is genuinely exercised — the crux of the
// feature is that a federation org_admin must NOT reach a club's classes.
//
// Self-skips when Postgres is unreachable, JWT_SECRET is unset, or migration
// 077 hasn't been applied.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

require("dotenv").config();

const createMiddleware = require("../lib/middleware");
const createClassesRouter = require("../routes/classes");
const createPaymentsRouter = require("../routes/payments");
const createStripeWebhook = require("../routes/stripe-webhook");

const silent = { warn() {}, error() {}, info() {} };
const suffix = crypto.randomUUID().slice(0, 8);
const JWT_SECRET = process.env.JWT_SECRET;

// Fake Stripe — captures args, returns canned objects. Mirrors the harness
// in test/payments.integration.test.js; a real Stripe key is never needed.
let lastCheckoutArgs = null;
// Indirection so a single test can swap the expire behaviour (e.g. to
// simulate a webhook landing DURING the network round-trip) without
// touching every other test's happy-path mock.
let lastExpireArgs = null;
let expireCheckoutSessionImpl = async (args) => { lastExpireArgs = args; return { status: "expired" }; };
let retrieveCheckoutSessionImpl = async (args) => ({ id: args.sessionId, status: "open", url: "https://stripe.test/resume" });
const fakePayments = {
  enabled: true,
  // Real-length session ids (~66 chars) — see the note in
  // test/payments.integration.test.js; guards the migration-079 fix.
  createCheckoutSession: async (args) => {
    lastCheckoutArgs = args;
    return {
      id: ("cs_test_" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")).slice(0, 66),
      url: "https://stripe.test/pay",
    };
  },
  expireCheckoutSession: (...args) => expireCheckoutSessionImpl(...args),
  retrieveCheckoutSession: (...args) => retrieveCheckoutSessionImpl(...args),
  createRefund: async (args) => ({ amount: args.amountCents }),
  constructWebhookEvent: (raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : raw),
};

let pool;
let ready = false;
let server;
let base;
let orgId, org2Id, clubId, otherClubId, classId, priceMonthlyId;
const U = {};

function tokenFor(u) {
  return jwt.sign(
    { id: u.id, org_id: u.org_id, org_roles: u.org_roles, is_system_admin: !!u.is_system_admin, tv: u.tv },
    JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
}

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function seedUser(name, roles, club, org = orgId) {
  const u = (await pool.query(
    "INSERT INTO users (username, full_name, org_id, club_id) VALUES ($1, $2, $3, $4) RETURNING id, token_version",
    [`${name}-${suffix}`, name, org, club || null],
  )).rows[0];
  for (const role of roles) {
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)", [u.id, org, role]);
  }
  return { id: u.id, tv: u.token_version, org_id: org, org_roles: roles, is_system_admin: false };
}

before(async () => {
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user: process.env.DB_USER || process.env.PGUSER,
        host: process.env.DB_HOST || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port: process.env.DB_PORT || process.env.PGPORT,
      });
  try { await pool.query("SELECT 1"); } catch { console.warn("[skip] classes: Postgres unreachable"); return; }
  if (!JWT_SECRET || JWT_SECRET === "change_this_secret_in_production") { console.warn("[skip] classes: JWT_SECRET unset"); return; }
  try { await pool.query("SELECT 1 FROM classes LIMIT 1"); } catch { console.warn("[skip] classes: migration 077 not applied"); return; }

  const mkOrg = async (n) => (await pool.query(
    `INSERT INTO organisations (name, slug, default_currency, platform_fee_bps)
     VALUES ($1, $2, 'GBP', 1500) RETURNING id`,
    [n, n.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
  )).rows[0].id;
  orgId = await mkOrg(`Classes Org ${suffix}`);
  org2Id = await mkOrg(`Other Org ${suffix}`);
  clubId = (await pool.query("INSERT INTO clubs (org_id, name, short_code) VALUES ($1, $2, 'CLB') RETURNING id", [orgId, `Club ${suffix}`])).rows[0].id;
  otherClubId = (await pool.query("INSERT INTO clubs (org_id, name, short_code) VALUES ($1, $2, 'OTH') RETURNING id", [orgId, `Other ${suffix}`])).rows[0].id;

  U.clubAdmin = await seedUser("clubadmin", [], clubId);
  await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [clubId, U.clubAdmin.id, orgId]);
  U.coach = await seedUser("coach", ["coach"], clubId);
  U.diver1 = await seedUser("diver1", ["diver"], clubId);
  U.diver2 = await seedUser("diver2", ["diver"], clubId);
  U.fedAdmin = await seedUser("fedadmin", ["org_admin"], null);
  U.otherAdmin = await seedUser("otheradmin", [], otherClubId);
  await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [otherClubId, U.otherAdmin.id, orgId]);
  U.foreignDiver = await seedUser("foreign", ["diver"], null, org2Id);

  const app = express();
  app.use((req, res, next) =>
    req.path === "/webhooks/stripe" ? next() : express.json()(req, res, next));
  const mw = createMiddleware({ pool, JWT_SECRET });
  app.use(createClassesRouter({
    pool, verifyToken: mw.verifyToken, requireClubAdminOnly: mw.requireClubAdminOnly,
    logger: silent, payments: fakePayments,
  }));
  // The refund endpoint lives in the payments router; mount it with the
  // REAL verifyToken so the club-private refund authorisation (club admin
  // yes, federation org_admin no) is genuinely exercised. The role-gated
  // fee/config routes aren't used by this suite — passthrough stubs.
  const stubGate = () => (req, res, next) => mw.verifyToken(req, res, next);
  app.use(createPaymentsRouter({
    pool,
    verifyToken: mw.verifyToken,
    optionalAuth: mw.verifyToken,
    requireOrgRole: stubGate,
    requireEventManager: stubGate,
    requireMeetEditor: (req, res, next) => mw.verifyToken(req, res, next),
    requireClubAdmin: stubGate,
    logger: silent, payments: fakePayments,
  }));
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }),
    createStripeWebhook({ pool, logger: silent, payments: fakePayments }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  ready = true;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) {
    for (const id of [orgId, org2Id]) {
      if (!id) continue;
      // payments.org_id is ON DELETE RESTRICT (so a payer never loses their
      // own receipt just because an org is torn down elsewhere) — without
      // deleting these first, DELETE FROM organisations below silently fails
      // via the .catch(), orphaning the org AND leaving stripe_payment_intent
      // literals (e.g. "pi_test") permanently squatting on idx_payments_pi
      // for every future test run.
      await pool.query("DELETE FROM payments WHERE org_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM classes WHERE org_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM club_admins WHERE org_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM user_org_roles WHERE org_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE org_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM clubs WHERE org_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM organisations WHERE id = $1", [id]).catch(() => {});
    }
    await pool.end();
  }
});

// ---- context discovery ------------------------------------------
test("GET /api/me/club-admin-clubs returns only the caller's own club-admin rows", async (t) => {
  if (!ready) return t.skip();
  const mine = await api("GET", "/api/me/club-admin-clubs", null, tokenFor(U.clubAdmin));
  assert.equal(mine.status, 200);
  assert.ok(mine.body.some((c) => c.id === clubId));
  assert.ok(!mine.body.some((c) => c.id === otherClubId), "doesn't see a club they don't admin");
  const notAdmin = await api("GET", "/api/me/club-admin-clubs", null, tokenFor(U.diver1));
  assert.equal(notAdmin.status, 200);
  assert.equal(notAdmin.body.length, 0);
});

// ---- club-private access control (the crux) --------------------
test("federation org_admin is BLOCKED from a club's classes (club-private)", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.fedAdmin);
  assert.equal((await api("GET", `/api/clubs/${clubId}/classes`, null, tok)).status, 403);
  assert.equal((await api("POST", `/api/clubs/${clubId}/classes`, { name: "Sneaky" }, tok)).status, 403);
});

test("an admin of a DIFFERENT club is blocked", async (t) => {
  if (!ready) return t.skip();
  assert.equal((await api("GET", `/api/clubs/${clubId}/classes`, null, tokenFor(U.otherAdmin))).status, 403);
});

test("a coach cannot manage classes; a diver cannot either", async (t) => {
  if (!ready) return t.skip();
  assert.equal((await api("POST", `/api/clubs/${clubId}/classes`, { name: "x" }, tokenFor(U.coach))).status, 403);
  assert.equal((await api("GET", `/api/clubs/${clubId}/classes`, null, tokenFor(U.diver1))).status, 403);
});

test("unauthenticated requests are rejected", async (t) => {
  if (!ready) return t.skip();
  const s = (await api("GET", `/api/clubs/${clubId}/classes`, null, null)).status;
  assert.ok(s === 401 || s === 403, `expected 401/403, got ${s}`);
});

test("GET /api/clubs/:id/members lists the club's own divers (club-private)", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/clubs/${clubId}/members`, null, tokenFor(U.clubAdmin));
  assert.equal(res.status, 200);
  assert.ok(res.body.some((m) => m.id === U.diver1.id));
  assert.ok(!res.body.some((m) => m.id === U.foreignDiver.id));
  assert.equal((await api("GET", `/api/clubs/${clubId}/members`, null, tokenFor(U.fedAdmin))).status, 403);
});

// ---- club admin manages classes --------------------------------
test("club admin creates a class with price options", async (t) => {
  if (!ready) return t.skip();
  const res = await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Junior Squad", level: "Beginner", schedule: "Mon & Wed 6-7pm", capacity: 12,
    price_options: [
      { label: "Monthly", amount_cents: 4000, currency: "GBP" },
      { label: "Per term", amount_cents: 12000, currency: "gbp" },
    ],
  }, tokenFor(U.clubAdmin));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.id);
  assert.equal(res.body.price_options.length, 2);
  classId = res.body.id;
  priceMonthlyId = res.body.price_options.find((p) => p.label === "Monthly").id;
  assert.ok(priceMonthlyId);
});

test("class create validates name + price options", async (t) => {
  if (!ready) return t.skip();
  assert.equal((await api("POST", `/api/clubs/${clubId}/classes`, { name: "  " }, tokenFor(U.clubAdmin))).status, 400);
  assert.equal((await api("POST", `/api/clubs/${clubId}/classes`,
    { name: "Bad", price_options: [{ label: "x", amount_cents: -5, currency: "GBP" }] }, tokenFor(U.clubAdmin))).status, 400);
});

test("club admin lists classes with counts + prices", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/clubs/${clubId}/classes`, null, tokenFor(U.clubAdmin));
  assert.equal(res.status, 200);
  const cls = res.body.find((c) => c.id === classId);
  assert.ok(cls);
  assert.equal(cls.enrolment_count, 0);
  assert.equal(cls.price_options.length, 2);
});

// ---- enrolment management --------------------------------------
test("club admin enrols a diver; duplicates + bad input rejected", async (t) => {
  if (!ready) return t.skip();
  const ok = await api("POST", `/api/clubs/${clubId}/classes/${classId}/enrolments`,
    { diver_user_id: U.diver1.id, price_option_id: priceMonthlyId, discount_cents: 500 }, tokenFor(U.clubAdmin));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // duplicate
  assert.equal((await api("POST", `/api/clubs/${clubId}/classes/${classId}/enrolments`,
    { diver_user_id: U.diver1.id }, tokenFor(U.clubAdmin))).status, 409);
  // discount > price
  assert.equal((await api("POST", `/api/clubs/${clubId}/classes/${classId}/enrolments`,
    { diver_user_id: U.diver2.id, price_option_id: priceMonthlyId, discount_cents: 999999 }, tokenFor(U.clubAdmin))).status, 400);
  // diver from another federation
  assert.equal((await api("POST", `/api/clubs/${clubId}/classes/${classId}/enrolments`,
    { diver_user_id: U.foreignDiver.id }, tokenFor(U.clubAdmin))).status, 400);
});

test("roster shows the enrolled diver (club admin)", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", `/api/clubs/${clubId}/classes/${classId}/roster`, null, tokenFor(U.clubAdmin));
  assert.equal(res.status, 200);
  const row = res.body.find((r) => r.diver_id === U.diver1.id);
  assert.ok(row);
  assert.equal(row.discount_cents, 500);
  assert.equal(row.amount_cents, 4000);
});

// ---- coach read-only view --------------------------------------
test("coach sees the club's classes + roster (read-only)", async (t) => {
  if (!ready) return t.skip();
  const res = await api("GET", "/api/coach/classes", null, tokenFor(U.coach));
  assert.equal(res.status, 200);
  const cls = res.body.find((c) => c.id === classId);
  assert.ok(cls, "coach sees the class");
  assert.ok(cls.enrolments.some((e) => e.diver_id === U.diver1.id), "coach sees who's enrolled");
});

test("a non-coach gets nothing from the coach endpoint", async (t) => {
  if (!ready) return t.skip();
  assert.equal((await api("GET", "/api/coach/classes", null, tokenFor(U.diver1))).status, 403);
});

// ---- diver: own data only + self-enrol -------------------------
test("diver sees only their OWN enrolments", async (t) => {
  if (!ready) return t.skip();
  const mine = await api("GET", "/api/me/classes", null, tokenFor(U.diver1));
  assert.equal(mine.status, 200);
  assert.ok(mine.body.some((e) => e.class_id === classId));
  // diver2 (not enrolled) sees none of diver1's rows.
  const theirs = await api("GET", "/api/me/classes", null, tokenFor(U.diver2));
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.length, 0);
});

test("diver browses + self-enrols into their own club's class (pending)", async (t) => {
  if (!ready) return t.skip();
  const avail = await api("GET", "/api/me/available-classes", null, tokenFor(U.diver2));
  assert.equal(avail.status, 200);
  const cls = avail.body.find((c) => c.id === classId);
  assert.ok(cls, "diver2 sees the class in their club");
  assert.equal(cls.already_enrolled, false);
  const enr = await api("POST", `/api/me/classes/${classId}/enrol`, { price_option_id: priceMonthlyId }, tokenFor(U.diver2));
  assert.equal(enr.status, 201, JSON.stringify(enr.body));
  assert.equal(enr.body.status, "pending"); // priced class → awaits payment
  // second self-enrol is blocked by the one-live-enrolment unique index
  assert.equal((await api("POST", `/api/me/classes/${classId}/enrol`, { price_option_id: priceMonthlyId }, tokenFor(U.diver2))).status, 409);
});

test("a diver in another federation cannot self-enrol here", async (t) => {
  if (!ready) return t.skip();
  // The class isn't in their club (they have none in this federation) — blocked.
  const s = (await api("POST", `/api/me/classes/${classId}/enrol`, {}, tokenFor(U.foreignDiver))).status;
  assert.ok(s === 404 || s === 400, `expected blocked (404/400), got ${s}`);
});

// ---- lifecycle: update + cancel --------------------------------
test("club admin cancels an enrolment, freeing the slot", async (t) => {
  if (!ready) return t.skip();
  const roster = await api("GET", `/api/clubs/${clubId}/classes/${classId}/roster`, null, tokenFor(U.clubAdmin));
  const enr = roster.body.find((r) => r.diver_id === U.diver1.id);
  assert.equal((await api("DELETE", `/api/clubs/${clubId}/classes/${classId}/enrolments/${enr.id}`, null, tokenFor(U.clubAdmin))).status, 200);
  // diver1 can now be re-enrolled (cancelled row freed the unique slot)
  assert.equal((await api("POST", `/api/clubs/${clubId}/classes/${classId}/enrolments`,
    { diver_user_id: U.diver1.id }, tokenFor(U.clubAdmin))).status, 201);
});

test("PUT enrolment re-validates a stale discount when the price is lowered", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Downgrade test",
    price_options: [
      { label: "Cheap", amount_cents: 4000, currency: "GBP" },
      { label: "Pricey", amount_cents: 12000, currency: "GBP" },
    ],
  }, tok)).body;
  const cheap = cls.price_options.find((p) => p.label === "Cheap").id;
  const pricey = cls.price_options.find((p) => p.label === "Pricey").id;
  const enr = (await api("POST", `/api/clubs/${clubId}/classes/${cls.id}/enrolments`,
    { diver_user_id: U.diver2.id, price_option_id: pricey, discount_cents: 5000 }, tok)).body;
  assert.ok(enr.id);
  // Switch to the cheaper option WITHOUT resending discount: the stale 5000
  // discount now exceeds the 4000 price and must be rejected.
  const res = await api("PUT", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enr.id}`,
    { price_option_id: cheap }, tok);
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

// ---- enrolment payments (fake Stripe) ----------------------------
test("diver checks out a priced pending enrolment; webhook activates it", async (t) => {
  if (!ready) return t.skip();
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Checkout Class",
    price_options: [{ label: "Monthly", amount_cents: 3000, currency: "GBP" }],
  }, tokenFor(U.clubAdmin))).body;
  const priceId = cls.price_options[0].id;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: priceId }, tokenFor(U.diver1));
  assert.equal(enrol.body.status, "pending");
  const enrolId = enrol.body.id;

  const co = await api("POST", `/api/me/class-enrolments/${enrolId}/checkout`, {}, tokenFor(U.diver1));
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.ok(co.body.url);
  const paymentId = co.body.payment_id;

  const pay = (await pool.query("SELECT * FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(pay.subject_type, "class_enrolment");
  assert.equal(pay.recipient_type, "club");
  assert.equal(pay.club_id, clubId);
  assert.equal(pay.class_enrolment_id, enrolId);
  assert.equal(pay.amount_cents, 3000);
  assert.equal(pay.platform_fee_cents, 450); // 15% of 3000

  const wh = await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_test", client_reference_id: paymentId, payment_intent: "pi_test" } },
  }, null);
  assert.equal(wh.status, 200);

  const enrRow = (await pool.query("SELECT status, payment_id FROM class_enrolments WHERE id = $1", [enrolId])).rows[0];
  assert.equal(enrRow.status, "active");
  assert.equal(enrRow.payment_id, paymentId);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [paymentId])).rows[0].status, "paid");
});

test("checkout is forbidden for someone else's enrolment", async (t) => {
  if (!ready) return t.skip();
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Forbidden Class", price_options: [{ label: "Fee", amount_cents: 1000, currency: "GBP" }],
  }, tokenFor(U.clubAdmin))).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const res = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver2));
  assert.equal(res.status, 403);
});

test("checkout on a non-pending enrolment is rejected", async (t) => {
  if (!ready) return t.skip();
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, { name: "Free Class" }, tokenFor(U.clubAdmin))).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, {}, tokenFor(U.diver1));
  assert.equal(enrol.body.status, "active"); // no price -> instantly active
  const res = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  assert.equal(res.status, 409);
});

test("a fully-discounted pending enrolment activates without opening a Stripe session", async (t) => {
  if (!ready) return t.skip();
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Discount Class", price_options: [{ label: "Fee", amount_cents: 2000, currency: "GBP" }],
  }, tokenFor(U.clubAdmin))).body;
  const priceId = cls.price_options[0].id;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: priceId }, tokenFor(U.diver1));
  assert.equal(enrol.body.status, "pending");
  // Club admin applies a discount that fully covers the price.
  await api("PUT", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`,
    { discount_cents: 2000 }, tokenFor(U.clubAdmin));
  const res = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.url, undefined, "no Stripe session opened for a $0 charge");
});

test("a second checkout attempt while one is in flight is blocked", async (t) => {
  if (!ready) return t.skip();
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "In-flight Class", price_options: [{ label: "Fee", amount_cents: 1500, currency: "GBP" }],
  }, tokenFor(U.clubAdmin))).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const first = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  assert.equal(first.status, 200);
  const second = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  assert.equal(second.status, 200);
  assert.equal(second.body.url, "https://stripe.test/resume", "the still-open session is resumed, not duplicated");
  assert.equal(second.body.payment_id, first.body.payment_id, "no new payment row was created");
});

test("webhook full refund reverts an active enrolment to pending and clears payment_id", async (t) => {
  if (!ready) return t.skip();
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Refund Class", price_options: [{ label: "Fee", amount_cents: 5000, currency: "GBP" }],
  }, tokenFor(U.clubAdmin))).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_refund", client_reference_id: co.body.payment_id, payment_intent: "pi_refund" } },
  }, null);
  assert.equal((await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0].status, "active");

  await api("POST", "/webhooks/stripe", {
    type: "charge.refunded",
    data: { object: { payment_intent: "pi_refund", amount_refunded: 5000 } },
  }, null);
  const after = (await pool.query("SELECT status, payment_id FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0];
  assert.equal(after.status, "pending");
  assert.equal(after.payment_id, null);
  assert.equal((await pool.query(
    "SELECT status FROM payments WHERE class_enrolment_id = $1 ORDER BY created_at DESC LIMIT 1", [enrol.body.id],
  )).rows[0].status, "refunded");
});

// ---- club payouts (club-private) ---------------------------------
test("club payout status/details/withdrawals are club-private (federation blocked)", async (t) => {
  if (!ready) return t.skip();
  for (const [method, path, body] of [
    ["GET", `/api/clubs/${clubId}/payments/status`, null],
    ["PUT", `/api/clubs/${clubId}/payout-details`, { account_name: "x", account_details: "y" }],
    ["GET", `/api/clubs/${clubId}/withdrawals`, null],
    ["POST", `/api/clubs/${clubId}/withdrawals`, {}],
  ]) {
    const res = await api(method, path, body, tokenFor(U.fedAdmin));
    assert.equal(res.status, 403, `${method} ${path} expected 403, got ${res.status}`);
  }
});

test("club admin saves payout details, sees balance, and withdraws (one payout, club_id set)", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const save = await api("PUT", `/api/clubs/${clubId}/payout-details`,
    { account_name: "Club Account", account_details: "GB00 CLUB 0000" }, tok);
  assert.equal(save.status, 200);

  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Payout Class", price_options: [{ label: "Fee", amount_cents: 8000, currency: "GBP" }],
  }, tok)).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver2));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver2));
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_payout", client_reference_id: co.body.payment_id, payment_intent: "pi_payout" } },
  }, null);

  const status = await api("GET", `/api/clubs/${clubId}/payments/status`, null, tok);
  assert.equal(status.status, 200);
  assert.equal(status.body.payout_details_set, true);
  assert.ok(status.body.balance_cents >= 6800, JSON.stringify(status.body)); // 8000 - 15% = 6800

  const wd = await api("POST", `/api/clubs/${clubId}/withdrawals`, {}, tok);
  assert.equal(wd.status, 201, JSON.stringify(wd.body));
  assert.equal(wd.body[0].status, "pending");
  const row = (await pool.query("SELECT club_id, org_id FROM payouts WHERE id = $1", [wd.body[0].id])).rows[0];
  assert.equal(row.org_id, null);
  assert.equal(row.club_id, clubId);
});

test("cancelling an enrolment with an in-flight checkout retires the payment; a late webhook can't reactivate it", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Cancel Race Class", price_options: [{ label: "Fee", amount_cents: 2500, currency: "GBP" }],
  }, tok)).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  assert.equal(co.status, 200);
  const paymentId = co.body.payment_id;
  const beforePay = (await pool.query("SELECT status, stripe_checkout_session FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(beforePay.status, "pending");

  lastExpireArgs = null;
  const del = await api("DELETE", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`, null, tok);
  assert.equal(del.status, 200);
  assert.equal((await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0].status, "cancelled");
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [paymentId])).rows[0].status, "failed",
    "the in-flight payment was retired (marked failed) by the cancellation");
  assert.ok(lastExpireArgs, "Stripe was actually asked to expire the session");
  assert.equal(lastExpireArgs.sessionId, beforePay.stripe_checkout_session, "the CORRECT stale session was expired");

  // A late webhook delivery for the now-retired session means the payer's
  // money WAS captured for something that no longer exists. It must never
  // reactivate the enrolment — and the charge is refunded automatically so
  // the money isn't silently stranded on a 'failed' row.
  const wh = await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_stale", client_reference_id: paymentId, payment_intent: "pi_stale_cancel" } },
  }, null);
  assert.equal(wh.status, 200);
  assert.equal((await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0].status, "cancelled",
    "the stale webhook did not reactivate the cancelled enrolment");
  const after = (await pool.query("SELECT status, refunded_amount_cents, amount_cents FROM payments WHERE id = $1", [paymentId])).rows[0];
  assert.equal(after.status, "refunded",
    "the captured charge for the retired checkout was automatically refunded");
  assert.equal(after.refunded_amount_cents, after.amount_cents, "refunded in full");
});

test("cancelling an already-paid enrolment is rejected, not silently overwritten", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Already Paid Class", price_options: [{ label: "Fee", amount_cents: 1800, currency: "GBP" }],
  }, tok)).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_paid_first", client_reference_id: co.body.payment_id, payment_intent: "pi_paid_first" } },
  }, null);
  assert.equal((await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0].status, "active");

  const del = await api("DELETE", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`, null, tok);
  assert.equal(del.status, 409, JSON.stringify(del.body));
  assert.equal((await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0].status, "active",
    "the paid enrolment was NOT cancelled underneath the successful payment");
});

test("editing the price option on a pending enrolment retires a stale in-flight checkout", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Reprice Class",
    price_options: [
      { label: "Cheap", amount_cents: 1000, currency: "GBP" },
      { label: "Pricey", amount_cents: 5000, currency: "GBP" },
    ],
  }, tok)).body;
  const cheap = cls.price_options.find((p) => p.label === "Cheap").id;
  const pricey = cls.price_options.find((p) => p.label === "Pricey").id;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cheap }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  assert.equal(co.status, 200);
  const stalePaymentId = co.body.payment_id;
  const beforePay = (await pool.query("SELECT status, stripe_checkout_session FROM payments WHERE id = $1", [stalePaymentId])).rows[0];
  assert.equal(beforePay.status, "pending");

  // Admin reprices the still-pending enrolment.
  lastExpireArgs = null;
  const put = await api("PUT", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`,
    { price_option_id: pricey }, tok);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [stalePaymentId])).rows[0].status, "failed",
    "the stale (old-price) checkout was retired by the reprice");
  assert.ok(lastExpireArgs, "Stripe was actually asked to expire the stale-price session");
  assert.equal(lastExpireArgs.sessionId, beforePay.stripe_checkout_session);

  // The stale session completing afterward must not activate at the old price.
  const wh = await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_stale_reprice", client_reference_id: stalePaymentId, payment_intent: "pi_stale_reprice" } },
  }, null);
  assert.equal(wh.status, 200);
  const after = (await pool.query("SELECT status, amount_cents FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0];
  assert.equal(after.status, "pending", "still awaiting a fresh checkout at the new price");
  assert.equal(after.amount_cents, 5000);
});

test("editing the discount on a pending enrolment retires a stale in-flight checkout", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Redisc Class", price_options: [{ label: "Fee", amount_cents: 4000, currency: "GBP" }],
  }, tok)).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  const stalePaymentId = co.body.payment_id;

  const put = await api("PUT", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`,
    { discount_cents: 1000 }, tok);
  assert.equal(put.status, 200);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [stalePaymentId])).rows[0].status, "failed");
});

test("manually activating a pending enrolment retires any in-flight checkout (prevents a double charge)", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Manual Activate Class", price_options: [{ label: "Fee", amount_cents: 3000, currency: "GBP" }],
  }, tok)).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  const stalePaymentId = co.body.payment_id;
  const beforePay = (await pool.query("SELECT stripe_checkout_session FROM payments WHERE id = $1", [stalePaymentId])).rows[0];

  // Admin marks the enrolment active directly (e.g. collected payment offline).
  lastExpireArgs = null;
  const put = await api("PUT", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`,
    { status: "active" }, tok);
  assert.equal(put.status, 200);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [stalePaymentId])).rows[0].status, "failed",
    "the stale online checkout was retired so the diver can't be charged again for an already-resolved enrolment");
  assert.ok(lastExpireArgs, "Stripe was actually asked to expire the stale online session");
  assert.equal(lastExpireArgs.sessionId, beforePay.stripe_checkout_session);

  // A late webhook for the retired session means the diver's card WAS
  // charged for an enrolment the admin already resolved offline — the exact
  // double-charge this guard exists for. The enrolment must be untouched
  // and the captured duplicate charge automatically refunded.
  const wh = await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_double_charge", client_reference_id: stalePaymentId, payment_intent: "pi_double_charge" } },
  }, null);
  assert.equal(wh.status, 200);
  const after = (await pool.query("SELECT status, refunded_amount_cents, amount_cents FROM payments WHERE id = $1", [stalePaymentId])).rows[0];
  assert.equal(after.status, "refunded", "the double charge was automatically refunded");
  assert.equal(after.refunded_amount_cents, after.amount_cents);
  assert.equal((await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0].status, "active");
});

test("editing an already-active (paid) enrolment's price/discount is a normal, unguarded edit", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Race Edit Class", price_options: [{ label: "Fee", amount_cents: 2200, currency: "GBP" }],
  }, tok)).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_race_edit", client_reference_id: co.body.payment_id, payment_intent: "pi_race_edit" } },
  }, null);
  assert.equal((await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0].status, "active");

  // Note: at this point the DB row is 'active', so this PUT wouldn't even
  // reach the retire guard (enr.status !== 'pending') — this instead proves
  // editing an already-settled enrolment is a normal, unguarded update (no
  // stale in-flight payment exists to protect against), and does not error.
  const put = await api("PUT", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`,
    { discount_cents: 500 }, tok);
  assert.equal(put.status, 200);
});

test("a webhook landing DURING the retire's Stripe round-trip is still detected — no clobber", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "TOCTOU Class", price_options: [{ label: "Fee", amount_cents: 6000, currency: "GBP" }],
  }, tok)).body;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  assert.equal(co.status, 200);
  const paymentId = co.body.payment_id;

  // Simulate the exact race the review found: the webhook delivery lands
  // WHILE retireInFlightClassEnrolmentPayment is awaiting the Stripe expire
  // call, settling the payment to 'paid' + activating the enrolment BEFORE
  // the retire helper's own "mark failed" UPDATE runs.
  const prevImpl = expireCheckoutSessionImpl;
  expireCheckoutSessionImpl = async (...args) => {
    await api("POST", "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_race", client_reference_id: paymentId, payment_intent: "pi_toctou_race" } },
    }, null);
    return { status: "expired" };
  };
  try {
    const del = await api("DELETE", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`, null, tok);
    assert.equal(del.status, 409, JSON.stringify(del.body));
  } finally {
    expireCheckoutSessionImpl = prevImpl;
  }

  const finalEnr = (await pool.query("SELECT status, payment_id FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0];
  assert.equal(finalEnr.status, "active", "the webhook's activation was NOT clobbered by the cancellation");
  assert.equal(finalEnr.payment_id, paymentId);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [paymentId])).rows[0].status, "paid",
    "the payment that won the race stays paid, not incorrectly marked failed");
});

test("the same webhook-during-retire race is caught on the PUT edit path too", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "TOCTOU Edit Class",
    price_options: [
      { label: "Cheap", amount_cents: 1500, currency: "GBP" },
      { label: "Pricey", amount_cents: 9000, currency: "GBP" },
    ],
  }, tok)).body;
  const cheap = cls.price_options.find((p) => p.label === "Cheap").id;
  const pricey = cls.price_options.find((p) => p.label === "Pricey").id;
  const enrol = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cheap }, tokenFor(U.diver1));
  const co = await api("POST", `/api/me/class-enrolments/${enrol.body.id}/checkout`, {}, tokenFor(U.diver1));
  const paymentId = co.body.payment_id;

  const prevImpl = expireCheckoutSessionImpl;
  expireCheckoutSessionImpl = async (...args) => {
    await api("POST", "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_race2", client_reference_id: paymentId, payment_intent: "pi_toctou_race_2" } },
    }, null);
    return { status: "expired" };
  };
  try {
    const put = await api("PUT", `/api/clubs/${clubId}/classes/${cls.id}/enrolments/${enrol.body.id}`,
      { price_option_id: pricey }, tok);
    assert.equal(put.status, 409, JSON.stringify(put.body));
  } finally {
    expireCheckoutSessionImpl = prevImpl;
  }

  const finalEnr = (await pool.query("SELECT status, price_option_id, amount_cents FROM class_enrolments WHERE id = $1", [enrol.body.id])).rows[0];
  assert.equal(finalEnr.status, "active");
  assert.equal(finalEnr.price_option_id, cheap, "the admin's stale reprice did NOT overwrite the price the diver actually paid");
  assert.equal(finalEnr.amount_cents, 1500);
});

// ---- free-class hole regressions (pre-deploy audit) ---------------
// Two API calls used to get a diver an ACTIVE spot in any priced class for
// nothing: self-enrol WITHOUT a price_option_id (row lands pending with
// amount_cents NULL) then checkout (NULL || 0 → 0 → "nothing to charge" →
// instant activate). Both halves are now closed.

test("self-enrol into a priced class requires a price option", async (t) => {
  if (!ready) return t.skip();
  const d = await seedUser("freeloader", ["diver"], clubId);
  const res = await api("POST", `/api/me/classes/${classId}/enrol`, {}, tokenFor(d));
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test("a price-less pending enrolment cannot be activated free via checkout", async (t) => {
  if (!ready) return t.skip();
  const d = await seedUser("unpriced", ["diver"], clubId);
  // The other way a NULL-amount pending row arises: the club admin adds the
  // diver to the roster without a price (active) and later flips it pending.
  const enr = await api("POST", `/api/clubs/${clubId}/classes/${classId}/enrolments`,
    { diver_user_id: d.id }, tokenFor(U.clubAdmin));
  assert.equal(enr.status, 201, JSON.stringify(enr.body));
  const upd = await api("PUT", `/api/clubs/${clubId}/classes/${classId}/enrolments/${enr.body.id}`,
    { status: "pending" }, tokenFor(U.clubAdmin));
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const co = await api("POST", `/api/me/class-enrolments/${enr.body.id}/checkout`, {}, tokenFor(d));
  assert.equal(co.status, 409, JSON.stringify(co.body));
  const row = (await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enr.body.id])).rows[0];
  assert.equal(row.status, "pending", "not silently activated for free");
});

test("a Stripe failure during class checkout frees the payment slot for retry", async (t) => {
  if (!ready) return t.skip();
  const d = await seedUser("retryer", ["diver"], clubId);
  const enr = await api("POST", `/api/me/classes/${classId}/enrol`,
    { price_option_id: priceMonthlyId }, tokenFor(d));
  assert.equal(enr.status, 201, JSON.stringify(enr.body));
  // First attempt: Stripe blows up AFTER the pending payment row is inserted.
  const orig = fakePayments.createCheckoutSession;
  fakePayments.createCheckoutSession = async () => { throw new Error("stripe down"); };
  let res;
  try {
    res = await api("POST", `/api/me/class-enrolments/${enr.body.id}/checkout`, {}, tokenFor(d));
  } finally {
    fakePayments.createCheckoutSession = orig;
  }
  assert.equal(res.status, 500);
  // The dead attempt must not squat the one-live-payment slot…
  const p = (await pool.query(
    "SELECT status FROM payments WHERE class_enrolment_id = $1 ORDER BY created_at DESC LIMIT 1",
    [enr.body.id],
  )).rows[0];
  assert.equal(p.status, "failed");
  // …so the diver can simply try again.
  res = await api("POST", `/api/me/class-enrolments/${enr.body.id}/checkout`, {}, tokenFor(d));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.url, "second attempt reaches Stripe");
});

// ---- Pre-deploy hardening regressions (audit round 2) -----------------

test("club admin can request online payment when adding a diver (status 'pending')", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Request Payment Class", price_options: [{ label: "Term", amount_cents: 4000, currency: "GBP" }],
  }, tok)).body;
  const d = await seedUser("requested", ["diver"], clubId);
  const enr = await api("POST", `/api/clubs/${clubId}/classes/${cls.id}/enrolments`,
    { diver_user_id: d.id, price_option_id: cls.price_options[0].id, status: "pending" }, tok);
  assert.equal(enr.status, 201, JSON.stringify(enr.body));
  assert.equal(enr.body.status, "pending", "the diver is asked to pay, not silently comped");
  // Requesting payment without a price is meaningless — refused.
  const d2 = await seedUser("requested2", ["diver"], clubId);
  const bad = await api("POST", `/api/clubs/${clubId}/classes/${cls.id}/enrolments`,
    { diver_user_id: d2.id, status: "pending" }, tok);
  assert.equal(bad.status, 400);
  // The requested diver can pay it like a self-enrolled one.
  const co = await api("POST", `/api/me/class-enrolments/${enr.body.id}/checkout`, {}, tokenFor(d));
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.ok(co.body.url);
});

test("self-enrolment respects class capacity", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Tiny Class", capacity: 1,
  }, tok)).body;
  const d1 = await seedUser("cap1", ["diver"], clubId);
  const d2 = await seedUser("cap2", ["diver"], clubId);
  assert.equal((await api("POST", `/api/me/classes/${cls.id}/enrol`, {}, tokenFor(d1))).status, 201);
  const second = await api("POST", `/api/me/classes/${cls.id}/enrol`, {}, tokenFor(d2));
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.match(second.body.error, /full/i);
});

test("deleting a class with live PAID enrolments is refused; retiring in-flight checkouts happens for pending ones", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Delete Guard Class", price_options: [{ label: "Fee", amount_cents: 2000, currency: "GBP" }],
  }, tok)).body;
  const d = await seedUser("deleteguard", ["diver"], clubId);
  const enr = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(d));
  const co = await api("POST", `/api/me/class-enrolments/${enr.body.id}/checkout`, {}, tokenFor(d));
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_delguard", client_reference_id: co.body.payment_id, payment_intent: "pi_delguard" } },
  }, null);
  // Paid + active → the class can't be deleted out from under the payer.
  let del = await api("DELETE", `/api/clubs/${clubId}/classes/${cls.id}`, null, tok);
  assert.equal(del.status, 409, JSON.stringify(del.body));
  // Refund (club admin CAN refund their own class revenue) → enrolment
  // reopens to pending, the money guard clears, and the pending row's
  // in-flight state is retired on delete.
  const refund = await api("POST", `/api/payments/${co.body.payment_id}/refund`, {}, tok);
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal((await pool.query("SELECT status FROM class_enrolments WHERE id = $1", [enr.body.id])).rows[0].status, "pending");
  del = await api("DELETE", `/api/clubs/${clubId}/classes/${cls.id}`, null, tok);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  // The payment row survives the cascade (class_enrolment_id nulled, money history intact).
  const p = (await pool.query("SELECT status, class_enrolment_id, club_id FROM payments WHERE id = $1", [co.body.payment_id])).rows[0];
  assert.equal(p.status, "refunded");
  assert.equal(p.class_enrolment_id, null);
  assert.equal(p.club_id, clubId, "the club linkage (and thus balance history) is preserved");
});

test("the federation org_admin cannot refund a club's class payment (club-private boundary)", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Fed Refund Class", price_options: [{ label: "Fee", amount_cents: 2600, currency: "GBP" }],
  }, tok)).body;
  const d = await seedUser("fedrefund", ["diver"], clubId);
  const enr = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(d));
  const co = await api("POST", `/api/me/class-enrolments/${enr.body.id}/checkout`, {}, tokenFor(d));
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_fedref", client_reference_id: co.body.payment_id, payment_intent: "pi_fedref" } },
  }, null);
  const res = await api("POST", `/api/payments/${co.body.payment_id}/refund`, {}, tokenFor(U.fedAdmin));
  assert.equal(res.status, 403, JSON.stringify(res.body));
  // The diver certainly can't either.
  assert.equal((await api("POST", `/api/payments/${co.body.payment_id}/refund`, {}, tokenFor(d))).status, 403);
});

test("roster exposes the online-payment linkage for paid enrolments", async (t) => {
  if (!ready) return t.skip();
  const tok = tokenFor(U.clubAdmin);
  const cls = (await api("POST", `/api/clubs/${clubId}/classes`, {
    name: "Roster Payment Class", price_options: [{ label: "Fee", amount_cents: 3200, currency: "GBP" }],
  }, tok)).body;
  const d = await seedUser("rosterpay", ["diver"], clubId);
  const enr = await api("POST", `/api/me/classes/${cls.id}/enrol`, { price_option_id: cls.price_options[0].id }, tokenFor(d));
  const co = await api("POST", `/api/me/class-enrolments/${enr.body.id}/checkout`, {}, tokenFor(d));
  await api("POST", "/webhooks/stripe", {
    type: "checkout.session.completed",
    data: { object: { id: "cs_rosterpay", client_reference_id: co.body.payment_id, payment_intent: "pi_rosterpay" } },
  }, null);
  const roster = await api("GET", `/api/clubs/${clubId}/classes/${cls.id}/roster`, null, tok);
  const row = roster.body.find((r) => r.id === enr.body.id);
  assert.equal(row.payment_id, co.body.payment_id);
  assert.equal(row.payment_status, "paid");
  assert.equal(row.paid_cents, 3200);
});
