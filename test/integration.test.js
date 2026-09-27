// End-to-end happy-path integration test.
//
// Spins up the real Express app from server.js against a live
// Postgres, then walks through:
//   1.  register a fresh org + admin user
//   2.  log in with that admin
//   3.  create a 5-judge individual event in that org
//   4.  hit /api/divers/search and confirm the admin shows up
//   5.  hit /api/orgs/all and confirm the new org is listed
//   6.  fetch the analytics endpoint for the admin (returns shape
//       even with no scores), catches the "every meet ranks 1st"
//       and silent-500 regressions the audit hit
//   7.  insert 3 diver fixtures + 5 judge fixtures + scored round 1,
//       then assert /api/divers/<diver>/analytics ranks the diver
//       AGAINST THE FULL FIELD (not 1-of-1). This is the regression
//       the audit pass found: it would silently report every meet as
//       a gold for any diver in the database.
//
// Skips with a console warning if Postgres is unreachable, same
// pattern calc.test.js uses, so a dev with no DB can still
// run `npm test` without failures. ALSO skips if JWT_SECRET is
// unset, since server.js fail-closes on missing secret and we don't
// want to mask that with a hardcoded test fallback (an agent
// debugging a production boot crash should see the same surface).
//
// Strict invariant checks (read AGENTS.md before touching):
//   * `req.user.id` (NOT user_id) is verified by the login flow
//   * /api/divers/:id/profile returns dashboard_widgets to owners
//     and omits it for outside viewers, both branches covered
//   * the analytics endpoint never 500s; per-widget errors degrade
//     to empty arrays via runQuery
//   * recent_form ranks the diver against the full field; field_size
//     = total competitors, rank reflects actual placement
//
// Test isolation:
//   Each subtest provisions its OWN org + admin + event fixture via
//   `beforeEach`, and tears it down in `afterEach`. There is NO
//   module-scoped mutable state passed between subtests, every
//   subtest sees a freshly-minted org so reordering / parallelism
//   can't introduce ghost-state regressions. The first subtest
//   (`register-org creates an org…`) is the exception: it exercises
//   the registration endpoint directly so it builds its fixture
//   inline rather than via the shared helper, and cleans up itself.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const crypto = require("node:crypto");

require("dotenv").config();
// Public signups are now a feature flag ('signups', migration 086), not an env
// var. This suite drives register-org / register as the system under test, so
// before() loads the flags and pins signups on once the server is up.
const { Pool } = require("pg");

const TEST_PASSWORD = "integration-test-password-1234";

let dbReachable = true;
let serverReady = false;
let httpServer;
let baseUrl;
let pool;

before(async () => {
  // Prefer the app's documented DB_* env vars; fall back to
  // libpq's PG* names so CI's Postgres service container keeps
  // working unchanged. Without this, an empty `new Pool()` would
  // only see PG*, and a dev with .env using DB_* would get a
  // confusing "client password must be a string" SASL error
  // instead of the friendly "skip" message.
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user:     process.env.DB_USER     || process.env.PGUSER,
        host:     process.env.DB_HOST     || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port:     process.env.DB_PORT     || process.env.PGPORT,
      });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    dbReachable = false;
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  // server.js fail-closes when JWT_SECRET is missing or weak. Don't
  // hardcode a fallback here, that masks production boot failures
  // and makes the test silently differ from the real surface. CI
  // sets JWT_SECRET in .github/workflows/ci.yml; a local dev must
  // either set it or accept that this test skips.
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change_this_secret_in_production") {
    serverReady = false;
    console.warn(`[skip] JWT_SECRET not set — integration test won't boot the server. ` +
                 `Set JWT_SECRET in your env (or .env) to run this suite.`);
    return;
  }

  // Boot the real server on an ephemeral port. server.js skips
  // listen() when required as a module (require.main !== module)
  // so we control startup here and shut down cleanly in after().
  // The suite logs in from 127.0.0.1 over and over, and the auth limiter
  // (20 per 15 min) runs out right around the 20th login, after which every
  // new test that signs in gets a 429. Nothing here tests the limiter, so
  // switch it off like the e2e config does. server.js reads this at require.
  process.env.RATE_LIMIT_DISABLED = "true";
  const mod = require("../server.js");
  httpServer = mod.server;
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // bootChecks() loads the feature flags, but it's skipped when server.js is
  // require()d as a module, so do it by hand. Then pin 'signups' on so the
  // register fixtures below aren't gated off by a shared test DB whose flag a
  // previous run (or the flip test) left disabled.
  await mod.features.load();
  if (!mod.features.enabled("signups")) await mod.features.set("signups", true);

  serverReady = true;
});

after(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  // Close Socket.IO so the event loop drains.
  try {
    const { io } = require("../server.js");
    if (io && typeof io.close === "function") io.close();
  } catch { /* noop */ }

  if (pool) await pool.end();
});

