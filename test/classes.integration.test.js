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

const silent = { warn() {}, error() {}, info() {} };
const suffix = crypto.randomUUID().slice(0, 8);
const JWT_SECRET = process.env.JWT_SECRET;

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
  app.use(express.json());
  const mw = createMiddleware({ pool, JWT_SECRET });
  app.use(createClassesRouter({ pool, verifyToken: mw.verifyToken, requireClubAdminOnly: mw.requireClubAdminOnly, logger: silent }));
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
  // second self-enrol is blocked
  assert.equal((await api("POST", `/api/me/classes/${classId}/enrol`, {}, tokenFor(U.diver2))).status, 409);
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