// =====================================================================
// HTTP helper, a small wrapper around node http so we don't pull in a
// supertest-class dep for one test file.
// =====================================================================
function fetchJson(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(
      { method, host: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// =====================================================================
// Fixture helpers, direct SQL inserts. We could use the API for
// some of these (POST /api/users etc.) but the surface is simpler if
// we stick to one path per fixture. The point of these fixtures is
// to populate the analytics queries; the endpoints under test are
// the read paths.
// =====================================================================
const bcrypt = require("bcrypt");

async function insertUser({ orgId, username, fullName, role }) {
  const hash = await bcrypt.hash("not-used-here", 4); // cost 4, fixture only
  // email_verified_at = now() so /api/auth/login doesn't refuse
  // these synthetic fixtures with the email-verification gate
  // added in Migration 021. Mirrors "user clicked the email link",
  // the production gate itself is unaffected.
  const u = await pool.query(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [username, hash, fullName, orgId],
  );
  const id = u.rows[0].id;
  await pool.query(
    `INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)`,
    [id, orgId, role],
  );
  return id;
}

// =====================================================================
// Per-test fixture provisioning
// =====================================================================
//
// `setupFixture()` returns a fresh org + admin + (optionally) event +
// JWT, with NO references to module-scoped state. Each subtest's
// `beforeEach` calls this, stashing the result in a `state` closure;
// `afterEach` runs `teardownFixture(state)` which deletes everything
// in the right order (users.org_id is ON DELETE RESTRICT, so events
// → users → org).
//
// `withEvent: true` provisions a 5-judge individual event in the new
// org (the default the original test built). Set `false` for the
// rare test that doesn't need one.

async function setupFixture({ withEvent = true } = {}) {
  const slug = `int-${crypto.randomBytes(4).toString("hex")}`;
  const username = `int-admin-${slug}`;
  const reg = await fetchJson("POST", "/api/auth/register-org", {
    body: {
      org_name:     `Integration Test ${slug}`,
      country_code: "TST",
      slug,
      username,
      password:     TEST_PASSWORD,
      full_name:    "Integration Tester",
      email:        `${username}@example.test`,
    },
  });
  if (reg.status !== 201) {
    throw new Error(`setupFixture: register-org ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  const orgId = reg.body.org_id;

  // Approve org + verify the admin so login works. Same gates as
  // the original inline test (Migration 021 email-verify + the
  // pending→active flip).
  await pool.query("UPDATE organisations SET status = 'active' WHERE id = $1", [orgId]);
  const u = await pool.query(
    `UPDATE users SET email_verified_at = now()
     WHERE org_id = $1 AND username = $2 RETURNING id`,
    [orgId, username],
  );
  const adminId = u.rows[0]?.id;

  // Log in to obtain a JWT.
  const login = await fetchJson("POST", "/api/auth/login", {
    body: { username, password: TEST_PASSWORD },
  });
  if (login.status !== 200) {
    throw new Error(`setupFixture: login ${login.status} ${JSON.stringify(login.body)}`);
  }
  const adminToken = login.body.token;

  let eventId = null;
  if (withEvent) {
    const ev = await fetchJson("POST", "/api/events", {
      token: adminToken,
      body: {
        name: `Integration Test Event ${slug}`,
        gender: "Mixed",
        height: "3m",
        number_of_judges: 5,
        total_rounds: 6,
        event_type: "individual",
      },
    });
    if (ev.status !== 201) {
      throw new Error(`setupFixture: event create ${ev.status} ${JSON.stringify(ev.body)}`);
    }
    eventId = ev.body.id;
  }

  return { slug, username, orgId, adminId, adminToken, eventId };
}

async function teardownFixture(state) {
  if (!state) return;
  // Best-effort cleanup. users.org_id is ON DELETE RESTRICT so we
  // have to delete every event (cascades to scores / event_judges /
  // competitor_dive_lists) and every user owned by the org BEFORE
  // we can drop the org itself. Wrapped in try/catch so a partial
  // failure mid-suite doesn't mask the real assertion error.
  try {
    if (state.orgId) {
      // Delete all events in this org (covers the seeded eventId
      // AND any test-created children) so the user cascade can run.
      await pool.query("DELETE FROM events WHERE org_id = $1", [state.orgId]);
      await pool.query("DELETE FROM users  WHERE org_id = $1", [state.orgId]);
      await pool.query("DELETE FROM organisations WHERE id = $1", [state.orgId]);
    }
  } catch (err) {
    console.warn(`[cleanup] failed for org ${state.orgId}: ${err.message}`);
  }
}

// =====================================================================
// Tests
// =====================================================================

test("account creation is gated off when signups are disabled", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  // The rest of the suite runs with the 'signups' flag on (pinned in before());
  // flip it off through the real feature service just for this test to prove
  // the coming-soon gate, then restore. require() is cached, so this is the
  // same features instance the running server reads.
  const { features } = require("../server.js");
  await features.set("signups", false);
  try {
    const status = await fetchJson("GET", "/api/auth/signups-status");
    assert.equal(status.body.enabled, false);
    const reg = await fetchJson("POST", "/api/auth/register-org", { body: { org_name: "x" } });
    assert.equal(reg.status, 403, `expected 403, got ${reg.status}: ${JSON.stringify(reg.body)}`);
    assert.equal(reg.body.code, "signups_disabled");
    const self = await fetchJson("POST", "/api/auth/register", { body: { username: "x" } });
    assert.equal(self.status, 403);
    assert.equal(self.body.code, "signups_disabled");
  } finally {
    await features.set("signups", true);
  }
});

test("end-to-end happy path", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");

  // 1. register-org
  //
  // Exercises the registration endpoint AS the system under test,
  // builds its own fixture inline (rather than via setupFixture)
  // because setupFixture's own implementation IS this flow.
  await t.test("register-org creates an org + founding admin", async () => {
    const state = {};
    try {
      const slug = `int-${crypto.randomBytes(4).toString("hex")}`;
      const username = `int-admin-${slug}`;
      const res = await fetchJson("POST", "/api/auth/register-org", {
        body: {
          org_name:     `Integration Test ${slug}`,
          country_code: "TST",
          slug,
          username,
          password:     TEST_PASSWORD,
          full_name:    "Integration Tester",
          // Required by the validation hardening in commit 1169992.
          // Synthetic; we mark email_verified directly below.
          email:        `${username}@example.test`,
        },
      });
      assert.equal(res.status, 201, `register-org: ${res.status} ${JSON.stringify(res.body)}`);
      assert.ok(res.body.org_id, "response includes org_id");
      state.orgId = res.body.org_id;
    } finally {
      await teardownFixture(state);
    }
  });

  // 2. login
  await t.test("login returns a JWT with id, not user_id", async () => {
    const state = await setupFixture({ withEvent: false });
    try {
      const res = await fetchJson("POST", "/api/auth/login", {
        body: { username: state.username, password: TEST_PASSWORD },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.token, "login returns a token");

      const payload = JSON.parse(
        Buffer.from(res.body.token.split(".")[1], "base64url").toString("utf8"),
      );
      assert.ok(payload.id, "JWT payload includes `id`");
      assert.ok(!payload.user_id, "JWT payload does NOT include user_id");
      assert.equal(payload.id, state.adminId, "JWT id matches the user row");
    } finally {
      await teardownFixture(state);
    }
  });

  // 3. cross-org search lists this admin
  await t.test("/api/divers/search and /api/orgs/all are reachable", async () => {
    const state = await setupFixture({ withEvent: false });
    try {
      const search = await fetchJson("GET", "/api/divers/search?q=zz", { token: state.adminToken });
      assert.equal(search.status, 200);
      assert.ok(Array.isArray(search.body), "search returns an array");

      const orgs = await fetchJson("GET", "/api/orgs/all", { token: state.adminToken });
      assert.equal(orgs.status, 200);
      assert.ok(Array.isArray(orgs.body));
      assert.ok(orgs.body.some((o) => o.id === state.orgId), "the new org appears in /api/orgs/all");
    } finally {
      await teardownFixture(state);
    }
  });

  // 4. create an event
  //
  // setupFixture provisions an event by default; this subtest
  // overrides that and POSTs the event itself so it's exercising
  // the create endpoint directly.
  await t.test("can create an event in this org", async () => {
    const state = await setupFixture({ withEvent: false });
    try {
      const res = await fetchJson("POST", "/api/events", {
        token: state.adminToken,
        body: {
          name: "Integration Test Event",
          gender: "Mixed",         // event_gender enum: Male/Female/Mixed
          height: "3m",            // board_height enum: 1m/3m/5m/7.5m/10m
          number_of_judges: 5,
          total_rounds: 6,
          event_type: "individual",
        },
      });
      assert.equal(res.status, 201, `event create: ${res.status} ${JSON.stringify(res.body)}`);
      assert.ok(res.body.id);
    } finally {
      await teardownFixture(state);
    }
  });

  // 5. analytics endpoint never 500s on an empty user
  await t.test("/api/divers/:id/analytics returns the documented shape", async () => {
    const state = await setupFixture({ withEvent: false });
    try {
      const res = await fetchJson(
        "GET", `/api/divers/${state.adminId}/analytics`, { token: state.adminToken },
      );
      assert.equal(res.status, 200, `analytics: ${res.status}`);
      const expected = [
        "recent_form", "placings", "height_breakdown", "round_stamina",
        "quality_mix", "dd_risk", "frequent_dives", "streak",
        "compare_peers", "event_type_splits", "year_over_year",
      ];
      for (const k of expected) {
        assert.ok(k in res.body, `analytics payload missing key: ${k}`);
      }
      assert.ok(res.body.filter, "analytics carries a filter echo");
    } finally {
      await teardownFixture(state);
    }
  });

  // 6. profile dashboard_widgets visibility
  await t.test("/api/divers/:id/profile returns dashboard_widgets to the owner", async () => {
    const state = await setupFixture({ withEvent: false });
    try {
      const res = await fetchJson(
        "GET", `/api/divers/${state.adminId}/profile`, { token: state.adminToken },
      );
      assert.equal(res.status, 200);
      assert.ok(res.body.diver, "profile carries a diver block");
      assert.ok("dashboard_widgets" in res.body, "owner sees dashboard_widgets in their own profile");
    } finally {
      await teardownFixture(state);
    }
  });

  // 7. RANKING REGRESSION GUARD
  //
  // The previous bug: recent_form / placings / streak / year_over_year
  // ranked the diver against an already-self-filtered CTE, so every
  // meet came out 1st-of-1. This subtest creates a 3-diver field with
  // distinct totals, scores them, and asserts the diver who finished
  // 2nd actually shows rank=2 with field_size=3.
  await t.test("recent_form ranks against the full field (regression #67a5708)", async () => {
    const state = await setupFixture({ withEvent: true });
    try {
      // ----- Build the field -----
      // 3 divers + 5 judges as raw SQL fixtures. Faster than driving
      // the API for each one and avoids the bcrypt-per-row cost.
      const slug = state.orgId.slice(0, 6);
      const diverIds = [];
      for (let i = 1; i <= 3; i++) {
        diverIds.push(await insertUser({
          orgId: state.orgId, role: "diver",
          username: `int-d${i}-${slug}`,
          fullName: `Diver ${i}`,
        }));
      }
      const judgeIds = [];
      for (let i = 1; i <= 5; i++) {
        judgeIds.push(await insertUser({
          orgId: state.orgId, role: "judge",
          username: `int-j${i}-${slug}`,
          fullName: `Judge ${i}`,
        }));
      }
      // event_judges rows so the trim algorithm has the panel to run on
      for (let i = 0; i < judgeIds.length; i++) {
        await pool.query(
          `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)`,
          [state.eventId, judgeIds[i], i + 1],
        );
      }
      // Pick any 3m dive, the directory is seeded by init.sql.
      const d = await pool.query(
        `SELECT id, dd FROM dive_directory WHERE height = 3 LIMIT 1`,
      );
      assert.ok(d.rows.length, "dive_directory has 3m entries");
      const diveId = d.rows[0].id;

      // dive_list rows + scores. Pre-baked totals so the ranking is
      // deterministic, Diver 2 wins (highest), Diver 1 second,
      // Diver 3 third. 5-judge trim drops the high + the low.
      //
      //   Diver 1: [7.0, 7.5, 7.0, 7.5, 7.0] → keep 7.0+7.0+7.5 = 21.5
      //   Diver 2: [8.0, 8.0, 8.0, 8.5, 8.5] → keep 8.0+8.0+8.5 = 24.5
      //   Diver 3: [6.0, 6.5, 6.0, 6.5, 7.0] → keep 6.0+6.5+6.5 = 19.0
      const SCORES = [
        [7.0, 7.5, 7.0, 7.5, 7.0],   // Diver 1
        [8.0, 8.0, 8.0, 8.5, 8.5],   // Diver 2
        [6.0, 6.5, 6.0, 6.5, 7.0],   // Diver 3
      ];
      for (let di = 0; di < diverIds.length; di++) {
        await pool.query(
          `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number)
           VALUES ($1, $2, $3, 1)`,
          [state.eventId, diverIds[di], diveId],
        );
        for (let ji = 0; ji < judgeIds.length; ji++) {
          await pool.query(
            `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
             VALUES ($1, $2, $3, $4, 1, $5)`,
            [state.eventId, diverIds[di], judgeIds[ji], diveId, SCORES[di][ji]],
          );
        }
      }

      // ----- Assertions: pull each diver's analytics -----
      const ranks = {};
      const fieldSizes = {};
      for (const id of diverIds) {
        const r = await fetchJson("GET", `/api/divers/${id}/analytics`, { token: state.adminToken });
        assert.equal(r.status, 200, `diver ${id} analytics ${r.status}`);
        const row = r.body.recent_form?.[0];
        assert.ok(row, `diver ${id} should have a recent_form row`);
        ranks[id] = Number(row.rank);
        fieldSizes[id] = Number(row.field_size);
      }
      // The bug we're guarding: every diver showed rank=1, field_size=1.
      // Now: rank reflects actual placement, field_size = 3 for all.
      for (const id of diverIds) {
        assert.equal(fieldSizes[id], 3, `diver ${id} field_size should be 3, got ${fieldSizes[id]}`);
      }
      assert.equal(ranks[diverIds[1]], 1, "Diver 2 finished 1st (highest scores)");
      assert.equal(ranks[diverIds[0]], 2, "Diver 1 finished 2nd");
      assert.equal(ranks[diverIds[2]], 3, "Diver 3 finished 3rd (lowest scores)");

      // Placings echoes the same ranking, Diver 2 has 1 gold.
      const p = await fetchJson(
        "GET", `/api/divers/${diverIds[1]}/analytics`, { token: state.adminToken },
      );
      assert.equal(p.body.placings.gold,  1, "Diver 2 placings.gold should be 1");
      assert.equal(p.body.placings.silver, 0);
    } finally {
      await teardownFixture(state);
    }
  });
});

// The seeded Administration org is 'active' so the sysadmin can sign in,
// which used to put it in the public register dropdown too.
test("the Administration org is hidden from public signup", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { ADMIN_ORG_ID } = require("../lib/admin-org");

  const list = await fetchJson("GET", "/api/orgs/active");
  assert.equal(list.status, 200);
  assert.ok(!list.body.some((o) => o.id === ADMIN_ORG_ID), "admin org must not be listed");

  const reg = await fetchJson("POST", "/api/auth/register", {
    body: {
      username:  `int-sneak-${crypto.randomBytes(4).toString("hex")}`,
      full_name: "Sneaky Registrant",
      email:     "sneak@example.test",
      password:  TEST_PASSWORD,
      org_id:    ADMIN_ORG_ID,
    },
  });
  assert.equal(reg.status, 400, `expected 400, got ${reg.status}: ${JSON.stringify(reg.body)}`);
  assert.match(reg.body.error, /Organisation not found/);
});

// Pending means "waiting for a sysadmin", suspended means denied or
// pulled. Neither should let anyone in, and an open session should
// drop the moment verifyToken next looks.
test("a pending or suspended federation can't sign in", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const state = await setupFixture({ withEvent: false });
  try {
    const login = () => fetchJson("POST", "/api/auth/login", {
      body: { username: state.username, password: TEST_PASSWORD },
    });

    await pool.query("UPDATE organisations SET status = 'pending' WHERE id = $1", [state.orgId]);
    let res = await login();
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "org_pending");
    // setupFixture never hit verifyToken with this token, so the 30s
    // auth-state cache is cold and this read sees the new status.
    const me = await fetchJson("GET", "/api/orgs/all", { token: state.adminToken });
    assert.equal(me.status, 401);
    assert.equal(me.body.code, "org_not_active");

    await pool.query("UPDATE organisations SET status = 'suspended' WHERE id = $1", [state.orgId]);
    res = await login();
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "org_suspended");

    await pool.query("UPDATE organisations SET status = 'active' WHERE id = $1", [state.orgId]);
    res = await login();
    assert.equal(res.status, 200, "an approved org signs in normally");
  } finally {
    await teardownFixture(state);
  }
});

// Nothing outside the tests used to write club_admins, so a club could
// never get an admin. The federation admin can now hand it out, but only
// to people in their own org.
test("a federation admin can appoint and remove club admins", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { ADMIN_ORG_ID } = require("../lib/admin-org");
  const state = await setupFixture({ withEvent: false });
  try {
    const club = await fetchJson("POST", `/api/orgs/${state.orgId}/clubs`, {
      token: state.adminToken, body: { name: "Admin Grant Club" },
    });
    assert.equal(club.status, 201);
    const clubId = club.body.id;
    const member = await pool.query(
      `INSERT INTO users (username, password, full_name, email, org_id, club_id)
       VALUES ($1, 'x', 'Club Volunteer', $2, $3, $4) RETURNING id`,
      [`int-vol-${state.slug}`, `vol-${state.slug}@example.test`, state.orgId, clubId],
    );
    const memberId = member.rows[0].id;

    let list = await fetchJson("GET", `/api/clubs/${clubId}/admins`, { token: state.adminToken });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.admins, []);
    assert.ok(list.body.members.some((m) => m.id === memberId), "member is offered in the picker");

    const add = await fetchJson("POST", `/api/clubs/${clubId}/admins`, {
      token: state.adminToken, body: { user_id: memberId },
    });
    assert.equal(add.status, 201);
    list = await fetchJson("GET", `/api/clubs/${clubId}/admins`, { token: state.adminToken });
    assert.deepEqual(list.body.admins.map((a) => a.id), [memberId]);

    // Someone from another org can't be slipped in.
    const outsider = await pool.query("SELECT id FROM users WHERE org_id = $1 LIMIT 1", [ADMIN_ORG_ID]);
    if (outsider.rows.length) {
      const cross = await fetchJson("POST", `/api/clubs/${clubId}/admins`, {
        token: state.adminToken, body: { user_id: outsider.rows[0].id },
      });
      assert.equal(cross.status, 400);
    }

    const del = await fetchJson("DELETE", `/api/clubs/${clubId}/admins/${memberId}`, { token: state.adminToken });
    assert.equal(del.status, 200);
    list = await fetchJson("GET", `/api/clubs/${clubId}/admins`, { token: state.adminToken });
    assert.deepEqual(list.body.admins, []);

    const bogus = await fetchJson("GET", "/api/clubs/not-a-uuid/admins", { token: state.adminToken });
    assert.equal(bogus.status, 404);
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [state.orgId]).catch(() => {});
    await teardownFixture(state);
  }
});

// Club-first signup (migration 087). Uses two small countries nobody
// else in the suite touches, and clears them first so a crashed earlier
// run can't leave an account behind that changes the outcome.
test("club-first signup starts an unclaimed country account", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODES = ["NRU", "TUV"];
  const wipe = async () => {
    for (const code of CODES) {
      const orgs = await pool.query("SELECT id FROM organisations WHERE country_code = $1", [code]);
      for (const { id } of orgs.rows) await teardownFixture({ orgId: id });
    }
  };
  await wipe();
  const reg = (body) => fetchJson("POST", "/api/auth/register", {
    body: {
      username:  `int-cf-${crypto.randomBytes(4).toString("hex")}`,
      full_name: "Club Founder",
      email:     `cf-${crypto.randomBytes(4).toString("hex")}@example.test`,
      password:  TEST_PASSWORD,
      ...body,
    },
  });
  const state = await setupFixture({ withEvent: false });
  try {
    const first = await reg({ country_code: "NRU", new_club_name: "Nauru Divers" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const org = (await pool.query(
      "SELECT id, name, claim_state, status FROM organisations WHERE country_code = 'NRU'",
    )).rows;
    assert.equal(org.length, 1);
    assert.equal(org[0].claim_state, "unclaimed");
    assert.equal(org[0].status, "active");
    assert.equal(org[0].name, "Nauru");
    const club = (await pool.query(
      `SELECT c.id, c.created_by, u.username,
              EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = c.created_by) AS is_admin
         FROM clubs c JOIN users u ON u.id = c.created_by WHERE c.org_id = $1`, [org[0].id],
    )).rows[0];
    assert.ok(club, "club was created with a founder");
    assert.equal(club.is_admin, true, "founder of a club in an unclaimed country becomes its admin");

    // A second person from the same country lands in the same account.
    const lookup = await fetchJson("GET", "/api/orgs/by-country/NRU");
    assert.deepEqual(lookup.body.map((o) => o.id), [org[0].id]);
    const second = await reg({ country_code: "NRU", club_id: club.id });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const count = await pool.query("SELECT count(*)::int AS n FROM organisations WHERE country_code = 'NRU'");
    assert.equal(count.rows[0].n, 1);

    // No federation there, so no org-wide meet managers either.
    const mm = await reg({ country_code: "NRU", requested_role: "meet_manager" });
    assert.equal(mm.status, 400);

    // A federation doesn't get a parallel account next to the clubs: it
    // claims theirs (phase 3). These clubs are brand new, so nobody's
    // eligible to vote and it goes to the sysadmin.
    const fed = await fetchJson("POST", "/api/auth/register-org", {
      body: {
        org_name: "Nauru Diving Federation", country_code: "NRU", slug: `int-nru-${state.slug}`,
        username: `int-nrufed-${state.slug}`, password: TEST_PASSWORD, full_name: "Fed Person",
        email: `nrufed-${state.slug}@example.test`,
      },
    });
    assert.equal(fed.status, 201, JSON.stringify(fed.body));
    assert.equal(fed.body.approver, "sysadmin");
    const nruOrgs = await pool.query("SELECT count(*)::int AS n FROM organisations WHERE country_code = 'NRU'");
    assert.equal(nruOrgs.rows[0].n, 1, "still one account for the country");

    // Two first-signups racing from a brand-new country: one account.
    const [a, b] = await Promise.all([
      reg({ country_code: "TUV", new_club_name: "Funafuti A" }),
      reg({ country_code: "TUV", new_club_name: "Funafuti B" }),
    ]);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const tuv = await pool.query("SELECT count(*)::int AS n FROM organisations WHERE country_code = 'TUV'");
    assert.equal(tuv.rows[0].n, 1);

    // Under a real (claimed) federation nothing changes: founding a club
    // doesn't make you its admin, the federation decides that.
    const claimed = await reg({ org_id: state.orgId, new_club_name: "Claimed Fed Club" });
    assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
    const cc = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id) AS has_admin
         FROM clubs c WHERE c.org_id = $1 AND c.name = 'Claimed Fed Club'`, [state.orgId],
    );
    assert.equal(cc.rows[0].has_admin, false);

    const bogus = await reg({ country_code: "ZZZ" });
    assert.equal(bogus.status, 400);
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [state.orgId]).catch(() => {});
    await teardownFixture(state);
    await wipe();
  }
});

// Phase 1 permissions: in an unclaimed country, a club admin runs the
// meets their club hosts, and nothing of the club next door.
test("club admins run their own club's meets and nobody else's", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "NIU";
  const wipe = async () => {
    const orgs = await pool.query("SELECT id FROM organisations WHERE country_code = $1", [CODE]);
    for (const { id } of orgs.rows) {
      await pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
      await teardownFixture({ orgId: id });
    }
  };
  await wipe();
  // Register a club founder, verify their email, sign in.
  const founder = async (clubName) => {
    const username = `int-ca-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register", {
      body: {
        username, full_name: `${clubName} Admin`, password: TEST_PASSWORD,
        email: `${username}@example.test`, country_code: CODE, new_club_name: clubName,
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [username]);
    const login = await fetchJson("POST", "/api/auth/login", { body: { username, password: TEST_PASSWORD } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    return { token: login.body.token, clubs: login.body.club_admin_of };
  };
  try {
    const A = await founder("Alofi Divers");
    const B = await founder("Tuapa Divers");
    assert.equal(A.clubs.length, 1, "login response lists the club you admin");
    const me = await fetchJson("GET", "/api/auth/me", { token: A.token });
    assert.equal(me.body.user.club_admin_of[0].name, "Alofi Divers");

    // A meet with no host named defaults to the admin's only club.
    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Alofi Open" } });
    assert.equal(meet.status, 201, JSON.stringify(meet.body));
    assert.equal(meet.body.host_club_id, A.clubs[0].id);
    const meetId = meet.body.id;

    // B can't host as A, edit A's meet, or add events to it.
    const hostAsA = await fetchJson("POST", "/api/meets", {
      token: B.token, body: { name: "Sneaky", host_club_id: A.clubs[0].id },
    });
    assert.equal(hostAsA.status, 400);
    assert.equal((await fetchJson("PUT", `/api/meets/${meetId}`, { token: B.token, body: { name: "x" } })).status, 403);
    const evBody = {
      name: "Alofi 1m", gender: "Mixed", height: "1m", number_of_judges: 5,
      total_rounds: 5, event_type: "individual", meet_id: meetId,
    };
    assert.equal((await fetchJson("POST", "/api/events", { token: B.token, body: evBody })).status, 403);

    // A runs it end to end.
    assert.equal((await fetchJson("PUT", `/api/meets/${meetId}`, { token: A.token, body: { venue: "Alofi Pool" } })).status, 200);
    const ev = await fetchJson("POST", "/api/events", { token: A.token, body: evBody });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const eventId = ev.body.id;
    assert.equal((await fetchJson("PUT", `/api/events/${eventId}`, { token: A.token, body: { name: "Alofi 1m Open" } })).status, 200);
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/roster`, { token: A.token })).status, 200,
      "control room roster is open to the host club admin");
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/judges`, { token: A.token })).status, 200);
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/managers`, { token: A.token })).status, 200);
    assert.equal((await fetchJson("GET", "/api/judges", { token: A.token })).status, 200);

    // ...and B stays out of all of it.
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/roster`, { token: B.token })).status, 403);
    assert.equal((await fetchJson("PUT", `/api/events/${eventId}`, { token: B.token, body: { name: "x" } })).status, 403);
    assert.equal((await fetchJson("DELETE", `/api/events/${eventId}`, { token: B.token })).status, 403);

    // A can't hand the event out of their own meets.
    assert.equal((await fetchJson("PUT", `/api/events/${eventId}/meet`, { token: A.token, body: { meet_id: null } })).status, 403);

    assert.equal((await fetchJson("DELETE", `/api/events/${eventId}`, { token: A.token })).status, 200);
    assert.equal((await fetchJson("DELETE", `/api/meets/${meetId}`, { token: B.token })).status, 403);
    assert.equal((await fetchJson("DELETE", `/api/meets/${meetId}`, { token: A.token })).status, 200);
  } finally {
    await wipe();
  }
});

// With no federation, a member's role request goes to their club's
// admins, and only theirs.
test("club admins review their own members' role requests", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "PLW";
  const wipe = async () => {
    const orgs = await pool.query("SELECT id FROM organisations WHERE country_code = $1", [CODE]);
    for (const { id } of orgs.rows) await teardownFixture({ orgId: id });
  };
  await wipe();
  const signUp = async (body) => {
    const username = `int-rr-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register", {
      body: { username, full_name: username, password: TEST_PASSWORD, email: `${username}@example.test`, country_code: CODE, ...body },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [username]);
    const login = await fetchJson("POST", "/api/auth/login", { body: { username, password: TEST_PASSWORD } });
    return { username, token: login.body.token, id: login.body.id, clubs: login.body.club_admin_of };
  };
  try {
    const A = await signUp({ new_club_name: "Koror Divers" });
    const B = await signUp({ new_club_name: "Melekeok Divers" });
    const member = await signUp({ club_id: A.clubs[0].id, requested_role: "judge", note: "Level 2 judge" });

    const aList = await fetchJson("GET", "/api/role-requests", { token: A.token });
    assert.equal(aList.status, 200);
    const mine = aList.body.filter((r) => r.user_id === member.id);
    assert.equal(mine.length, 1, "A sees their member's request");
    assert.equal(mine[0].club_name, "Koror Divers");
    // Founders asked for 'diver' by default at signup, so filter to the member.
    const bList = await fetchJson("GET", "/api/role-requests", { token: B.token });
    assert.ok(!bList.body.some((r) => r.user_id === member.id), "B doesn't see A's member");

    const dash = await fetchJson("GET", "/api/dashboard", { token: A.token });
    assert.ok((dash.body.role_requests || []).some((r) => r.user_id === member.id), "dashboard feed agrees");

    // A plain member can't review anything.
    assert.equal((await fetchJson("GET", "/api/role-requests", { token: member.token })).status, 403);

    const rqId = mine[0].id;
    const bReview = await fetchJson("POST", `/api/role-requests/${rqId}/review`, {
      token: B.token, body: { decision: "approved" },
    });
    assert.equal(bReview.status, 403);
    const aReview = await fetchJson("POST", `/api/role-requests/${rqId}/review`, {
      token: A.token, body: { decision: "approved" },
    });
    assert.equal(aReview.status, 200, JSON.stringify(aReview.body));
    const granted = await pool.query(
      "SELECT 1 FROM user_org_roles WHERE user_id = $1 AND role = 'judge'", [member.id],
    );
    assert.equal(granted.rows.length, 1);

    // A founder who asks to judge can't wave it through themselves.
    const C = await signUp({ new_club_name: "Airai Divers", requested_role: "judge" });
    const own = await pool.query(
      "SELECT id FROM role_requests WHERE user_id = $1 AND status = 'pending'", [C.id],
    );
    const cList = await fetchJson("GET", "/api/role-requests", { token: C.token });
    assert.ok(!cList.body.some((r) => r.id === own.rows[0].id));
    const self = await fetchJson("POST", `/api/role-requests/${own.rows[0].id}/review`, {
      token: C.token, body: { decision: "approved" },
    });
    assert.equal(self.status, 403);

    // With no federation, A manages their own co-admins: members only,
    // and never down to zero.
    const clubA = A.clubs[0].id;
    const asB = await fetchJson("POST", `/api/clubs/${clubA}/admins`, { token: A.token, body: { user_id: B.id } });
    assert.equal(asB.status, 400, "B isn't a member of A's club");
    const addMember = await fetchJson("POST", `/api/clubs/${clubA}/admins`, { token: A.token, body: { user_id: member.id } });
    assert.equal(addMember.status, 201, JSON.stringify(addMember.body));
    assert.equal((await fetchJson("GET", `/api/clubs/${clubA}/admins`, { token: B.token })).status, 403);
    assert.equal((await fetchJson("DELETE", `/api/clubs/${clubA}/admins/${member.id}`, { token: A.token })).status, 200);
    const last = await fetchJson("DELETE", `/api/clubs/${clubA}/admins/${A.id}`, { token: A.token });
    assert.equal(last.status, 409, "can't remove the last admin");
  } finally {
    await wipe();
  }
});

// Phase 2: regions. Canada is the club-first country here (nobody else in
// the suite uses it); the claimed fixture org plays a federation.
test("regions: built-in lists, signup, club moves and region admins", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CAN";
  const wipe = async () => {
    const orgs = await pool.query("SELECT id FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'", [CODE]);
    for (const { id } of orgs.rows) await teardownFixture({ orgId: id });
  };
  await wipe();
  const signUp = async (body) => {
    const username = `int-rg-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register", {
      body: { username, full_name: username, password: TEST_PASSWORD, email: `${username}@example.test`, ...body },
    });
    if (r.status !== 201) return { status: r.status, body: r.body };
    await pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [username]);
    const login = await fetchJson("POST", "/api/auth/login", { body: { username, password: TEST_PASSWORD } });
    return { status: 201, token: login.body.token, id: login.body.id, clubs: login.body.club_admin_of, login: login.body };
  };
  const state = await setupFixture({ withEvent: false });
  try {
    const cat = await fetchJson("GET", `/api/countries/${CODE}/regions`);
    assert.equal(cat.body.label, "province");
    assert.equal(cat.body.regions.length, 13);

    // A new club in a country with regions has to say which one.
    const noRegion = await signUp({ country_code: CODE, new_club_name: "Toronto Divers" });
    assert.equal(noRegion.status, 400);
    assert.equal(noRegion.body.code, "region_required");
    const A = await signUp({ country_code: CODE, new_club_name: "Toronto Divers", region_code: "on" });
    assert.equal(A.status, 201, JSON.stringify(A.body));

    const org = (await pool.query(
      "SELECT id, region_label FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'", [CODE],
    )).rows[0];
    assert.equal(org.region_label, "province");
    const regions = await fetchJson("GET", `/api/orgs/${org.id}/regions`);
    assert.equal(regions.body.regions.length, 13);
    const on = regions.body.regions.find((r) => r.short_code === "ON");
    const qc = regions.body.regions.find((r) => r.short_code === "QC");
    assert.equal(on.club_count, 1);
    const clubs = await fetchJson("GET", `/api/orgs/${org.id}/clubs`);
    assert.equal(clubs.body[0].region_id, on.id);

    // The club's own admin can move it (no federation to ask)...
    const clubId = A.clubs[0].id;
    assert.equal((await fetchJson("PUT", `/api/clubs/${clubId}/region`, { token: A.token, body: { region_id: qc.id } })).status, 200);
    // ...a member can't, and nobody can move it into another org's region.
    const B = await signUp({ country_code: CODE, club_id: clubId });
    assert.equal((await fetchJson("PUT", `/api/clubs/${clubId}/region`, { token: B.token, body: { region_id: on.id } })).status, 403);

    // Nobody can appoint region admins in an unclaimed country but the
    // sysadmin (claims come later).
    assert.equal((await fetchJson("POST", `/api/regions/${qc.id}/admins`, { token: A.token, body: { user_id: B.id } })).status, 403);

    // A federation opts in to regions and appoints a state admin.
    await pool.query("UPDATE organisations SET country_code = 'GBR' WHERE id = $1", [state.orgId]);
    const seed = await fetchJson("POST", `/api/orgs/${state.orgId}/regions/seed`, { token: state.adminToken });
    assert.equal(seed.status, 200, JSON.stringify(seed.body));
    assert.equal(seed.body.added, 4);
    const again = await fetchJson("POST", `/api/orgs/${state.orgId}/regions/seed`, { token: state.adminToken });
    assert.equal(again.body.added, 0, "seeding twice adds nothing");
    const gbr = await fetchJson("GET", `/api/orgs/${state.orgId}/regions`);
    const sco = gbr.body.regions.find((r) => r.short_code === "SCO");
    const fedClub = await fetchJson("POST", `/api/orgs/${state.orgId}/clubs`, { token: state.adminToken, body: { name: "Edinburgh Test Club" } });
    assert.equal((await fetchJson("PUT", `/api/clubs/${fedClub.body.id}/region`, { token: state.adminToken, body: { region_id: sco.id } })).status, 200);
    // Someone from another org can't be appointed.
    assert.equal((await fetchJson("POST", `/api/regions/${sco.id}/admins`, { token: state.adminToken, body: { user_id: A.id } })).status, 400);
    const scotAdmin = (await pool.query(
      `INSERT INTO users (username, password, full_name, email, org_id, club_id, email_verified_at)
       VALUES ($1, $2, 'Scot Admin', $3, $4, $5, now()) RETURNING id`,
      [`int-scot-${state.slug}`, await require("bcrypt").hash(TEST_PASSWORD, 4), `scot-${state.slug}@example.test`, state.orgId, fedClub.body.id],
    )).rows[0].id;
    const appoint = await fetchJson("POST", `/api/regions/${sco.id}/admins`, { token: state.adminToken, body: { user_id: scotAdmin } });
    assert.equal(appoint.status, 201);
    const scotLogin = await fetchJson("POST", "/api/auth/login", { body: { username: `int-scot-${state.slug}`, password: TEST_PASSWORD } });
    assert.deepEqual(scotLogin.body.region_admin_of.map((r) => r.short_code), ["SCO"]);
    const overview = await fetchJson("GET", `/api/regions/${sco.id}/overview`, { token: scotLogin.body.token });
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.body.clubs.map((c) => c.name), ["Edinburgh Test Club"]);
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [state.orgId]).catch(() => {});
    await teardownFixture(state);
    await wipe();
  }
});

// Phase 2: what a region admin can reach. Ontario's admin runs Ontario's
// meets (region-hosted and its clubs'), reviews its clubs' requests, and
// can't touch Quebec.
test("region admins run their region's meets and nothing across the border", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CAN";
  const wipe = async () => {
    const orgs = await pool.query("SELECT id FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'", [CODE]);
    for (const { id } of orgs.rows) {
      await pool.query("DELETE FROM events WHERE org_id = $1", [id]);
      await pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
      await teardownFixture({ orgId: id });
    }
  };
  await wipe();
  const signUp = async (body) => {
    const username = `int-ra-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register", {
      body: { username, full_name: username, password: TEST_PASSWORD, email: `${username}@example.test`, country_code: CODE, ...body },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [username]);
    const login = await fetchJson("POST", "/api/auth/login", { body: { username, password: TEST_PASSWORD } });
    return { username, token: login.body.token, id: login.body.id, clubs: login.body.club_admin_of };
  };
  const relogin = async (u) => (await fetchJson("POST", "/api/auth/login", { body: { username: u.username, password: TEST_PASSWORD } })).body;
  try {
    const A = await signUp({ new_club_name: "Ottawa Divers", region_code: "ON" });
    const B = await signUp({ new_club_name: "Montreal Divers", region_code: "QC" });
    const R = await signUp({ club_id: A.clubs[0].id });
    const org = (await pool.query("SELECT id FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'", [CODE])).rows[0];
    const on = (await pool.query("SELECT id FROM regions WHERE org_id = $1 AND short_code = 'ON'", [org.id])).rows[0].id;
    // The sysadmin appoints region admins here (no federation, no claims yet).
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [on, R.id, org.id]);
    const rBody = await relogin(R);
    assert.deepEqual(rBody.region_admin_of.map((r) => r.short_code), ["ON"]);
    R.token = rBody.token;

    // Region-hosted meet: defaulted, since R only admins one region.
    const champs = await fetchJson("POST", "/api/meets", { token: R.token, body: { name: "Ontario Championships" } });
    assert.equal(champs.status, 201, JSON.stringify(champs.body));
    assert.equal(champs.body.host_region_id, on);
    // Hosting as a club in the region is fine, a Quebec club isn't.
    assert.equal((await fetchJson("POST", "/api/meets", { token: R.token, body: { name: "Ottawa Invitational", host_club_id: A.clubs[0].id } })).status, 201);
    assert.equal((await fetchJson("POST", "/api/meets", { token: R.token, body: { name: "Nope", host_club_id: B.clubs[0].id } })).status, 400);
    assert.equal((await fetchJson("POST", "/api/meets", { token: R.token, body: { name: "Nope", host_club_id: A.clubs[0].id, host_region_id: on } })).status, 400);

    // One level down: R can run Ottawa's own meet; Ottawa can't run the
    // state's; neither reaches Montreal's.
    const aMeet = (await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Ottawa Club Night" } })).body;
    const bMeet = (await fetchJson("POST", "/api/meets", { token: B.token, body: { name: "Montreal Club Night" } })).body;
    assert.equal((await fetchJson("PUT", `/api/meets/${aMeet.id}`, { token: R.token, body: { venue: "Ottawa Pool" } })).status, 200);
    assert.equal((await fetchJson("PUT", `/api/meets/${champs.body.id}`, { token: A.token, body: { venue: "x" } })).status, 403);
    assert.equal((await fetchJson("PUT", `/api/meets/${bMeet.id}`, { token: R.token, body: { venue: "x" } })).status, 403);

    const evBody = { name: "Ottawa 3m", gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 5, event_type: "individual", meet_id: aMeet.id };
    const ev = await fetchJson("POST", "/api/events", { token: A.token, body: evBody });
    assert.equal(ev.status, 201);
    assert.equal((await fetchJson("GET", `/api/events/${ev.body.id}/roster`, { token: R.token })).status, 200);
    assert.equal((await fetchJson("GET", `/api/events/${ev.body.id}/roster`, { token: B.token })).status, 403);

    // Requests from Ottawa's members reach the Ontario admin, not Montreal.
    const judge = await signUp({ club_id: A.clubs[0].id, requested_role: "judge" });
    const rList = await fetchJson("GET", "/api/role-requests", { token: R.token });
    const rq = rList.body.find((x) => x.user_id === judge.id);
    assert.ok(rq, "region admin sees the club's request");
    assert.ok(!(await fetchJson("GET", "/api/role-requests", { token: B.token })).body.some((x) => x.user_id === judge.id));
    assert.equal((await fetchJson("POST", `/api/role-requests/${rq.id}/review`, { token: B.token, body: { decision: "approved" } })).status, 403);
    assert.equal((await fetchJson("POST", `/api/role-requests/${rq.id}/review`, { token: R.token, body: { decision: "approved" } })).status, 200);

    // And R can appoint a club admin in their region, but not in Quebec.
    assert.equal((await fetchJson("POST", `/api/clubs/${A.clubs[0].id}/admins`, { token: R.token, body: { user_id: judge.id } })).status, 201);
    assert.equal((await fetchJson("GET", `/api/clubs/${B.clubs[0].id}/admins`, { token: R.token })).status, 403);
  } finally {
    await wipe();
  }
});


// ---------------------------------------------------------------------
// Phase 3: claims (lib/claims.js).
// ---------------------------------------------------------------------

// Helpers shared by the claim tests.
const claimKit = {
  jwt: require("jsonwebtoken"),
  // Stand in for clicking the emailed link: same token shape, same route.
  async verify(userId) {
    const token = claimKit.jwt.sign({ sub: userId, type: "email_verify" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await fetchJson("POST", "/api/auth/verify-email", { body: { token } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  },
  async founder(code, clubName, extra = {}) {
    const username = `int-cl-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register", {
      body: { username, full_name: clubName + " Admin", password: TEST_PASSWORD,
              email: `${username}@example.test`, country_code: code, new_club_name: clubName, ...extra },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [username]);
    const login = await fetchJson("POST", "/api/auth/login", { body: { username, password: TEST_PASSWORD } });
    return { username, id: login.body.id, token: login.body.token, clubId: login.body.club_admin_of[0]?.id };
  },
  // Old and active enough to vote: backdate it and give it a meet.
  async makeEligible(clubId) {
    const c = (await pool.query(
      "UPDATE clubs SET created_at = now() - interval '90 days' WHERE id = $1 RETURNING org_id", [clubId],
    )).rows[0];
    await pool.query("INSERT INTO meets (org_id, name, host_club_id) VALUES ($1, 'Club night', $2)", [c.org_id, clubId]);
  },
  async claim(body) {
    const username = `int-cf-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register-org", {
      body: { slug: `claim-${crypto.randomBytes(3).toString("hex")}`, username, password: TEST_PASSWORD,
              full_name: "Claimant", email: `${username}@example.test`, ...body },
    });
    const id = (await pool.query("SELECT id FROM users WHERE username = $1", [username])).rows[0]?.id;
    return { res: r, username, id };
  },
  async login(username, password = TEST_PASSWORD) {
    return (await fetchJson("POST", "/api/auth/login", { body: { username, password } })).body;
  },
  async wipe(code) {
    const orgs = await pool.query("SELECT id FROM organisations WHERE country_code = $1", [code]);
    for (const { id } of orgs.rows) {
      await pool.query("DELETE FROM claims WHERE org_id = $1", [id]);
      await pool.query("DELETE FROM events WHERE org_id = $1", [id]);
      await pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
      await teardownFixture({ orgId: id });
    }
  },
};

test("claims: the clubs vote a national federation in", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "WSM";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Apia Divers");
    const B = await claimKit.founder(CODE, "Salelologa Divers");
    const C = await claimKit.founder(CODE, "Faleolo Divers");
    const young = await claimKit.founder(CODE, "Brand New Divers");
    for (const x of [A, B, C]) await claimKit.makeEligible(x.clubId);

    const fed = await claimKit.claim({
      org_name: "Samoa Diving Federation", country_code: CODE, website: "https://www.samoadiving.ws",
    });
    assert.equal(fed.res.status, 201, JSON.stringify(fed.res.body));
    assert.equal(fed.res.body.approver, "clubs");
    // Point the claimant's email at the website's domain for the badge.
    const claimRow = (await pool.query("SELECT * FROM claims WHERE id = $1", [fed.res.body.claim_id])).rows[0];
    assert.equal(claimRow.domain_verified, false, "example.test isn't samoadiving.ws");

    // Nothing to see until the claimant verifies.
    assert.equal((await fetchJson("GET", "/api/claims", { token: A.token })).body.length, 0);
    await claimKit.verify(fed.id);
    const list = (await fetchJson("GET", "/api/claims", { token: A.token })).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].can_vote, true);
    assert.equal(list[0].tally.eligible, 3, "the young club doesn't count");

    // The young club and the claimant don't get a vote.
    assert.equal((await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: young.token, body: { vote: "approve" } })).status, 403);
    const fedLogin = await claimKit.login(fed.username);
    assert.equal((await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: fedLogin.token, body: { vote: "approve" } })).status, 403);

    // One of three isn't a majority; two is.
    let v = await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: A.token, body: { vote: "approve" } });
    assert.equal(v.body.status, "open");
    assert.equal((await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: A.token, body: { vote: "approve" } })).status, 403, "one vote per club");
    v = await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: B.token, body: { vote: "approve" } });
    assert.equal(v.body.status, "approved");

    const org = (await pool.query("SELECT name, claim_state FROM organisations WHERE id = $1", [claimRow.org_id])).rows[0];
    assert.equal(org.claim_state, "claimed");
    assert.equal(org.name, "Samoa Diving Federation");
    const after = await claimKit.login(fed.username);
    assert.ok(after.org_roles.includes("org_admin"), "the claimant runs the federation now");
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: an objection goes to the sysadmin, who can decide and revoke", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "TKL";
  await claimKit.wipe(CODE);
  try {
    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
    const A = await claimKit.founder(CODE, "Atafu Divers");
    const B = await claimKit.founder(CODE, "Nukunonu Divers");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    const fed = await claimKit.claim({ org_name: "Tokelau Aquatics", country_code: CODE });
    assert.equal(fed.res.body.approver, "clubs");
    await claimKit.verify(fed.id);
    const id = fed.res.body.claim_id;

    // A second body can't claim the same thing while this is live.
    const dup = await claimKit.claim({ org_name: "Rival Aquatics", country_code: CODE });
    assert.equal(dup.res.status, 409);
    assert.equal(dup.res.body.code, "claim_in_progress");

    assert.equal((await fetchJson("POST", `/api/claims/${id}/vote`, { token: A.token, body: { vote: "object" } })).status, 400, "objections need a reason");
    const obj = await fetchJson("POST", `/api/claims/${id}/vote`, { token: A.token, body: { vote: "object", reason: "Not our federation" } });
    assert.equal(obj.body.status, "escalated");
    assert.equal((await fetchJson("POST", `/api/claims/${id}/vote`, { token: B.token, body: { vote: "approve" } })).status, 409);
    // Club admins can't decide; the sysadmin sees why it was escalated.
    assert.equal((await fetchJson("POST", `/api/claims/${id}/decide`, { token: B.token, body: { decision: "approve" } })).status, 403);
    const sysList = (await fetchJson("GET", "/api/claims", { token: sys.token })).body.find((c) => c.id === id);
    assert.deepEqual(sysList.objections, ["Not our federation"]);
    assert.equal(sysList.can_decide, true);

    assert.equal((await fetchJson("POST", `/api/claims/${id}/decide`, { token: sys.token, body: { decision: "approve" } })).status, 200);
    let org = (await pool.query("SELECT name, claim_state FROM organisations WHERE country_code = $1", [CODE])).rows[0];
    assert.equal(org.claim_state, "claimed");

    assert.equal((await fetchJson("POST", `/api/claims/${id}/revoke`, { token: A.token })).status, 403);
    assert.equal((await fetchJson("POST", `/api/claims/${id}/revoke`, { token: sys.token, body: { reason: "Wrong body" } })).status, 200);
    org = (await pool.query("SELECT name, claim_state FROM organisations WHERE country_code = $1", [CODE])).rows[0];
    assert.equal(org.claim_state, "unclaimed");
    assert.equal(org.name, "Tokelau", "back to the country's name");
    const roles = await pool.query("SELECT 1 FROM user_org_roles WHERE user_id = $1 AND role = 'org_admin'", [fed.id]);
    assert.equal(roles.rows.length, 0);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: a state body claims its region under a federation", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CAN";
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: false });
  try {
    // The fixture federation becomes Canada's (the only one) and sets up
    // provinces.
    await pool.query("UPDATE organisations SET country_code = $2 WHERE id = $1", [state.orgId, CODE]);
    assert.equal((await fetchJson("POST", `/api/orgs/${state.orgId}/regions/seed`, { token: state.adminToken })).status, 200);

    const body = await claimKit.claim({ org_name: "Diving Ontario", country_code: CODE, region_code: "on" });
    assert.equal(body.res.status, 201, JSON.stringify(body.res.body));
    assert.equal(body.res.body.approver, "parent");
    assert.equal(body.res.body.target_kind, "region");
    await claimKit.verify(body.id);

    const list = (await fetchJson("GET", "/api/claims", { token: state.adminToken })).body;
    const mine = list.find((c) => c.id === body.res.body.claim_id);
    assert.equal(mine.can_decide, true, "the federation decides");
    assert.equal((await fetchJson("POST", `/api/claims/${mine.id}/decide`, { token: state.adminToken, body: { decision: "approve" } })).status, 200);

    const rg = (await pool.query("SELECT claim_state, claimed_name FROM regions WHERE org_id = $1 AND short_code = 'ON'", [state.orgId])).rows[0];
    assert.equal(rg.claim_state, "claimed");
    assert.equal(rg.claimed_name, "Diving Ontario");
    const login = await claimKit.login(body.username);
    assert.deepEqual(login.region_admin_of.map((r) => r.short_code), ["ON"]);

    // Claimed regions can't be claimed again.
    const again = await claimKit.claim({ org_name: "Other Ontario", country_code: CODE, region_code: "ON" });
    assert.equal(again.res.status, 409);
    assert.equal(again.res.body.code, "already_claimed");
  } finally {
    await pool.query("DELETE FROM claims WHERE org_id = $1", [state.orgId]).catch(() => {});
    await teardownFixture(state);
    await claimKit.wipe(CODE);
  }
});

test("claims: the sweep resolves expired votes and drops unverified claims", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { sweepOnce } = require("../lib/claims");
  const CODE = "NFK";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Kingston Divers");
    const B = await claimKit.founder(CODE, "Burnt Pine Divers");
    const C = await claimKit.founder(CODE, "Cascade Divers");
    for (const x of [A, B, C]) await claimKit.makeEligible(x.clubId);
    const fed = await claimKit.claim({ org_name: "Norfolk Island Diving", country_code: CODE });
    await claimKit.verify(fed.id);
    const id = fed.res.body.claim_id;
    // One approval of three isn't enough to pass on the spot...
    await fetchJson("POST", `/api/claims/${id}/vote`, { token: A.token, body: { vote: "approve" } });
    // ...but when the window closes with no objections, it passes.
    await pool.query("UPDATE claims SET closes_at = now() - interval '1 minute' WHERE id = $1", [id]);
    const r = await sweepOnce({ pool });
    assert.ok(r.resolved >= 1);
    assert.equal((await pool.query("SELECT status FROM claims WHERE id = $1", [id])).rows[0].status, "approved");

    // A claim nobody verified in a week is withdrawn.
    const stale = await pool.query(
      `INSERT INTO claims (target_kind, target_id, org_id, claimant_id, body_name, approver, created_at)
       SELECT 'region', gen_random_uuid(), org_id, id, 'Ghost Body', 'sysadmin', now() - interval '8 days'
         FROM users WHERE id = $1 RETURNING id`,
      [A.id],
    );
    await sweepOnce({ pool });
    assert.equal((await pool.query("SELECT status FROM claims WHERE id = $1", [stale.rows[0].id])).rows[0].status, "withdrawn");
  } finally {
    await claimKit.wipe(CODE);
  }
});

// Phase 4: what divers represent, per meet, snapshotted at entry.
test("representation: meet setting drives the label, entries keep their snapshot", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CAN";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Ottawa Divers", { region_code: "ON", new_club_short_code: "OTT" });
    const B = await claimKit.founder(CODE, "Montreal Divers", { region_code: "QC", new_club_short_code: "MTL" });
    const meet = await fetchJson("POST", "/api/meets", {
      token: A.token, body: { name: "Canadian Club Champs", represent_as: "region" },
    });
    assert.equal(meet.status, 201, JSON.stringify(meet.body));
    assert.equal(meet.body.represent_as, "region");
    assert.equal((await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "x", represent_as: "planet" } })).status, 400);
    const ev = await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name: "Open 1m", gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 1, event_type: "individual", meet_id: meet.body.id },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const dive = (await pool.query("SELECT id FROM dive_directory LIMIT 1")).rows[0].id;
    // Entered the plain way: the trigger snapshots club, region and country.
    for (const d of [A, B]) {
      await pool.query(
        "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
        [ev.body.id, d.id, dive],
      );
    }
    const labels = async () => {
      const r = await fetchJson("GET", `/api/scoreboard/${ev.body.id}`, { token: A.token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return Object.fromEntries((r.body.upcoming || []).map((u) => [u.full_name, u.country_code]));
    };
    assert.deepEqual(await labels(), { "Ottawa Divers Admin": "ON", "Montreal Divers Admin": "QC" });

    // Montreal's diver moves to Ottawa's club after entering: this
    // event still shows where they entered from.
    await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [A.clubId, B.id]);
    assert.equal((await labels())["Montreal Divers Admin"], "QC");

    // Switching the meet re-labels straight away (cache dropped).
    assert.equal((await fetchJson("PUT", `/api/meets/${meet.body.id}`, { token: A.token, body: { represent_as: "club" } })).status, 200);
    assert.deepEqual(await labels(), { "Ottawa Divers Admin": "OTT", "Montreal Divers Admin": "MTL" });
    assert.equal((await fetchJson("PUT", `/api/meets/${meet.body.id}`, { token: A.token, body: { represent_as: "country" } })).status, 200);
    assert.deepEqual(await labels(), { "Ottawa Divers Admin": "CAN", "Montreal Divers Admin": "CAN" });
    assert.equal((await fetchJson("PUT", `/api/meets/${meet.body.id}`, { token: A.token, body: { represent_as: "nope" } })).status, 400);

    // The Control Room roster (and so the venue / judge payload) agrees.
    await fetchJson("PUT", `/api/meets/${meet.body.id}`, { token: A.token, body: { represent_as: "region" } });
    const roster = await fetchJson("GET", `/api/events/${ev.body.id}/roster`, { token: A.token });
    assert.equal(roster.status, 200);
    assert.ok(Array.isArray(roster.body), "roster is an array of entry rows");
    const codes = new Set(roster.body.map((r) => r.country_code));
    assert.deepEqual([...codes].sort(), ["ON", "QC"]);
  } finally {
    await claimKit.wipe(CODE);
  }
});

// Phase 4: state records, and records from unclaimed accounts reading
// as unofficial.
test("records: a dive sets a state record, unofficial until the state is claimed", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CAN";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Kingston Divers", { region_code: "ON" });
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const on = (await pool.query("SELECT id FROM regions WHERE org_id = $1 AND short_code = 'ON'", [orgId])).rows[0].id;
    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Ontario Open", represent_as: "region" } });
    const ev = await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name: "3m", gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 1, event_type: "individual", meet_id: meet.body.id },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const dive = (await pool.query("SELECT id FROM dive_directory WHERE height = 3 LIMIT 1")).rows[0].id;
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
      [ev.body.id, A.id, dive],
    );
    for (let i = 1; i <= 5; i++) {
      const j = await insertUser({ orgId, role: "judge", username: `int-rj${i}-${crypto.randomBytes(3).toString("hex")}`, fullName: `Judge ${i}` });
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [ev.body.id, j, i]);
      await pool.query(
        "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, 1, 7.5)",
        [ev.body.id, A.id, j, dive],
      );
    }
    const records = require("../lib/records")({ pool, verifyToken: (_req, _res, next) => next() });
    const broken = await records.checkAndApplyRecords({ eventId: ev.body.id, competitorId: A.id, roundNumber: 1 });
    const region = broken.find((b) => b.scope === "region");
    assert.ok(region, `a state record was set: ${JSON.stringify(broken.map((b) => b.scope))}`);
    assert.equal(region.scope_name, "Ontario");

    const list = async (scope, id) =>
      (await fetchJson("GET", `/api/records?scope=${scope}&scope_id=${id}`, { token: A.token })).body;
    let reg = await list("region", on);
    assert.equal(reg.length, 1);
    assert.equal(reg[0].official, false, "Ontario has no state body yet");
    assert.equal((await list("federation", orgId))[0].official, false, "nor Canada a federation");
    await pool.query("UPDATE regions SET claim_state = 'claimed' WHERE id = $1", [on]);
    reg = await list("region", on);
    assert.equal(reg[0].official, true);
  } finally {
    await claimKit.wipe(CODE);
  }
});

// Claim notices go out by email as well as in-app, with enough in them to
// act on without opening the app. A fake mailer records every send.
test("claims: voters, claimant and clubs get the right emails", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const claimsLib = require("../lib/claims");
  const CODE = "COK";
  await claimKit.wipe(CODE);
  const sent = [];
  const email = { sendClaimEmail: async (userIds, msg) => { sent.push({ userIds: [...userIds].sort(), ...msg }); } };
  const deps = { email };
  try {
    const A = await claimKit.founder(CODE, "Avarua Divers");
    const B = await claimKit.founder(CODE, "Arorangi Divers");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    const fed = await claimKit.claim({ org_name: "Cook Islands Aquatics", country_code: CODE, website: "cookislandsaquatics.ck" });
    assert.equal(fed.res.body.approver, "clubs");

    // Going live: the two voting clubs' admins, and the claimant.
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [fed.id]);
    assert.equal(await claimsLib.activateForUser(pool, fed.id, deps), 1);
    const voters = sent.find((m) => m.userIds.includes(A.id));
    assert.deepEqual(voters.userIds, [A.id, B.id].sort());
    assert.match(voters.subject, /Cook Islands Aquatics wants to run Cook Islands/);
    assert.match(voters.body, /Voting closes on \d{1,2} \w+ \d{4}/);
    assert.match(voters.body, /cookislandsaquatics\.ck/);
    const opened = sent.find((m) => m.userIds.includes(fed.id));
    assert.match(opened.subject, /Your claim on Cook Islands is open/);

    // Two approvals pass it: the claimant and the clubs hear separately.
    sent.length = 0;
    const id = fed.res.body.claim_id;
    const asUser = async (u) => ({ id: u.id, org_id: (await pool.query("SELECT org_id FROM users WHERE id = $1", [u.id])).rows[0].org_id, org_roles: [] });
    await claimsLib.castVote(pool, { claimId: id, user: await asUser(A), vote: "approve" }, deps);
    assert.equal(sent.length, 0, "one approval of two isn't a decision yet");
    await claimsLib.castVote(pool, { claimId: id, user: await asUser(B), vote: "approve" }, deps);
    const toClaimant = sent.find((m) => m.userIds.includes(fed.id));
    assert.match(toClaimant.subject, /was approved/);
    assert.match(toClaimant.body, /federation admin access/);
    const toClubs = sent.find((m) => !m.userIds.includes(fed.id));
    assert.deepEqual(toClubs.userIds, [A.id, B.id].sort());
    assert.match(toClubs.subject, /Cook Islands Aquatics now runs Cook Islands/);

    // Revoking tells the claimant, with the reason.
    sent.length = 0;
    await claimsLib.revoke(pool, { claimId: id, user: { is_system_admin: true, id: null }, reason: "Duplicate body" }, deps);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].userIds, [fed.id]);
    assert.match(sent[0].body, /Duplicate body/);

    // A fresh claim that a club objects to: the sysadmin's email carries
    // the objection so they can decide from the inbox.
    const rival = await claimKit.claim({ org_name: "Rarotonga Diving", country_code: CODE });
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [rival.id]);
    await claimsLib.activateForUser(pool, rival.id, deps);
    sent.length = 0;
    await claimsLib.castVote(pool, {
      claimId: rival.res.body.claim_id, user: await asUser(A), vote: "object", reason: "Not a real body",
    }, deps);
    const sysIds = (await pool.query("SELECT id FROM users WHERE is_system_admin")).rows.map((r) => r.id).sort();
    const toSys = sent.find((m) => m.subject.startsWith("Claim needs a decision"));
    assert.ok(toSys, "the sysadmin is emailed");
    assert.deepEqual(toSys.userIds, sysIds);
    assert.match(toSys.body, /"Not a real body"/);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("email verification: the link signs you in, a lost one can be resent", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "KIR";
  await claimKit.wipe(CODE);
  await claimKit.wipe("FSM");
  const link = (sub) => claimKit.jwt.sign({ sub, type: "email_verify" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  try {
    const username = `int-cl-${crypto.randomBytes(4).toString("hex")}`;
    const reg = await fetchJson("POST", "/api/auth/register", {
      body: { username, full_name: "Tarawa Admin", password: TEST_PASSWORD,
              email: `${username}@example.test`, country_code: CODE, new_club_name: "Tarawa Divers" },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const blocked = await fetchJson("POST", "/api/auth/login", { body: { username, password: TEST_PASSWORD } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "email_not_verified");

    // Resend answers the same whoever you are, so it can't enumerate.
    for (const body of [{ username }, { email: `${username}@example.test` }, { username: "nobody-here-at-all" }, {}]) {
      const r = await fetchJson("POST", "/api/auth/resend-verification", { body });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true });
    }

    const id = (await pool.query("SELECT id FROM users WHERE username = $1", [username])).rows[0].id;
    assert.equal((await fetchJson("POST", "/api/auth/verify-email", { body: { token: "junk" } })).status, 400);
    const ok = await fetchJson("POST", "/api/auth/verify-email", { body: { token: link(id) } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.next, "sign_in");
    // Clicking it twice is harmless.
    assert.equal((await fetchJson("POST", "/api/auth/verify-email", { body: { token: link(id) } })).status, 200);
    assert.equal((await fetchJson("POST", "/api/auth/login", { body: { username, password: TEST_PASSWORD } })).status, 200);

    // A claimant can sign in while the claim runs; the page says so.
    const fed = await claimKit.claim({ org_name: "Kiribati Aquatics", country_code: CODE });
    const cl = await fetchJson("POST", "/api/auth/verify-email", { body: { token: link(fed.id) } });
    assert.equal(cl.body.next, "claim_open");

    // A brand new federation waits for approval.
    const pendingUser = `int-cf-${crypto.randomBytes(4).toString("hex")}`;
    const pend = await fetchJson("POST", "/api/auth/register-org", {
      body: { org_name: "Micronesia Diving", country_code: "FSM", slug: `fsm-${crypto.randomBytes(3).toString("hex")}`,
              username: pendingUser, password: TEST_PASSWORD, full_name: "FSM Admin", email: `${pendingUser}@example.test` },
    });
    assert.equal(pend.status, 201, JSON.stringify(pend.body));
    const pid = (await pool.query("SELECT id FROM users WHERE username = $1", [pendingUser])).rows[0].id;
    assert.equal((await fetchJson("POST", "/api/auth/verify-email", { body: { token: link(pid) } })).body.next, "org_pending");

    // A password reset proves the inbox too.
    const u2 = `int-cl-${crypto.randomBytes(4).toString("hex")}`;
    await fetchJson("POST", "/api/auth/register", {
      body: { username: u2, full_name: "Betio Admin", password: TEST_PASSWORD,
              email: `${u2}@example.test`, country_code: CODE, new_club_name: "Betio Divers" },
    });
    const row = (await pool.query("SELECT id, password FROM users WHERE username = $1", [u2])).rows[0];
    const fp = crypto.createHash("sha256").update(row.password).digest("hex").slice(0, 16);
    const resetTok = claimKit.jwt.sign({ sub: row.id, type: "password_reset", fp }, process.env.JWT_SECRET, { expiresIn: "30m" });
    const reset = await fetchJson("POST", "/api/auth/reset-password", { body: { token: resetTok, new_password: TEST_PASSWORD + "x" } });
    // (fp mirrors hashFingerprint in lib/email.js)
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal((await fetchJson("POST", "/api/auth/login", { body: { username: u2, password: TEST_PASSWORD + "x" } })).status, 200);
  } finally {
    await claimKit.wipe(CODE);
    await claimKit.wipe("FSM");
  }
});

// ---------------------------------------------------------------------
// Delegate permissions (track c). Each test owns one country code nobody
// else in test/ uses, and wipes it before and after.
// ---------------------------------------------------------------------

// Sign up in a country (or org), verify, sign in. Returns the login body
// bits the tests below lean on.
async function delegateSignUp(body) {
  const username = `int-dg-${crypto.randomBytes(4).toString("hex")}`;
  const r = await fetchJson("POST", "/api/auth/register", {
    body: { username, full_name: body.full_name || username, password: TEST_PASSWORD,
            email: `${username}@example.test`, ...body },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [username]);
  const login = await fetchJson("POST", "/api/auth/login", { body: { username, password: TEST_PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    username, id: login.body.id, token: login.body.token,
    clubId: login.body.club_admin_of?.[0]?.id || null,
    orgId: (await pool.query("SELECT org_id FROM users WHERE id = $1", [login.body.id])).rows[0].org_id,
  };
}

test("unclaimed country: referee requests go to the sysadmin, judge stays with the club", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "STP";
  await claimKit.wipe(CODE);
  const roleRequests = require("../lib/role-requests");
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Sao Tome Divers" });
    const ref = await delegateSignUp({ country_code: CODE, club_id: A.clubId, requested_role: "referee" });
    const judge = await delegateSignUp({ country_code: CODE, club_id: A.clubId, requested_role: "judge" });

    // Who gets told: the club for a judge, the sysadmin for a referee.
    assert.equal((await roleRequests.reviewersFor(pool, ref.id, A.orgId, "referee")).via, "sysadmin");
    assert.equal((await roleRequests.reviewersFor(pool, judge.id, A.orgId, "judge")).via, "club");

    const aList = (await fetchJson("GET", "/api/role-requests", { token: A.token })).body;
    assert.ok(aList.some((r) => r.user_id === judge.id), "the club still reviews judges");
    assert.ok(!aList.some((r) => r.user_id === ref.id), "but never sees the referee request");
    const refRq = (await pool.query(
      "SELECT id FROM role_requests WHERE user_id = $1 AND status = 'pending'", [ref.id],
    )).rows[0].id;
    assert.equal((await fetchJson("POST", `/api/role-requests/${refRq}/review`, {
      token: A.token, body: { decision: "approved" },
    })).status, 403);
    const dash = await fetchJson("GET", "/api/dashboard", { token: A.token });
    assert.ok(!(dash.body.role_requests || []).some((r) => r.user_id === ref.id), "dashboard feed agrees");

    // A region admin one level up can't grant it either.
    const reg = await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Principe', 'PRI') RETURNING id", [A.orgId],
    );
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [reg.rows[0].id, A.clubId]);
    const R = await delegateSignUp({ country_code: CODE, club_id: A.clubId });
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [reg.rows[0].id, R.id, A.orgId]);
    assert.equal((await fetchJson("POST", `/api/role-requests/${refRq}/review`, {
      token: R.token, body: { decision: "approved" },
    })).status, 403);

    // The sysadmin sees it and decides.
    const sys = await claimKit.login("admin", "admin");
    const sysList = (await fetchJson("GET", "/api/role-requests", { token: sys.token })).body;
    assert.ok(sysList.some((r) => r.id === refRq));
    assert.equal((await fetchJson("POST", `/api/role-requests/${refRq}/review`, {
      token: sys.token, body: { decision: "approved" },
    })).status, 200);
    const judgeRq = aList.find((r) => r.user_id === judge.id).id;
    assert.equal((await fetchJson("POST", `/api/role-requests/${judgeRq}/review`, {
      token: A.token, body: { decision: "approved" },
    })).status, 200);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("referee credential sign-off: eligibility before bcrypt, one answer for every failure, throttled", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "COM";
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: false });
  const pw = "referee-password-9876";
  const hash = await bcrypt.hash(pw, 4);
  const mkUser = async (orgId, { role, verified = true } = {}) => {
    const username = `int-so-${crypto.randomBytes(4).toString("hex")}`;
    const id = (await pool.query(
      `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
       VALUES ($1, $2, $1, $3, ${verified ? "now()" : "NULL"}) RETURNING id`,
      [username, hash, orgId],
    )).rows[0].id;
    if (role) await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)", [id, orgId, role]);
    return { id, username };
  };
  try {
    // A self-serve founder, which is exactly who could reach this before.
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Moroni Divers" });
    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Moroni Open" } });
    const ev = await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name: "1m", gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 5, event_type: "individual", meet_id: meet.body.id },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const url = `/api/events/${ev.body.id}/dive-order/sign-off/credential`;
    const ref = await mkUser(A.orgId, { role: "referee" });
    const plain = await mkUser(A.orgId, { role: "diver" });
    const unverified = await mkUser(A.orgId, { role: "referee", verified: false });
    const outsider = await mkUser(state.orgId, { role: "referee" });

    // Right password for the wrong person looks exactly like a wrong one.
    const wrong = await fetchJson("POST", url, { token: A.token, body: { username: ref.username, password: "nope-nope-nope" } });
    assert.equal(wrong.status, 401);
    for (const who of [plain, unverified, outsider, { username: "nobody-at-all-here" }]) {
      const r = await fetchJson("POST", url, { token: A.token, body: { username: who.username, password: pw } });
      assert.equal(r.status, 401, `${who.username}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, wrong.body);
    }
    assert.equal((await fetchJson("POST", url, { token: A.token, body: { username: ["x"], password: pw } })).status, 400);

    const ok = await fetchJson("POST", url, { token: A.token, body: { username: ref.username, password: pw } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const signed = await pool.query("SELECT dive_order_signed_off_by FROM events WHERE id = $1", [ev.body.id]);
    assert.equal(signed.rows[0].dive_order_signed_off_by, ref.id);

    // With the limiter on (the suite runs with it off), five misses on one
    // referee and the sixth try is refused before any password check.
    process.env.RATE_LIMIT_DISABLED = "false";
    try {
      const target = await mkUser(A.orgId, { role: "referee" });
      for (let i = 0; i < 5; i++) {
        const r = await fetchJson("POST", url, { token: A.token, body: { username: target.username, password: `guess-${i}` } });
        assert.equal(r.status, 401);
      }
      const blocked = await fetchJson("POST", url, { token: A.token, body: { username: target.username, password: pw } });
      assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
      // Another referee isn't caught by that one's budget.
      const other = await mkUser(A.orgId, { role: "referee" });
      assert.equal((await fetchJson("POST", url, { token: A.token, body: { username: other.username, password: "x" } })).status, 401);
    } finally {
      process.env.RATE_LIMIT_DISABLED = "true";
    }
  } finally {
    await teardownFixture(state);
    await claimKit.wipe(CODE);
  }
});

test("editing an event can't chain it onto a neighbouring club's stage", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "DMA";
  await claimKit.wipe(CODE);
  const mkEvent = async (token, meetId, name, extra = {}) => {
    const r = await fetchJson("POST", "/api/events", {
      token,
      body: { name, gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 5,
              event_type: "individual", meet_id: meetId, ...extra },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Roseau Divers" });
    const B = await delegateSignUp({ country_code: CODE, new_club_name: "Portsmouth Divers" });
    const aMeet = (await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Roseau Open" } })).body.id;
    const bMeet = (await fetchJson("POST", "/api/meets", { token: B.token, body: { name: "Portsmouth Open" } })).body.id;
    // A's event is the older one, which is what made the hijack work.
    const x = await mkEvent(A.token, aMeet, "Roseau 3m Final", { event_format: "final" });
    const bPrelim = await mkEvent(B.token, bMeet, "Portsmouth 3m Prelim", { event_format: "preliminary" });
    await mkEvent(B.token, bMeet, "Portsmouth 3m Final", { event_format: "final", parent_event_id: bPrelim });

    const hijack = await fetchJson("PUT", `/api/events/${x}`, { token: A.token, body: { parent_event_id: bPrelim } });
    assert.equal(hijack.status, 400, JSON.stringify(hijack.body));
    const after = await pool.query("SELECT parent_event_id FROM events WHERE id = $1", [x]);
    assert.equal(after.rows[0].parent_event_id, null);

    // Chaining onto their own prelim is fine, and saving again with the
    // parent unchanged still works.
    const aPrelim = await mkEvent(A.token, aMeet, "Roseau 3m Prelim", { event_format: "preliminary" });
    assert.equal((await fetchJson("PUT", `/api/events/${x}`, { token: A.token, body: { parent_event_id: aPrelim } })).status, 200);
    assert.equal((await fetchJson("PUT", `/api/events/${x}`, { token: A.token, body: { parent_event_id: aPrelim, name: "Roseau 3m F" } })).status, 200);
    // Nor can an event feed from itself, or from junk.
    assert.equal((await fetchJson("PUT", `/api/events/${x}`, { token: A.token, body: { parent_event_id: x } })).status, 400);
    assert.equal((await fetchJson("PUT", `/api/events/${x}`, { token: A.token, body: { parent_event_id: "not-a-uuid" } })).status, 400);

    // A plain event manager of X (no club role) is held to the same rule.
    const helper = await delegateSignUp({ country_code: CODE });
    await pool.query("INSERT INTO event_managers (event_id, user_id) VALUES ($1, $2)", [x, helper.id]);
    assert.equal((await fetchJson("PUT", `/api/events/${x}`, { token: helper.token, body: { parent_event_id: bPrelim } })).status, 400);
    assert.equal((await fetchJson("PUT", `/api/events/${x}`, { token: helper.token, body: { name: "Roseau 3m Final" } })).status, 200);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("moving an event between meets: managers keep their reach, club admins can't pull events in", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const state = await setupFixture({ withEvent: true });
  const mkMember = async (clubId = null) => {
    const username = `int-mv-${crypto.randomBytes(4).toString("hex")}`;
    await pool.query(
      `INSERT INTO users (username, password, full_name, org_id, club_id, email_verified_at)
       VALUES ($1, $2, $1, $3, $4, now())`,
      [username, await bcrypt.hash(TEST_PASSWORD, 4), state.orgId, clubId],
    );
    const login = await claimKit.login(username);
    return { id: login.id, token: login.token };
  };
  const adm = state.adminToken;
  const meet = async (body) => {
    const r = await fetchJson("POST", "/api/meets", { token: adm, body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  try {
    // A federation with a club whose admin also helps run Nationals.
    const club = (await fetchJson("POST", `/api/orgs/${state.orgId}/clubs`, { token: adm, body: { name: "Mover Club" } })).body.id;
    const C = await mkMember(club);
    assert.equal((await fetchJson("POST", `/api/clubs/${club}/admins`, { token: adm, body: { user_id: C.id } })).status, 201);
    const nationals = await meet({ name: "Nationals" });
    const nationals2 = await meet({ name: "Nationals Day 2" });
    const clubMeet = await meet({ name: "Mover Club Night", host_club_id: club });
    const clubMeet2 = await meet({ name: "Mover Club Night 2", host_club_id: club });
    const E = state.eventId;
    assert.equal((await fetchJson("PUT", `/api/events/${E}/meet`, { token: adm, body: { meet_id: nationals } })).status, 200);
    await pool.query("INSERT INTO event_managers (event_id, user_id) VALUES ($1, $2)", [E, C.id]);

    // C can't pull the federation's event into their club's meet (and so
    // can't go on to delete it).
    const pull = await fetchJson("PUT", `/api/events/${E}/meet`, { token: C.token, body: { meet_id: clubMeet } });
    assert.equal(pull.status, 403, JSON.stringify(pull.body));
    assert.equal((await pool.query("SELECT meet_id FROM events WHERE id = $1", [E])).rows[0].meet_id, nationals);
    assert.equal((await fetchJson("DELETE", `/api/events/${E}`, { token: C.token })).status, 403);
    // As its manager they can still move it around the federation's meets.
    assert.equal((await fetchJson("PUT", `/api/events/${E}/meet`, { token: C.token, body: { meet_id: nationals2 } })).status, 200);

    // A plain event manager keeps the old behaviour, including detaching.
    const M = await mkMember();
    await pool.query("INSERT INTO event_managers (event_id, user_id) VALUES ($1, $2)", [E, M.id]);
    assert.equal((await fetchJson("PUT", `/api/events/${E}/meet`, { token: M.token, body: { meet_id: nationals } })).status, 200);
    assert.equal((await fetchJson("PUT", `/api/events/${E}/meet`, { token: M.token, body: { meet_id: null } })).status, 200);
    assert.equal((await fetchJson("PUT", `/api/events/${E}/meet`, { token: M.token, body: { meet_id: "junk" } })).status, 400);

    // A club admin with no manager row moves their own event between
    // their own meets, and nowhere else.
    const own = await fetchJson("POST", "/api/events", {
      token: C.token,
      body: { name: "Club 1m", gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 5, event_type: "individual", meet_id: clubMeet },
    });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal((await fetchJson("PUT", `/api/events/${own.body.id}/meet`, { token: C.token, body: { meet_id: clubMeet2 } })).status, 200);
    assert.equal((await fetchJson("PUT", `/api/events/${own.body.id}/meet`, { token: C.token, body: { meet_id: nationals } })).status, 403);
    assert.equal((await fetchJson("PUT", `/api/events/${own.body.id}/meet`, { token: C.token, body: { meet_id: null } })).status, 403);
  } finally {
    await pool.query("DELETE FROM events WHERE org_id = $1", [state.orgId]);
    await pool.query("DELETE FROM meets WHERE org_id = $1", [state.orgId]);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [state.orgId]).catch(() => {});
    await teardownFixture(state);
  }
});

test("last club admin: only live admins count, and co-admins can't remove each other at once", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "KNA";
  await claimKit.wipe(CODE);
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Basseterre Divers" });
    const club = A.clubId;
    const promote = async (u) => assert.equal(
      (await fetchJson("POST", `/api/clubs/${club}/admins`, { token: A.token, body: { user_id: u.id } })).status, 201);
    const liveAdmins = async () => (await pool.query(
      `SELECT count(*)::int AS n FROM club_admins ca JOIN users u ON u.id = ca.user_id
        WHERE ca.club_id = $1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL`, [club],
    )).rows[0].n;

    // A deleted co-admin's row is left behind; it doesn't count.
    const B = await delegateSignUp({ country_code: CODE, club_id: club });
    await promote(B);
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [B.id]);
    const alone = await fetchJson("DELETE", `/api/clubs/${club}/admins/${A.id}`, { token: A.token });
    assert.equal(alone.status, 409, JSON.stringify(alone.body));
    // Nor does a suspended one.
    const S = await delegateSignUp({ country_code: CODE, club_id: club });
    await promote(S);
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [S.id]);
    assert.equal((await fetchJson("DELETE", `/api/clubs/${club}/admins/${A.id}`, { token: A.token })).status, 409);
    // Clearing out a dead account's row is fine, uppercase id and all.
    assert.equal((await fetchJson("DELETE", `/api/clubs/${club}/admins/${B.id.toUpperCase()}`, { token: A.token })).status, 200);
    assert.equal((await fetchJson("DELETE", `/api/clubs/${club}/admins/${B.id}`, { token: A.token })).status, 404);

    // Two live co-admins removing each other at the same moment: exactly
    // one wins, and the club keeps a live admin. A few rounds, since it's
    // a race.
    for (let round = 0; round < 3; round++) {
      const keep = round === 0 ? A : (await pool.query(
        `SELECT u.id, u.username FROM club_admins ca JOIN users u ON u.id = ca.user_id
          WHERE ca.club_id = $1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL`, [club],
      )).rows[0];
      const keepTok = keep.token || (await claimKit.login(keep.username)).token;
      const C = await delegateSignUp({ country_code: CODE, club_id: club });
      assert.equal((await fetchJson("POST", `/api/clubs/${club}/admins`, { token: keepTok, body: { user_id: C.id } })).status, 201);
      const [x, y] = await Promise.all([
        fetchJson("DELETE", `/api/clubs/${club}/admins/${C.id}`, { token: keepTok }),
        fetchJson("DELETE", `/api/clubs/${club}/admins/${keep.id}`, { token: C.token }),
      ]);
      // The loser gets 409 if it was already past its permission check when
      // the winner committed, or 403 if the winner had already taken its
      // admin row away. Either way only one removal lands.
      const statuses = [x.status, y.status].sort();
      assert.equal(statuses[0], 200, `round ${round}: ${x.status} ${y.status}`);
      assert.ok([403, 409].includes(statuses[1]), `round ${round}: ${x.status} ${y.status}`);
      assert.equal(await liveAdmins(), 1);
    }

    // The HTTP race above can settle at the permission check, before the
    // lock matters. Straight at the helper, both removals are always past
    // that point, so this is the lock on its own.
    const { removeAdmin } = require("../lib/admin-rows");
    for (let round = 0; round < 5; round++) {
      const keep = (await pool.query(
        `SELECT u.id FROM club_admins ca JOIN users u ON u.id = ca.user_id
          WHERE ca.club_id = $1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL`, [club],
      )).rows[0];
      const C = await delegateSignUp({ country_code: CODE, club_id: club });
      await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [club, C.id, A.orgId]);
      const outs = await Promise.all([keep.id, C.id].map((userId) =>
        removeAdmin(pool, { scope: "club", scopeId: club, userId, keepOneLive: true })));
      assert.deepEqual(outs.map((o) => o.status).sort(), [200, 409], `helper round ${round}`);
      assert.equal(await liveAdmins(), 1);
    }
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("region co-admins: a region's own admins manage them, and an orphaned region can be claimed again", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CAN";
  await claimKit.wipe(CODE);
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Kingston Tritons", region_code: "ON" });
    const M = await delegateSignUp({ country_code: CODE, club_id: A.clubId });
    const Q = await delegateSignUp({ country_code: CODE, new_club_name: "Quebec Tritons", region_code: "QC" });
    const on = (await pool.query("SELECT id FROM regions WHERE org_id = $1 AND short_code = 'ON'", [A.orgId])).rows[0].id;
    // Ontario's body won its claim: claimed, with one admin.
    const R = await delegateSignUp({ country_code: CODE, club_id: A.clubId });
    await pool.query("UPDATE regions SET claim_state = 'claimed', claimed_name = 'Diving Ontario' WHERE id = $1", [on]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [on, R.id, A.orgId]);
    const url = `/api/regions/${on}/admins`;

    const list = await fetchJson("GET", url, { token: R.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.can_manage, true);
    assert.ok(list.body.candidates.some((c) => c.id === M.id));

    // Their own clubs' members only; a club admin can't appoint here.
    assert.equal((await fetchJson("POST", url, { token: R.token, body: { user_id: Q.id } })).status, 400);
    assert.equal((await fetchJson("POST", url, { token: A.token, body: { user_id: M.id } })).status, 403);
    assert.equal((await fetchJson("POST", url, { token: R.token, body: { user_id: M.id } })).status, 201);
    assert.equal((await fetchJson("DELETE", `${url}/${M.id}`, { token: A.token })).status, 403);
    assert.equal((await fetchJson("DELETE", `${url}/${M.id}`, { token: R.token })).status, 200);
    // Never down to nobody, and a dead co-admin doesn't count.
    assert.equal((await fetchJson("DELETE", `${url}/${R.id}`, { token: R.token })).status, 409);
    assert.equal((await fetchJson("POST", url, { token: R.token, body: { user_id: M.id } })).status, 201);
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [M.id]);
    assert.equal((await fetchJson("DELETE", `${url}/${R.id}`, { token: R.token })).status, 409);

    // Under a federation it's the org admin's call, as before.
    await pool.query("UPDATE organisations SET claim_state = 'claimed' WHERE id = $1", [A.orgId]);
    assert.equal((await fetchJson("POST", url, { token: R.token, body: { user_id: A.id } })).status, 403);
    assert.equal((await fetchJson("GET", url, { token: R.token })).body.can_manage, false);
    await pool.query("UPDATE organisations SET claim_state = 'unclaimed' WHERE id = $1", [A.orgId]);

    // While Ontario has a live admin a second body can't claim it...
    const early = await claimKit.claim({ org_name: "Ontario Diving Two", country_code: CODE, region_code: "ON" });
    assert.equal(early.res.status, 409);
    assert.equal(early.res.body.code, "already_claimed");
    // ...but once its last admin has gone, the region is open again.
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [R.id]);
    const again = await claimKit.claim({ org_name: "Ontario Diving Two", country_code: CODE, region_code: "ON" });
    assert.equal(again.res.status, 201, JSON.stringify(again.res.body));
    assert.equal(again.res.body.target_kind, "region");
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("club region moves: self-serve between unclaimed regions, both sides agree on a claimed one", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CAN";
  await claimKit.wipe(CODE);
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Sudbury Divers", region_code: "ON" });
    const B = await delegateSignUp({ country_code: CODE, new_club_name: "Gatineau Divers", region_code: "QC" });
    const rid = async (code) => (await pool.query(
      "SELECT id FROM regions WHERE org_id = $1 AND short_code = $2", [A.orgId, code])).rows[0].id;
    const [on, qc, nb] = [await rid("ON"), await rid("QC"), await rid("NB")];
    const move = (tok, clubId, regionId) =>
      fetchJson("PUT", `/api/clubs/${clubId}/region`, { token: tok, body: { region_id: regionId } });
    const regionOf = async (clubId) => (await pool.query("SELECT region_id FROM clubs WHERE id = $1", [clubId])).rows[0].region_id;
    const askedFor = async (clubId) => (await pool.query("SELECT requested_region_id FROM clubs WHERE id = $1", [clubId])).rows[0].requested_region_id;

    // Nobody's claimed anything yet: the club decides.
    assert.equal((await move(A.token, A.clubId, qc)).status, 200);
    assert.equal((await move(A.token, A.clubId, on.toUpperCase())).status, 200);
    assert.equal(await regionOf(A.clubId), on);

    // Ontario's body claims it.
    const R = await delegateSignUp({ country_code: CODE, club_id: A.clubId });
    await pool.query("UPDATE regions SET claim_state = 'claimed', claimed_name = 'Diving Ontario' WHERE id = $1", [on]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [on, R.id, A.orgId]);

    // Sudbury can't walk out on its own.
    const out = await move(A.token, A.clubId, null);
    assert.equal(out.status, 403, JSON.stringify(out.body));
    assert.equal(out.body.code, "region_admin_required");
    assert.equal((await move(A.token, A.clubId, qc)).status, 403);
    assert.equal(await regionOf(A.clubId), on);
    // Moves that don't touch Ontario stay self-serve.
    assert.equal((await move(B.token, B.clubId, nb)).status, 200);

    // Ontario can't annex a club that never asked...
    const annex = await move(R.token, B.clubId, on);
    assert.equal(annex.status, 403, JSON.stringify(annex.body));
    assert.equal(annex.body.code, "club_request_required");
    assert.equal(await regionOf(B.clubId), nb);

    // ...but Gatineau can ask, which moves nothing yet and tells Ontario.
    const ask = await move(B.token, B.clubId, on);
    assert.equal(ask.status, 202, JSON.stringify(ask.body));
    assert.equal(ask.body.requested, true);
    assert.equal(await regionOf(B.clubId), nb);
    assert.equal(await askedFor(B.clubId), on);
    const told = await pool.query(
      "SELECT action_url FROM notifications WHERE user_id = $1 AND category = 'region_request'", [R.id]);
    assert.equal(told.rows[0]?.action_url, "/region");
    const overview = (await fetchJson("GET", `/api/regions/${on}/overview`, { token: R.token })).body;
    assert.deepEqual(overview.join_requests.map((c) => c.id), [B.clubId]);
    const mine = (await fetchJson("GET", `/api/clubs/${B.clubId}/admins`, { token: B.token })).body;
    assert.equal(mine.region_request.region_id, on);

    // Only the asking club's admin or Ontario can withdraw or decline it.
    assert.equal((await fetchJson("DELETE", `/api/clubs/${B.clubId}/region-request`, { token: A.token })).status, 403);
    assert.equal((await fetchJson("DELETE", `/api/clubs/${B.clubId}/region-request`, { token: R.token })).status, 200);
    assert.equal(await askedFor(B.clubId), null);
    assert.equal((await move(R.token, B.clubId, on)).body.code, "club_request_required");

    // Asked again, Ontario accepts, and Gatineau hears about it.
    assert.equal((await move(B.token, B.clubId, on)).status, 202);
    assert.equal((await move(R.token, B.clubId, on)).status, 200);
    assert.equal(await regionOf(B.clubId), on);
    assert.equal(await askedFor(B.clubId), null);
    const heard = await pool.query(
      "SELECT title FROM notifications WHERE user_id = $1 AND category = 'region_decision'", [B.id]);
    assert.match(heard.rows[0]?.title || "", /now in Diving Ontario/);

    // Ontario lets clubs go, but can't pick where they land.
    assert.equal((await move(R.token, B.clubId, qc)).status, 403);
    assert.equal((await move(R.token, B.clubId, null)).status, 200);
    assert.equal(await regionOf(B.clubId), null);
    assert.equal((await move(R.token, B.clubId, qc)).status, 403);

    // Nor can it take a club out of another body's claimed region, even
    // one that asked to join Ontario.
    await move(B.token, B.clubId, qc);
    const R2 = await delegateSignUp({ country_code: CODE, club_id: B.clubId });
    await pool.query("UPDATE regions SET claim_state = 'claimed' WHERE id = $1", [qc]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [qc, R2.id, A.orgId]);
    assert.equal((await move(B.token, B.clubId, on)).body.code, "region_admin_required");
    assert.equal((await move(R.token, B.clubId, on)).status, 403);
    assert.equal(await regionOf(B.clubId), qc);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("unclaimed country: people ask to join a club and its admins say yes", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "LCA";
  await claimKit.wipe(CODE);
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Castries Divers" });
    const B = await delegateSignUp({ country_code: CODE, new_club_name: "Soufriere Divers" });
    // Signed up Independent, and asked to dive.
    const D = await delegateSignUp({ country_code: CODE, requested_role: "diver" });
    const clubOf = async (id) => (await pool.query("SELECT club_id FROM users WHERE id = $1", [id])).rows[0].club_id;

    // Setting a club directly is still not theirs (or a club admin's) to do.
    assert.equal((await fetchJson("PUT", `/api/users/${D.id}/club`, { token: D.token, body: { club_id: A.clubId } })).status, 403);
    assert.equal((await fetchJson("PUT", `/api/users/${D.id}/club`, { token: A.token, body: { club_id: A.clubId } })).status, 403);

    // A club admin can't sign someone up; the person asks.
    assert.equal((await fetchJson("POST", "/api/club-change-requests", {
      token: A.token, body: { user_id: D.id, to_club_id: A.clubId } })).status, 403);
    const ask = await fetchJson("POST", "/api/club-change-requests", { token: D.token, body: { to_club_id: A.clubId, note: "Training at Castries" } });
    assert.equal(ask.status, 201, JSON.stringify(ask.body));
    assert.equal(ask.body.finalised, false);
    const note = await pool.query(
      "SELECT action_url FROM notifications WHERE user_id = $1 AND category = 'club_join_request'", [A.id]);
    assert.equal(note.rows[0]?.action_url, "/club", "A is told");

    // A sees it, B doesn't and can't decide it.
    const aInbox = (await fetchJson("GET", "/api/club-change-requests", { token: A.token })).body;
    assert.ok(aInbox.some((r) => r.id === ask.body.id));
    const bInbox = (await fetchJson("GET", "/api/club-change-requests", { token: B.token })).body;
    assert.ok(!bInbox.some((r) => r.id === ask.body.id));
    assert.equal((await fetchJson("POST", `/api/club-change-requests/${ask.body.id}/review`, {
      token: B.token, body: { decision: "approved" } })).status, 403);
    assert.equal((await fetchJson("POST", `/api/club-change-requests/${ask.body.id}/review`, {
      token: D.token, body: { decision: "approved" } })).status, 403);

    assert.equal((await fetchJson("POST", `/api/club-change-requests/${ask.body.id}/review`, {
      token: A.token, body: { decision: "approved" } })).status, 200);
    assert.equal(await clubOf(D.id), A.clubId);
    const audit = await pool.query(
      "SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'user.club_changed'", [D.id]);
    assert.equal(audit.rows.length, 1);
    // The ask was for A to act on; the answer is only news for D.
    const dNotes = await pool.query("SELECT category FROM notifications WHERE user_id = $1", [D.id]);
    assert.deepEqual(dNotes.rows.map((r) => r.category), ["club_change"]);

    // Now a member: their diver request is A's to review, and A can make
    // them a co-admin.
    assert.ok((await fetchJson("GET", "/api/role-requests", { token: A.token })).body.some((r) => r.user_id === D.id));
    assert.equal((await fetchJson("POST", `/api/clubs/${A.clubId}/admins`, { token: A.token, body: { user_id: D.id } })).status, 201);

    // Switching to B goes to B, and B can turn it down.
    const sw = await fetchJson("POST", "/api/club-change-requests", { token: D.token, body: { to_club_id: B.clubId } });
    assert.equal(sw.status, 201);
    assert.ok(!(await fetchJson("GET", "/api/club-change-requests", { token: A.token })).body
      .some((r) => r.id === sw.body.id && r.user_id !== A.id && r.to_club_id === A.clubId));
    assert.equal((await fetchJson("POST", `/api/club-change-requests/${sw.body.id}/review`, {
      token: A.token, body: { decision: "approved" } })).status, 403);
    assert.equal((await fetchJson("POST", `/api/club-change-requests/${sw.body.id}/review`, {
      token: B.token, body: { decision: "rejected" } })).status, 200);
    assert.equal(await clubOf(D.id), A.clubId);

    // Under a real federation this stays the org admin's call.
    await pool.query("UPDATE organisations SET claim_state = 'claimed' WHERE id = $1", [A.orgId]);
    const fed = await fetchJson("POST", "/api/club-change-requests", { token: D.token, body: { to_club_id: B.clubId } });
    assert.equal(fed.status, 201);
    assert.equal((await fetchJson("POST", `/api/club-change-requests/${fed.body.id}/review`, {
      token: B.token, body: { decision: "approved" } })).status, 403);
  } finally {
    await pool.query(
      "DELETE FROM club_change_requests WHERE from_org_id IN (SELECT id FROM organisations WHERE country_code = $1)", [CODE],
    ).catch(() => {});
    await claimKit.wipe(CODE);
  }
});

test("coach: requestable at signup, a club grants it, a founder can't grant it to themselves", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "VCT";
  await claimKit.wipe(CODE);
  const roleRequests = require("../lib/role-requests");
  const pendingFor = async (userId) => (await pool.query(
    "SELECT id, requested_role FROM role_requests WHERE user_id = $1 AND status = 'pending'", [userId],
  )).rows;
  try {
    // The founder brings the club in as its coach.
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Kingstown Divers", requested_role: "coach" });
    const coach = await delegateSignUp({ country_code: CODE, club_id: A.clubId, requested_role: "coach" });
    // Signup used to drop 'coach' on the floor.
    assert.deepEqual((await pendingFor(coach.id)).map((r) => r.requested_role), ["coach"]);

    // A member's coach request is the club's to decide...
    assert.equal((await roleRequests.reviewersFor(pool, coach.id, A.orgId, "coach")).via, "club");
    const list = (await fetchJson("GET", "/api/role-requests", { token: A.token })).body;
    assert.ok(list.some((r) => r.user_id === coach.id && r.requested_role === "coach"));

    // ...but not the founder's own: that goes up to DivingHQ.
    const own = (await pendingFor(A.id))[0];
    assert.equal(own.requested_role, "coach");
    assert.ok(!list.some((r) => r.id === own.id), "never offered to approve their own");
    assert.equal((await roleRequests.reviewersFor(pool, A.id, A.orgId, "coach")).via, "sysadmin");
    assert.equal((await fetchJson("POST", `/api/role-requests/${own.id}/review`, {
      token: A.token, body: { decision: "approved" },
    })).status, 403);

    const rq = list.find((r) => r.user_id === coach.id).id;
    assert.equal((await fetchJson("POST", `/api/role-requests/${rq}/review`, {
      token: A.token, body: { decision: "approved" },
    })).status, 200);
    const held = await pool.query(
      "SELECT 1 FROM user_org_roles WHERE user_id = $1 AND org_id = $2 AND role = 'coach'", [coach.id, A.orgId],
    );
    assert.equal(held.rows.length, 1);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("request a role after signup: routed like signup, one pending per role, a decline can be asked again later", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "GRD";
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: false });
  try {
    // Under a federation: a diver who now wants to judge.
    const username = `int-rr-${crypto.randomBytes(4).toString("hex")}`;
    const dId = (await pool.query(
      `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
       VALUES ($1, $2, $1, $3, now()) RETURNING id`,
      [username, await bcrypt.hash(TEST_PASSWORD, 4), state.orgId],
    )).rows[0].id;
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'diver')", [dId, state.orgId]);
    const D = await claimKit.login(username);

    // Signed-out is refused (by the CSRF gate or verifyToken, whichever runs first).
    assert.ok([401, 403].includes((await fetchJson("POST", "/api/role-requests", { body: { role: "judge" } })).status));
    const mine = await fetchJson("GET", "/api/role-requests/mine", { token: D.token });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.claim_state, "claimed");
    assert.ok(mine.body.requestable.includes("meet_manager"));
    assert.ok(mine.body.held.includes("diver"));

    for (const [role, status, code] of [
      ["org_admin", 400, "role_not_requestable"],
      ["spectator", 400, "role_not_requestable"],
      ["diver", 409, "already_held"],
    ]) {
      const r = await fetchJson("POST", "/api/role-requests", { token: D.token, body: { role } });
      assert.equal(r.status, status, `${role}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code);
    }
    const ask = await fetchJson("POST", "/api/role-requests", { token: D.token, body: { role: "judge", note: "Level 2\u0007 judge" } });
    assert.equal(ask.status, 201, JSON.stringify(ask.body));
    assert.equal(ask.body.note, "Level 2  judge");
    assert.equal((await fetchJson("POST", "/api/role-requests", { token: D.token, body: { role: "judge" } })).body.code, "already_pending");

    // The org admin sees it where signup's requests land, and says no.
    const list = (await fetchJson("GET", "/api/role-requests", { token: state.adminToken })).body;
    assert.ok(list.some((r) => r.id === ask.body.id));
    const decide = (id, decision) => fetchJson("POST", `/api/role-requests/${id}/review`, {
      token: state.adminToken, body: { decision },
    });
    assert.equal((await decide(ask.body.id, "rejected")).status, 200);

    // Not straight back in, but the next day is fine. Turning down a
    // second one used to trip the old UNIQUE(..., status) and 500.
    assert.equal((await fetchJson("POST", "/api/role-requests", { token: D.token, body: { role: "judge" } })).body.code, "recently_declined");
    await pool.query("UPDATE role_requests SET reviewed_at = now() - interval '25 hours' WHERE id = $1", [ask.body.id]);
    const again = await fetchJson("POST", "/api/role-requests", { token: D.token, body: { role: "judge" } });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal((await decide(again.body.id, "rejected")).status, 200);
    await pool.query("UPDATE role_requests SET reviewed_at = now() - interval '25 hours' WHERE user_id = $1", [dId]);
    const third = await fetchJson("POST", "/api/role-requests", { token: D.token, body: { role: "judge" } });
    assert.equal((await decide(third.body.id, "approved")).status, 200);
    // Approval bumps token_version, so sign in again to read it back.
    const D2 = await claimKit.login(username);
    const history = (await fetchJson("GET", "/api/role-requests/mine", { token: D2.token })).body;
    assert.deepEqual(history.requests.map((r) => r.status), ["approved", "rejected", "rejected"]);
    assert.ok(history.held.includes("judge"));

    // Where there's no federation: the club decides judge, DivingHQ
    // referee, and org-wide meet manager isn't on offer at all.
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "St George's Divers" });
    const M = await delegateSignUp({ country_code: CODE, club_id: A.clubId });
    const mMine = (await fetchJson("GET", "/api/role-requests/mine", { token: M.token })).body;
    assert.equal(mMine.claim_state, "unclaimed");
    assert.ok(!mMine.requestable.includes("meet_manager"));
    assert.equal((await fetchJson("POST", "/api/role-requests", { token: M.token, body: { role: "meet_manager" } })).status, 400);
    const j = await fetchJson("POST", "/api/role-requests", { token: M.token, body: { role: "judge" } });
    const ref = await fetchJson("POST", "/api/role-requests", { token: M.token, body: { role: "referee" } });
    assert.equal(j.status, 201);
    assert.equal(ref.status, 201);
    const aList = (await fetchJson("GET", "/api/role-requests", { token: A.token })).body;
    assert.ok(aList.some((r) => r.id === j.body.id));
    assert.ok(!aList.some((r) => r.id === ref.body.id));
    assert.equal((await fetchJson("POST", `/api/role-requests/${j.body.id}/review`, {
      token: A.token, body: { decision: "approved" },
    })).status, 200);

    // Platform staff have nothing to ask for.
    const sys = await claimKit.login("admin", "admin");
    assert.deepEqual((await fetchJson("GET", "/api/role-requests/mine", { token: sys.token })).body.requestable, []);
  } finally {
    await teardownFixture(state);
    await claimKit.wipe(CODE);
  }
});

test("referee credential sign-off: the 2FA prompt doesn't use up the lockout budget", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "ATG";
  await claimKit.wipe(CODE);
  const speakeasy = require("speakeasy");
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "St John's Divers" });
    const meet = (await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "St John's Open" } })).body.id;
    const mkEvent = async (name) => (await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name, gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 5, event_type: "individual", meet_id: meet },
    })).body.id;

    const pw = "referee-2fa-password";
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const username = `int-so2-${crypto.randomBytes(4).toString("hex")}`;
    const refId = (await pool.query(
      `INSERT INTO users (username, password, full_name, org_id, email_verified_at, totp_enabled_at, totp_secret)
       VALUES ($1, $2, $1, $3, now(), now(), $4) RETURNING id`,
      [username, await bcrypt.hash(pw, 4), A.orgId, secret],
    )).rows[0].id;
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'referee')", [refId, A.orgId]);

    process.env.RATE_LIMIT_DISABLED = "false";
    try {
      // A morning's worth of events: each one asks for the code first.
      const events = [];
      for (let i = 0; i < 6; i++) events.push(await mkEvent(`1m heat ${i}`));
      for (const id of events) {
        const r = await fetchJson("POST", `/api/events/${id}/dive-order/sign-off/credential`, {
          token: A.token, body: { username, password: pw },
        });
        assert.equal(r.status, 401, JSON.stringify(r.body));
        assert.equal(r.body.needs_totp, true);
      }
      // Still let in with the code, well past five prompts.
      await pool.query("UPDATE users SET totp_last_used_step = NULL WHERE id = $1", [refId]);
      const ok = await fetchJson("POST", `/api/events/${events[5]}/dive-order/sign-off/credential`, {
        token: A.token, body: { username, password: pw, code: speakeasy.totp({ secret, encoding: "base32" }) },
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));

      // Wrong passwords still count.
      for (let i = 0; i < 5; i++) {
        const r = await fetchJson("POST", `/api/events/${events[0]}/dive-order/sign-off/credential`, {
          token: A.token, body: { username, password: `nope-${i}` },
        });
        assert.equal(r.status, 401);
      }
      assert.equal((await fetchJson("POST", `/api/events/${events[0]}/dive-order/sign-off/credential`, {
        token: A.token, body: { username, password: pw },
      })).status, 429);
    } finally {
      process.env.RATE_LIMIT_DISABLED = "true";
    }
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("unclaimed country: a region admin can't approve their own request to join a club", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "BRB";
  await claimKit.wipe(CODE);
  try {
    const X = await delegateSignUp({ country_code: CODE, new_club_name: "Bridgetown Divers" });
    const Y = await delegateSignUp({ country_code: CODE, new_club_name: "Oistins Divers" });
    const R = await delegateSignUp({ country_code: CODE, club_id: X.clubId });
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Christ Church', 'CC') RETURNING id", [X.orgId],
    )).rows[0].id;
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = ANY($2::uuid[])", [region, [X.clubId, Y.clubId]]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [region, R.id, X.orgId]);

    const ask = await fetchJson("POST", "/api/club-change-requests", { token: R.token, body: { to_club_id: Y.clubId } });
    assert.equal(ask.status, 201, JSON.stringify(ask.body));
    const review = (tok, decision) => fetchJson("POST", `/api/club-change-requests/${ask.body.id}/review`, {
      token: tok, body: { decision },
    });
    assert.equal((await review(R.token, "approved")).status, 403);
    assert.equal((await pool.query("SELECT club_id FROM users WHERE id = $1", [R.id])).rows[0].club_id, X.clubId);
    // Y's own admin decides it.
    assert.equal((await review(Y.token, "approved")).status, 200);
    assert.equal((await pool.query("SELECT club_id FROM users WHERE id = $1", [R.id])).rows[0].club_id, Y.clubId);
  } finally {
    await pool.query(
      "DELETE FROM club_change_requests WHERE from_org_id IN (SELECT id FROM organisations WHERE country_code = $1)", [CODE],
    ).catch(() => {});
    await claimKit.wipe(CODE);
  }
});

test("referee credential sign-off: guesses from another org can't lock a federation's referee out", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CUW";
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: true });
  try {
    const pw = "federation-referee-pw-42";
    const username = `int-xo-${crypto.randomBytes(4).toString("hex")}`;
    const refId = (await pool.query(
      `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
       VALUES ($1, $2, $1, $3, now()) RETURNING id`,
      [username, await bcrypt.hash(pw, 4), state.orgId],
    )).rows[0].id;
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'referee')", [refId, state.orgId]);

    // Anyone can found a club in a country with no federation and run
    // an event, which is all this route asks of the caller.
    const X = await delegateSignUp({ country_code: CODE, new_club_name: "Willemstad Divers" });
    const meet = (await fetchJson("POST", "/api/meets", { token: X.token, body: { name: "Willemstad Open" } })).body.id;
    const ev = (await fetchJson("POST", "/api/events", {
      token: X.token,
      body: { name: "1m", gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 5, event_type: "individual", meet_id: meet },
    })).body.id;

    // Each side from its own address, so the per-IP limiter (which other
    // tests in this process have been feeding) stays out of it and only
    // the per-referee one is under test. server.js trusts one proxy hop.
    const from = (ip, path, token, body) => new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const data = JSON.stringify(body);
      const req = http.request({
        method: "POST", host: url.hostname, port: url.port, path: url.pathname,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
                   Authorization: `Bearer ${token}`, "X-Forwarded-For": ip },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "null") }));
      });
      req.on("error", reject);
      req.end(data);
    });
    const attackerIp = `10.97.${crypto.randomInt(256)}.${crypto.randomInt(256)}`;
    const venueIp = `10.98.${crypto.randomInt(256)}.${crypto.randomInt(256)}`;

    process.env.RATE_LIMIT_DISABLED = "false";
    try {
      // Five tries of junk at the federation referee's username, from the
      // attacker's own event: exactly what used to use up that referee's
      // budget. None of it can ever match (the lookup is pinned to the
      // event's org).
      for (let i = 0; i < 5; i++) {
        const r = await from(attackerIp, `/api/events/${ev}/dive-order/sign-off/credential`, X.token,
          { username, password: `junk-${i}` });
        assert.equal(r.status, 401, JSON.stringify(r.body));
      }
      // The federation's own sign-off still goes through...
      const legit = await from(venueIp, `/api/events/${state.eventId}/dive-order/sign-off/credential`,
        state.adminToken, { username, password: pw });
      assert.equal(legit.status, 200, JSON.stringify(legit.body));
      // ...while the attacker has used up their own tries at that name.
      const sixth = await from(attackerIp, `/api/events/${ev}/dive-order/sign-off/credential`, X.token,
        { username, password: "junk-6" });
      assert.equal(sixth.status, 429, JSON.stringify(sixth.body));
    } finally {
      process.env.RATE_LIMIT_DISABLED = "true";
    }
  } finally {
    await teardownFixture(state);
    await claimKit.wipe(CODE);
  }
});

test("club region moves: a claimed region with nobody left running it doesn't hold its clubs", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "MAF";
  await claimKit.wipe(CODE);
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Marigot Divers" });
    const B = await delegateSignUp({ country_code: CODE, new_club_name: "Grand Case Divers" });
    const mkRegion = async (name, code) => (await pool.query(
      "INSERT INTO regions (org_id, name, short_code, claim_state, claimed_name) VALUES ($1, $2, $3, 'claimed', $4) RETURNING id",
      [A.orgId, name, code, `${name} Diving`],
    )).rows[0].id;
    const north = await mkRegion("North", "NTH");
    const south = await mkRegion("South", "STH");
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [north, A.clubId]);
    const R = await delegateSignUp({ country_code: CODE, club_id: A.clubId });
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [north, R.id, A.orgId]);
    const Rs = await delegateSignUp({ country_code: CODE, club_id: B.clubId });
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [south, Rs.id, A.orgId]);
    const move = (tok, clubId, regionId) =>
      fetchJson("PUT", `/api/clubs/${clubId}/region`, { token: tok, body: { region_id: regionId } });
    const regionOf = async (clubId) => (await pool.query("SELECT region_id FROM clubs WHERE id = $1", [clubId])).rows[0].region_id;
    const listed = async () => Object.fromEntries(
      (await fetchJson("GET", `/api/orgs/${A.orgId}/regions`)).body.regions.map((r) => [r.id, r.has_live_admin]));

    // While North's admin is around, it decides.
    assert.equal((await move(A.token, A.clubId, null)).body.code, "region_admin_required");
    assert.deepEqual(await listed(), { [north]: true, [south]: true });

    // North's only admin deletes their account. Nobody is left to say yes,
    // so the club's own admin can take it out again...
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [R.id]);
    assert.equal((await listed())[north], false);
    assert.equal((await move(A.token, A.clubId, null)).status, 200);
    assert.equal(await regionOf(A.clubId), null);
    // ...and back in, with nobody there to ask.
    assert.equal((await move(A.token, A.clubId, north)).status, 200);
    assert.equal(await regionOf(A.clubId), north);

    // A region with a live admin still decides for itself: South hears
    // an ask, and the club doesn't move until it says yes.
    const ask = await move(A.token, A.clubId, south);
    assert.equal(ask.status, 202, JSON.stringify(ask.body));
    assert.equal(await regionOf(A.clubId), north);
    const told = await pool.query(
      "SELECT category FROM notifications WHERE user_id = $1", [Rs.id]);
    assert.deepEqual(told.rows.map((r) => r.category), ["region_request"]);
    assert.equal((await move(Rs.token, A.clubId, south)).status, 200);
    assert.equal(await regionOf(A.clubId), south);
    const heard = await pool.query(
      "SELECT category FROM notifications WHERE user_id = $1", [A.id]);
    assert.deepEqual(heard.rows.map((r) => r.category), ["region_decision"]);
  } finally {
    await claimKit.wipe(CODE);
  }
});
