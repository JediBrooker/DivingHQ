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
    // Nobody to approve it there, so it's live straight away (migration 096).
    assert.equal(first.body.club_status, "active");
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

    // Under a real (claimed) federation founding a club doesn't make you
    // its admin, and the club waits for the federation to approve it
    // (migration 096, the club approval tests further down).
    const claimed = await reg({ org_id: state.orgId, new_club_name: "Claimed Fed Club" });
    assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
    assert.equal(claimed.body.club_status, "pending");
    const cc = await pool.query(
      `SELECT c.status, EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id) AS has_admin
         FROM clubs c WHERE c.org_id = $1 AND c.name = 'Claimed Fed Club'`, [state.orgId],
    );
    assert.equal(cc.rows[0].has_admin, false);
    assert.equal(cc.rows[0].status, "pending");
    const nru = (await pool.query("SELECT status FROM clubs WHERE id = $1", [club.id])).rows[0];
    assert.equal(nru.status, "active");

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
  // The body's own domain, not the founders' example.test: a voter whose
  // email shares the claimant's organisation domain loses their vote.
  async claim(body) {
    const username = `int-cf-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register-org", {
      body: { slug: `claim-${crypto.randomBytes(3).toString("hex")}`, username, password: TEST_PASSWORD,
              full_name: "Claimant", email: `${username}@claimant.example.org`, ...body },
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
    assert.deepEqual(list[0].my_votes, [{ voter_id: A.clubId, name: "Apia Divers", vote: null }]);

    // The young club and the claimant don't get a vote.
    assert.equal((await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: young.token, body: { vote: "approve" } })).status, 403);
    const fedLogin = await claimKit.login(fed.username);
    assert.equal((await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: fedLogin.token, body: { vote: "approve" } })).status, 403);

    // One of three isn't a majority; two is.
    let v = await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: A.token, body: { vote: "approve" } });
    assert.equal(v.body.status, "open");
    assert.equal((await fetchJson("POST", `/api/claims/${claimRow.id}/vote`, { token: A.token, body: { vote: "approve" } })).status, 403, "one vote per club");
    // The listing folds the tally and the caller's seats into its one
    // query, so check it reads the same as the vote just cast.
    const voted = (await fetchJson("GET", "/api/claims", { token: A.token })).body[0];
    assert.deepEqual(voted.tally, { eligible: 3, approvals: 1, objections: 0 });
    assert.deepEqual(voted.my_votes, [{ voter_id: A.clubId, name: "Apia Divers", vote: "approve" }]);
    assert.equal(voted.can_vote, false, "its one seat has voted");
    assert.deepEqual(voted.objections, []);
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
    const aList = (await fetchJson("GET", "/api/claims", { token: A.token })).body.find((c) => c.id === id);
    assert.deepEqual(aList.objections, [], "only the sysadmin reads the reasons");
    assert.deepEqual(aList.tally, { eligible: 2, approvals: 0, objections: 1 });

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
    // One approval of three isn't enough to pass on the spot, and a
    // quiet window doesn't make it enough: it goes to the sysadmin.
    await fetchJson("POST", `/api/claims/${id}/vote`, { token: A.token, body: { vote: "approve" } });
    await pool.query("UPDATE claims SET closes_at = now() - interval '1 minute' WHERE id = $1", [id]);
    const r = await sweepOnce({ pool });
    assert.ok(r.resolved >= 1);
    const swept = (await pool.query("SELECT status, status_reason FROM claims WHERE id = $1", [id])).rows[0];
    assert.equal(swept.status, "escalated");
    assert.match(swept.status_reason, /1 of 3 approving, short of the 2 needed/);

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
    // Judges only score a Live event, and an Upcoming one sets no records.
    await pool.query("UPDATE events SET status = 'Live' WHERE id = $1", [ev.body.id]);
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
    // A Mixed event files the dive under the diver's own gender
    // (migration 094), so give the founder one or nothing is set.
    await pool.query("UPDATE users SET gender = 'female' WHERE id = $1", [A.id]);
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
    // Same answer for somebody who isn't signed in: the books are public.
    const anon = await fetchJson("GET", `/api/records?scope=region&scope_id=${on}`);
    assert.equal(anon.status, 200);
    assert.equal(anon.body[0].official, false);
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

    // Revoking tells the claimant, with the reason, and the clubs that
    // were told who runs things now (without it).
    sent.length = 0;
    await claimsLib.revoke(pool, { claimId: id, user: { is_system_admin: true, id: null }, reason: "Duplicate body" }, deps);
    const revokedMail = sent.find((m) => m.userIds.includes(fed.id));
    assert.deepEqual(revokedMail.userIds, [fed.id]);
    assert.match(revokedMail.body, /Duplicate body/);
    const clubsMail = sent.find((m) => !m.userIds.includes(fed.id));
    assert.deepEqual(clubsMail.userIds, [A.id, B.id].sort());
    assert.match(clubsMail.subject, /no longer runs Cook Islands/);
    assert.doesNotMatch(clubsMail.body, /Duplicate body/);

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
  const link = (sub) => claimKit.jwt.sign({ sub, type: "email_verify" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  let pendingOrgId = null;
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

    // A federation from a code outside the country list still gets the
    // old pending org, and the page says it's waiting for approval. (A
    // real country opens a claim now, covered further down.)
    const pendingUser = `int-cf-${crypto.randomBytes(4).toString("hex")}`;
    const pend = await fetchJson("POST", "/api/auth/register-org", {
      body: { org_name: "Test Land Diving", country_code: "TST", slug: `tst-${crypto.randomBytes(3).toString("hex")}`,
              username: pendingUser, password: TEST_PASSWORD, full_name: "TST Admin", email: `${pendingUser}@example.test` },
    });
    assert.equal(pend.status, 201, JSON.stringify(pend.body));
    pendingOrgId = pend.body.org_id;
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
    await teardownFixture({ orgId: pendingOrgId });
  }
});

// ---------------------------------------------------------------------
// Countries and federations at signup (migration 093).
// ---------------------------------------------------------------------

// R19: a federation from a country nobody's on yet doesn't get a pending
// org of its own any more. It claims a freshly started country account,
// so the country's first club lands in the same place.
test("register-org: a federation from a brand-new country claims its account", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "WLF";
  await claimKit.wipe(CODE);
  try {
    const fed = await claimKit.claim({ org_name: "Wallis and Futuna Diving", country_code: CODE, slug: undefined });
    assert.equal(fed.res.status, 201, JSON.stringify(fed.res.body));
    assert.equal(fed.res.body.approver, "sysadmin", "nobody there to vote yet");
    assert.equal(fed.res.body.target_kind, "org");
    assert.equal(fed.res.body.org_id, undefined, "no org of its own");

    const orgs = (await pool.query(
      "SELECT id, status, claim_state, name FROM organisations WHERE country_code = $1", [CODE],
    )).rows;
    assert.equal(orgs.length, 1, "one account for the country, no pending twin");
    assert.equal(orgs[0].status, "active");
    assert.equal(orgs[0].claim_state, "unclaimed");
    assert.equal(orgs[0].name, "Wallis & Futuna");
    const claim = (await pool.query("SELECT * FROM claims WHERE id = $1", [fed.res.body.claim_id])).rows[0];
    assert.equal(claim.target_id, orgs[0].id);
    assert.equal(claim.body_name, "Wallis and Futuna Diving");

    // They can sign in (as a spectator) while it's reviewed.
    const v = await fetchJson("POST", "/api/auth/verify-email", {
      body: { token: claimKit.jwt.sign({ sub: fed.id, type: "email_verify" }, process.env.JWT_SECRET, { expiresIn: "1h" }) },
    });
    assert.equal(v.body.next, "claim_open");
    const me = await claimKit.login(fed.username);
    assert.ok(me.token, "claimant can sign in");
    assert.equal(me.org_id, orgs[0].id);

    // The country's first club joins that account rather than starting another.
    await claimKit.founder(CODE, "Mata-Utu Divers");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM organisations WHERE country_code = $1", [CODE])).rows[0].n, 1);

    // A second federation for the same country is told it's already claimed for.
    const again = await claimKit.claim({ org_name: "Rival Wallis Diving", country_code: CODE });
    assert.equal(again.res.status, 409);
    assert.equal(again.res.body.code, "claim_in_progress");

    // DivingHQ approves: the account becomes the federation.
    const sys = await claimKit.login("admin", "admin");
    if (sys?.token) {
      const d = await fetchJson("POST", `/api/claims/${claim.id}/decide`, { token: sys.token, body: { decision: "approve" } });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const after = (await pool.query("SELECT name, claim_state FROM organisations WHERE id = $1", [orgs[0].id])).rows[0];
      assert.deepEqual(after, { name: "Wallis and Futuna Diving", claim_state: "claimed" });
      const roles = (await claimKit.login(fed.username)).org_roles;
      assert.ok(roles.includes("org_admin"));
    }
  } finally {
    await claimKit.wipe(CODE);
  }
});

// R6: a country is required and has to be alpha-3; the slug is ours to make.
test("register-org: country is required and the slug comes from the name", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const made = [];
  const register = async (body) => {
    const username = `int-slug-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register-org", {
      body: { username, password: TEST_PASSWORD, full_name: "Slug Tester", email: `${username}@example.test`, ...body },
    });
    if (r.body?.org_id) made.push(r.body.org_id);
    return r;
  };
  try {
    for (const country_code of [undefined, "", "AU", "aus", "AUST", 12]) {
      const r = await register({ org_name: "No Country Diving", country_code });
      assert.equal(r.status, 400, `country_code ${JSON.stringify(country_code)}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "country_required");
    }

    // An uncatalogued code keeps the old pending path, and without a slug
    // one is made from the name, suffixed when it's taken.
    const tag = crypto.randomBytes(3).toString("hex");
    const a = await register({ org_name: `Fédération Test ${tag}`, country_code: "TST" });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await register({ org_name: `Fédération Test ${tag}`, country_code: "TST" });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const slugs = (await pool.query(
      "SELECT id, slug, status, country_code FROM organisations WHERE id = ANY($1::uuid[]) ORDER BY created_at",
      [[a.body.org_id, b.body.org_id]],
    )).rows;
    assert.equal(slugs.length, 2);
    assert.equal(slugs.find((o) => o.id === a.body.org_id).slug, `federation-test-${tag}`);
    assert.match(slugs.find((o) => o.id === b.body.org_id).slug, new RegExp(`^federation-test-${tag}-[0-9a-f]{4}$`));
    assert.ok(slugs.every((o) => o.status === "pending" && o.country_code === "TST"));

    // Nothing Latin in the name: falls back to the country.
    const c = await register({ org_name: "Федерация прыжков", country_code: "TST" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const cs = (await pool.query("SELECT slug FROM organisations WHERE id = $1", [c.body.org_id])).rows[0].slug;
    assert.match(cs, /^org-tst(-[0-9a-f]{4})?$/);

    // An explicit slug still works, has to be URL-safe, and is the
    // client's to lose on a clash.
    const own = `int-own-${tag}`;
    const d = await register({ org_name: "Own Slug Diving", country_code: "TST", slug: own });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal((await pool.query("SELECT slug FROM organisations WHERE id = $1", [d.body.org_id])).rows[0].slug, own);
    const taken = await register({ org_name: "Own Slug Again", country_code: "TST", slug: own });
    assert.equal(taken.status, 400);
    assert.match(taken.body.error, /already taken/);
    const bad = await register({ org_name: "Bad Slug", country_code: "TST", slug: "Not A Slug" });
    assert.equal(bad.status, 400);
  } finally {
    for (const orgId of made) await teardownFixture({ orgId });
  }
});

// #8 / #26: a federation still waiting for approval is that country's org
// being set up. A club signing up meanwhile is told so, instead of
// starting an unclaimed account the approval would then sit next to.
test("a pending federation blocks a parallel country account", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "SPM";
  await claimKit.wipe(CODE);
  await claimKit.wipe("PM");
  try {
    // Legacy rows: register-org can't make these for a real country now.
    for (const code of [CODE, "PM"]) {
      const pending = (await pool.query(
        `INSERT INTO organisations (name, country_code, slug, status)
         VALUES ('Saint Pierre Diving', $1, $2, 'pending') RETURNING id`,
        [code, `int-spm-${crypto.randomBytes(4).toString("hex")}`],
      )).rows[0].id;

      const username = `int-spm-${crypto.randomBytes(4).toString("hex")}`;
      const club = await fetchJson("POST", "/api/auth/register", {
        body: { username, full_name: "Club Founder", password: TEST_PASSWORD, email: `${username}@example.test`,
                country_code: CODE, new_club_name: "Saint-Pierre Plongeon" },
      });
      assert.equal(club.status, 409, `${code}: ${JSON.stringify(club.body)}`);
      assert.equal(club.body.code, "federation_pending");
      assert.match(club.body.error, /waiting for approval/);

      const fed = await claimKit.claim({ org_name: "Another SPM Body", country_code: CODE });
      assert.equal(fed.res.status, 409, JSON.stringify(fed.res.body));
      assert.equal(fed.res.body.code, "federation_pending");

      const n = (await pool.query(
        "SELECT count(*)::int AS n FROM organisations WHERE country_code IN ('SPM', 'PM')",
      )).rows[0].n;
      assert.equal(n, 1, "nothing started next to the pending federation");
      assert.equal((await pool.query("SELECT 1 FROM users WHERE username = $1", [username])).rows.length, 0);
      await teardownFixture({ orgId: pending });
    }

    // Once there's nothing pending, the country's first club starts it as usual.
    await claimKit.founder(CODE, "Miquelon Divers");
    const org = (await pool.query("SELECT claim_state FROM organisations WHERE country_code = $1", [CODE])).rows;
    assert.deepEqual(org, [{ claim_state: "unclaimed" }]);
  } finally {
    await claimKit.wipe(CODE);
    await claimKit.wipe("PM");
  }
});

// #6 belt and braces: until migration 093 has run on a box, a federation
// stored with its alpha-2 code must still be the one its country joins.
test("a federation stored with an alpha-2 code is still found by country", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "MSR";
  await claimKit.wipe(CODE);
  await claimKit.wipe("MS");
  try {
    const fedId = (await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status)
       VALUES ('Montserrat Diving', 'MS', $1, 'active') RETURNING id`,
      [`int-msr-${crypto.randomBytes(4).toString("hex")}`],
    )).rows[0].id;

    const lookup = await fetchJson("GET", `/api/orgs/by-country/${CODE}`);
    assert.deepEqual(lookup.body.map((o) => o.id), [fedId]);

    const username = `int-msr-${crypto.randomBytes(4).toString("hex")}`;
    const reg = await fetchJson("POST", "/api/auth/register", {
      body: { username, full_name: "Plymouth Diver", password: TEST_PASSWORD, email: `${username}@example.test`, country_code: CODE },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal((await pool.query("SELECT org_id FROM users WHERE username = $1", [username])).rows[0].org_id, fedId);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM organisations WHERE country_code = $1", [CODE])).rows[0].n, 0,
      "no unclaimed Montserrat next to the real one");

    // And a second body for the country is sent to support, not handed a
    // pending org of its own.
    const fed = await claimKit.claim({ org_name: "Montserrat Aquatics", country_code: CODE });
    assert.equal(fed.res.status, 409, JSON.stringify(fed.res.body));
    assert.equal(fed.res.body.code, "already_claimed");
    assert.match(fed.res.body.error, /Montserrat Diving already runs Montserrat/);
  } finally {
    await claimKit.wipe(CODE);
    await claimKit.wipe("MS");
  }
});

// The sysadmin side of #6 / #26: approving needs a country and won't split
// one, and live orgs with no usable country can be given one.
test("sysadmin: org countries, and approvals that would split a country", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const sys = await claimKit.login("admin", "admin");
  if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
  const CODE = "FRO";
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: false });
  const made = [];
  const mkOrg = async (country, status) => {
    const id = (await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status) VALUES ($1, $2, $3, $4) RETURNING id`,
      [`Int Country ${crypto.randomBytes(3).toString("hex")}`, country, `int-cc-${crypto.randomBytes(4).toString("hex")}`, status],
    )).rows[0].id;
    made.push(id);
    return id;
  };
  try {
    // No country, no approval.
    const noCountry = await mkOrg(null, "pending");
    const st = await fetchJson("PUT", `/api/orgs/${noCountry}/status`, { token: sys.token, body: { status: "active" } });
    assert.equal(st.status, 400, JSON.stringify(st.body));
    assert.equal(st.body.code, "country_required");
    assert.equal((await fetchJson("PUT", `/api/orgs/${noCountry}/status`, { token: sys.token, body: { status: "bogus" } })).status, 400);

    // Live orgs signups can't find by country are listed for fixing.
    const lost = await mkOrg(null, "active");
    const ioc = await mkOrg("GER", "active");
    const fine = await mkOrg("GRL", "active");
    const list = (await fetchJson("GET", "/api/orgs/needs-country", { token: sys.token })).body;
    const ids = list.map((o) => o.id);
    assert.ok(ids.includes(lost) && ids.includes(ioc), "NULL and non-ISO codes are listed");
    assert.ok(!ids.includes(fine) && !ids.includes(noCountry), "real codes and pending orgs aren't");
    assert.equal((await fetchJson("GET", "/api/orgs/needs-country", { token: state.adminToken })).status, 403);

    // Give one its country.
    assert.equal((await fetchJson("PUT", `/api/orgs/${lost}/country`, { token: sys.token, body: { country_code: "XX" } })).body.code, "country_unknown");
    assert.equal((await fetchJson("PUT", `/api/orgs/${lost}/country`, { token: state.adminToken, body: { country_code: "GRL" } })).status, 403);
    const set = await fetchJson("PUT", `/api/orgs/${lost}/country`, { token: sys.token, body: { country_code: "grl" } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.country_code, "GRL");
    const audit = await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'org.country_changed'", [lost],
    );
    assert.deepEqual(audit.rows[0]?.metadata, { from: null, to: "GRL" });
    assert.ok(!(await fetchJson("GET", "/api/orgs/needs-country", { token: sys.token })).body.some((o) => o.id === lost));
    await pool.query("DELETE FROM audit_log WHERE entity_id = $1", [lost]);

    // Clubs started the Faroes; approving a pending Faroese federation now
    // would give the country two accounts.
    await claimKit.founder(CODE, "Tórshavn Divers");
    const clubsOrg = (await pool.query(
      "SELECT id FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'", [CODE],
    )).rows[0].id;
    const fed = await mkOrg(CODE, "pending");
    const clash = await fetchJson("PUT", `/api/orgs/${fed}/status`, { token: sys.token, body: { status: "active" } });
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal(clash.body.code, "country_has_unclaimed_org");
    assert.equal((await pool.query("SELECT status FROM organisations WHERE id = $1", [fed])).rows[0].status, "pending");
    // Denying it is still fine.
    assert.equal((await fetchJson("PUT", `/api/orgs/${fed}/status`, { token: sys.token, body: { status: "suspended" } })).status, 200);
    // And the clubs' own account keeps its country.
    const fixed = await fetchJson("PUT", `/api/orgs/${clubsOrg}/country`, { token: sys.token, body: { country_code: "GRL" } });
    assert.equal(fixed.status, 409);
    assert.equal(fixed.body.code, "unclaimed_country_fixed");
  } finally {
    await pool.query("DELETE FROM audit_log WHERE entity_id = ANY($1::uuid[])", [made]).catch(() => {});
    for (const orgId of made) await teardownFixture({ orgId });
    await teardownFixture(state);
    await claimKit.wipe(CODE);
  }
});

// Review follow-up to the approval guard: before migration 093 has run, a
// pending federation can still be stored as 'IM'. It's the Isle of Man all
// the same, so approving it next to the clubs' IMN account is refused too.
test("approving a pending org stored with an alpha-2 code can't split its country", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const sys = await claimKit.login("admin", "admin");
  if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
  const CODE = "IMN";
  await claimKit.wipe(CODE);
  await claimKit.wipe("IM");
  try {
    await claimKit.founder(CODE, "Douglas Divers");
    const fed = (await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status)
       VALUES ('Manx Diving', 'IM', $1, 'pending') RETURNING id`,
      [`int-im-${crypto.randomBytes(4).toString("hex")}`],
    )).rows[0].id;
    const r = await fetchJson("PUT", `/api/orgs/${fed}/status`, { token: sys.token, body: { status: "active" } });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "country_has_unclaimed_org");
    assert.equal((await pool.query("SELECT status FROM organisations WHERE id = $1", [fed])).rows[0].status, "pending");
  } finally {
    await claimKit.wipe(CODE);
    await claimKit.wipe("IM");
  }
});

// The edges of R19's "every real country is a claim": two federations
// racing for the same empty country, a country whose clubs' account the
// sysadmin has paused, and a state body behind a pending federation.
test("register-org: a race for a new country, a paused country, a region behind a pending org", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const codes = ["JEY", "GGY", "GIB"];
  for (const c of codes) await claimKit.wipe(c);
  const count = async (code) =>
    (await pool.query("SELECT count(*)::int AS n FROM organisations WHERE country_code = $1", [code])).rows[0].n;
  try {
    // Both see an empty Jersey. One country account comes out of it.
    // Unverified claims don't hold a target (migration 092), so both are
    // accepted, and it's settled when they verify: only one goes live.
    const [a, b] = await Promise.all([
      claimKit.claim({ org_name: "Jersey Diving", country_code: "JEY" }),
      claimKit.claim({ org_name: "Jersey Aquatics", country_code: "JEY" }),
    ]);
    assert.deepEqual([a.res.status, b.res.status], [201, 201], JSON.stringify([a.res.body, b.res.body]));
    assert.equal(await count("JEY"), 1);
    await claimKit.verify(a.id);
    await claimKit.verify(b.id);
    const jey = (await pool.query(
      "SELECT status FROM claims WHERE id = ANY($1::uuid[]) ORDER BY status",
      [[a.res.body.claim_id, b.res.body.claim_id]],
    )).rows.map((r) => r.status);
    assert.deepEqual(jey, ["open", "withdrawn"]);

    // The sysadmin paused Guernsey's account: no second one beside it.
    await claimKit.founder("GGY", "St Peter Port Divers");
    await pool.query("UPDATE organisations SET status = 'suspended' WHERE country_code = 'GGY'");
    const paused = await claimKit.claim({ org_name: "Guernsey Diving", country_code: "GGY" });
    assert.equal(paused.res.status, 409, JSON.stringify(paused.res.body));
    assert.equal(paused.res.body.code, "claim_needs_support");
    assert.equal(await count("GGY"), 1);
    assert.equal(paused.id, undefined);

    // A pending federation holds the country against a state body too.
    await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status) VALUES ('Gibraltar Diving', 'GIB', $1, 'pending')`,
      [`int-gib-${crypto.randomBytes(4).toString("hex")}`],
    );
    const region = await claimKit.claim({ org_name: "Upper Rock Diving", country_code: "GIB", region_code: "UR" });
    assert.equal(region.res.status, 409, JSON.stringify(region.res.body));
    assert.equal(region.res.body.code, "federation_pending");
    assert.equal(await count("GIB"), 1);
  } finally {
    for (const c of codes) await claimKit.wipe(c);
  }
});

// ---------------------------------------------------------------------
// Claims hardening (migration 092).
// ---------------------------------------------------------------------

// Stands in for push + email when a test drives lib/claims directly.
function claimInbox() {
  const mail = [];
  const inApp = [];
  return {
    mail,
    inApp,
    deps: {
      email: { sendClaimEmail: async (userIds, msg) => { mail.push({ userIds: [...userIds].sort(), ...msg }); } },
      push: { sendNotification: async (userIds, p) => { inApp.push({ userIds: [...userIds].sort(), ...p }); } },
    },
    mailTo(id, re) { return mail.find((m) => m.userIds.includes(id) && (!re || re.test(m.subject))); },
    inAppTo(id, re) { return inApp.find((m) => m.userIds.includes(id) && (!re || re.test(m.title))); },
    clear() { mail.length = 0; inApp.length = 0; },
  };
}

// The shape lib/claims wants for req.user, read fresh from the row.
async function claimActor(id) {
  const u = (await pool.query("SELECT id, org_id, is_system_admin FROM users WHERE id = $1", [id])).rows[0];
  const roles = (await pool.query("SELECT role::text AS role FROM user_org_roles WHERE user_id = $1 AND org_id = $2", [id, u.org_id])).rows;
  return { id: u.id, org_id: u.org_id, is_system_admin: u.is_system_admin, org_roles: roles.map((r) => r.role) };
}

async function claimSysadmin() {
  const id = (await pool.query("SELECT id FROM users WHERE is_system_admin ORDER BY created_at LIMIT 1")).rows[0]?.id;
  return id ? { id, org_id: null, is_system_admin: true, org_roles: [] } : null;
}

const claimStatus = async (id) => (await pool.query("SELECT status, status_reason, activated_at FROM claims WHERE id = $1", [id])).rows[0];

test("claims: a club admin's second account can't vote its own claim through", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "SHN";
  await claimKit.wipe(CODE);
  try {
    const tag = crypto.randomBytes(4).toString("hex");
    const A = await claimKit.founder(CODE, "Jamestown Divers");
    const B = await claimKit.founder(CODE, "Longwood Divers");
    const C = await claimKit.founder(CODE, "Half Tree Hollow Divers");
    const D = await claimKit.founder(CODE, "Levelwood Divers");
    for (const x of [A, B, C, D]) await claimKit.makeEligible(x.clubId);
    // A runs a club from Gmail. B works for the body. D is on Gmail too,
    // a different mailbox, which says nothing about who they are.
    await pool.query("UPDATE users SET email = $2 WHERE id = $1", [A.id, `sh.boss.${tag}@gmail.com`]);
    await pool.query("UPDATE users SET email = $2 WHERE id = $1", [B.id, `coach-${tag}@shdiving-${tag}.example.org`]);
    await pool.query("UPDATE users SET email = $2 WHERE id = $1", [D.id, `someone.else.${tag}@gmail.com`]);
    const voters = async (claimId) => (await pool.query(
      "SELECT voter_id FROM claim_voters WHERE claim_id = $1", [claimId],
    )).rows.map((r) => r.voter_id).sort();

    // A opens a claim under the same mailbox, spelt differently: their
    // own club doesn't get a vote on it.
    const sock = await claimKit.claim({ org_name: "St Helena Diving", country_code: CODE, email: `shboss${tag}+fed@googlemail.com` });
    assert.equal(sock.res.status, 201, JSON.stringify(sock.res.body));
    assert.equal(sock.res.body.approver, "clubs");
    assert.deepEqual(await voters(sock.res.body.claim_id), [B.clubId, C.clubId, D.clubId].sort());

    // The body itself registers from its own domain (a subdomain of B's).
    // That replaces the unverified one, and B's club sits this one out.
    const fed = await claimKit.claim({ org_name: "St Helena Diving", country_code: CODE, email: `office-${tag}@mail.shdiving-${tag}.example.org` });
    assert.equal(fed.res.status, 201, JSON.stringify(fed.res.body));
    const id = fed.res.body.claim_id;
    assert.deepEqual(await voters(id), [A.clubId, C.clubId, D.clubId].sort());
    const opened = (await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'claim.opened'", [id],
    )).rows[0].metadata;
    assert.equal(opened.excluded_voters, 1);
    assert.deepEqual(opened.replaced, [sock.res.body.claim_id]);
    assert.equal((await claimStatus(sock.res.body.claim_id)).status, "withdrawn");

    // B gets made an admin of a voting club after the snapshot: the same
    // test runs when the vote is cast.
    await claimKit.verify(fed.id);
    await pool.query(
      "INSERT INTO club_admins (club_id, user_id, org_id) SELECT id, $2, org_id FROM clubs WHERE id = $1",
      [C.clubId, B.id],
    );
    const v = await fetchJson("POST", `/api/claims/${id}/vote`, { token: B.token, body: { vote: "approve", voter_id: C.clubId } });
    assert.equal(v.status, 403, JSON.stringify(v.body));
    assert.match(v.body.error, /matches the claimant/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM claim_votes WHERE claim_id = $1", [id])).rows[0].n, 0);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: revoking a national claim takes back everything handed out under it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "SPM";
  await claimKit.wipe(CODE);
  try {
    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
    const A = await claimKit.founder(CODE, "Saint-Pierre Plongeon");
    const B = await claimKit.founder(CODE, "Miquelon Plongeon");
    const C = await claimKit.founder(CODE, "Langlade Plongeon");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const region = async (name, code) => (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, name, code],
    )).rows[0].id;
    const north = await region("Nord", "NRD");
    const south = await region("Sud", "SUD");
    // Someone already looked after the south before any claim: that stays.
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [south, C.id, orgId]);

    const fed = await claimKit.claim({ org_name: "Fédération de Plongeon SPM", country_code: CODE });
    assert.equal(fed.res.body.approver, "clubs");
    await claimKit.verify(fed.id);
    const id = fed.res.body.claim_id;
    for (const x of [A, B]) await fetchJson("POST", `/api/claims/${id}/vote`, { token: x.token, body: { vote: "approve" } });
    assert.equal((await claimStatus(id)).status, "approved");

    // While it runs the country, the federation hands out access.
    const fedToken = (await claimKit.login(fed.username)).token;
    const put = async (userId, roles) => (await fetchJson("PUT", `/api/users/${userId}/roles`, { token: fedToken, body: { roles } })).status;
    assert.equal(await put(C.id, ["org_admin", "meet_manager", "spectator"]), 200);
    assert.equal(await put(A.id, ["meet_manager", "spectator"]), 200);
    assert.equal((await fetchJson("POST", `/api/clubs/${A.clubId}/admins`, { token: fedToken, body: { user_id: C.id } })).status, 201);
    assert.equal((await fetchJson("POST", `/api/regions/${north}/admins`, { token: fedToken, body: { user_id: B.id } })).status, 201);
    // ...and approves a state body.
    const state = await claimKit.claim({ org_name: "Plongeon du Nord", country_code: CODE, region_code: "NRD" });
    assert.equal(state.res.body.approver, "parent");
    await claimKit.verify(state.id);
    assert.equal((await fetchJson("POST", `/api/claims/${state.res.body.claim_id}/decide`, { token: fedToken, body: { decision: "approve" } })).status, 200);
    // ...and has another waiting on its decision.
    const waiting = await claimKit.claim({ org_name: "Plongeon du Sud", country_code: CODE, region_code: "SUD" });
    assert.equal(waiting.res.body.approver, "parent");
    await claimKit.verify(waiting.id);

    const everyone = [fed.id, A.id, B.id, C.id, state.id];
    const versions = async () => Object.fromEntries((await pool.query(
      "SELECT id, token_version FROM users WHERE id = ANY($1::uuid[])", [everyone],
    )).rows.map((r) => [r.id, r.token_version]));
    const before = await versions();

    const rv = await fetchJson("POST", `/api/claims/${id}/revoke`, { token: sys.token, body: { reason: "Not the federation" } });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));

    // Unclaimed again means nobody holds org-wide power.
    const orgRow = (await pool.query("SELECT claim_state, name FROM organisations WHERE id = $1", [orgId])).rows[0];
    assert.deepEqual(orgRow, { claim_state: "unclaimed", name: "St. Pierre & Miquelon" });
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM user_org_roles WHERE org_id = $1 AND role IN ('org_admin', 'meet_manager')", [orgId],
    )).rows[0].n, 0);
    // Founders keep their own clubs; the admin the federation added goes.
    const clubAdmins = (await pool.query(
      "SELECT club_id, user_id FROM club_admins WHERE org_id = $1", [orgId],
    )).rows.map((r) => `${r.club_id}:${r.user_id}`).sort();
    assert.deepEqual(clubAdmins, [`${A.clubId}:${A.id}`, `${B.clubId}:${B.id}`, `${C.clubId}:${C.id}`].sort());
    // Region admins from before the claim stay, the rest go, and so does
    // the state body the federation approved.
    const regionAdmins = (await pool.query("SELECT region_id, user_id FROM region_admins WHERE org_id = $1", [orgId])).rows;
    assert.deepEqual(regionAdmins, [{ region_id: south, user_id: C.id }]);
    assert.deepEqual((await pool.query("SELECT claim_state, claimed_name FROM regions WHERE id = $1", [north])).rows[0],
      { claim_state: "unclaimed", claimed_name: null });
    assert.equal((await claimStatus(state.res.body.claim_id)).status, "revoked");
    // The one still waiting on the federation goes to DivingHQ instead.
    const orphan = await claimStatus(waiting.res.body.claim_id);
    assert.equal(orphan.status, "escalated");
    assert.match(orphan.status_reason, /no longer runs the country/);
    // Everyone who lost something signs in again.
    const after = await versions();
    for (const u of everyone) assert.ok(after[u] > before[u], `token_version bumped for ${u}`);
    // Nobody is left with no role at all.
    for (const u of [fed.id, C.id]) {
      assert.ok((await pool.query("SELECT 1 FROM user_org_roles WHERE user_id = $1 AND org_id = $2", [u, orgId])).rows.length);
    }

    // The response and the audit log both say what went.
    const pairs = (rows, key) => rows.map((r) => `${r.user_id}:${r[key]}`).sort();
    const removed = rv.body.removed;
    assert.deepEqual(pairs(removed.org_roles, "role"),
      [`${fed.id}:org_admin`, `${C.id}:org_admin`, `${C.id}:meet_manager`, `${A.id}:meet_manager`].sort());
    assert.deepEqual(pairs(removed.club_admins, "club_id"), [`${C.id}:${A.clubId}`]);
    assert.deepEqual(pairs(removed.region_admins, "region_id"), [`${B.id}:${north}`, `${state.id}:${north}`].sort());
    assert.deepEqual(removed.region_claims.map((r) => r.id), [state.res.body.claim_id]);
    assert.ok(removed.org_roles.every((r) => r.full_name), "names come back for the sysadmin to read");
    const audit = (await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'claim.revoked'", [id],
    )).rows[0].metadata;
    assert.equal(audit.reason, "Not the federation");
    assert.equal(audit.removed.org_roles.length, 4);
    assert.deepEqual(audit.removed.region_claims, [state.res.body.claim_id]);

    // The appointees and the state body hear about it (in-app, real push).
    const noticed = async (userId) => (await pool.query(
      "SELECT title FROM notifications WHERE user_id = $1 AND data->>'claim_id' IS NOT NULL ORDER BY created_at", [userId],
    )).rows.map((r) => r.title);
    assert.ok((await noticed(C.id)).some((x) => /Your access in St\. Pierre & Miquelon has changed/.test(x)));
    assert.ok((await noticed(state.id)).some((x) => /Your claim on Nord .* was revoked/.test(x)));
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: revoking a region claim resets its admins, and nobody decides a claim before it's verified", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "WLF";
  await claimKit.wipe(CODE);
  const fedFx = await setupFixture({ withEvent: false });
  try {
    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
    await pool.query("UPDATE organisations SET country_code = $2 WHERE id = $1", [fedFx.orgId, CODE]);
    const uvea = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Uvea', 'UV') RETURNING id", [fedFx.orgId],
    )).rows[0].id;
    const early = await insertUser({ orgId: fedFx.orgId, role: "spectator", username: `int-early-${crypto.randomBytes(3).toString("hex")}`, fullName: "Early Admin" });
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [uvea, early, fedFx.orgId]);

    const body = await claimKit.claim({ org_name: "Uvea Diving", country_code: CODE, region_code: "UV" });
    assert.equal(body.res.body.approver, "parent");
    const id = body.res.body.claim_id;

    // Not verified yet: neither the federation nor the sysadmin can decide it.
    for (const token of [fedFx.adminToken, sys.token]) {
      const early409 = await fetchJson("POST", `/api/claims/${id}/decide`, { token, body: { decision: "approve" } });
      assert.equal(early409.status, 409, JSON.stringify(early409.body));
      assert.equal(early409.body.code, "claim_not_live");
    }
    const sysView = (await fetchJson("GET", "/api/claims", { token: sys.token })).body.find((c) => c.id === id);
    assert.equal(sysView.can_decide, false);
    assert.equal((await pool.query("SELECT claim_state FROM regions WHERE id = $1", [uvea])).rows[0].claim_state, "unclaimed");

    await claimKit.verify(body.id);
    assert.equal((await fetchJson("POST", `/api/claims/${id}/decide`, { token: fedFx.adminToken, body: { decision: "approve" } })).status, 200);
    const later = await insertUser({ orgId: fedFx.orgId, role: "spectator", username: `int-later-${crypto.randomBytes(3).toString("hex")}`, fullName: "Later Admin" });
    assert.equal((await fetchJson("POST", `/api/regions/${uvea}/admins`, { token: fedFx.adminToken, body: { user_id: later } })).status, 201);

    const rv = await fetchJson("POST", `/api/claims/${id}/revoke`, { token: sys.token, body: {} });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.deepEqual(rv.body.removed.region_admins.map((r) => r.user_id).sort(), [body.id, later].sort());
    assert.deepEqual(rv.body.removed.org_roles, [], "a region claim leaves the federation alone");
    assert.deepEqual((await pool.query("SELECT user_id FROM region_admins WHERE region_id = $1", [uvea])).rows, [{ user_id: early }]);
    assert.equal((await pool.query("SELECT claim_state FROM regions WHERE id = $1", [uvea])).rows[0].claim_state, "unclaimed");
    // The federation above it is told.
    const fedNotes = (await pool.query(
      "SELECT title FROM notifications WHERE user_id = $1 AND data->>'claim_id' = $2", [fedFx.adminId, id],
    )).rows.map((r) => r.title);
    assert.ok(fedNotes.some((x) => /Uvea Diving no longer runs Uvea/.test(x)), JSON.stringify(fedNotes));
  } finally {
    await pool.query("DELETE FROM claims WHERE org_id = $1", [fedFx.orgId]).catch(() => {});
    await teardownFixture(fedFx);
    await claimKit.wipe(CODE);
  }
});

test("claims: an unverified claim doesn't hold its target, and only one claim goes live", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "AIA";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "The Valley Divers");
    const B = await claimKit.founder(CODE, "Sandy Ground Divers");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;

    // A typo'd (or throwaway) claim nobody verifies doesn't block the next.
    const first = await claimKit.claim({ org_name: "Anguilla Diving", country_code: CODE });
    const second = await claimKit.claim({ org_name: "Anguilla Aquatics", country_code: CODE });
    assert.equal(second.res.status, 201, JSON.stringify(second.res.body));
    const replaced = await claimStatus(first.res.body.claim_id);
    assert.equal(replaced.status, "withdrawn");
    assert.match(replaced.status_reason, /newer claim/);
    // Its claimant is told, and can still see it once they sign in.
    const firstNote = (await pool.query("SELECT title FROM notifications WHERE user_id = $1", [first.id])).rows;
    assert.ok(firstNote.some((n) => /Your claim on Anguilla was withdrawn/.test(n.title)), JSON.stringify(firstNote));
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [first.id]);
    const mine = (await fetchJson("GET", "/api/claims", { token: (await claimKit.login(first.username)).token })).body;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, "withdrawn");
    assert.match(mine[0].status_reason, /newer claim/);
    // ...but voters never saw it, and still don't.
    assert.equal((await fetchJson("GET", "/api/claims", { token: A.token })).body.length, 0);

    // Two unverified claims at once (one slipped in while the other was
    // being opened): whichever verifies first goes live, the other is
    // withdrawn when it verifies, and told.
    const racer = await insertUser({ orgId, role: "spectator", username: `int-racer-${crypto.randomBytes(3).toString("hex")}`, fullName: "Racer" });
    const racing = (await pool.query(
      `INSERT INTO claims (target_kind, target_id, org_id, claimant_id, body_name, approver)
       VALUES ('org', $1, $1, $2, 'Racing Body', 'sysadmin') RETURNING id`, [orgId, racer],
    )).rows[0].id;
    await claimKit.verify(second.id);
    assert.ok((await claimStatus(second.res.body.claim_id)).activated_at);
    await claimKit.verify(racer);
    const lost = await claimStatus(racing);
    assert.equal(lost.status, "withdrawn");
    assert.match(lost.status_reason, /went live first/);
    assert.equal(lost.activated_at, null);
    assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND title LIKE 'Your claim on % was withdrawn'", [racer])).rows.length);

    // With one live, a new claim is still refused.
    const third = await claimKit.claim({ org_name: "Rival Body", country_code: CODE });
    assert.equal(third.res.status, 409);
    assert.equal(third.res.body.code, "claim_in_progress");

    // A pending claim can't outlive the approval of another one.
    const late = await insertUser({ orgId, role: "spectator", username: `int-late-${crypto.randomBytes(3).toString("hex")}`, fullName: "Late" });
    const lateClaim = (await pool.query(
      `INSERT INTO claims (target_kind, target_id, org_id, claimant_id, body_name, approver)
       VALUES ('org', $1, $1, $2, 'Late Body', 'sysadmin') RETURNING id`, [orgId, late],
    )).rows[0].id;
    for (const x of [A, B]) await fetchJson("POST", `/api/claims/${second.res.body.claim_id}/vote`, { token: x.token, body: { vote: "approve" } });
    assert.equal((await claimStatus(second.res.body.claim_id)).status, "approved");
    const gone = await claimStatus(lateClaim);
    assert.equal(gone.status, "withdrawn");
    assert.match(gone.status_reason, /already has its body/);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: a deleted or suspended claimant is never approved", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const claimsLib = require("../lib/claims");
  const CODE = "MSR";
  await claimKit.wipe(CODE);
  try {
    const sys = await claimSysadmin();
    if (!sys) return t.skip("no sysadmin in this DB");
    const A = await claimKit.founder(CODE, "Brades Divers");
    const B = await claimKit.founder(CODE, "Little Bay Divers");
    const C = await claimKit.founder(CODE, "Salem Divers");
    for (const x of [A, B, C]) await claimKit.makeEligible(x.clubId);
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const inbox = claimInbox();

    // Suspended mid-vote: the vote that would pass it escalates instead.
    const fed = await claimKit.claim({ org_name: "Montserrat Diving", country_code: CODE });
    await claimKit.verify(fed.id);
    const id = fed.res.body.claim_id;
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [fed.id]);
    await claimsLib.castVote(pool, { claimId: id, user: await claimActor(A.id), vote: "approve" }, inbox.deps);
    assert.equal(await claimsLib.castVote(pool, { claimId: id, user: await claimActor(B.id), vote: "approve" }, inbox.deps), "escalated");
    assert.match((await claimStatus(id)).status_reason, /suspended/);
    // The sysadmin can't approve past it either; nothing changes.
    await assert.rejects(
      claimsLib.decide(pool, { claimId: id, user: sys, decision: "approve" }, inbox.deps),
      (err) => err.status === 409 && err.code === "claimant_suspended",
    );
    assert.equal((await claimStatus(id)).status, "escalated");
    // Deleted instead: approving withdraws it, and says so.
    await pool.query("UPDATE users SET suspended_at = NULL, deleted_at = now() WHERE id = $1", [fed.id]);
    await assert.rejects(
      claimsLib.decide(pool, { claimId: id, user: sys, decision: "approve" }, inbox.deps),
      (err) => err.status === 409 && err.code === "claimant_gone",
    );
    assert.equal((await claimStatus(id)).status, "withdrawn");
    assert.equal((await pool.query("SELECT claim_state FROM organisations WHERE id = $1", [orgId])).rows[0].claim_state, "unclaimed");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM user_org_roles WHERE org_id = $1 AND role = 'org_admin'", [orgId])).rows[0].n, 0);

    // Deleting your account through the API withdraws your claim in the
    // same breath.
    const fed2 = await claimKit.claim({ org_name: "Montserrat Aquatics", country_code: CODE });
    await claimKit.verify(fed2.id);
    const fed2Token = (await claimKit.login(fed2.username)).token;
    const del = await fetchJson("POST", "/api/users/me/delete", { token: fed2Token, body: { password: TEST_PASSWORD } });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const w = await claimStatus(fed2.res.body.claim_id);
    assert.equal(w.status, "withdrawn");
    assert.match(w.status_reason, /deleted their account/);

    // ...and a club founder's (or region admin's) authority goes with them.
    const plymouth = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Plymouth', 'PLY') RETURNING id", [orgId],
    )).rows[0].id;
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [plymouth, C.id, orgId]);
    const delC = await fetchJson("POST", "/api/users/me/delete", { token: C.token, body: { password: TEST_PASSWORD } });
    assert.equal(delC.status, 200, JSON.stringify(delC.body));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM club_admins WHERE user_id = $1", [C.id])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM region_admins WHERE user_id = $1", [C.id])).rows[0].n, 0);
    const deleted = (await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'user.self_delete'", [C.id],
    )).rows[0].metadata;
    assert.equal(deleted.club_admin_rows_removed, 1);
    assert.equal(deleted.region_admin_rows_removed, 1);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: the sweep tells unverified claimants, and passes only a real majority", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { sweepOnce } = require("../lib/claims");
  const CODE = "FLK";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Stanley Divers");
    const B = await claimKit.founder(CODE, "Goose Green Divers");
    const C = await claimKit.founder(CODE, "Fox Bay Divers");
    for (const x of [A, B, C]) await claimKit.makeEligible(x.clubId);
    const inbox = claimInbox();
    const expire = (id) => pool.query("UPDATE claims SET closes_at = now() - interval '1 minute' WHERE id = $1", [id]);
    // Approvals that are on record but were never counted, as if the
    // bar had been lowered since the votes came in.
    const recordVotes = (id, voters) => pool.query(
      `INSERT INTO claim_votes (claim_id, voter_kind, voter_id, user_id, vote)
       SELECT $1, 'club', x.club_id, x.user_id, 'approve'
         FROM unnest($2::uuid[], $3::uuid[]) AS x(club_id, user_id)`,
      [id, voters.map((v) => v.clubId), voters.map((v) => v.id)],
    );

    // A week unverified: withdrawn, and the claimant hears in-app and by email.
    const stale = await claimKit.claim({ org_name: "Falklands Diving", country_code: CODE });
    await pool.query("UPDATE claims SET created_at = now() - interval '8 days' WHERE id = $1", [stale.res.body.claim_id]);
    const r1 = await sweepOnce({ pool, ...inbox.deps });
    assert.ok(r1.withdrawn >= 1);
    assert.match((await claimStatus(stale.res.body.claim_id)).status_reason, /verified within a week/);
    assert.ok(inbox.mailTo(stale.id, /Your claim on Falkland Islands was withdrawn/), JSON.stringify(inbox.mail));
    assert.ok(inbox.inAppTo(stale.id, /was withdrawn/));

    // Enough approvals, but the claimant has since gone: withdrawn, never approved.
    const gone = await claimKit.claim({ org_name: "Falklands Aquatics", country_code: CODE });
    await claimKit.verify(gone.id);
    await recordVotes(gone.res.body.claim_id, [A, B]);
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [gone.id]);
    await expire(gone.res.body.claim_id);
    await sweepOnce({ pool, ...inbox.deps });
    assert.equal((await claimStatus(gone.res.body.claim_id)).status, "withdrawn");

    // Two of three approving clears the bar, so the sweep passes it.
    inbox.clear();
    const fed = await claimKit.claim({ org_name: "Falkland Islands Diving Association", country_code: CODE });
    await claimKit.verify(fed.id);
    await recordVotes(fed.res.body.claim_id, [A, B]);
    await expire(fed.res.body.claim_id);
    await sweepOnce({ pool, ...inbox.deps });
    assert.equal((await claimStatus(fed.res.body.claim_id)).status, "approved");
    assert.match(inbox.mailTo(A.id, /now runs/).body, /The clubs voted it through/);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: outcome notices reach voters, the federation and the claimant with the right words", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const claimsLib = require("../lib/claims");
  const CODE = "MYT";
  const FED_CODE = "PCN";
  await claimKit.wipe(CODE);
  await claimKit.wipe(FED_CODE);
  const fedFx = await setupFixture({ withEvent: false });
  try {
    const sys = await claimSysadmin();
    if (!sys) return t.skip("no sysadmin in this DB");
    const sysIds = (await pool.query("SELECT id FROM users WHERE is_system_admin")).rows.map((r) => r.id);
    const inbox = claimInbox();
    const A = await claimKit.founder(CODE, "Mamoudzou Divers");
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    // Two states already run by their bodies, each with its own admin.
    const stateAdmins = [];
    for (const [name, code] of [["Grande-Terre", "GT"], ["Petite-Terre", "PT"]]) {
      const rg = (await pool.query(
        "INSERT INTO regions (org_id, name, short_code, claim_state) VALUES ($1, $2, $3, 'claimed') RETURNING id",
        [orgId, name, code],
      )).rows[0].id;
      const admin = await insertUser({ orgId, role: "spectator", username: `int-ra-${crypto.randomBytes(3).toString("hex")}`, fullName: `${name} Admin` });
      await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [rg, admin, orgId]);
      stateAdmins.push(admin);
    }
    const [X, Y] = stateAdmins;
    const live = async (claim) => {
      await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [claim.id]);
      assert.equal(await claimsLib.activateForUser(pool, claim.id, inbox.deps), 1);
    };

    // The states vote, and the claimant is told that, not "the clubs".
    const bad = await claimKit.claim({ org_name: "Mayotte Diving", country_code: CODE });
    assert.equal(bad.res.body.approver, "regions");
    await live(bad);
    assert.match(inbox.inAppTo(bad.id, /is open/).body, /The states and provinces vote until/);
    // An objection sends it to DivingHQ, and the claimant and the other
    // voter hear so, not just the sysadmin.
    inbox.clear();
    await claimsLib.castVote(pool, { claimId: bad.res.body.claim_id, user: await claimActor(X), vote: "object", reason: "Never heard of them" }, inbox.deps);
    assert.deepEqual(inbox.mailTo(sysIds[0], /needs a decision/).userIds, [...sysIds].sort());
    assert.match(inbox.mailTo(bad.id, /has gone to DivingHQ/).body, /A voter objected/);
    assert.ok(inbox.mailTo(Y, /has gone to DivingHQ/), "the voter who hadn't voted yet");
    // Turned down: the voters and clubs hear it's off, without the reason.
    inbox.clear();
    await claimsLib.decide(pool, { claimId: bad.res.body.claim_id, user: sys, decision: "reject", reason: "Unknown body" }, inbox.deps);
    assert.match(inbox.mailTo(bad.id, /wasn't approved/).body, /Unknown body/);
    const offMail = inbox.mailTo(X, /wasn't approved/);
    assert.deepEqual(offMail.userIds, [A.id, X, Y].sort());
    assert.doesNotMatch(offMail.body, /Unknown body/);

    // Passed by the states: the state admins who voted hear it, with the clubs.
    const good = await claimKit.claim({ org_name: "Fédération Mahoraise", country_code: CODE });
    await live(good);
    inbox.clear();
    for (const s of [X, Y]) await claimsLib.castVote(pool, { claimId: good.res.body.claim_id, user: await claimActor(s), vote: "approve" }, inbox.deps);
    const passed = inbox.mailTo(X, /now runs/);
    assert.deepEqual(passed.userIds, [A.id, X, Y].sort());
    assert.match(passed.body, /The states and provinces voted it through/);

    // A state body under a federation that doesn't decide in time: it
    // goes to DivingHQ, the federation is told, and hears the outcome.
    await pool.query("UPDATE organisations SET country_code = $2 WHERE id = $1", [fedFx.orgId, FED_CODE]);
    await pool.query("INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Adamstown', 'ADM')", [fedFx.orgId]);
    const body = await claimKit.claim({ org_name: "Adamstown Diving", country_code: FED_CODE, region_code: "ADM" });
    assert.equal(body.res.body.approver, "parent");
    inbox.clear();
    await live(body);
    assert.match(inbox.mailTo(fedFx.adminId, /wants to run/).body, /If nobody decides by .*, it goes to DivingHQ/);
    assert.match(inbox.inAppTo(body.id, /is open/).body, /The federation decides/);
    await pool.query("UPDATE claims SET closes_at = now() - interval '1 minute' WHERE id = $1", [body.res.body.claim_id]);
    inbox.clear();
    await claimsLib.sweepOnce({ pool, ...inbox.deps });
    assert.equal((await claimStatus(body.res.body.claim_id)).status, "escalated");
    assert.ok(inbox.mailTo(fedFx.adminId, /has gone to DivingHQ/));
    inbox.clear();
    await claimsLib.decide(pool, { claimId: body.res.body.claim_id, user: sys, decision: "approve" }, inbox.deps);
    const toFed = inbox.mailTo(fedFx.adminId, /now runs/);
    assert.ok(toFed, "the federation hears a state body now runs its region");
    assert.match(toFed.body, /DivingHQ approved it/);
    assert.match(toFed.body, /Role requests from its clubs still go to/);
    assert.doesNotMatch(toFed.body, /review role requests/);

    // Nobody to vote: the sysadmin's email doesn't tell them it goes to
    // DivingHQ if they don't decide.
    await claimKit.wipe("CXR");
    const lone = await claimKit.founder("CXR", "Flying Fish Cove Divers");
    const island = await claimKit.claim({ org_name: "Christmas Island Diving", country_code: "CXR" });
    assert.equal(island.res.body.approver, "sysadmin");
    inbox.clear();
    await live(island);
    const toSys = inbox.mailTo(sysIds[0], /wants to run/);
    assert.match(toSys.body, /yours to decide/);
    assert.doesNotMatch(toSys.body, /goes to DivingHQ/);
    assert.ok(lone.id);
  } finally {
    await pool.query("DELETE FROM claims WHERE org_id = $1", [fedFx.orgId]).catch(() => {});
    await teardownFixture(fedFx);
    await claimKit.wipe(CODE);
    await claimKit.wipe(FED_CODE);
    await claimKit.wipe("CXR");
  }
});

test("claims: a long name still gets its in-app notice", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CCK";
  await claimKit.wipe(CODE);
  const fedFx = await setupFixture({ withEvent: false });
  try {
    const fedName = `Federation of Underwater and Springboard Diving of the Cocos Keeling Islands ${"x".repeat(15)}`;
    await pool.query("UPDATE organisations SET country_code = $2, name = $3 WHERE id = $1", [fedFx.orgId, CODE, fedName]);
    const regionName = "Home Island and the Surrounding Southern Atoll Lagoon Territories";
    await pool.query("INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, 'HI')", [fedFx.orgId, regionName]);
    const bodyName = "Home Island Amateur Swimming, Diving and Water Polo Association Incorporated (Est. 1962)";
    const body = await claimKit.claim({ org_name: bodyName, country_code: CODE, region_code: "HI" });
    assert.equal(body.res.status, 201, JSON.stringify(body.res.body));
    // Through the real verify link and the real push, which is where the
    // varchar(160) insert used to throw and lose the notice.
    await claimKit.verify(body.id);
    const note = (await pool.query(
      "SELECT title, body FROM notifications WHERE user_id = $1 AND category = 'claim_review'", [fedFx.adminId],
    )).rows[0];
    assert.ok(note, "the federation got its in-app notice");
    assert.ok(Array.from(note.title).length <= 160);
    assert.ok(note.title.endsWith("…"));
    assert.ok(note.body.startsWith(`${bodyName} wants to run ${regionName} (${fedName}).`), note.body);
  } finally {
    await pool.query("DELETE FROM claims WHERE org_id = $1", [fedFx.orgId]).catch(() => {});
    await teardownFixture(fedFx);
    await claimKit.wipe(CODE);
  }
});

test("claims: a national revoke also takes back event manager seats handed out under it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "ALA";
  await claimKit.wipe(CODE);
  try {
    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
    const A = await claimKit.founder(CODE, "Mariehamn Divers");
    const B = await claimKit.founder(CODE, "Jomala Divers");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;

    // A runs its own club night, from before anyone claimed the country.
    const meet = (await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Mariehamn Club Night" } })).body;
    const ev = await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name: "Mariehamn 1m", gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 5, event_type: "individual", meet_id: meet.id },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const eventId = ev.body.id;

    const fed = await claimKit.claim({ org_name: "Ålands Simförbund", country_code: CODE });
    assert.equal(fed.res.body.approver, "clubs");
    await claimKit.verify(fed.id);
    const id = fed.res.body.claim_id;
    for (const x of [A, B]) await fetchJson("POST", `/api/claims/${id}/vote`, { token: x.token, body: { vote: "approve" } });
    assert.equal((await claimStatus(id)).status, "approved");

    // Running the country, the federation seats itself and a friend on
    // the club's event.
    const fedToken = (await claimKit.login(fed.username)).token;
    const friend = await insertUser({ orgId, role: "spectator", username: `int-friend-${crypto.randomBytes(3).toString("hex")}`, fullName: "Friend" });
    for (const who of [fed.id, friend]) {
      assert.equal((await fetchJson("POST", `/api/events/${eventId}/managers`, { token: fedToken, body: { user_id: who } })).status, 200);
    }
    // A state body registers under the federation but hasn't verified yet.
    await pool.query("INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Norra Åland', 'NA')", [orgId]);
    const state = await claimKit.claim({ org_name: "Norra Ålands Simklubbar", country_code: CODE, region_code: "NA" });
    assert.equal(state.res.body.approver, "parent");

    const rv = await fetchJson("POST", `/api/claims/${id}/revoke`, { token: sys.token, body: {} });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    // Nobody's left to be its "parent", so DivingHQ gets it once it's live.
    assert.equal((await pool.query("SELECT approver FROM claims WHERE id = $1", [state.res.body.claim_id])).rows[0].approver, "sysadmin");
    const seats = (await pool.query("SELECT user_id FROM event_managers WHERE event_id = $1", [eventId])).rows.map((r) => r.user_id);
    assert.deepEqual(seats, [A.id], "only the club's own seat is left");
    assert.deepEqual(rv.body.removed.event_managers.map((r) => r.user_id).sort(), [fed.id, friend].sort());
    assert.ok(rv.body.removed.event_managers.every((r) => r.event_id === eventId && r.event_name === "Mariehamn 1m"));
    const audit = (await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'claim.revoked'", [id],
    )).rows[0].metadata;
    assert.equal(audit.removed.event_managers.length, 2);

    // With a fresh token the ex-federation can't touch the event any more.
    const again = (await claimKit.login(fed.username)).token;
    assert.equal((await fetchJson("POST", `/api/events/${eventId}/managers`, { token: again, body: { user_id: friend } })).status, 403);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: only a real voter hears that their address matches the claimant's", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "BES";
  await claimKit.wipe(CODE);
  try {
    const tag = crypto.randomBytes(4).toString("hex");
    const A = await claimKit.founder(CODE, "Kralendijk Divers");
    const B = await claimKit.founder(CODE, "Rincon Divers");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    // A member of the country with no vote at all, on the body's domain.
    const nosy = await claimKit.founder(CODE, "Sorobon Divers");
    await pool.query("UPDATE users SET email = $2 WHERE id = $1", [nosy.id, `nosy-${tag}@bonairediving-${tag}.example.org`]);

    const fed = await claimKit.claim({ org_name: "Bonaire Diving", country_code: CODE, email: `office-${tag}@bonairediving-${tag}.example.org` });
    assert.equal(fed.res.body.approver, "clubs");
    await claimKit.verify(fed.id);
    const id = fed.res.body.claim_id;
    const probe = await fetchJson("POST", `/api/claims/${id}/vote`, { token: nosy.token, body: { vote: "approve" } });
    assert.equal(probe.status, 403);
    assert.doesNotMatch(probe.body.error, /claimant/, "no hint about the claimant's address to someone without a vote");
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("claims: a region revoke takes back the event seats its admins handed out", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "GGY";
  await claimKit.wipe(CODE);
  const fedFx = await setupFixture({ withEvent: false });
  try {
    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
    await pool.query("UPDATE organisations SET country_code = $2 WHERE id = $1", [fedFx.orgId, CODE]);
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'St Peter Port', 'SPP') RETURNING id", [fedFx.orgId],
    )).rows[0].id;
    const meet = (await pool.query(
      "INSERT INTO meets (org_id, name, host_region_id) VALUES ($1, 'St Peter Port Open', $2) RETURNING id", [fedFx.orgId, region],
    )).rows[0].id;
    const mkEvent = async (name) => {
      const ev = await fetchJson("POST", "/api/events", {
        token: fedFx.adminToken,
        body: { name, gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 5, event_type: "individual", meet_id: meet },
      });
      assert.equal(ev.status, 201, JSON.stringify(ev.body));
      return ev.body.id;
    };
    const ev1 = await mkEvent("SPP 3m");
    const ev2 = await mkEvent("SPP 1m");

    const body = await claimKit.claim({ org_name: "St Peter Port Diving", country_code: CODE, region_code: "SPP" });
    await claimKit.verify(body.id);
    assert.equal((await fetchJson("POST", `/api/claims/${body.res.body.claim_id}/decide`, { token: fedFx.adminToken, body: { decision: "approve" } })).status, 200);

    // The state body seats itself and a friend on the region's event; the
    // federation seats the state body on another one, its own call.
    const token = (await claimKit.login(body.username)).token;
    const friend = await insertUser({ orgId: fedFx.orgId, role: "spectator", username: `int-sppf-${crypto.randomBytes(3).toString("hex")}`, fullName: "SPP Friend" });
    for (const who of [body.id, friend]) {
      assert.equal((await fetchJson("POST", `/api/events/${ev1}/managers`, { token, body: { user_id: who } })).status, 200);
    }
    assert.equal((await fetchJson("POST", `/api/events/${ev2}/managers`, { token: fedFx.adminToken, body: { user_id: body.id } })).status, 200);

    const rv = await fetchJson("POST", `/api/claims/${body.res.body.claim_id}/revoke`, { token: sys.token, body: {} });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    const seats = async (ev) => (await pool.query("SELECT user_id FROM event_managers WHERE event_id = $1", [ev])).rows.map((r) => r.user_id).sort();
    assert.deepEqual(await seats(ev1), [fedFx.adminId]);
    assert.deepEqual((await seats(ev2)).sort(), [fedFx.adminId, body.id].sort());
    assert.deepEqual(rv.body.removed.event_managers.map((r) => r.user_id).sort(), [body.id, friend].sort());
  } finally {
    await pool.query("DELETE FROM claims WHERE org_id = $1", [fedFx.orgId]).catch(() => {});
    await pool.query("DELETE FROM meets WHERE org_id = $1", [fedFx.orgId]).catch(() => {});
    await teardownFixture(fedFx);
    await claimKit.wipe(CODE);
  }
});

test("claims: a state body made org_admin still can't approve its own claim", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "JEY";
  await claimKit.wipe(CODE);
  const fedFx = await setupFixture({ withEvent: false });
  try {
    await pool.query("UPDATE organisations SET country_code = $2 WHERE id = $1", [fedFx.orgId, CODE]);
    await pool.query("INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'St Helier', 'SH')", [fedFx.orgId]);
    const body = await claimKit.claim({ org_name: "St Helier Diving", country_code: CODE, region_code: "SH" });
    assert.equal(body.res.body.approver, "parent");
    await claimKit.verify(body.id);
    // The federation promotes the claimant's account inside its own org.
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'org_admin')", [body.id, fedFx.orgId]);
    const token = (await claimKit.login(body.username)).token;
    const mine = (await fetchJson("GET", "/api/claims", { token })).body.find((c) => c.id === body.res.body.claim_id);
    assert.equal(mine.can_decide, false);
    const d = await fetchJson("POST", `/api/claims/${body.res.body.claim_id}/decide`, { token, body: { decision: "approve" } });
    assert.equal(d.status, 403, JSON.stringify(d.body));
    assert.equal((await claimStatus(body.res.body.claim_id)).status, "open");
    // The federation's own admin still can.
    assert.equal((await fetchJson("POST", `/api/claims/${body.res.body.claim_id}/decide`, { token: fedFx.adminToken, body: { decision: "approve" } })).status, 200);
  } finally {
    await pool.query("DELETE FROM claims WHERE org_id = $1", [fedFx.orgId]).catch(() => {});
    await teardownFixture(fedFx);
    await claimKit.wipe(CODE);
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
    // Picking it again is the same ask, not a second ping.
    assert.equal((await move(A.token, A.clubId, south)).status, 202);
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

// Migration 095: an entry's snapshot is the whole answer. A club move
// after the meet, or the entry club being deleted, mustn't relabel old
// results, and a synchro partner entered on the lead's row (late add /
// CSV import, no row of their own) keeps a snapshot of their own.
test("representation: a later club move doesn't rewrite past results", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "SHN";
  await claimKit.wipe(CODE);
  try {
    // Both founders first: once the org has regions, signup insists on one.
    const A = await claimKit.founder(CODE, "Jamestown Divers", { new_club_short_code: "JTD" });
    const B = await claimKit.founder(CODE, "Longwood Divers", { new_club_short_code: "LWD" });
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    // St Helena has no built-in regions, so make two. Jamestown stays unplaced for now.
    const region = async (name, code) => (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, name, code],
    )).rows[0].id;
    const east = await region("East", "EA");
    const west = await region("West", "WE");
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [west, B.clubId]);
    const doomed = (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, 'Half Tree Hollow Divers', 'HTH') RETURNING id", [orgId],
    )).rows[0].id;

    const diver = async (fullName, clubId) => {
      const id = await insertUser({ orgId, role: "diver", fullName, username: `int-rp-${crypto.randomBytes(3).toString("hex")}` });
      await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [clubId, id]);
      return id;
    };
    const mover   = await diver("Mover", A.clubId);
    const orphan  = await diver("Orphan", doomed);
    const lead    = await diver("Lead", A.clubId);
    const partner = await diver("Partner", B.clubId);
    const standIn = await diver("Stand In", A.clubId);

    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Island Champs", represent_as: "region" } });
    assert.equal(meet.status, 201, JSON.stringify(meet.body));
    const setMode = async (mode) => assert.equal((await fetchJson("PUT", `/api/meets/${meet.body.id}`, {
      token: A.token, body: { represent_as: mode },
    })).status, 200);
    const mkEvent = async (body) => {
      const r = await fetchJson("POST", "/api/events", {
        token: A.token, body: { gender: "Mixed", height: "1m", total_rounds: 1, meet_id: meet.body.id, ...body },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.id;
    };
    const indiv = await mkEvent({ name: "Open 1m", number_of_judges: 5, event_type: "individual" });
    const sync = await mkEvent({ name: "Synchro 1m", number_of_judges: 7, event_type: "synchro_pair" });
    const dive = (await pool.query("SELECT id FROM dive_directory LIMIT 1")).rows[0].id;
    for (const id of [mover, orphan]) {
      await pool.query(
        "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
        [indiv, id, dive],
      );
    }
    const lateAdd = (partnerId) => fetchJson("POST", `/api/events/${sync}/roster`, {
      token: A.token, body: { competitor_id: lead, partner_id: partnerId, dive_id: dive, round_number: 1 },
    });
    assert.equal((await lateAdd(partner)).status, 201);
    assert.equal((await pool.query("SELECT 1 FROM competitor_dive_lists WHERE event_id = $1 AND competitor_id = $2", [sync, partner])).rows.length, 0,
      "the partner has no row of their own, only the lead's partner_id");

    // cache=skip: a cached payload would pass these trivially.
    const codes = async () => {
      const read = async (id) => {
        const r = await fetchJson("GET", `/api/scoreboard/${id}?cache=skip`, { token: A.token });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        return r.body.upcoming;
      };
      const out = Object.fromEntries((await read(indiv)).map((u) => [u.full_name, u.country_code]));
      const [pair] = await read(sync);
      return { ...out, Lead: pair.country_code, Partner: pair.partner_country };
    };
    // Jamestown and Half Tree Hollow have no region, so their divers read as the country.
    assert.deepEqual(await codes(), { Mover: "SHN", Orphan: "SHN", Lead: "SHN", Partner: "WE" });

    // Next season: Mover and Orphan join Longwood (West), Partner joins
    // Jamestown, and Half Tree Hollow folds.
    await pool.query("UPDATE users SET club_id = $1 WHERE id = ANY($2::uuid[])", [B.clubId, [mover, orphan]]);
    await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [A.clubId, partner]);
    await pool.query("DELETE FROM clubs WHERE id = $1", [doomed]);
    assert.deepEqual(await codes(), { Mover: "SHN", Orphan: "SHN", Lead: "SHN", Partner: "WE" });
    // The region record lookup (lib/records.js) resolves the same way.
    const repRegion = async (ev, id) =>
      (await pool.query("SELECT region_id FROM event_rep_ids($1, $2)", [ev, id])).rows[0].region_id;
    assert.equal(await repRegion(indiv, mover), null, "not West, where Mover is now");
    assert.equal(await repRegion(sync, partner), west);

    await setMode("club");
    assert.deepEqual(await codes(), { Mover: "JTD", Orphan: "SHN", Lead: "JTD", Partner: "LWD" });

    // Jamestown gets placed in East afterwards. Same club, so its old
    // entries pick the region up.
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [east, A.clubId]);
    await setMode("region");
    assert.deepEqual(await codes(), { Mover: "EA", Orphan: "SHN", Lead: "EA", Partner: "WE" });
    assert.equal(await repRegion(indiv, mover), east);

    // Swapping the partner through the upsert takes the new partner's snapshot.
    assert.equal((await lateAdd(standIn)).status, 200);
    assert.equal((await codes()).Partner, "EA");

    // An account merge moves partner_id to the same person's other account
    // and asks the trigger to keep the snapshot (routes/users.js).
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('divinghq.keep_rep_snapshot', 'on', true)");
      await c.query("UPDATE competitor_dive_lists SET partner_id = $1 WHERE event_id = $2", [mover, sync]);
      const kept = (await c.query("SELECT partner_rep_club_id FROM competitor_dive_lists WHERE event_id = $1", [sync])).rows[0];
      assert.equal(kept.partner_rep_club_id, A.clubId, "Stand In's snapshot, not Mover's Longwood");
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  } finally {
    await claimKit.wipe(CODE);
  }
});

// Pull the drawn text out of a PDFKit file: inflate each content stream
// and decode the hex strings in its TJ operators, one line per operator.
function pdfText(buf) {
  const zlib = require("node:zlib");
  const raw = buf.toString("latin1");
  const lines = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    let body;
    try { body = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    for (const tj of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      lines.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)]
        .map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""));
    }
  }
  return lines;
}

// Migration 095: a team's standings row carries the code its divers
// share (state, club or country per the meet), otherwise the team org's
// country, and keeps the team short code as its subline.
test("team labels follow the meet's represent_as", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "PCN";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Adamstown Divers", { new_club_short_code: "ADM" });
    const B = await claimKit.founder(CODE, "Bounty Bay Divers", { new_club_short_code: "BBY" });
    const C = await claimKit.founder(CODE, "Christian's Cave Divers", { new_club_short_code: "CCV" });
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const region = async (name, code) => (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, name, code],
    )).rows[0].id;
    const north = await region("North", "NO");
    const south = await region("South", "SO");
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = ANY($2::uuid[])", [north, [A.clubId, B.clubId]]);
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [south, C.clubId]);

    const diver = async (fullName, clubId) => {
      const id = await insertUser({ orgId, role: "diver", fullName, username: `int-tl-${crypto.randomBytes(3).toString("hex")}` });
      if (clubId) await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [clubId, id]);
      return id;
    };
    const a1 = await diver("Ada One", A.clubId);
    const a2 = await diver("Ada Two", A.clubId);
    const a3 = await diver("Ada Three", A.clubId);
    const a4 = await diver("Ada Four", A.clubId);
    const b1 = await diver("Bea One", B.clubId);
    const c1 = await diver("Cal One", C.clubId);
    const loner = await diver("No Club", null);

    const team = async (name, short, members) => {
      const id = (await pool.query(
        "INSERT INTO teams (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, name, short],
      )).rows[0].id;
      for (const u of members) await pool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [id, u]);
      return id;
    };
    // Two northern clubs; a northerner diving synchro with a southerner
    // (the partner has no row of their own, and still counts); one club
    // plus a diver with no club at all, who doesn't get a say.
    const northern = await team("Northern", "NTH", [a1, b1]);
    const mixed = await team("Mixed", "MIX", [a2, c1]);
    const adamstown = await team("Adamstown A", "ADA", [a3, a4, loner]);

    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Pitcairn Team Champs", represent_as: "region" } });
    assert.equal(meet.status, 201, JSON.stringify(meet.body));
    const setMode = async (mode) => assert.equal((await fetchJson("PUT", `/api/meets/${meet.body.id}`, {
      token: A.token, body: { represent_as: mode },
    })).status, 200);
    const mkTeamEvent = async (extra) => {
      const r = await fetchJson("POST", "/api/events", {
        token: A.token,
        body: { name: "Mixed Team", gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 3, event_type: "team", ...extra },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.id;
    };
    const ev = await mkTeamEvent({ meet_id: meet.body.id });
    const dive = (await pool.query("SELECT id FROM dive_directory WHERE height = 3 LIMIT 1")).rows[0].id;
    const judges = [];
    for (let i = 1; i <= 5; i++) {
      judges.push(await insertUser({ orgId, role: "judge", fullName: `Judge ${i}`, username: `int-tlj${i}-${crypto.randomBytes(3).toString("hex")}` }));
    }
    const enter = async (eventId, teamId, rows, score) => {
      await pool.query("INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [eventId, teamId]);
      for (const [competitor, round, partner] of rows) {
        await pool.query(
          `INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, team_id, dive_id, round_number)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [eventId, competitor, partner || null, teamId, dive, round],
        );
        for (let j = 0; j < 5; j++) {
          await pool.query(
            "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, $5, $6)",
            [eventId, competitor, judges[j], dive, round, score],
          );
        }
      }
    };
    for (let i = 0; i < 5; i++) {
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [ev, judges[i], i + 1]);
    }
    await enter(ev, northern, [[a1, 1], [b1, 2]], 8);
    await enter(ev, mixed, [[a2, 1, c1]], 7);
    await enter(ev, adamstown, [[a3, 1], [a4, 2], [loner, 3]], 6);

    const labels = async (eventId = ev) => {
      const r = await fetchJson("GET", `/api/scoreboard/${eventId}?cache=skip`, { token: A.token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      for (const s of r.body.standings) assert.equal(s.competitor_id ?? null, null, "team events rank teams, not divers");
      return Object.fromEntries(r.body.standings.map((s) => [s.full_name, `${s.country_code}/${s.club_name}`]));
    };
    assert.deepEqual(await labels(), { "Northern": "NO/NTH", "Mixed": "PCN/MIX", "Adamstown A": "NO/ADA" });
    await setMode("club");
    assert.deepEqual(await labels(), { "Northern": "PCN/NTH", "Mixed": "PCN/MIX", "Adamstown A": "ADM/ADA" });
    await setMode("country");
    assert.deepEqual(await labels(), { "Northern": "PCN/NTH", "Mixed": "PCN/MIX", "Adamstown A": "PCN/ADA" });

    // Bea joins a southern club after the entry: the team keeps what she entered as.
    await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [C.clubId, b1]);
    await setMode("region");
    assert.equal((await labels()).Northern, "NO/NTH");

    // The recap reads the same rows, so a team event now gets a medal
    // table (two distinct codes) where every row used to be blank.
    await pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [ev]);
    const recap = await fetchJson("GET", `/api/archive/${ev}/results`);
    assert.equal(recap.status, 200, JSON.stringify(recap.body));
    assert.deepEqual(
      Object.fromEntries(recap.body.standings.map((s) => [s.full_name, `${s.country_code}/${s.club_name}`])),
      { "Northern": "NO/NTH", "Mixed": "PCN/MIX", "Adamstown A": "NO/ADA" },
    );
    assert.ok(recap.body.standings.every((s) => s.competitor_id == null));

    // results.pdf ranks teams too, each dive line naming its diver, and
    // a mixed team's members show their own state.
    const pdf = await fetch(`${baseUrl}/api/events/${ev}/results.pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-type"), /application\/pdf/);
    const text = pdfText(Buffer.from(await pdf.arrayBuffer())).join("\n");
    assert.match(text, /\d\.\s+Northern {2}NO\n/);
    assert.match(text, /\d\.\s+Mixed {2}PCN\n/);
    assert.match(text, /\d\.\s+Adamstown A {2}NO\n\S*\s*ADA/);
    assert.match(text, /R1\s+Ada Two \(NO\) & Cal One\s/);
    assert.ok(!/\d\.\s+Ada One/.test(text), "members aren't ranked on their own");

    // An event outside any meet reads as the team org's country. (Club
    // admins can only create events inside meets they host, hence SQL.)
    const loose = (await pool.query(
      `INSERT INTO events (org_id, name, gender, height, number_of_judges, total_rounds, event_type)
       VALUES ($1, 'Friendly', 'Mixed', '3m', 5, 3, 'team') RETURNING id`, [orgId],
    )).rows[0].id;
    for (let i = 0; i < 5; i++) {
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [loose, judges[i], i + 1]);
    }
    await enter(loose, adamstown, [[a3, 1]], 6);
    assert.deepEqual(await labels(loose), { "Adamstown A": "PCN/ADA" });
  } finally {
    await claimKit.wipe(CODE);
  }
});

// Host club admins run team events in an unclaimed country, so they need
// the event's team list: the Control Room late-entry picker reads it.
test("an event's team list opens to its delegates, and only them", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "MSR";
  await claimKit.wipe(CODE);
  await claimKit.wipe("AIA");
  try {
    const A = await claimKit.founder(CODE, "Plymouth Divers");
    const B = await claimKit.founder(CODE, "Salem Divers");
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Montserrat Open" } });
    assert.equal(meet.status, 201, JSON.stringify(meet.body));
    const ev = await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name: "Mixed Team", gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 3, event_type: "team", meet_id: meet.body.id },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const teamId = (await pool.query(
      "INSERT INTO teams (org_id, name, short_code) VALUES ($1, 'Plymouth A', 'PLA') RETURNING id", [orgId],
    )).rows[0].id;
    await pool.query("INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)", [ev.body.id, teamId]);

    const list = (token) => fetchJson("GET", `/api/events/${ev.body.id}/teams`, { token });
    const host = await list(A.token);
    assert.equal(host.status, 200, JSON.stringify(host.body));
    assert.deepEqual(host.body.map((r) => [r.name, r.short_code]), [["Plymouth A", "PLA"]]);
    assert.equal((await list(B.token)).status, 403, "another club's admin doesn't run this meet");
    // No token at all: verifyToken answers 403 (its long-standing contract).
    const anon = await list(null);
    assert.equal(anon.status, 403);
    assert.ok(!Array.isArray(anon.body));

    // The org editors keep their way in; another org's don't get one.
    const signIn = async (org, role) => {
      const username = `int-et-${crypto.randomBytes(3).toString("hex")}`;
      await insertUser({ orgId: org, role, username, fullName: "Meet Manager" });
      const r = await fetchJson("POST", "/api/auth/login", { body: { username, password: "not-used-here" } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.token;
    };
    assert.equal((await list(await signIn(orgId, "meet_manager"))).status, 200);
    const X = await claimKit.founder("AIA", "Anguilla Divers");
    const otherOrg = (await pool.query("SELECT org_id FROM users WHERE id = $1", [X.id])).rows[0].org_id;
    assert.equal((await list(await signIn(otherOrg, "meet_manager"))).status, 403);

    // With the list readable, the host's late-entry flow goes through.
    const diver = await insertUser({ orgId, role: "diver", username: `int-et-${crypto.randomBytes(3).toString("hex")}`, fullName: "Walk Up" });
    await pool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [teamId, diver]);
    const dive = (await pool.query("SELECT id FROM dive_directory WHERE height = 3 LIMIT 1")).rows[0].id;
    const late = await fetchJson("POST", `/api/events/${ev.body.id}/roster`, {
      token: A.token, body: { competitor_id: diver, dive_id: dive, round_number: 1, team_id: host.body[0].id },
    });
    assert.equal(late.status, 201, JSON.stringify(late.body));
  } finally {
    await claimKit.wipe(CODE);
    await claimKit.wipe("AIA");
  }
});

// The recap titles its medal table by what the codes are, so the archive
// event block says how the meet represents divers and what the host
// country calls its regions.
test("recap event block carries represent_as and the region label", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "FLK";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Stanley Divers");
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    await pool.query("UPDATE organisations SET region_label = 'province' WHERE id = $1", [orgId]);
    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Falklands Champs", represent_as: "region" } });
    assert.equal(meet.status, 201, JSON.stringify(meet.body));
    const ev = await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name: "1m", gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 1, event_type: "individual", meet_id: meet.body.id },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const loose = (await pool.query(
      `INSERT INTO events (org_id, name, gender, height, number_of_judges, total_rounds, status)
       VALUES ($1, 'Friendly', 'Mixed', '1m', 5, 1, 'Completed') RETURNING id`, [orgId],
    )).rows[0].id;
    await pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [ev.body.id]);

    const meta = async (id) => {
      const r = await fetchJson("GET", `/api/archive/${id}/results`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { represent_as: r.body.event.represent_as, region_label: r.body.event.region_label };
    };
    assert.deepEqual(await meta(ev.body.id), { represent_as: "region", region_label: "province" });
    assert.equal((await fetchJson("PUT", `/api/meets/${meet.body.id}`, { token: A.token, body: { represent_as: "club" } })).status, 200);
    assert.equal((await meta(ev.body.id)).represent_as, "club");
    // No meet, no setting: the chips are countries, so is the heading.
    assert.equal((await meta(loose)).represent_as, "country");
  } finally {
    await claimKit.wipe(CODE);
  }
});

// Claiming an old account moves its entries to the claimant, synchro
// partner slots included. It's the same diver, so the partner snapshot
// taken at entry has to survive the move (routes/users.js sets
// divinghq.keep_rep_snapshot for that transaction).
test("claiming an old account keeps its synchro-partner snapshot", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "WLF";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Mata-Utu Divers", { new_club_short_code: "MUD" });
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const leava = (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, 'Leava Divers', 'LVD') RETURNING id", [orgId],
    )).rows[0].id;
    const mk = async (fullName, clubId) => {
      const username = `int-cm-${crypto.randomBytes(3).toString("hex")}`;
      const id = await insertUser({ orgId, role: "diver", username, fullName });
      await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [clubId, id]);
      return { id, username };
    };
    // Same person, so the same name: a claim only takes a past account
    // with the claimer's name.
    const lead = await mk("Lead Diver", A.clubId);
    const old = await mk("Sione Me", A.clubId);
    const me = await mk("Sione Me", leava);

    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Wallis Open", represent_as: "club" } });
    assert.equal(meet.status, 201, JSON.stringify(meet.body));
    const ev = await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name: "Synchro 3m", gender: "Mixed", height: "3m", number_of_judges: 7, total_rounds: 1, event_type: "synchro_pair", meet_id: meet.body.id },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const dive = (await pool.query("SELECT id FROM dive_directory WHERE height = 3 LIMIT 1")).rows[0].id;
    // One row for the pair, the old account only as partner_id.
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, dive_id, round_number) VALUES ($1, $2, $3, $4, 1)",
      [ev.body.id, lead.id, old.id, dive],
    );
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [old.id]);

    const login = await fetchJson("POST", "/api/auth/login", { body: { username: me.username, password: "not-used-here" } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const claim = await fetchJson("POST", "/api/users/me/claim", {
      token: login.body.token, body: { old_user_ids: [old.id], password: "not-used-here" },
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.deepEqual(claim.body.claimed, [old.id]);

    const row = (await pool.query(
      "SELECT partner_id, partner_rep_club_id FROM competitor_dive_lists WHERE event_id = $1", [ev.body.id],
    )).rows[0];
    assert.equal(row.partner_id, me.id);
    assert.equal(row.partner_rep_club_id, A.clubId, "entered from Mata-Utu, still Mata-Utu");
    const sb = await fetchJson("GET", `/api/scoreboard/${ev.body.id}?cache=skip`, { token: A.token });
    assert.equal(sb.body.upcoming[0].partner_country, "MUD");
  } finally {
    await claimKit.wipe(CODE);
  }
});

// event_team_rep_code only polls the divers actually on the team's
// entry. A withdrawn diver or a reserve from another state shouldn't
// knock an all-North team down to the country code.
test("team labels leave withdrawn and reserve divers out of the vote", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CXR";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Flying Fish Cove Divers", { new_club_short_code: "FFC" });
    const B = await claimKit.founder(CODE, "Drumsite Divers", { new_club_short_code: "DRM" });
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const region = async (name, code) => (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, name, code],
    )).rows[0].id;
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [await region("North", "NTH"), A.clubId]);
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [await region("South", "STH"), B.clubId]);

    const diver = async (fullName, clubId) => {
      const id = await insertUser({ orgId, role: "diver", fullName, username: `int-tw-${crypto.randomBytes(3).toString("hex")}` });
      await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [clubId, id]);
      return id;
    };
    const n1 = await diver("North One", A.clubId);
    const n2 = await diver("North Two", A.clubId);
    const quitter = await diver("South Withdrawn", B.clubId);
    const bench = await diver("South Reserve", B.clubId);

    const meet = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Island Teams", represent_as: "region" } });
    assert.equal(meet.status, 201, JSON.stringify(meet.body));
    const ev = await fetchJson("POST", "/api/events", {
      token: A.token,
      body: { name: "Mixed Team", gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 3, event_type: "team", meet_id: meet.body.id },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const eventId = ev.body.id;
    const teamId = (await pool.query(
      "INSERT INTO teams (org_id, name, short_code) VALUES ($1, 'Cove A', 'CVA') RETURNING id", [orgId],
    )).rows[0].id;
    await pool.query("INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)", [eventId, teamId]);
    const dive = (await pool.query("SELECT id FROM dive_directory WHERE height = 3 LIMIT 1")).rows[0].id;
    const judges = [];
    for (let i = 1; i <= 5; i++) {
      const j = await insertUser({ orgId, role: "judge", fullName: `Judge ${i}`, username: `int-twj${i}-${crypto.randomBytes(3).toString("hex")}` });
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [eventId, j, i]);
      judges.push(j);
    }
    for (const [who, round, reserve] of [[n1, 1, false], [n2, 2, false], [quitter, 3, false], [bench, 3, true]]) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, team_id, dive_id, round_number, is_reserve)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [eventId, who, teamId, dive, round, reserve],
      );
    }
    for (const [who, round] of [[n1, 1], [n2, 2]]) {
      for (const j of judges) {
        await pool.query(
          "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, $5, 7)",
          [eventId, who, j, dive, round],
        );
      }
    }
    await pool.query("UPDATE competitor_dive_lists SET withdrawn_at = now() WHERE event_id = $1 AND competitor_id = $2", [eventId, quitter]);

    const label = async () => {
      const r = await fetchJson("GET", `/api/scoreboard/${eventId}?cache=skip`, { token: A.token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.standings.length, 1, JSON.stringify(r.body.standings));
      return `${r.body.standings[0].country_code}/${r.body.standings[0].club_name}`;
    };
    assert.equal(await label(), "NTH/CVA");

    // Put the southerner back on the team and the vote is split, so the
    // team falls back to the country. Proves the withdrawn row was what
    // kept it out, not some accident of the fixture.
    await pool.query("UPDATE competitor_dive_lists SET withdrawn_at = NULL WHERE event_id = $1 AND competitor_id = $2", [eventId, quitter]);
    assert.equal(await label(), `${CODE}/CVA`);
  } finally {
    await claimKit.wipe(CODE);
  }
});

// ---------------------------------------------------------------------
// Records split by gender, individual dives only (migration 094).
// ---------------------------------------------------------------------

// Direct-SQL fixtures for the record tests: a live event with a full
// panel, and a dive scored by every judge so checkAndApplyRecords sees
// a complete dive. Everything hangs off a setupFixture() org, so the
// books these tests write can't collide with anybody else's.
const recordKit = {
  lib() {
    return require("../lib/records")({ pool, verifyToken: (_req, _res, next) => next() });
  },
  async club(orgId, name, shortCode, regionId = null) {
    return (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code, region_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [orgId, name, shortCode, regionId],
    )).rows[0].id;
  },
  async diver(orgId, clubId, gender, name = "Record Diver") {
    const id = await insertUser({
      orgId, role: "diver", fullName: name,
      username: `int-rd-${crypto.randomBytes(4).toString("hex")}`,
    });
    await pool.query("UPDATE users SET club_id = $2, gender = $3 WHERE id = $1", [id, clubId, gender]);
    return id;
  },
  async event(orgId, { gender, eventType = "individual" }) {
    const id = (await pool.query(
      `INSERT INTO events (org_id, name, gender, height, number_of_judges, total_rounds, event_type, status)
       VALUES ($1, $2, $3, '3m', 5, 6, $4, 'Live') RETURNING id`,
      [orgId, `Records ${gender} ${eventType}`, gender, eventType],
    )).rows[0].id;
    const judges = [];
    for (let i = 1; i <= 5; i++) {
      const j = await insertUser({
        orgId, role: "judge", fullName: `Judge ${i}`,
        username: `int-rj-${crypto.randomBytes(4).toString("hex")}`,
      });
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [id, j, i]);
      judges.push(j);
    }
    return { id, judges };
  },
  async dive(ev, competitorId, round, diveId, judgeScore, { partnerId = null } = {}) {
    await pool.query(
      `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number, partner_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [ev.id, competitorId, diveId, round, partnerId],
    );
    for (const j of ev.judges) {
      await pool.query(
        "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, $5, $6)",
        [ev.id, competitorId, j, diveId, round, judgeScore],
      );
    }
  },
  // History tables carry no FKs (on purpose, see init.sql), so they
  // outlive teardownFixture unless we sweep them first.
  async cleanup(orgId) {
    await pool.query("DELETE FROM records_personal_history WHERE user_id IN (SELECT id FROM users WHERE org_id = $1)", [orgId]);
    await pool.query("DELETE FROM records_club_history WHERE club_id IN (SELECT id FROM clubs WHERE org_id = $1)", [orgId]);
    await pool.query("DELETE FROM records_region_history WHERE region_id IN (SELECT id FROM regions WHERE org_id = $1)", [orgId]);
    await pool.query("DELETE FROM records_federation_history WHERE org_id = $1", [orgId]);
  },
  async threeMetreDive() {
    return (await pool.query(
      "SELECT id FROM dive_directory WHERE height = 3 AND is_custom = FALSE ORDER BY dive_code, position LIMIT 1",
    )).rows[0].id;
  },
};

test("records: Women's and Men's books stay apart, and only individual dives count", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const lib = recordKit.lib();
    const club = await recordKit.club(st.orgId, "Split Book Divers", "SBD");
    const her = await recordKit.diver(st.orgId, club, null, "Ana Record");
    const him = await recordKit.diver(st.orgId, club, "male", "Ben Record");
    const mixedHer = await recordKit.diver(st.orgId, club, "Female ", "Cleo Record");
    const unknown = await recordKit.diver(st.orgId, club, "prefer_not_to_say", "Dee Record");
    const dive = await recordKit.threeMetreDive();
    const clubRows = async () => (await pool.query(
      "SELECT gender::text, holder_id, score::float, prev_score::float, event_id FROM records_club WHERE club_id = $1 ORDER BY gender",
      [club],
    )).rows;

    // A women's event decides the book even with no profile gender.
    const women = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(women, her, 1, dive, 6);
    let broken = await lib.checkAndApplyRecords({ eventId: women.id, competitorId: her, roundNumber: 1 });
    let mark = broken.find((b) => b.scope === "club");
    assert.ok(mark, JSON.stringify(broken));
    assert.equal(mark.gender, "Female");
    assert.equal(mark.prev_score, null, "a first mark beats nothing");
    assert.equal(mark.round_number, 1);
    assert.equal(mark.scope_code, "SBD");
    assert.equal(mark.official, true);
    assert.equal(broken.find((b) => b.scope === "federation").scope_code, "TST");
    const hers = mark.score;

    // A man scoring more on the same dive gets his own record and
    // leaves hers alone. Under the old key he'd have archived it.
    const men = await recordKit.event(st.orgId, { gender: "Male" });
    await recordKit.dive(men, him, 1, dive, 8);
    broken = await lib.checkAndApplyRecords({ eventId: men.id, competitorId: him, roundNumber: 1 });
    assert.equal(broken.find((b) => b.scope === "club")?.gender, "Male");
    let rows = await clubRows();
    assert.deepEqual(rows.map((r) => [r.gender, r.holder_id]), [["Female", her], ["Male", him]]);
    assert.equal(rows[0].score, hers);

    // She beats her own mark: prev_score carries what she beat, and the
    // old row goes to history with its gender.
    await recordKit.dive(women, her, 2, dive, 7);
    broken = await lib.checkAndApplyRecords({ eventId: women.id, competitorId: her, roundNumber: 2 });
    mark = broken.find((b) => b.scope === "club");
    assert.equal(mark.prev_score, hers);
    assert.equal(mark.round_number, 2);
    rows = await clubRows();
    assert.equal(rows.find((r) => r.gender === "Female").prev_score, hers);
    const hist = await pool.query(
      "SELECT gender::text, score::float FROM records_club_history WHERE club_id = $1", [club]);
    assert.deepEqual(hist.rows, [{ gender: "Female", score: hers }]);

    // Mixed individual event: the profile gender decides ('Female ' with
    // stray case and space still counts), and no usable gender means no
    // record at all rather than a guess.
    const mixed = await recordKit.event(st.orgId, { gender: "Mixed" });
    await recordKit.dive(mixed, mixedHer, 1, dive, 9);
    broken = await lib.checkAndApplyRecords({ eventId: mixed.id, competitorId: mixedHer, roundNumber: 1 });
    assert.equal(broken.find((b) => b.scope === "club")?.gender, "Female");
    await recordKit.dive(mixed, unknown, 1, dive, 9.5);
    broken = await lib.checkAndApplyRecords({ eventId: mixed.id, competitorId: unknown, roundNumber: 1 });
    assert.deepEqual(broken, []);

    // Synchro dives don't set records, however good.
    const synchro = await recordKit.event(st.orgId, { gender: "Male", eventType: "synchro_pair" });
    await recordKit.dive(synchro, him, 1, dive, 10, { partnerId: unknown });
    broken = await lib.checkAndApplyRecords({ eventId: synchro.id, competitorId: him, roundNumber: 1 });
    assert.deepEqual(broken, []);
    for (const tbl of ["records_personal", "records_club", "records_federation", "records_continental", "records_region"]) {
      const n = (await pool.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE event_id = $1`, [synchro.id])).rows[0].n;
      assert.equal(n, 0, `${tbl} has nothing from the synchro event`);
    }
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

test("records: rebuild-records reports on a dry run and repairs a book with --apply", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { rebuildRecords } = require("../scripts/rebuild-records");
  const st = await setupFixture({ withEvent: false });
  const client = await pool.connect();
  try {
    const lib = recordKit.lib();
    const club = await recordKit.club(st.orgId, "Rebuild Divers", "RBD");
    const her = await recordKit.diver(st.orgId, club, "female", "Eve Rebuild");
    const him = await recordKit.diver(st.orgId, club, "male", "Finn Rebuild");
    const dive = await recordKit.threeMetreDive();
    const women = await recordKit.event(st.orgId, { gender: "Female" });
    const men = await recordKit.event(st.orgId, { gender: "Male" });
    await recordKit.dive(women, her, 1, dive, 6);
    await lib.checkAndApplyRecords({ eventId: women.id, competitorId: her, roundNumber: 1 });
    await recordKit.dive(men, him, 1, dive, 8);
    await lib.checkAndApplyRecords({ eventId: men.id, competitorId: him, roundNumber: 1 });

    // Recreate what the old single book did: his dive sitting on the
    // women's record, no men's row, and a leftover synchro mark that
    // 094 couldn't give a gender to.
    const his = (await pool.query(
      "SELECT score FROM records_club WHERE club_id = $1 AND gender = 'Male'", [club])).rows[0].score;
    await pool.query("DELETE FROM records_club WHERE club_id = $1 AND gender = 'Male'", [club]);
    await pool.query(
      "UPDATE records_club SET holder_id = $2, score = $3, event_id = $4 WHERE club_id = $1 AND gender = 'Female'",
      [club, him, his, men.id]);
    const synchro = await recordKit.event(st.orgId, { gender: "Male", eventType: "synchro_pair" });
    await pool.query(
      `INSERT INTO records_club (club_id, holder_id, gender, height, dive_code, position, score, event_id)
       SELECT $1, $2, NULL, '3m', dive_code, position, 99, $3 FROM dive_directory WHERE id = $4`,
      [club, him, synchro.id, dive]);
    const snapshot = async () => (await pool.query(
      "SELECT gender::text, holder_id, score::float FROM records_club WHERE club_id = $1 ORDER BY gender NULLS LAST", [club])).rows;
    const before = await snapshot();

    const dry = await rebuildRecords(client, { orgId: st.orgId });
    const clubCounts = dry.find((r) => r.scope === "club").counts;
    assert.equal(clubCounts.changed, 1, JSON.stringify(clubCounts));
    assert.equal(clubCounts.added, 1);
    assert.equal(clubCounts.removed, 1);
    assert.deepEqual(await snapshot(), before, "a dry run writes nothing");
    assert.ok(!dry.some((r) => r.scope === "continental"), "--org leaves the continental books alone");

    await rebuildRecords(client, { orgId: st.orgId, apply: true });
    const after = await snapshot();
    assert.deepEqual(after.map((r) => [r.gender, r.holder_id]), [["Female", her], ["Male", him]]);
    const archived = await pool.query(
      "SELECT gender::text, score::float FROM records_club_history WHERE club_id = $1 ORDER BY score", [club]);
    assert.deepEqual(archived.rows.map((r) => r.gender), ["Female", null], "both replaced rows kept in history");

    // Running it again finds nothing left to do.
    const again = await rebuildRecords(client, { orgId: st.orgId });
    const c2 = again.find((r) => r.scope === "club").counts;
    assert.equal(c2.changed + c2.added + c2.removed, 0, JSON.stringify(c2));
  } finally {
    client.release();
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

test("records: every book is public and carries what the records page prints", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { ADMIN_ORG_ID } = require("../lib/admin-org");
  const st = await setupFixture({ withEvent: false });
  // A continental row with a dive code no real book uses, so asserting on
  // it can't trip over marks other tests or the seed left in 'africa'.
  const oddCode = `9${crypto.randomBytes(2).toString("hex")}`;
  try {
    const lib = recordKit.lib();
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Public Province', 'PP') RETURNING id",
      [st.orgId])).rows[0].id;
    const club = await recordKit.club(st.orgId, "Public Book Divers", "PBD", region);
    const her = await recordKit.diver(st.orgId, club, "female", "Gia Public");
    const dive = await recordKit.threeMetreDive();
    const women = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(women, her, 1, dive, 6.5);
    await lib.checkAndApplyRecords({ eventId: women.id, competitorId: her, roundNumber: 1 });
    const catalogue = (await pool.query(
      "SELECT dd::text, description FROM dive_directory WHERE id = $1", [dive])).rows[0];

    // No token anywhere below: this used to be 401.
    const book = async (scope, id) => {
      const r = await fetchJson("GET", `/api/records?scope=${scope}&scope_id=${id}`);
      assert.equal(r.status, 200, `${scope}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    for (const [scope, id, name] of [
      ["club", club, "Public Book Divers"],
      ["region", region, "Public Province"],
      ["federation", st.orgId, `Integration Test ${st.slug}`],
    ]) {
      const rows = await book(scope, id);
      assert.equal(rows.length, 1, scope);
      const row = rows[0];
      assert.equal(row.scope_name, name);
      assert.equal(row.gender, "Female");
      assert.equal(row.prev_score, null);
      assert.equal(row.holder_id, her);
      assert.equal(row.holder_name, "Gia Public");
      assert.equal(row.holder_country_code, "TST");
      assert.equal(row.holder_deleted, false);
      assert.equal(row.event_id, women.id);
      assert.equal(row.dd, catalogue.dd);
      assert.equal(row.description, catalogue.description);
      assert.equal(row.official, scope !== "region", `${scope} official flag`);
      assert.equal(row.book_org_id, st.orgId);
    }

    await pool.query(
      `INSERT INTO records_continental (continent, holder_id, gender, height, dive_code, position, score)
       VALUES ('africa', $1, 'Female', '3m', $2, 'B', 12.34)`, [her, oddCode]);
    const africa = (await book("continental", "africa")).find((r) => r.dive_code === oddCode);
    assert.ok(africa, "the continental row is there");
    assert.equal(africa.scope_name, "Africa");
    assert.equal(africa.holder_country_code, "TST");
    assert.equal(africa.dd, null, "no catalogue row for a made-up dive");

    // The same 400s as before, signed in or not.
    assert.equal((await fetchJson("GET", "/api/records")).status, 400);
    assert.equal((await fetchJson("GET", `/api/records?scope=nope&scope_id=${club}`)).status, 400);
    assert.equal((await fetchJson("GET", "/api/records?scope=club&scope_id=not-a-uuid")).status, 400);
    assert.equal((await fetchJson("GET", "/api/records?scope=continental&scope_id=atlantis")).status, 400);
    assert.equal((await fetchJson("GET", "/api/records?event_id=nope")).status, 400);
    assert.ok(Array.isArray((await fetchJson("GET", `/api/records?event_id=${women.id}`)).body));

    // A holder who deleted their account keeps the mark, but the page
    // mustn't link to a profile that 404s.
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [her]);
    assert.equal((await book("club", club))[0].holder_deleted, true);

    // A suspended federation's books go dark, club and region included.
    await pool.query("UPDATE organisations SET status = 'suspended' WHERE id = $1", [st.orgId]);
    for (const [scope, id] of [["club", club], ["region", region], ["federation", st.orgId]]) {
      assert.deepEqual(await book(scope, id), [], `${scope} of a suspended org`);
    }
    await pool.query("UPDATE organisations SET status = 'active' WHERE id = $1", [st.orgId]);

    // And the sysadmins' own Administration org never has a public book.
    await pool.query(
      `INSERT INTO records_federation (org_id, holder_id, gender, height, dive_code, position, score)
       VALUES ($1, $2, 'Female', '3m', $3, 'B', 1)`, [ADMIN_ORG_ID, her, oddCode]);
    assert.deepEqual(await book("federation", ADMIN_ORG_ID), []);

    // The country picker gets the continent so the Continental tab can
    // open on the right book.
    await pool.query("UPDATE organisations SET continent = 'africa' WHERE id = $1", [st.orgId]);
    const active = await fetchJson("GET", "/api/orgs/active");
    assert.equal(active.body.find((o) => o.id === st.orgId)?.continent, "africa");
    assert.equal(active.body.find((o) => o.id === st.orgId)?.claim_state, "claimed");
  } finally {
    await pool.query("DELETE FROM records_continental WHERE dive_code = $1", [oddCode]);
    await pool.query("DELETE FROM records_federation WHERE dive_code = $1", [oddCode]);
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

test("scoreboard: record chips ride on the payload, first marks and personal bests don't", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const lib = recordKit.lib();
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Chip Province', 'CPV') RETURNING id",
      [st.orgId])).rows[0].id;
    const club = await recordKit.club(st.orgId, "Chip Divers", "CHD", region);
    const first = await recordKit.diver(st.orgId, club, "female", "Hana First");
    const second = await recordKit.diver(st.orgId, club, "female", "Ivy Second");
    const dive = await recordKit.threeMetreDive();
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    const scoreboard = async () => {
      const r = await fetchJson("GET", `/api/scoreboard/${ev.id}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };

    // Hana's dive is the first anyone has done here, so it opens every
    // book. None of that is worth a chip.
    await recordKit.dive(ev, first, 1, dive, 6);
    const opened = await lib.checkAndApplyRecords({ eventId: ev.id, competitorId: first, roundNumber: 1 });
    assert.deepEqual(opened.map((b) => b.scope).sort(), ["club", "federation", "personal", "region"]);
    const hers = opened[0].score;
    assert.deepEqual((await scoreboard()).records, []);

    // Ivy beats it. Four of her five scores go straight in, and the
    // scoreboard gets fetched (and cached) before the fifth, which the
    // operator types in through manual entry like a meet that lost its
    // judges' phones.
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
      [ev.id, second, dive]);
    for (const j of ev.judges.slice(0, 4)) {
      await pool.query(
        "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, 1, 7)",
        [ev.id, second, j, dive]);
    }
    assert.deepEqual((await scoreboard()).records, []);
    const entry = await fetchJson("POST", "/api/scores/manual-entry", {
      token: st.adminToken,
      body: { event_id: ev.id, competitor_id: second, round_number: 1, judge_id: ev.judges[4], score: 7 },
    });
    assert.equal(entry.status, 200, JSON.stringify(entry.body));

    // No ?cache=skip: whatever the server hands a spectator now has to
    // include the marks. Her personal best is her first go at the dive,
    // so it stays out.
    const sb = await scoreboard();
    const marks = [...sb.records].sort((a, b) => a.scope.localeCompare(b.scope));
    assert.deepEqual(marks.map((m) => m.scope), ["club", "federation", "region"]);
    assert.deepEqual(marks.map((m) => m.scope_code), ["CHD", "TST", "CPV"]);
    assert.deepEqual(marks.map((m) => m.official), [true, true, false], "the province is unclaimed");
    for (const m of marks) {
      assert.equal(m.competitor_id, second);
      assert.equal(m.gender, "Female");
      assert.equal(m.dive_code, opened[0].dive_code);
      assert.equal(m.position, opened[0].position);
      assert.equal(typeof m.score, "number");
      assert.equal(m.prev_score, hers);
    }
    // The history card the chip hangs off carries the same points.
    const card = sb.history.find((h) => h.competitor_id === second);
    assert.ok(Math.abs(Number(card.total_dive_score) - marks[0].score) < 0.01);

    // The recap carries the same list.
    const recap = await fetchJson("GET", `/api/archive/${ev.id}/results`);
    assert.equal(recap.status, 200);
    assert.deepEqual(recap.body.records.map((m) => m.scope).sort(), ["club", "federation", "region"]);

    // Once Hana takes those records back at a later meet, this event no
    // longer holds them and the chips go with them.
    const later = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(later, first, 1, dive, 8);
    await lib.checkAndApplyRecords({ eventId: later.id, competitorId: first, roundNumber: 1 });
    const after = await fetchJson("GET", `/api/scoreboard/${ev.id}?cache=skip`);
    assert.deepEqual(after.body.records, []);
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

test("records: scores typed into an event that hasn't started set nothing", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { rebuildRecords } = require("../scripts/rebuild-records");
  const st = await setupFixture({ withEvent: false });
  try {
    const lib = recordKit.lib();
    const club = await recordKit.club(st.orgId, "Try-out Divers", "TOD");
    const her = await recordKit.diver(st.orgId, club, "female", "Kit Tryout");
    const dive = await recordKit.threeMetreDive();
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    // Judges can't score an Upcoming event, but manual entry doesn't
    // check, so an operator trying the Control Room out can complete
    // a dive there. Four scores straight in, the fifth by hand.
    await pool.query("UPDATE events SET status = 'Upcoming' WHERE id = $1", [ev.id]);
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
      [ev.id, her, dive]);
    for (const j of ev.judges.slice(0, 4)) {
      await pool.query(
        "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, 1, 7)",
        [ev.id, her, j, dive]);
    }
    const entry = await fetchJson("POST", "/api/scores/manual-entry", {
      token: st.adminToken,
      body: { event_id: ev.id, competitor_id: her, round_number: 1, judge_id: ev.judges[4], score: 7 },
    });
    assert.equal(entry.status, 200, JSON.stringify(entry.body));
    const held = async () => {
      let n = 0;
      for (const tbl of ["records_personal", "records_club", "records_federation", "records_continental", "records_region"]) {
        n += (await pool.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE event_id = $1`, [ev.id])).rows[0].n;
      }
      return n;
    };
    assert.equal(await held(), 0, "nothing from an Upcoming event reaches the books");

    // A replay applies the same rule, or it'd add what the live path skipped.
    const client = await pool.connect();
    try {
      const dry = await rebuildRecords(client, { orgId: st.orgId });
      assert.equal(dry.find((r) => r.scope === "club").counts.added, 0);
    } finally {
      client.release();
    }

    // Sign-off still counts: that's scores being typed up after the
    // event ran, and they're real results.
    await pool.query("UPDATE events SET status = 'pending_signoff' WHERE id = $1", [ev.id]);
    const broken = await lib.checkAndApplyRecords({ eventId: ev.id, competitorId: her, roundNumber: 1 });
    assert.ok(broken.some((b) => b.scope === "club"), JSON.stringify(broken));
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// SUPPORT_EMAIL (lib/support.js). The SPA footers read it from a public
// endpoint, and the messages that used to say "contact support" with no way
// to do so now carry the address. Uses Svalbard for the club-first account,
// a country code nothing else in the suite touches.
test("support email: public config and the contact lines in messages", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { supportEmail } = require("../lib/support");
  const claimsLib = require("../lib/claims");
  const CODE = "SJM";
  const saved = process.env.SUPPORT_EMAIL;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: false });
  try {
    // Anonymous, cacheable, and follows the env var.
    let cfg = await fetchJson("GET", "/api/public-config");
    assert.equal(cfg.status, 200);
    assert.deepEqual(Object.keys(cfg.body), ["support_email"]);
    assert.equal(cfg.body.support_email, supportEmail());
    process.env.SUPPORT_EMAIL = "help@svalbard-diving.example.test";
    cfg = await fetchJson("GET", "/api/public-config");
    assert.equal(cfg.body.support_email, "help@svalbard-diving.example.test");
    const addr = new RegExp(escape("help@svalbard-diving.example.test"));

    // Suspended under a real federation: the federation admin, and us.
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [state.adminId]);
    let res = await fetchJson("POST", "/api/auth/login", { body: { username: state.username, password: TEST_PASSWORD } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "account_suspended");
    assert.match(res.body.error, /federation administrator/);
    assert.match(res.body.error, addr);

    // Suspended in a club-first country, where nobody holds org_admin:
    // don't send them looking for a federation that doesn't exist.
    const founder = await claimKit.founder(CODE, "Longyearbyen Divers");
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [founder.id]);
    res = await fetchJson("POST", "/api/auth/login", { body: { username: founder.username, password: TEST_PASSWORD } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "account_suspended");
    assert.match(res.body.error, /club admin/);
    assert.doesNotMatch(res.body.error, /federation/);
    assert.match(res.body.error, addr);
    await pool.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [founder.id]);

    // A suspended organisation says where to go too.
    await pool.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [state.adminId]);
    await pool.query("UPDATE organisations SET status = 'suspended' WHERE id = $1", [state.orgId]);
    res = await fetchJson("POST", "/api/auth/login", { body: { username: state.username, password: TEST_PASSWORD } });
    assert.equal(res.body.code, "org_suspended");
    assert.match(res.body.error, addr);

    // Claim notices that used to say "contact DivingHQ" name the inbox. A
    // brand-new club can't vote yet, so this claim lands with the sysadmin.
    const sent = [];
    const pushed = [];
    const deps = {
      email: { sendClaimEmail: async (userIds, msg) => { sent.push({ userIds, ...msg }); } },
      push: { sendNotification: async (userIds, msg) => { pushed.push({ userIds, ...msg }); } },
    };
    const fed = await claimKit.claim({ org_name: "Svalbard Aquatics", country_code: CODE });
    assert.equal(fed.res.status, 201, JSON.stringify(fed.res.body));
    assert.equal(fed.res.body.approver, "sysadmin");
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [fed.id]);
    await claimsLib.activateForUser(pool, fed.id, deps);
    sent.length = 0;
    pushed.length = 0;
    await claimsLib.decide(pool, {
      claimId: fed.res.body.claim_id, user: { is_system_admin: true, id: null }, decision: "reject",
    }, deps);
    const rejected = sent.find((m) => m.userIds.includes(fed.id));
    assert.ok(rejected, "the claimant is emailed");
    assert.match(rejected.body, /Reply to this email/);
    assert.match(rejected.body, addr);
    const inApp = pushed.find((m) => m.userIds.includes(fed.id));
    assert.match(inApp.body, addr);

    // A second claim while one is live is refused with the address in it.
    const again = await claimKit.claim({ org_name: "Svalbard Diving", country_code: CODE });
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [again.id]);
    await claimsLib.activateForUser(pool, again.id, deps);
    const dup = await claimKit.claim({ org_name: "Svalbard Diving Two", country_code: CODE });
    assert.equal(dup.res.status, 409, JSON.stringify(dup.res.body));
    assert.match(dup.res.body.error, addr);
  } finally {
    if (saved === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = saved;
    await teardownFixture(state);
    await claimKit.wipe(CODE);
  }
});

// Account deletion has to live up to the privacy policy (docs/privacy-
// policy.md section 7): the competition details and the club admin seat go
// with the account, the name stays on the sporting record. Cocos (Keeling)
// Islands, which nothing else in the suite uses.
test("account deletion clears personal details and admin seats", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CCK";
  await claimKit.wipe(CODE);
  try {
    const founder = await claimKit.founder(CODE, "West Island Divers");
    assert.ok(founder.clubId, "founder admins the club they started");
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [founder.id])).rows[0].org_id;
    await pool.query(
      "UPDATE users SET date_of_birth = '2010-04-02', gender = 'Female', nationality = 'AUS' WHERE id = $1",
      [founder.id],
    );
    // A state seat as well, the same cleanup has to cover region_admins.
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Home Island', 'HMI') RETURNING id", [orgId],
    )).rows[0];
    await pool.query(
      "INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [region.id, founder.id, orgId],
    );

    const del = await fetchJson("POST", "/api/users/me/delete", {
      token: founder.token, body: { password: TEST_PASSWORD },
    });
    assert.equal(del.status, 200, JSON.stringify(del.body));

    const row = (await pool.query(
      "SELECT full_name, email, date_of_birth, gender, nationality, deleted_at FROM users WHERE id = $1", [founder.id],
    )).rows[0];
    assert.ok(row.deleted_at);
    assert.equal(row.full_name, "West Island Divers Admin", "the name stays for the sporting record");
    assert.equal(row.email, null);
    assert.equal(row.date_of_birth, null);
    assert.equal(row.gender, null);
    assert.equal(row.nationality, null);
    const seats = await pool.query(
      `SELECT (SELECT count(*)::int FROM club_admins WHERE user_id = $1) AS clubs,
              (SELECT count(*)::int FROM region_admins WHERE user_id = $1) AS regions`, [founder.id],
    );
    assert.deepEqual(seats.rows[0], { clubs: 0, regions: 0 });
  } finally {
    await pool.query(
      "DELETE FROM regions WHERE org_id IN (SELECT id FROM organisations WHERE country_code = $1)", [CODE],
    ).catch(() => {});
    await claimKit.wipe(CODE);
  }
});

// Crawler files. Before public/robots.txt and sitemap.xml existed, both paths
// fell through to the SPA fallback and answered 200 with the app's HTML. The
// integration server runs without a build, so this also proves the explicit
// routes in server.js, not just a dist/ copy, serve them.
test("robots.txt and sitemap.xml are real files, not the SPA shell", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const get = (p) => new Promise((resolve, reject) => {
    http.get(baseUrl + p, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });

  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.type, /^text\/plain/);
  assert.match(robots.body, /^Disallow: \/api\/$/m);
  assert.match(robots.body, /^Sitemap: https:\/\/divinghq\.app\/sitemap\.xml$/m);
  assert.doesNotMatch(robots.body, /<html/i);

  const sitemap = await get("/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.type, /^application\/xml/);
  assert.match(sitemap.body, /<urlset /);
  assert.match(sitemap.body, /<loc>https:\/\/divinghq\.app\/guide\/quick-start<\/loc>/);
  assert.doesNotMatch(sitemap.body, /<div id="app">/);
});

// A session that was already open when the account got suspended is cut off
// by verifyToken, not the login handler, and it used to send everyone to
// "your federation administrator", club-first countries included. Both paths
// share lib/support.js now. The merge-conflict refusal on "claim past
// results" also named a federation admin, who can't merge accounts anyway.
// Cayman Islands for the club-first half, nothing else in the suite uses it.
test("support email: suspended sessions and merge conflicts say who to ask", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "CYM";
  const saved = process.env.SUPPORT_EMAIL;
  process.env.SUPPORT_EMAIL = "help@cayman-diving.example.test";
  const addr = /help@cayman-diving\.example\.test/;
  await claimKit.wipe(CODE);
  // No event through the API: that request would warm the 30s auth-state
  // cache for the admin, and the suspension below wouldn't show until it
  // expired. The merge check further down makes its own event in SQL.
  const state = await setupFixture({ withEvent: false });
  try {
    // Neither token has been through verifyToken yet, so the cache is cold
    // and the suspension is seen on the very next request.
    const founder = await claimKit.founder(CODE, "George Town Divers");
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = ANY($1)", [[founder.id, state.adminId]]);

    let res = await fetchJson("GET", "/api/claims", { token: founder.token });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "account_suspended");
    assert.match(res.body.error, /club admin/);
    assert.doesNotMatch(res.body.error, /federation/);
    assert.match(res.body.error, addr);

    res = await fetchJson("GET", "/api/claims", { token: state.adminToken });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "account_suspended");
    assert.match(res.body.error, /federation administrator/);
    assert.match(res.body.error, addr);
    await pool.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [state.adminId]);

    // Claim-past-results where both accounts entered the same round: refused,
    // and pointed at support rather than a federation admin.
    const oldId = await insertUser({ orgId: state.orgId, username: `int-old-${state.slug}`, fullName: "Ebanks Twin", role: "diver" });
    const newId = await insertUser({ orgId: state.orgId, username: `int-new-${state.slug}`, fullName: "Ebanks Twin", role: "diver" });
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [oldId]);
    const dive = (await pool.query("SELECT id FROM dive_directory LIMIT 1")).rows[0].id;
    const eventId = (await pool.query(
      "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, 'Seven Mile Open', 'Mixed', 5) RETURNING id",
      [state.orgId],
    )).rows[0].id;
    for (const id of [oldId, newId]) {
      await pool.query(
        "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
        [eventId, id, dive],
      );
    }
    // insertUser's fixture password.
    const login = await fetchJson("POST", "/api/auth/login", { body: { username: `int-new-${state.slug}`, password: "not-used-here" } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    res = await fetchJson("POST", "/api/users/me/claim", {
      token: login.body.token, body: { old_user_ids: [oldId], password: "not-used-here" },
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error, /^Cannot merge/);
    assert.match(res.body.error, addr);
    assert.doesNotMatch(res.body.error, /federation admin/);
  } finally {
    if (saved === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = saved;
    await teardownFixture(state);
    await claimKit.wipe(CODE);
  }
});

// Deleting an account while a claim of yours is still being decided. The
// claim used to stay live: the clubs (or DivingHQ) could still approve it and
// hand org_admin to an account nobody can sign in to, leaving the country
// "claimed" with no one running it. Guardian links, the other tie to another
// person the deletion missed, get ended as well. Northern Mariana Islands,
// which no other test file uses.
test("account deletion withdraws a live claim and ends guardian links", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "MNP";
  const claimsLib = require("../lib/claims");
  await claimKit.wipe(CODE);
  try {
    const club = await claimKit.founder(CODE, "Saipan Divers");
    const fed = await claimKit.claim({ org_name: "Marianas Diving Federation", country_code: CODE });
    assert.equal(fed.res.status, 201, JSON.stringify(fed.res.body));
    const claimId = fed.res.body.claim_id;
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [fed.id]);
    // Parked with DivingHQ, the state where a sysadmin could still approve it.
    await pool.query("UPDATE claims SET status = 'escalated' WHERE id = $1", [claimId]);
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [fed.id])).rows[0].org_id;
    const link = (await pool.query(
      `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status)
       VALUES ($1, $2, $3, 'approved') RETURNING id`,
      [orgId, fed.id, club.id],
    )).rows[0].id;

    const login = await claimKit.login(fed.username);
    assert.ok(login.token, JSON.stringify(login));
    const del = await fetchJson("POST", "/api/users/me/delete", { token: login.token, body: { password: TEST_PASSWORD } });
    assert.equal(del.status, 200, JSON.stringify(del.body));

    const claim = (await pool.query("SELECT status, status_reason FROM claims WHERE id = $1", [claimId])).rows[0];
    assert.equal(claim.status, "withdrawn");
    assert.match(claim.status_reason, /deleted their account/);
    const g = (await pool.query("SELECT status FROM guardians WHERE id = $1", [link])).rows[0];
    assert.equal(g.status, "revoked");

    // A sysadmin can't approve it any more...
    await assert.rejects(
      claimsLib.decide(pool, { claimId, user: { is_system_admin: true, id: null }, decision: "approve" }, {}),
      (err) => err.status === 409,
    );
    const org = (await pool.query("SELECT claim_state FROM organisations WHERE id = $1", [orgId])).rows[0];
    assert.equal(org.claim_state, "unclaimed");
    // ...and the country is free for the body to apply again properly.
    const again = await claimKit.claim({ org_name: "Marianas Diving Federation", country_code: CODE });
    assert.equal(again.res.status, 201, JSON.stringify(again.res.body));
  } finally {
    await claimKit.wipe(CODE);
  }
});

// ---------------------------------------------------------------------
// Track d: club-first follow-ups.
// ---------------------------------------------------------------------

// A claimant signs in as a plain spectator. has_claim on the session body
// is what puts Claims in their nav, and my_claims on the dashboard bundle
// is their chip while it's being decided.
test("claims: a claimant is told about their own claim on sign-in and on the dashboard", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "VUT";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Port Vila Divers");
    const B = await claimKit.founder(CODE, "Luganville Divers");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    assert.equal((await claimKit.login(A.username)).has_claim, false, "a club founder hasn't claimed anything");

    const fed = await claimKit.claim({ org_name: "Vanuatu Diving Federation", country_code: CODE });
    assert.equal(fed.res.status, 201, JSON.stringify(fed.res.body));
    await claimKit.verify(fed.id);

    const login = await claimKit.login(fed.username);
    assert.equal(login.has_claim, true);
    assert.equal(login.user.has_claim, true, "the nested user object carries it too");
    const me = await fetchJson("GET", "/api/auth/me", { token: login.token });
    assert.equal(me.body.user.has_claim, true);

    const dash = await fetchJson("GET", "/api/dashboard", { token: login.token });
    assert.equal(dash.status, 200);
    assert.equal(dash.body.my_claims.length, 1);
    const mine = dash.body.my_claims[0];
    assert.equal(mine.id, fed.res.body.claim_id);
    assert.equal(mine.target_kind, "org");
    assert.equal(mine.target_name, "Vanuatu", "a national claim is named for the country");
    assert.equal(mine.status, "open");
    assert.equal(mine.approver, "clubs");
    assert.equal(mine.activated, true);
    assert.ok(mine.closes_at, "voting has a closing date once activated");
    // A voter's bundle doesn't list someone else's claim as theirs.
    assert.deepEqual((await fetchJson("GET", "/api/dashboard", { token: A.token })).body.my_claims, []);

    // Once it's decided the chip goes, but Claims stays in the nav so
    // they can see how it went.
    for (const x of [A, B]) {
      await fetchJson("POST", `/api/claims/${mine.id}/vote`, { token: x.token, body: { vote: "approve" } });
    }
    const after = await claimKit.login(fed.username);
    assert.deepEqual((await fetchJson("GET", "/api/dashboard", { token: after.token })).body.my_claims, []);
    assert.equal(after.has_claim, true);
  } finally {
    await claimKit.wipe(CODE);
  }
});

// My club tells "your federation appoints the admins" apart from "you're
// not an admin any more" by the org's claim_state on club_admin_of, and
// after removing yourself the session body has to stop listing the club.
test("club admins: club_admin_of says who runs the org, and self-removal drops the club", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "SLB";
  await claimKit.wipe(CODE);
  const fedState = await setupFixture({ withEvent: false });
  try {
    const A = await claimKit.founder(CODE, "Honiara Divers");
    const login = await claimKit.login(A.username);
    assert.equal(login.club_admin_of[0].org_claim_state, "unclaimed");

    // A second admin, so the club isn't left with none.
    const orgId = (await pool.query("SELECT org_id FROM clubs WHERE id = $1", [A.clubId])).rows[0].org_id;
    const bId = await insertUser({ orgId, username: `int-slb-${crypto.randomBytes(4).toString("hex")}`, fullName: "Gizo Admin", role: "spectator" });
    await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [A.clubId, bId]);
    assert.equal((await fetchJson("POST", `/api/clubs/${A.clubId}/admins`, { token: A.token, body: { user_id: bId } })).status, 201);

    // A takes themselves off. Their session no longer lists the club and
    // the admins list now refuses them, which My club reads as "not an
    // admin any more" because the org is unclaimed.
    assert.equal((await fetchJson("DELETE", `/api/clubs/${A.clubId}/admins/${A.id}`, { token: A.token })).status, 200);
    const me = await fetchJson("GET", "/api/auth/me", { token: A.token });
    assert.deepEqual(me.body.user.club_admin_of, []);
    assert.equal((await fetchJson("GET", `/api/clubs/${A.clubId}/admins`, { token: A.token })).status, 403);

    // Under a federation the same row says claimed.
    const clubId = (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, 'Federation Club') RETURNING id", [fedState.orgId],
    )).rows[0].id;
    const judgeName = `int-fedclub-${fedState.slug}`;
    const judgeId = await insertUser({ orgId: fedState.orgId, username: judgeName, fullName: "Fed Club Admin", role: "judge" });
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [clubId, judgeId, fedState.orgId]);
    // insertUser's fixture password.
    const fedLogin = await claimKit.login(judgeName, "not-used-here");
    assert.equal(fedLogin.club_admin_of[0].org_claim_state, "claimed");
    assert.equal((await fetchJson("GET", `/api/clubs/${clubId}/admins`, { token: fedLogin.token })).status, 403,
      "the federation appoints, a club admin there can't manage the list");
  } finally {
    await pool.query("DELETE FROM club_admins WHERE org_id = $1", [fedState.orgId]).catch(() => {});
    await pool.query("DELETE FROM users WHERE org_id = $1", [fedState.orgId]).catch(() => {});
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [fedState.orgId]).catch(() => {});
    await teardownFixture(fedState);
    await claimKit.wipe(CODE);
  }
});

// The Clubs screen only offers "Set up regions" where the seed route can
// work, which is decided by lib/regions.json having a list for the org's
// country. Pending orgs so nobody's by-country lookup trips over them.
test("regions: an org's region list says whether its country has a built-in catalogue", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const ids = [];
  try {
    for (const code of ["GBR", "MHL"]) {
      const slug = `int-cat-${code.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}`;
      ids.push((await pool.query(
        "INSERT INTO organisations (name, slug, country_code, status) VALUES ($1, $2, $3, 'pending') RETURNING id",
        [`Catalogue ${code}`, slug, code],
      )).rows[0].id);
    }
    const gbr = await fetchJson("GET", `/api/orgs/${ids[0]}/regions`);
    assert.equal(gbr.status, 200);
    assert.equal(gbr.body.catalogue, true, "Britain's home nations ship in regions.json");
    assert.deepEqual(gbr.body.regions, [], "nothing seeded until someone asks");
    const mhl = await fetchJson("GET", `/api/orgs/${ids[1]}/regions`);
    assert.equal(mhl.body.catalogue, false, "no list for the Marshall Islands");
    assert.equal((await fetchJson("GET", "/api/orgs/not-a-uuid/regions")).body.catalogue, false);
  } finally {
    for (const id of ids) await pool.query("DELETE FROM organisations WHERE id = $1", [id]).catch(() => {});
  }
});

// Number('') is 0, and 0 is inside most claim-rule ranges, so an emptied
// field on /admin/features used to save as 0. The server now refuses
// anything that isn't a number (or a string spelling one).
test("platform settings: an empty or non-numeric value is refused, not saved as 0", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const sys = await claimKit.login("admin", "admin");
  if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
  const KEY = "claim_voter_min_age_days";
  const before = (await fetchJson("GET", "/api/admin/settings", { token: sys.token })).body.find((s) => s.key === KEY);
  assert.ok(before, "the setting is listed");
  for (const value of ["", "   ", null, false, "abc", [], {}]) {
    const r = await fetchJson("PUT", `/api/admin/settings/${KEY}`, { token: sys.token, body: { value } });
    assert.equal(r.status, 400, `value ${JSON.stringify(value)} should be refused, got ${r.status}`);
  }
  // Leaving value out entirely is the same as empty.
  assert.equal((await fetchJson("PUT", `/api/admin/settings/${KEY}`, { token: sys.token, body: {} })).status, 400);
  const after = (await fetchJson("GET", "/api/admin/settings", { token: sys.token })).body.find((s) => s.key === KEY);
  assert.equal(after.value, before.value, "nothing was written");
  // A numeric string with stray spaces is still a number. Re-save the
  // current value so the shared test DB ends up where it started.
  const ok = await fetchJson("PUT", `/api/admin/settings/${KEY}`, { token: sys.token, body: { value: ` ${before.value} ` } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.value, before.value);
});

// Review follow-up. The claimant flag and chip are meant to follow the
// claim, not stick to the account: a withdrawn claim (the sweep does
// this to one whose email was never verified) drops both, and a claim on
// a region is named for the region rather than the country.
test("claims: a region claim is named for its region, and a withdrawn one drops the claimant flag", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "GUM";
  await claimKit.wipe(CODE);
  try {
    // Guam has no built-in region list, so the regions go in by hand
    // once the first club has started the country's account.
    await claimKit.founder(CODE, "Hagatna Divers");
    const orgId = (await pool.query(
      "SELECT id FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'", [CODE],
    )).rows[0].id;
    await pool.query("UPDATE organisations SET region_label = 'region' WHERE id = $1", [orgId]);
    await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Northern Guam', 'NG'), ($1, 'Southern Guam', 'SG')",
      [orgId],
    );
    const catalogue = await fetchJson("GET", `/api/orgs/${orgId}/regions`);
    assert.equal(catalogue.body.catalogue, false, "no built-in list for Guam, even with regions added by hand");
    assert.equal(catalogue.body.regions.length, 2);

    const body = await claimKit.claim({ org_name: "North Guam Diving", country_code: CODE, region_code: "ng" });
    assert.equal(body.res.status, 201, JSON.stringify(body.res.body));
    assert.equal(body.res.body.target_kind, "region");
    await claimKit.verify(body.id);

    const login = await claimKit.login(body.username);
    assert.equal(login.has_claim, true);
    const dash = await fetchJson("GET", "/api/dashboard", { token: login.token });
    assert.equal(dash.body.my_claims.length, 1);
    assert.equal(dash.body.my_claims[0].target_kind, "region");
    assert.equal(dash.body.my_claims[0].target_name, "Northern Guam");

    await pool.query("UPDATE claims SET status = 'withdrawn' WHERE claimant_id = $1", [body.id]);
    const after = await claimKit.login(body.username);
    assert.equal(after.has_claim, false, "a withdrawn claim isn't one to follow");
    const me = await fetchJson("GET", "/api/auth/me", { token: after.token });
    assert.equal(me.body.user.has_claim, false);
    assert.deepEqual((await fetchJson("GET", "/api/dashboard", { token: after.token })).body.my_claims, []);
  } finally {
    await claimKit.wipe(CODE);
  }
});

// Any well-formed id gets the same answer shape, so the Clubs screen
// never reads catalogue off undefined for an org that's since gone.
test("regions: an unknown org's region list is empty with no catalogue", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const r = await fetchJson("GET", `/api/orgs/${crypto.randomUUID()}/regions`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { label: null, regions: [], catalogue: false });
});

// A new meet labels divers at the host's own level unless the creator
// picks: club for a club's meet, region for a region's, country for the
// federation's. Before this every club night came out as 'country'.
test("new meets default 'divers represent' to the host's level", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "BLM";
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: false });
  try {
    const A = await claimKit.founder(CODE, "Gustavia Divers");
    const clubNight = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Gustavia Club Night" } });
    assert.equal(clubNight.status, 201, JSON.stringify(clubNight.body));
    assert.equal(clubNight.body.host_club_id, A.clubId);
    assert.equal(clubNight.body.represent_as, "club");
    // An explicit choice still wins, and junk is still refused.
    const open = await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Island Open", represent_as: "country" } });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    assert.equal(open.body.represent_as, "country");
    assert.equal((await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "x", represent_as: "" } })).status, 400);

    // A region admin's meet (defaulted to their only region) goes by region.
    const orgId = (await pool.query("SELECT org_id FROM clubs WHERE id = $1", [A.clubId])).rows[0].org_id;
    const regionId = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Saint-Barthélemy', 'SBH') RETURNING id", [orgId],
    )).rows[0].id;
    const rUser = `int-ra-${crypto.randomBytes(4).toString("hex")}`;
    const reg = await fetchJson("POST", "/api/auth/register", {
      body: { username: rUser, full_name: "Region Admin", password: TEST_PASSWORD,
              email: `${rUser}@example.test`, country_code: CODE, club_id: A.clubId },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const rId = (await pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1 RETURNING id", [rUser])).rows[0].id;
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [regionId, rId, orgId]);
    const R = await claimKit.login(rUser);
    const champs = await fetchJson("POST", "/api/meets", { token: R.token, body: { name: "Island Championships" } });
    assert.equal(champs.status, 201, JSON.stringify(champs.body));
    assert.equal(champs.body.host_region_id, regionId);
    assert.equal(champs.body.represent_as, "region");

    // The federation's own meets keep 'country'; one it sets up on a
    // club's behalf follows the club.
    const fedMeet = await fetchJson("POST", "/api/meets", { token: state.adminToken, body: { name: "Nationals" } });
    assert.equal(fedMeet.status, 201, JSON.stringify(fedMeet.body));
    assert.equal(fedMeet.body.represent_as, "country");
    const fedClub = (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, 'Fed Club', 'FC') RETURNING id", [state.orgId],
    )).rows[0].id;
    const onBehalf = await fetchJson("POST", "/api/meets", { token: state.adminToken, body: { name: "Fed Club Night", host_club_id: fedClub } });
    assert.equal(onBehalf.status, 201, JSON.stringify(onBehalf.body));
    assert.equal(onBehalf.body.represent_as, "club");
  } finally {
    await claimKit.wipe(CODE);
    await pool.query("DELETE FROM meets WHERE org_id = $1", [state.orgId]).catch(() => {});
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [state.orgId]).catch(() => {});
    await teardownFixture(state);
  }
});

// Club setup (routes/club-setup.js): the dashboard's Get started panel
// and My club's invite link / short code card read and write this.
test("club setup: a founder's progress, invite parts and short code", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "SXM";
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: false });
  try {
    const A = await claimKit.founder(CODE, "Philipsburg Divers");
    const B = await claimKit.founder(CODE, "Simpson Bay Divers", { new_club_short_code: "SBY" });

    const fresh = await fetchJson("GET", `/api/clubs/${A.clubId}/setup`, { token: A.token });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.name, "Philipsburg Divers");
    assert.equal(fresh.body.country_code, CODE, "invite link needs the country");
    assert.equal(fresh.body.short_code, null);
    assert.equal(fresh.body.claim_state, "unclaimed");
    assert.equal(fresh.body.can_edit_code, true, "no federation, so the club sets its own code");
    assert.equal(fresh.body.meet_count, 0);
    assert.equal(fresh.body.member_count, 1);
    assert.equal(fresh.body.you_are_member, true);

    // Someone follows the invite link (country + club), and a meet lands.
    const member = `int-inv-${crypto.randomBytes(4).toString("hex")}`;
    const joined = await fetchJson("POST", "/api/auth/register", {
      body: { username: member, full_name: "Invited Diver", password: TEST_PASSWORD,
              email: `${member}@example.test`, country_code: CODE, club_id: A.clubId },
    });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    assert.equal((await fetchJson("POST", "/api/meets", { token: A.token, body: { name: "Philipsburg Club Night" } })).status, 201);
    const later = (await fetchJson("GET", `/api/clubs/${A.clubId}/setup`, { token: A.token })).body;
    assert.equal(later.member_count, 2);
    assert.equal(later.meet_count, 1);

    // The code: trimmed, upper-cased, validated, unique within the country.
    const set = await fetchJson("PUT", `/api/clubs/${A.clubId}/short-code`, { token: A.token, body: { short_code: " phi " } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.short_code, "PHI");
    assert.equal((await fetchJson("GET", `/api/clubs/${A.clubId}/setup`, { token: A.token })).body.short_code, "PHI");
    for (const bad of ["WAY-TOO-LONG", "P L Y", "<b>", 42]) {
      const r = await fetchJson("PUT", `/api/clubs/${A.clubId}/short-code`, { token: A.token, body: { short_code: bad } });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} should be refused`);
    }
    // A body without the field doesn't quietly clear the code.
    assert.equal((await fetchJson("PUT", `/api/clubs/${A.clubId}/short-code`, { token: A.token, body: {} })).status, 400);
    const taken = await fetchJson("PUT", `/api/clubs/${A.clubId}/short-code`, { token: A.token, body: { short_code: "sby" } });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, "short_code_taken");
    const audit = await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'club.code_changed'", [A.clubId],
    );
    assert.deepEqual(audit.rows.map((r) => r.metadata), [{ from: null, to: "PHI" }]);
    // Clearing it is allowed too.
    const cleared = await fetchJson("PUT", `/api/clubs/${A.clubId}/short-code`, { token: A.token, body: { short_code: "" } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.short_code, null);

    // Nobody else's club: another club's admin, a plain member, another org.
    assert.equal((await fetchJson("GET", `/api/clubs/${A.clubId}/setup`, { token: B.token })).status, 403);
    assert.equal((await fetchJson("PUT", `/api/clubs/${A.clubId}/short-code`, { token: B.token, body: { short_code: "HAX" } })).status, 403);
    await pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [member]);
    const M = await claimKit.login(member);
    assert.equal((await fetchJson("GET", `/api/clubs/${A.clubId}/setup`, { token: M.token })).status, 403);
    assert.equal((await fetchJson("GET", `/api/clubs/${A.clubId}/setup`, { token: state.adminToken })).status, 404);
    assert.equal((await fetchJson("GET", "/api/clubs/not-a-uuid/setup", { token: A.token })).status, 404);
    assert.equal((await fetchJson("GET", `/api/clubs/${A.clubId}/setup`)).status, 403, "anonymous gets nothing");

    // Under a federation the club admin can read their progress, but the
    // federation owns the code.
    const fedClub = (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, 'Federation Club') RETURNING id", [state.orgId],
    )).rows[0].id;
    const adminUser = await insertUser({ orgId: state.orgId, username: `int-fca-${state.slug}`, fullName: "Fed Club Admin", role: "spectator" });
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [fedClub, adminUser, state.orgId]);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [await require("bcrypt").hash(TEST_PASSWORD, 4), adminUser]);
    const FCA = await claimKit.login(`int-fca-${state.slug}`);
    const fedView = await fetchJson("GET", `/api/clubs/${fedClub}/setup`, { token: FCA.token });
    assert.equal(fedView.status, 200, JSON.stringify(fedView.body));
    assert.equal(fedView.body.can_edit_code, false);
    assert.equal((await fetchJson("PUT", `/api/clubs/${fedClub}/short-code`, { token: FCA.token, body: { short_code: "FED" } })).status, 403);
    // ...and the federation's admin can set it from here as well.
    const orgSet = await fetchJson("PUT", `/api/clubs/${fedClub}/short-code`, { token: state.adminToken, body: { short_code: "FED" } });
    assert.equal(orgSet.status, 200, JSON.stringify(orgSet.body));
  } finally {
    await claimKit.wipe(CODE);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [state.orgId]).catch(() => {});
    await teardownFixture(state);
  }
});

// ---------------------------------------------------------------------
// Federation approval of new clubs (migration 096, lib/club-approvals.js).
// ---------------------------------------------------------------------

const clubApprovals = require("../lib/club-approvals");

const approvalKit = {
  // A claimed federation in `code`, with its org admin signed in.
  async federation(code) {
    const fx = await setupFixture({ withEvent: false });
    await pool.query("UPDATE organisations SET country_code = $2 WHERE id = $1", [fx.orgId, code]);
    fx.name = (await pool.query("SELECT name FROM organisations WHERE id = $1", [fx.orgId])).rows[0].name;
    return fx;
  },
  // Sign up by country with a brand-new club. Left unverified unless asked,
  // since verifying is what puts the club in front of the federation.
  async signUp(code, clubName, extra = {}, { verify = false } = {}) {
    const username = `int-ap-${crypto.randomBytes(4).toString("hex")}`;
    const r = await fetchJson("POST", "/api/auth/register", {
      body: { username, full_name: `${clubName} Founder`, password: TEST_PASSWORD,
              email: `${username}@example.test`, country_code: code, new_club_name: clubName, ...extra },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = (await pool.query("SELECT id, club_id FROM users WHERE username = $1", [username])).rows[0];
    if (verify) await claimKit.verify(row.id);
    return { username, id: row.id, clubId: row.club_id, res: r.body };
  },
  // A signed-in user with one org role, straight into the table.
  async member(orgId, role, clubId = null) {
    const username = `int-apm-${crypto.randomBytes(4).toString("hex")}`;
    const id = await insertUser({ orgId, username, fullName: `A ${role}`, role });
    await pool.query("UPDATE users SET password = $1, club_id = $3 WHERE id = $2",
      [await bcrypt.hash(TEST_PASSWORD, 4), id, clubId]);
    const login = await claimKit.login(username);
    return { id, username, token: login.token };
  },
  async club(id) {
    return (await pool.query("SELECT * FROM clubs WHERE id = $1", [id])).rows[0];
  },
  async isAdmin(clubId, userId) {
    return (await pool.query("SELECT 1 FROM club_admins WHERE club_id = $1 AND user_id = $2", [clubId, userId])).rows.length > 0;
  },
  async notices(userId, category) {
    return (await pool.query(
      "SELECT title, body, action_url, data FROM notifications WHERE user_id = $1 AND category = $2 ORDER BY created_at",
      [userId, category],
    )).rows;
  },
  // Stands in for push + email when a test drives lib/club-approvals.
  inbox() {
    const mail = [];
    const inApp = [];
    return {
      mail,
      inApp,
      deps: {
        email: { sendNoticeEmail: async (userIds, msg) => { mail.push({ userIds: [...userIds].sort(), ...msg }); } },
        push: { sendNotification: async (userIds, p) => { inApp.push({ userIds: [...userIds].sort(), ...p }); } },
      },
    };
  },
};

test("club approval: a new club under a federation waits, unseen, until its founder verifies", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "BTN";
  await claimKit.wipe(CODE);
  try {
    const fx = await approvalKit.federation(CODE);
    const A = await approvalKit.signUp(CODE, "Thimphu Divers", { new_club_short_code: "thi" });
    assert.equal(A.res.club_status, "pending");
    assert.equal(A.res.org_name, fx.name, "the federation's own name, not the country's");
    const row = await approvalKit.club(A.clubId);
    assert.equal(row.status, "pending");
    assert.equal(row.submitted_at, null);
    assert.equal(row.approved_at, null);
    assert.equal(row.created_by, A.id);
    assert.equal(await approvalKit.isAdmin(A.clubId, A.id), false, "the federation decides who runs it");
    assert.deepEqual(await approvalKit.notices(fx.adminId, "club_pending"), [], "nobody hears before the email is verified");

    // Hidden from every picker, and not joinable by hand either.
    const pub = await fetchJson("GET", `/api/orgs/${fx.orgId}/clubs`);
    assert.ok(!pub.body.some((c) => c.id === A.clubId), "not in the public club list");
    const by = await fetchJson("GET", `/api/orgs/by-country/${CODE}`);
    assert.equal(by.body[0].auto_approve_clubs, false);
    const joiner = await fetchJson("POST", "/api/auth/register", {
      body: { username: `int-apj-${crypto.randomBytes(3).toString("hex")}`, full_name: "Joiner", password: TEST_PASSWORD,
              email: `j-${crypto.randomBytes(3).toString("hex")}@example.test`, country_code: CODE, club_id: A.clubId },
    });
    assert.equal(joiner.status, 400, JSON.stringify(joiner.body));

    // An unverified founder's club isn't in the federation's queue yet.
    let grid = (await fetchJson("GET", "/api/clubs", { token: fx.adminToken })).body;
    assert.ok(!grid.some((c) => c.id === A.clubId));
    assert.equal((await fetchJson("GET", "/api/dashboard", { token: fx.adminToken })).body.clubs_pending, 0);

    // Verifying asks the federation, once, however often the link is used.
    await claimKit.verify(A.id);
    await claimKit.verify(A.id);
    const asked = await approvalKit.notices(fx.adminId, "club_pending");
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.match(asked[0].title, /Thimphu Divers/);
    assert.equal(asked[0].action_url, "/clubs");
    assert.ok((await approvalKit.club(A.clubId)).submitted_at, "submitted_at stamped");

    grid = (await fetchJson("GET", "/api/clubs", { token: fx.adminToken })).body;
    const pending = grid.find((c) => c.id === A.clubId);
    assert.ok(pending, "the org admin sees it now");
    assert.equal(pending.status, "pending");
    assert.equal(pending.founder_id, A.id);
    assert.equal(pending.founder_username, A.username);
    assert.equal(pending.founder_email, `${A.username}@example.test`);
    assert.equal(pending.founder_email_verified, true);
    assert.ok(pending.submitted_at);
    // Founder details ride on pending rows only.
    const active = await pool.query("INSERT INTO clubs (org_id, name) VALUES ($1, 'Paro Divers') RETURNING id", [fx.orgId]);
    grid = (await fetchJson("GET", "/api/clubs", { token: fx.adminToken })).body;
    const paro = grid.find((c) => c.id === active.rows[0].id);
    assert.equal(paro.status, "active");
    assert.equal(paro.founder_email, null);

    // A meet manager sees the clubs grid but never the queue.
    const mm = await approvalKit.member(fx.orgId, "meet_manager");
    const mmGrid = (await fetchJson("GET", "/api/clubs", { token: mm.token })).body;
    assert.ok(mmGrid.some((c) => c.id === active.rows[0].id));
    assert.ok(!mmGrid.some((c) => c.id === A.clubId), "meet managers don't see waiting clubs");
    assert.equal((await fetchJson("GET", "/api/dashboard", { token: mm.token })).body.clubs_pending, 0);

    // The dashboard counts it for the org admin and the sysadmin.
    assert.equal((await fetchJson("GET", "/api/dashboard", { token: fx.adminToken })).body.clubs_pending, 1);
    const sys = await claimKit.login("admin", "admin");
    if (sys?.token) {
      assert.ok((await fetchJson("GET", "/api/dashboard", { token: sys.token })).body.clubs_pending >= 1);
    }

    // The founder can sign in, and the session says what's waiting.
    const login = await claimKit.login(A.username);
    assert.deepEqual(login.pending_club, { id: A.clubId, name: "Thimphu Divers", org_name: fx.name });
    assert.deepEqual(login.club_admin_of, []);
    const me = await fetchJson("GET", "/api/auth/me", { token: login.token });
    assert.equal(me.body.user.pending_club.id, A.clubId);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("club approval: the federation hears by email, and the sysadmin does when there's no org admin", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "MDV";
  await claimKit.wipe(CODE);
  try {
    const fx = await approvalKit.federation(CODE);
    const rg = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Kaafu', 'KAF') RETURNING id", [fx.orgId],
    )).rows[0].id;
    const A = await approvalKit.signUp(CODE, "Male Divers", { region_code: "kaf", new_club_short_code: "MLE" });
    assert.equal((await approvalKit.club(A.clubId)).region_id, rg);
    // Stand in for the click without going through the route, so the
    // notices land in a fake inbox we can read.
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [A.id]);
    const box = approvalKit.inbox();
    assert.equal(await clubApprovals.submitForUser(pool, A.id, box.deps), 1);
    assert.equal(box.mail.length, 1);
    const m = box.mail[0];
    assert.deepEqual(m.userIds, [fx.adminId]);
    assert.equal(m.path, "/clubs");
    assert.match(m.subject, /New club waiting for your approval: Male Divers/);
    for (const bit of ["Club: Male Divers", "Code: MLE", "Region: Kaafu", `@${A.username}`,
                       `${A.username}@example.test`, "can't host meets", "join automatically"]) {
      assert.ok(m.body.includes(bit), `email mentions ${bit}: ${m.body}`);
    }
    assert.equal(box.inApp[0].category, "club_pending");
    // A second go sends nothing: the club was already put forward.
    assert.equal(await clubApprovals.submitForUser(pool, A.id, box.deps), 0);
    assert.equal(box.mail.length, 1);

    // A claimed org with no live org admin: the sysadmins hear instead.
    const sysIds = (await pool.query(
      "SELECT id FROM users WHERE is_system_admin AND deleted_at IS NULL",
    )).rows.map((r) => r.id).sort();
    await pool.query("DELETE FROM user_org_roles WHERE user_id = $1 AND role = 'org_admin'", [fx.adminId]);
    assert.deepEqual((await clubApprovals.reviewerIds(pool, fx.orgId)).sort(), sysIds);
    const B = await approvalKit.signUp(CODE, "Hulhumale Divers", { region_code: "KAF" });
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [B.id]);
    const box2 = approvalKit.inbox();
    await clubApprovals.submitForUser(pool, B.id, box2.deps);
    assert.deepEqual(box2.mail[0].userIds, sysIds);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("club approval: a waiting club can't host, be joined, be managed or be paid for", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "DJI";
  await claimKit.wipe(CODE);
  let paymentId = null;
  try {
    const fx = await approvalKit.federation(CODE);
    const tadj = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Tadjourah', 'TA') RETURNING id", [fx.orgId],
    )).rows[0].id;
    const A = await approvalKit.signUp(CODE, "Tadjourah Divers", { region_code: "TA", new_club_short_code: "TAD" }, { verify: true });
    const P = A.clubId;
    const diver = await approvalKit.member(fx.orgId, "diver");
    const founder = await claimKit.login(A.username);

    // Hosting a meet.
    const meet = await fetchJson("POST", "/api/meets", { token: fx.adminToken, body: { name: "Gulf Open", host_club_id: P } });
    assert.equal(meet.status, 400, JSON.stringify(meet.body));
    // Joining it, by request or by the federation setting it.
    const ask = await fetchJson("POST", "/api/club-change-requests", { token: diver.token, body: { to_club_id: P } });
    assert.equal(ask.status, 400, JSON.stringify(ask.body));
    const set = await fetchJson("PUT", `/api/users/${diver.id}/club`, { token: fx.adminToken, body: { club_id: P } });
    assert.equal(set.status, 400, JSON.stringify(set.body));
    // Editing or deleting it outside approve / reject.
    for (const [method, path, body] of [
      ["PUT", `/api/clubs/${P}`, { name: "Renamed" }],
      ["DELETE", `/api/clubs/${P}`],
      ["PUT", `/api/clubs/${P}/short-code`, { short_code: "NEW" }],
      ["GET", `/api/clubs/${P}/setup`],
      ["PUT", `/api/clubs/${P}/region`, { region_id: null }],
      ["GET", `/api/clubs/${P}/admins`],
      ["POST", `/api/clubs/${P}/admins`, { user_id: A.id }],
    ]) {
      const r = await fetchJson(method, path, { token: fx.adminToken, body });
      assert.equal(r.status, 409, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "club_pending");
    }
    // ...and somebody with no say gets a plain 403, not a hint it's waiting.
    assert.equal((await fetchJson("POST", `/api/clubs/${P}/admins`, { token: diver.token, body: { user_id: diver.id } })).status, 403);
    assert.equal((await fetchJson("PUT", `/api/clubs/${P}/region`, { token: founder.token, body: { region_id: null } })).status, 403);
    // Club-admin surfaces: affiliation (federation or club admin) and the
    // club-private payouts page, even for the sysadmin.
    const aff = await fetchJson("GET", `/api/clubs/${P}/affiliation`, { token: fx.adminToken });
    assert.equal(aff.status, 409, JSON.stringify(aff.body));
    assert.equal(aff.body.code, "club_pending");
    const sys = await claimKit.login("admin", "admin");
    if (sys?.token) {
      const pay = await fetchJson("GET", `/api/clubs/${P}/payments/status`, { token: sys.token });
      assert.equal(pay.status, 409, JSON.stringify(pay.body));
      const list = (await fetchJson("GET", "/api/me/club-admin-clubs", { token: sys.token })).body;
      assert.ok(!list.some((c) => c.id === P), "not in the sysadmin's club list");
    }
    // Not counted as one of the region's clubs, nor in its overview.
    const regions = (await fetchJson("GET", `/api/orgs/${fx.orgId}/regions`)).body.regions;
    assert.equal(regions.find((r) => r.id === tadj).club_count, 0);
    const overview = (await fetchJson("GET", `/api/regions/${tadj}/overview`, { token: fx.adminToken })).body;
    assert.deepEqual(overview.clubs, []);

    // The founder can still dive. Their club's code stays off the
    // scoreboard, and the club gets no record book, until it's approved.
    const ev = await fetchJson("POST", "/api/events", {
      token: fx.adminToken,
      body: { name: "1m", gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 1, event_type: "individual" },
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const clubMeet = await fetchJson("POST", "/api/meets", { token: fx.adminToken, body: { name: "Club Night", represent_as: "club" } });
    await pool.query("UPDATE events SET status = 'Live', meet_id = $2 WHERE id = $1", [ev.body.id, clubMeet.body.id]);
    const dive = (await pool.query("SELECT id FROM dive_directory WHERE height = 1 LIMIT 1")).rows[0].id;
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
      [ev.body.id, A.id, dive],
    );
    for (let i = 1; i <= 5; i++) {
      const j = await insertUser({ orgId: fx.orgId, role: "judge", username: `int-apj${i}-${crypto.randomBytes(3).toString("hex")}`, fullName: `Judge ${i}` });
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [ev.body.id, j, i]);
      await pool.query(
        "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, 1, 6.5)",
        [ev.body.id, A.id, j, dive],
      );
    }
    const rep = async () => (await pool.query("SELECT event_rep_code($1, $2, 'DJI') AS code", [ev.body.id, A.id])).rows[0].code;
    assert.equal(await rep(), "DJI", "a waiting club's code isn't shown");
    await pool.query("UPDATE users SET gender = 'male' WHERE id = $1", [A.id]);
    const records = require("../lib/records")({ pool, verifyToken: (_req, _res, next) => next() });
    const broken = await records.checkAndApplyRecords({ eventId: ev.body.id, competitorId: A.id, roundNumber: 1 });
    assert.ok(broken.some((b) => b.scope === "personal"), "the diver's own best still counts");
    assert.ok(!broken.some((b) => b.scope === "club"), "no club record for a waiting club");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM records_club WHERE club_id = $1", [P])).rows[0].n, 0);
    const archive = (await fetchJson("GET", "/api/archive/clubs?limit=500")).body;
    assert.ok(!archive.some((c) => c.id === P), "not in the public archive's club list");
    // Nor its founder-typed name and code, on anything the public reads.
    const clubName = (await approvalKit.club(P)).name;
    const standing = async () => (await fetchJson("GET", `/api/scoreboard/${ev.body.id}?cache=skip`)).body
      .standings.find((r) => r.competitor_id === A.id);
    assert.equal((await standing()).club_name, null, "scoreboard standings");
    const profile = (await fetchJson("GET", `/api/divers/${A.id}/profile`)).body;
    assert.equal(profile.club_name ?? null, null, "public diver profile");
    assert.equal(profile.club_code ?? null, null);
    const csv = await new Promise((resolve, reject) => {
      http.get(`${baseUrl}/api/events/${ev.body.id}/results.csv`, (r) => {
        const chunks = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }).on("error", reject);
    });
    // As a field of its own: the founder's name has the club's in it.
    const esc = clubName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.ok(!new RegExp(`(^|,)"?${esc}"?(,|$)`, "m").test(csv), "results.csv");

    // Payments RESTRICT a club's deletion. Shouldn't happen to a waiting
    // club, but if it does, reject says so instead of a 500.
    paymentId = (await pool.query(
      `INSERT INTO payments (org_id, subject_type, amount_cents, currency, payer_type, payer_club_id, status)
       VALUES ($1, 'club_affiliation', 100, 'aud', 'club', $2, 'failed') RETURNING id`,
      [fx.orgId, P],
    )).rows[0].id;
    const blocked = await fetchJson("POST", `/api/clubs/${P}/reject`, { token: fx.adminToken, body: {} });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.code, "club_has_payments");
    assert.equal((await approvalKit.club(P)).status, "pending", "rolled back, still waiting");
    await pool.query("DELETE FROM payments WHERE id = $1", [paymentId]);
    paymentId = null;

    // Once approved, all of that opens up.
    assert.equal((await fetchJson("POST", `/api/clubs/${P}/approve`, { token: fx.adminToken, body: {} })).status, 200);
    assert.equal(await rep(), "TAD", "the entry snapshot picks the code up by itself");
    assert.equal((await standing()).club_name, (await approvalKit.club(P)).name, "and the name shows once it's approved");
    const hosted = await fetchJson("POST", "/api/meets", { token: fx.adminToken, body: { name: "Gulf Open", host_club_id: P } });
    assert.equal(hosted.status, 201, JSON.stringify(hosted.body));
    assert.equal((await fetchJson("POST", "/api/club-change-requests", { token: diver.token, body: { to_club_id: P } })).status, 201);
  } finally {
    if (paymentId) await pool.query("DELETE FROM payments WHERE id = $1", [paymentId]).catch(() => {});
    await claimKit.wipe(CODE);
  }
});

test("club approval: nobody runs a waiting club, even with a stray admin row", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  // Only reachable by hand today (pending clubs only exist under a
  // federation, where club admins don't review anything), so force one
  // into an unclaimed country and check the club-admin paths still say no.
  const CODE = "ERI";
  await claimKit.wipe(CODE);
  try {
    const A = await claimKit.founder(CODE, "Asmara Divers");
    const B = await claimKit.founder(CODE, "Massawa Divers");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const member = await approvalKit.member(orgId, "spectator", A.clubId);
    await fetchJson("POST", "/api/role-requests", { token: member.token, body: { role: "judge" } });
    const roleRequests = require("../lib/role-requests");
    const claims = require("../lib/claims");
    const rq = (await pool.query("SELECT * FROM role_requests WHERE user_id = $1", [member.id])).rows[0];
    assert.ok(rq, "the request exists");
    assert.equal(await roleRequests.delegateCanReview(pool, A.id, rq), true);
    const settings = await require("../lib/platform-settings").getAll(pool);
    const voters = await claims.eligibleClubs(pool, { orgId, regionId: null, claimantId: null, claimantEmail: "x@elsewhere.example.org", settings });
    assert.deepEqual(voters.ids.sort(), [A.clubId, B.clubId].sort());

    await pool.query("UPDATE clubs SET status = 'pending' WHERE id = $1", [A.clubId]);
    assert.equal(await roleRequests.delegateCanReview(pool, A.id, rq), false);
    assert.ok(!(await roleRequests.listForDelegate(pool, A.id)).some((r) => r.id === rq.id));
    assert.equal((await roleRequests.reviewersFor(pool, member.id, orgId, "judge")).via, "sysadmin");
    const after = await claims.eligibleClubs(pool, { orgId, regionId: null, claimantId: null, claimantEmail: "x@elsewhere.example.org", settings });
    assert.deepEqual(after.ids, [B.clubId], "a waiting club never counts as a claim voter");
    // Age runs from approval, not creation.
    await pool.query("UPDATE clubs SET approved_at = now() WHERE id = $1", [B.clubId]);
    const fresh = await claims.eligibleClubs(pool, { orgId, regionId: null, claimantId: null, claimantEmail: "x@elsewhere.example.org", settings });
    assert.deepEqual(fresh.ids, []);
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("club approval: the federation approves, fixing details and making the founder admin", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "GNQ";
  await claimKit.wipe(CODE);
  const other = await setupFixture({ withEvent: false });
  try {
    const fx = await approvalKit.federation(CODE);
    const region = async (name, code, orgId = fx.orgId) => (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, name, code],
    )).rows[0].id;
    const bioko = await region("Bioko Norte", "BN");
    const litoral = await region("Litoral", "LI");
    const elsewhere = await region("Elsewhere", "EL", other.orgId);
    await pool.query("INSERT INTO clubs (org_id, name, short_code) VALUES ($1, 'Bata Divers', 'BAT')", [fx.orgId]);
    const A = await approvalKit.signUp(CODE, "malabo divers", { region_code: "BN", new_club_short_code: "mal" }, { verify: true });

    // Only this federation's admins (or DivingHQ) decide.
    const mm = await approvalKit.member(fx.orgId, "meet_manager");
    const founder = await claimKit.login(A.username);
    for (const token of [other.adminToken, mm.token, founder.token]) {
      const r = await fetchJson("POST", `/api/clubs/${A.clubId}/approve`, { token, body: {} });
      assert.equal(r.status, 403, JSON.stringify(r.body));
    }
    assert.equal((await fetchJson("POST", "/api/clubs/not-a-uuid/approve", { token: fx.adminToken, body: {} })).status, 404);

    // Edits are checked before anything changes.
    const tries = [
      [{ short_code: "WAY-TOO-LONG" }, 400],
      [{ short_code: "bat" }, 409],
      [{ region_id: elsewhere }, 400],
      [{ region_id: "nope" }, 400],
      [{ name: "   " }, 400],
    ];
    for (const [body, status] of tries) {
      const r = await fetchJson("POST", `/api/clubs/${A.clubId}/approve`, { token: fx.adminToken, body });
      assert.equal(r.status, status, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await approvalKit.club(A.clubId)).status, "pending");

    const ok = await fetchJson("POST", `/api/clubs/${A.clubId}/approve`, {
      token: fx.adminToken,
      body: { name: "Malabo Divers", short_code: "mlb", region_id: litoral },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.founder_admin, true, "ticked by default");
    const row = await approvalKit.club(A.clubId);
    assert.equal(row.status, "active");
    assert.ok(row.approved_at);
    assert.deepEqual([row.name, row.short_code, row.region_id], ["Malabo Divers", "MLB", litoral]);
    assert.equal(await approvalKit.isAdmin(A.clubId, A.id), true);
    const audit = (await pool.query(
      "SELECT actor_id, metadata FROM audit_log WHERE entity_id = $1 AND action = 'club.approved'", [A.clubId],
    )).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, fx.adminId);
    assert.deepEqual(audit[0].metadata.edits, {
      name: { from: "malabo divers", to: "Malabo Divers" },
      // Signup upper-cases the code now, even for a club that waits.
      short_code: { from: "MAL", to: "MLB" },
      region_id: { from: bioko, to: litoral },
    });
    assert.equal(audit[0].metadata.founder_admin, true);
    const told = await approvalKit.notices(A.id, "club_decision");
    assert.equal(told.length, 1);
    assert.match(told[0].title, /approved Malabo Divers/);
    assert.equal(told[0].action_url, "/club");

    // Decided is decided.
    const again = await fetchJson("POST", `/api/clubs/${A.clubId}/approve`, { token: fx.adminToken, body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "club_not_pending");

    // The founder's session catches up without signing in again.
    const me = (await fetchJson("GET", "/api/auth/me", { token: founder.token })).body.user;
    assert.equal(me.pending_club, null);
    assert.deepEqual(me.club_admin_of.map((c) => c.id), [A.clubId]);
    assert.ok((await fetchJson("GET", `/api/orgs/${fx.orgId}/clubs`)).body.some((c) => c.id === A.clubId));

    // Two admins deciding at once: one wins, the other is told.
    const second = await approvalKit.member(fx.orgId, "org_admin");
    const B = await approvalKit.signUp(CODE, "Luba Divers", { region_code: "BN" }, { verify: true });
    const race = await Promise.all([
      fetchJson("POST", `/api/clubs/${B.clubId}/approve`, { token: fx.adminToken, body: {} }),
      fetchJson("POST", `/api/clubs/${B.clubId}/reject`, { token: second.token, body: {} }),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409], JSON.stringify(race.map((r) => r.body)));
    const decided = (await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action IN ('club.approved', 'club.rejected')", [B.clubId],
    )).rows[0].n;
    assert.equal(decided, 1);

    // Without the box ticked, the federation keeps the admin seat to itself,
    // and the founder is told so, by email too.
    const C = await approvalKit.signUp(CODE, "Ebebiyin Divers", { region_code: "BN" }, { verify: true });
    const box = approvalKit.inbox();
    const out = await clubApprovals.approve(pool, {
      clubId: C.clubId, user: await claimActor(fx.adminId), makeFounderAdmin: false,
    }, box.deps);
    assert.equal(out.founder_admin, false);
    assert.equal(await approvalKit.isAdmin(C.clubId, C.id), false);
    assert.deepEqual(box.mail[0].userIds, [C.id]);
    assert.match(box.mail[0].subject, /Ebebiyin Divers is on DivingHQ/);
    assert.match(box.mail[0].body, /appoints club admins/);
    assert.equal(box.mail[0].path, "/dashboard");
    assert.equal((await fetchJson("GET", "/api/dashboard", { token: fx.adminToken })).body.clubs_pending, 0);
  } finally {
    await claimKit.wipe(CODE);
    await teardownFixture(other);
  }
});

test("club approval: rejecting deletes the club and can move its founder into an existing one", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "MCO";
  await claimKit.wipe(CODE);
  const other = await setupFixture({ withEvent: false });
  try {
    const fx = await approvalKit.federation(CODE);
    const real = (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, 'Monaco Diving Club', 'MDC') RETURNING id", [fx.orgId],
    )).rows[0].id;
    const foreign = (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, 'Somewhere Else') RETURNING id", [other.orgId],
    )).rows[0].id;
    const A = await approvalKit.signUp(CODE, "Monaco DC", {}, { verify: true });
    const B = await approvalKit.signUp(CODE, "Monte Carlo Divers", {}, { verify: true });

    // Only somewhere real to move them to: an approved club in the same org.
    for (const target of [B.clubId, foreign, "not-a-club"]) {
      const r = await fetchJson("POST", `/api/clubs/${A.clubId}/reject`, { token: fx.adminToken, body: { move_members_to: target } });
      assert.equal(r.status, 400, `${target}: ${JSON.stringify(r.body)}`);
    }

    const box = approvalKit.inbox();
    const out = await clubApprovals.reject(pool, {
      clubId: A.clubId, user: await claimActor(fx.adminId), reason: "  You're already with Monaco Diving Club.  ", moveMembersTo: real,
    }, box.deps);
    assert.deepEqual(out, { id: A.clubId, moved_to: real, members: 1 });
    assert.equal(await approvalKit.club(A.clubId), undefined, "the club is gone");
    assert.equal((await pool.query("SELECT club_id FROM users WHERE id = $1", [A.id])).rows[0].club_id, real);
    const audit = (await pool.query(
      "SELECT metadata, note FROM audit_log WHERE entity_id = $1 AND action = 'club.rejected'", [A.clubId],
    )).rows[0];
    assert.deepEqual(audit.metadata, {
      name: "Monaco DC", short_code: null, founder_id: A.id,
      reason: "You're already with Monaco Diving Club.", moved_to: real, members: 1,
    });
    assert.deepEqual(box.mail[0].userIds, [A.id]);
    assert.match(box.mail[0].body, /The reason they gave: You're already with Monaco Diving Club\./);
    assert.match(box.mail[0].body, /We've put you in Monaco Diving Club/);
    assert.equal(box.inApp[0].category, "club_decision");

    // Without a move the founder keeps their account, with no club.
    const r = await fetchJson("POST", `/api/clubs/${B.clubId}/reject`, { token: fx.adminToken, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = (await pool.query("SELECT club_id, deleted_at FROM users WHERE id = $1", [B.id])).rows[0];
    assert.deepEqual(b, { club_id: null, deleted_at: null });
    const login = await claimKit.login(B.username);
    assert.ok(login.token, "still signs in");
    assert.equal(login.pending_club, null);
    const told = await approvalKit.notices(B.id, "club_decision");
    assert.match(told[0].title, /didn't approve Monte Carlo Divers/);
    // Nothing left to decide, and the federation is told that rather than
    // "not found". Another org's admin still just gets not found.
    const redo = await fetchJson("POST", `/api/clubs/${B.clubId}/reject`, { token: fx.adminToken, body: {} });
    assert.equal(redo.status, 409, JSON.stringify(redo.body));
    assert.equal(redo.body.code, "club_not_pending");
    assert.equal((await fetchJson("POST", `/api/clubs/${B.clubId}/approve`, { token: fx.adminToken, body: {} })).status, 409);
    assert.equal((await fetchJson("POST", `/api/clubs/${B.clubId}/approve`, { token: other.adminToken, body: {} })).status, 404);
  } finally {
    await claimKit.wipe(CODE);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [other.orgId]).catch(() => {});
    await teardownFixture(other);
  }
});

test("club approval: a federation can let new clubs join automatically", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "SWZ";
  const LOOSE = "LSO";
  await claimKit.wipe(CODE);
  await claimKit.wipe(LOOSE);
  const other = await setupFixture({ withEvent: false });
  try {
    const fx = await approvalKit.federation(CODE);
    const waiting = await approvalKit.signUp(CODE, "Mbabane Divers", {}, { verify: true });
    const path = `/api/orgs/${fx.orgId}/club-settings`;
    assert.deepEqual((await fetchJson("GET", path, { token: fx.adminToken })).body,
      { auto_approve_clubs: false, claim_state: "claimed" });

    const mm = await approvalKit.member(fx.orgId, "meet_manager");
    assert.equal((await fetchJson("PUT", path, { token: mm.token, body: { auto_approve_clubs: true } })).status, 403);
    assert.equal((await fetchJson("PUT", path, { token: other.adminToken, body: { auto_approve_clubs: true } })).status, 403);
    assert.equal((await fetchJson("GET", path, { token: other.adminToken })).status, 403);
    assert.equal((await fetchJson("PUT", path, { token: fx.adminToken, body: { auto_approve_clubs: "yes" } })).status, 400);
    const on = await fetchJson("PUT", path, { token: fx.adminToken, body: { auto_approve_clubs: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.auto_approve_clubs, true);
    const audit = (await pool.query(
      "SELECT actor_id, metadata FROM audit_log WHERE entity_id = $1 AND action = 'org.club_settings_changed'", [fx.orgId],
    )).rows;
    assert.deepEqual(audit, [{ actor_id: fx.adminId, metadata: { auto_approve_clubs: { from: false, to: true } } }]);
    assert.equal((await fetchJson("GET", `/api/orgs/by-country/${CODE}`)).body[0].auto_approve_clubs, true);
    // Switching it on doesn't wave through the ones already waiting.
    assert.equal((await approvalKit.club(waiting.clubId)).status, "pending");

    const A = await approvalKit.signUp(CODE, "Manzini Divers");
    assert.equal(A.res.club_status, "active");
    const row = await approvalKit.club(A.clubId);
    assert.equal(row.status, "active");
    assert.equal(row.approved_at, null, "it never waited");
    assert.equal(await approvalKit.isAdmin(A.clubId, A.id), false, "the federation still appoints admins");
    assert.ok((await fetchJson("GET", `/api/orgs/${fx.orgId}/clubs`)).body.some((c) => c.id === A.clubId));
    // The heads-up is fire-and-forget, so give it a moment.
    let heads = [];
    for (let i = 0; i < 20 && !heads.length; i++) {
      heads = (await approvalKit.notices(fx.adminId, "club_created")).filter((n) => n.data?.club_id === A.clubId);
      if (!heads.length) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(heads.length, 1);
    assert.match(heads[0].title, /New club joined: Manzini Divers/);

    // The sysadmin can change it too, and turn it back off.
    const sys = await claimKit.login("admin", "admin");
    if (sys?.token) {
      const off = await fetchJson("PUT", path, { token: sys.token, body: { auto_approve_clubs: false } });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.equal((await approvalKit.signUp(CODE, "Siteki Divers")).res.club_status, "pending");

      // In a country the clubs started nobody approves anything, so the
      // setting isn't there to change.
      const founder = await claimKit.founder(LOOSE, "Maseru Divers");
      const looseOrg = (await pool.query("SELECT org_id FROM users WHERE id = $1", [founder.id])).rows[0].org_id;
      const r = await fetchJson("PUT", `/api/orgs/${looseOrg}/club-settings`, { token: sys.token, body: { auto_approve_clubs: true } });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, "org_unclaimed");
    }
  } finally {
    await claimKit.wipe(CODE);
    await claimKit.wipe(LOOSE);
    await teardownFixture(other);
  }
});

test("club approval: unclaimed countries are unchanged, and a revoked claim lets waiting clubs in", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "TKM";
  await claimKit.wipe(CODE);
  try {
    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
    // No federation: the club is live and the founder runs it, as before.
    const A = await approvalKit.signUp(CODE, "Ashgabat Divers");
    assert.equal(A.res.club_status, "active");
    assert.equal((await approvalKit.club(A.clubId)).status, "active");
    assert.equal(await approvalKit.isAdmin(A.clubId, A.id), true);
    await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [A.id]);
    const B = await claimKit.founder(CODE, "Mary Divers");
    for (const clubId of [A.clubId, B.clubId]) await claimKit.makeEligible(clubId);
    const Atoken = (await claimKit.login(A.username)).token;

    // A federation claims the country and the clubs vote it in.
    const fed = await claimKit.claim({ org_name: "Turkmen Aquatics", country_code: CODE });
    await claimKit.verify(fed.id);
    const claimId = fed.res.body.claim_id;
    for (const token of [Atoken, B.token]) {
      await fetchJson("POST", `/api/claims/${claimId}/vote`, { token, body: { vote: "approve" } });
    }
    assert.equal((await claimStatus(claimId)).status, "approved");
    const fedToken = (await claimKit.login(fed.username)).token;

    // Now new clubs wait. One gets approved with its founder as admin,
    // one is still waiting when DivingHQ revokes the claim.
    const P = await approvalKit.signUp(CODE, "Balkanabat Divers", {}, { verify: true });
    const Q = await approvalKit.signUp(CODE, "Dashoguz Divers", {}, { verify: true });
    assert.equal(P.res.club_status, "pending");
    assert.equal((await fetchJson("POST", `/api/clubs/${Q.clubId}/approve`, { token: fedToken, body: {} })).status, 200);
    assert.equal(await approvalKit.isAdmin(Q.clubId, Q.id), true);
    // The federation lets new clubs straight in from here on.
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const flip = await fetchJson("PUT", `/api/orgs/${orgId}/club-settings`, { token: fedToken, body: { auto_approve_clubs: true } });
    assert.equal(flip.status, 200, JSON.stringify(flip.body));

    const rv = await fetchJson("POST", `/api/claims/${claimId}/revoke`, { token: sys.token, body: { reason: "Test" } });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.deepEqual(rv.body.activated_clubs, [{ id: P.clubId, name: "Balkanabat Divers" }]);
    const p = await approvalKit.club(P.clubId);
    assert.equal(p.status, "active");
    assert.ok(p.approved_at);
    assert.equal(await approvalKit.isAdmin(P.clubId, P.id), true, "a founder runs their club where there's no federation");
    // A founder the federation made admin of their own club keeps it too:
    // in an unclaimed country they'd have had it from the start.
    assert.equal(await approvalKit.isAdmin(Q.clubId, Q.id), true);
    const told = await approvalKit.notices(P.id, "club_decision");
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.match(told[0].title, /Balkanabat Divers is active/);
    const audit = (await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'claim.revoked'", [claimId],
    )).rows[0].metadata;
    assert.deepEqual(audit.activated_clubs, [P.clubId]);
    // Its "join automatically" goes with it, so the next claimant starts
    // with the queue their approval email describes.
    assert.equal((await pool.query("SELECT auto_approve_clubs FROM organisations WHERE id = $1", [orgId])).rows[0].auto_approve_clubs, false);
    assert.equal(audit.auto_approve_clubs_reset, true);
    const act = (await pool.query(
      "SELECT actor_id, metadata FROM audit_log WHERE entity_id = $1 AND action = 'club.approved'", [P.clubId],
    )).rows[0];
    assert.equal(act.metadata.via, "claim_revoked");
    // And new clubs join straight away again.
    assert.equal((await approvalKit.signUp(CODE, "Turkmenbashi Divers")).res.club_status, "active");
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("club approval: whoever loses a race to decide is told it's decided, whichever way it went", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  // The earlier race test fires both at once and takes whatever order the
  // server picks. Here the order is pinned: something else holds the row,
  // the first decision queues on it, then the second, then it's let go.
  // A reject deletes the row, so the one queued behind it used to come
  // back 404 instead of 409.
  const CODE = "GNB";
  await claimKit.wipe(CODE);
  try {
    const fx = await approvalKit.federation(CODE);
    const second = await approvalKit.member(fx.orgId, "org_admin");
    const waiting = async (n) => {
      for (let i = 0; i < 100; i++) {
        const r = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%FOR UPDATE OF c%'`,
        );
        if (r.rows[0].n >= n) return;
        await new Promise((res) => setTimeout(res, 20));
      }
      throw new Error(`never saw ${n} decisions queued on the lock`);
    };
    const race = async (clubId, first, then) => {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM clubs WHERE id = $1 FOR UPDATE", [clubId]);
        const a = fetchJson("POST", `/api/clubs/${clubId}/${first}`, { token: fx.adminToken, body: {} });
        await waiting(1);
        const b = fetchJson("POST", `/api/clubs/${clubId}/${then}`, { token: second.token, body: {} });
        await waiting(2);
        await holder.query("ROLLBACK");
        return [await a, await b];
      } finally {
        holder.release();
      }
    };

    const A = await approvalKit.signUp(CODE, "Bissau Divers", {}, { verify: true });
    const [rejected, lateApprove] = await race(A.clubId, "reject", "approve");
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(lateApprove.status, 409, JSON.stringify(lateApprove.body));
    assert.equal(lateApprove.body.code, "club_not_pending");
    assert.equal(await approvalKit.club(A.clubId), undefined);

    const B = await approvalKit.signUp(CODE, "Bafata Divers", {}, { verify: true });
    const [approved, lateReject] = await race(B.clubId, "approve", "reject");
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(lateReject.status, 409, JSON.stringify(lateReject.body));
    assert.equal((await approvalKit.club(B.clubId)).status, "active", "the late reject didn't delete it");
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("club approval: a waiting club's code doesn't block an approved club from taking it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  // Approve ignores other waiting clubs' codes; club setup has to agree,
  // or an unvetted signup could squat on a code a real club wants.
  const CODE = "TCD";
  await claimKit.wipe(CODE);
  try {
    const fx = await approvalKit.federation(CODE);
    const real = (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, 'Club de Plongeon de N''Djamena', 'NDJ') RETURNING id",
      [fx.orgId],
    )).rows[0].id;
    const P = await approvalKit.signUp(CODE, "Chari Divers", { new_club_short_code: "chr" }, { verify: true });

    const set = await fetchJson("PUT", `/api/clubs/${real}/short-code`, { token: fx.adminToken, body: { short_code: "CHR" } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.short_code, "CHR");

    // Now it's the waiting club that has to pick something else.
    const clash = await fetchJson("POST", `/api/clubs/${P.clubId}/approve`, { token: fx.adminToken, body: {} });
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal(clash.body.code, "short_code_taken");
    const ok = await fetchJson("POST", `/api/clubs/${P.clubId}/approve`, { token: fx.adminToken, body: { short_code: "CHA" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // And an approved club's code still can't be taken twice.
    const taken = await fetchJson("PUT", `/api/clubs/${real}/short-code`, { token: fx.adminToken, body: { short_code: "cha" } });
    assert.equal(taken.status, 409, JSON.stringify(taken.body));
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("club approval: a revoke activates waiting clubs but doesn't make a suspended founder admin", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "BDI";
  await claimKit.wipe(CODE);
  try {
    const fx = await approvalKit.federation(CODE);
    const P = await approvalKit.signUp(CODE, "Bujumbura Divers", {}, { verify: true });
    const Q = await approvalKit.signUp(CODE, "Gitega Divers", {}, { verify: true });
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [P.id]);

    const client = await pool.connect();
    let out;
    try {
      await client.query("BEGIN");
      out = await clubApprovals.activateAllPending(client, fx.orgId, { actorId: fx.adminId });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    assert.deepEqual(out.clubs.map((c) => c.id).sort(), [P.clubId, Q.clubId].sort());
    assert.equal((await approvalKit.club(P.clubId)).status, "active");
    assert.equal(await approvalKit.isAdmin(P.clubId, P.id), false, "suspended, so no admin seat");
    assert.equal(await approvalKit.isAdmin(Q.clubId, Q.id), true);
    const audit = (await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'club.approved'", [P.clubId],
    )).rows[0].metadata;
    assert.equal(audit.founder_admin, false);
  } finally {
    await claimKit.wipe(CODE);
  }
});

// My club and My region grey out Remove on the last live admin before
// anyone clicks it, so the admins lists have to say who's live and whether
// the caller is held to the rule at all. Monaco, nothing else here uses it.
test("admin lists say who's live and whether the caller has to keep one", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "MCO";
  await claimKit.wipe(CODE);
  const state = await setupFixture({ withEvent: false });
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Monte Carlo Divers" });
    const club = A.clubId;
    const clubList = async (token = A.token) => {
      const r = await fetchJson("GET", `/api/clubs/${club}/admins`, { token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    let list = await clubList();
    assert.equal(list.keep_one_live, true, "a club admin can't leave the club with nobody");
    assert.deepEqual(list.admins.map((a) => [a.id, a.live]), [[A.id, true]]);

    // A suspended co-admin stays on the list, so it can be cleared out, but
    // it isn't live, and the server agrees with what the page will show.
    const S = await delegateSignUp({ country_code: CODE, club_id: club, full_name: "Suspended Co-admin" });
    assert.equal((await fetchJson("POST", `/api/clubs/${club}/admins`, { token: A.token, body: { user_id: S.id } })).status, 201);
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [S.id]);
    list = await clubList();
    assert.deepEqual(Object.fromEntries(list.admins.map((a) => [a.id, a.live])), { [A.id]: true, [S.id]: false });
    assert.equal((await fetchJson("DELETE", `/api/clubs/${club}/admins/${A.id}`, { token: A.token })).status, 409);

    // A second live admin frees them both up.
    const B = await delegateSignUp({ country_code: CODE, club_id: club });
    assert.equal((await fetchJson("POST", `/api/clubs/${club}/admins`, { token: A.token, body: { user_id: B.id } })).status, 201);
    list = await clubList();
    assert.equal(list.admins.filter((a) => a.live).length, 2);

    // Same fields on a region's list.
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Monaco-Ville', 'MV') RETURNING id", [A.orgId],
    )).rows[0].id;
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [region, club]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [region, A.id, A.orgId]);
    const rl = await fetchJson("GET", `/api/regions/${region}/admins`, { token: A.token });
    assert.equal(rl.status, 200, JSON.stringify(rl.body));
    assert.equal(rl.body.can_manage, true);
    assert.equal(rl.body.keep_one_live, true);
    assert.deepEqual(rl.body.admins.map((a) => [a.id, a.live]), [[A.id, true]]);
    assert.equal((await fetchJson("DELETE", `/api/regions/${region}/admins/${A.id}`, { token: A.token })).status, 409);

    // A federation's admin appoints club admins and can clear the list, so
    // they aren't held to it and their Remove stays live.
    const fedClub = (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, 'Federation Club') RETURNING id", [state.orgId],
    )).rows[0].id;
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [fedClub, state.adminId, state.orgId]);
    const fed = await fetchJson("GET", `/api/clubs/${fedClub}/admins`, { token: state.adminToken });
    assert.equal(fed.status, 200, JSON.stringify(fed.body));
    assert.equal(fed.body.keep_one_live, false);
    assert.deepEqual(fed.body.admins.map((a) => [a.id, a.live]), [[state.adminId, true]]);
  } finally {
    await pool.query(
      "DELETE FROM regions WHERE org_id IN (SELECT id FROM organisations WHERE country_code = $1)", [CODE],
    ).catch(() => {});
    await claimKit.wipe(CODE);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [state.orgId]).catch(() => {});
    await teardownFixture(state);
  }
});

// PUT /api/clubs/:id/short-code checks for a clash and then writes, so two
// clubs saving the same code at the same moment used to both get it. The
// per-org lock makes it one step: exactly one wins, whatever the timing.
// Bhutan, nothing else here uses it.
test("club short codes: clubs racing for the same code, only one gets it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "BTN";
  await claimKit.wipe(CODE);
  try {
    const founders = [];
    for (const name of ["Thimphu", "Paro", "Punakha", "Bumthang", "Haa"]) {
      founders.push(await claimKit.founder(CODE, `${name} Divers`));
    }
    const holders = async (code) => (await pool.query(
      `SELECT c.id FROM clubs c JOIN organisations o ON o.id = c.org_id
        WHERE o.country_code = $1 AND upper(c.short_code) = $2`, [CODE, code],
    )).rows.map((r) => r.id);

    // A few rounds, since it's a race. Each round every club asks for the
    // same fresh code at once.
    for (const want of ["THI", "PRO", "DZO"]) {
      const outs = await Promise.all(founders.map((f) =>
        fetchJson("PUT", `/api/clubs/${f.clubId}/short-code`, { token: f.token, body: { short_code: want.toLowerCase() } })));
      const statuses = outs.map((o) => o.status);
      assert.equal(statuses.filter((s) => s === 200).length, 1, `${want}: ${statuses.join(",")}`);
      assert.equal(statuses.filter((s) => s === 409).length, founders.length - 1, `${want}: ${statuses.join(",")}`);
      for (const o of outs.filter((x) => x.status === 409)) assert.equal(o.body.code, "short_code_taken");
      const winner = founders[statuses.indexOf(200)];
      assert.deepEqual(await holders(want), [winner.clubId]);
      // The winner lets it go again, so the next round starts clean.
      assert.equal((await fetchJson("PUT", `/api/clubs/${winner.clubId}/short-code`, { token: winner.token, body: { short_code: null } })).status, 200);
    }

    // Clearing codes at the same time never clashes, and the audit trail
    // says what each club actually had.
    await Promise.all(founders.map((f, i) =>
      fetchJson("PUT", `/api/clubs/${f.clubId}/short-code`, { token: f.token, body: { short_code: `B${i}` } })));
    const cleared = await Promise.all(founders.map((f) =>
      fetchJson("PUT", `/api/clubs/${f.clubId}/short-code`, { token: f.token, body: { short_code: "" } })));
    assert.deepEqual(cleared.map((o) => o.status), founders.map(() => 200));
    const last = await pool.query(
      `SELECT DISTINCT ON (entity_id) entity_id, metadata FROM audit_log
        WHERE entity_id = ANY($1::uuid[]) AND action = 'club.code_changed'
        ORDER BY entity_id, created_at DESC`,
      [founders.map((f) => f.clubId)],
    );
    const byClub = Object.fromEntries(last.rows.map((r) => [r.entity_id, r.metadata]));
    founders.forEach((f, i) => assert.deepEqual(byClub[f.clubId], { from: `B${i}`, to: null }));
  } finally {
    await claimKit.wipe(CODE);
  }
});

// robots.txt and sitemap.xml come out of public/ naming divinghq.app. A
// self-hosted copy sets APP_BASE_URL, and its crawler files have to name it
// too, the way the shell's canonical links already did. publicOrigin() reads
// the env per request, so flipping it here is enough.
test("robots.txt and sitemap.xml name APP_BASE_URL's origin when it's set", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const get = (p) => new Promise((resolve, reject) => {
    http.get(baseUrl + p, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
  const saved = process.env.APP_BASE_URL;
  try {
    process.env.APP_BASE_URL = "https://diving.example.org/some/path";
    const robots = await get("/robots.txt");
    assert.equal(robots.status, 200);
    assert.match(robots.type, /^text\/plain/);
    assert.match(robots.body, /^Sitemap: https:\/\/diving\.example\.org\/sitemap\.xml$/m);
    assert.match(robots.body, /^Disallow: \/api\/$/m);
    const sitemap = await get("/sitemap.xml");
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.type, /^application\/xml/);
    assert.match(sitemap.body, /<loc>https:\/\/diving\.example\.org\/guide\/quick-start<\/loc>/);
    assert.ok(!sitemap.body.includes("https://divinghq.app") && !robots.body.includes("https://divinghq.app"),
      "nothing left pointing at the hosted site");

    // Unset (or junk), the hosted site's files go out as written.
    delete process.env.APP_BASE_URL;
    assert.match((await get("/robots.txt")).body, /^Sitemap: https:\/\/divinghq\.app\/sitemap\.xml$/m);
    process.env.APP_BASE_URL = "not a url";
    assert.match((await get("/sitemap.xml")).body, /<loc>https:\/\/divinghq\.app\/privacy<\/loc>/);
  } finally {
    if (saved === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = saved;
  }
});

// ---------------------------------------------------------------------
// Release review fixes (track/review).
// ---------------------------------------------------------------------

// Referee runs any meet in the org, same as org_admin, so a revoked
// federation can't leave its referees behind. A sysadmin's grant and one
// made before the claim stay put.
test("claims: a national revoke also takes back referees the federation appointed", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "AFG";
  await claimKit.wipe(CODE);
  try {
    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
    const A = await claimKit.founder(CODE, "Kabul Divers");
    const B = await claimKit.founder(CODE, "Herat Divers");
    const C = await claimKit.founder(CODE, "Mazar Divers");
    const D = await claimKit.founder(CODE, "Kandahar Divers");
    for (const x of [A, B]) await claimKit.makeEligible(x.clubId);
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    // Before any claim: DivingHQ made C a referee, and D has an old grant.
    await pool.query(
      "INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1, $2, 'referee', $3)",
      [C.id, orgId, sys.id],
    );
    await pool.query(
      "INSERT INTO user_org_roles (user_id, org_id, role, granted_at) VALUES ($1, $2, 'referee', now() - interval '30 days')",
      [D.id, orgId],
    );

    const fed = await claimKit.claim({ org_name: "Afghan Diving Federation", country_code: CODE });
    assert.equal(fed.res.body.approver, "clubs");
    await claimKit.verify(fed.id);
    const id = fed.res.body.claim_id;
    for (const x of [A, B]) await fetchJson("POST", `/api/claims/${id}/vote`, { token: x.token, body: { vote: "approve" } });
    assert.equal((await claimStatus(id)).status, "approved");

    // Running the country, it makes an accomplice and itself referees.
    const fedToken = (await claimKit.login(fed.username)).token;
    const put = async (userId, roles) => (await fetchJson("PUT", `/api/users/${userId}/roles`, { token: fedToken, body: { roles } })).status;
    assert.equal(await put(A.id, ["referee", "spectator"]), 200);
    assert.equal(await put(fed.id, ["org_admin", "referee"]), 200);
    const versionOf = async (u) => (await pool.query("SELECT token_version FROM users WHERE id = $1", [u])).rows[0].token_version;
    const aBefore = await versionOf(A.id);

    const rv = await fetchJson("POST", `/api/claims/${id}/revoke`, { token: sys.token, body: { reason: "Not the federation" } });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));

    const referees = (await pool.query(
      "SELECT user_id FROM user_org_roles WHERE org_id = $1 AND role = 'referee'", [orgId],
    )).rows.map((r) => r.user_id).sort();
    assert.deepEqual(referees, [C.id, D.id].sort(), "only the sysadmin's and the pre-claim referee are left");
    const pairs = rv.body.removed.org_roles.map((r) => `${r.user_id}:${r.role}`).sort();
    assert.ok(pairs.includes(`${A.id}:referee`), JSON.stringify(pairs));
    assert.ok(pairs.includes(`${fed.id}:referee`), JSON.stringify(pairs));
    assert.ok(!pairs.includes(`${C.id}:referee`) && !pairs.includes(`${D.id}:referee`));
    const audit = (await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'claim.revoked'", [id],
    )).rows[0].metadata;
    assert.ok(audit.removed.org_roles.some((r) => r.user_id === A.id && r.role === "referee"));
    // The JWT carries org_roles, so A has to sign in again to lose it.
    assert.ok((await versionOf(A.id)) > aBefore, "token_version bumped");
    assert.ok((await pool.query("SELECT 1 FROM user_org_roles WHERE user_id = $1 AND org_id = $2", [A.id, orgId])).rows.length);
  } finally {
    await claimKit.wipe(CODE);
  }
});

// A region re-claimed after its admins have all gone: the new claim
// retires the old one, and the old one can't be revoked out from under it.
test("claims: re-claiming an orphaned region retires the old claim and its dead admin rows", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "ALB";
  await claimKit.wipe(CODE);
  try {
    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no seeded sysadmin (admin/admin) in this DB");
    const A = await claimKit.founder(CODE, "Tirana Divers");
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [A.id])).rows[0].org_id;
    const tr = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Tirana', 'TR') RETURNING id", [orgId],
    )).rows[0].id;
    const approve = async (who) => {
      await claimKit.verify(who.id);
      const r = await fetchJson("POST", `/api/claims/${who.res.body.claim_id}/decide`, { token: sys.token, body: { decision: "approve" } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    const first = await claimKit.claim({ org_name: "Tirana Diving", country_code: CODE, region_code: "TR" });
    assert.equal(first.res.status, 201, JSON.stringify(first.res.body));
    await approve(first);
    // Its only admin is suspended, so the region is open to a new body.
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [first.id]);
    const second = await claimKit.claim({ org_name: "Tirana Diving Two", country_code: CODE, region_code: "TR" });
    assert.equal(second.res.status, 201, JSON.stringify(second.res.body));
    await approve(second);

    const old = await claimStatus(first.res.body.claim_id);
    assert.equal(old.status, "revoked");
    assert.match(old.status_reason, /newer approved claim/);
    assert.equal((await claimStatus(second.res.body.claim_id)).status, "approved");
    const admins = (await pool.query("SELECT user_id FROM region_admins WHERE region_id = $1", [tr])).rows.map((r) => r.user_id);
    assert.deepEqual(admins, [second.id], "the suspended claimant's row is gone, the new one's stays");
    // Nothing left for a revoke of the old claim to unwind.
    assert.equal((await fetchJson("POST", `/api/claims/${first.res.body.claim_id}/revoke`, { token: sys.token, body: {} })).status, 409);

    // Rows from before this fix can still have two approved claims. The
    // older one is refused rather than stripping the current state body.
    await pool.query("UPDATE claims SET status = 'approved', decided_at = now() - interval '1 day' WHERE id = $1", [first.res.body.claim_id]);
    const legacy = await fetchJson("POST", `/api/claims/${first.res.body.claim_id}/revoke`, { token: sys.token, body: {} });
    assert.equal(legacy.status, 409, JSON.stringify(legacy.body));
    assert.equal(legacy.body.code, "claim_superseded");
    assert.equal((await pool.query("SELECT claim_state FROM regions WHERE id = $1", [tr])).rows[0].claim_state, "claimed");
    assert.ok((await pool.query("SELECT 1 FROM region_admins WHERE region_id = $1 AND user_id = $2", [tr, second.id])).rows.length);
  } finally {
    await claimKit.wipe(CODE);
  }
});

// A club admin who transfers to another federation leaves their seats in
// the old one behind: club, region and event manager. A row stranded by an
// older transfer doesn't count either.
test("org transfer: the mover's admin seats in the old federation go with the move", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const X = await setupFixture({ withEvent: true });
  const Y = await setupFixture({ withEvent: false });
  try {
    const club = (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, 'Old Town Divers') RETURNING id", [X.orgId],
    )).rows[0].id;
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Old Shire', 'OSH') RETURNING id", [X.orgId],
    )).rows[0].id;
    const mover = await insertUser({ orgId: X.orgId, username: `int-mv-${X.slug}`, fullName: "Mover Person", role: "diver" });
    const stayer = await insertUser({ orgId: X.orgId, username: `int-st-${X.slug}`, fullName: "Stayer Person", role: "diver" });
    for (const u of [mover, stayer]) {
      await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [club, u, X.orgId]);
    }
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [region, mover, X.orgId]);
    const meet = (await pool.query(
      "INSERT INTO meets (org_id, name, host_club_id) VALUES ($1, 'Club night', $2) RETURNING id", [X.orgId, club],
    )).rows[0].id;
    await pool.query("UPDATE events SET meet_id = $2 WHERE id = $1", [X.eventId, meet]);
    const other = (await fetchJson("POST", "/api/events", {
      token: X.adminToken,
      body: { name: `Other ${X.slug}`, gender: "Mixed", height: "1m", number_of_judges: 5, total_rounds: 6, event_type: "individual" },
    })).body.id;
    await pool.query("INSERT INTO event_managers (event_id, user_id) VALUES ($1, $2)", [other, mover]);

    const signIn = async () => (await fetchJson("POST", "/api/auth/login", {
      body: { username: `int-mv-${X.slug}`, password: "not-used-here" },
    })).body.token;
    let token = await signIn();
    assert.equal((await fetchJson("GET", `/api/events/${X.eventId}/score-audit`, { token })).status, 200);
    const tv = async () => (await pool.query("SELECT token_version FROM users WHERE id = $1", [mover])).rows[0].token_version;
    const before = await tv();

    const ask = await fetchJson("POST", "/api/club-change-requests", { token, body: { to_org_id: Y.orgId } });
    assert.equal(ask.status, 201, JSON.stringify(ask.body));
    assert.equal(ask.body.kind, "org_transfer");
    const review = (tok) => fetchJson("POST", `/api/club-change-requests/${ask.body.id}/review`, { token: tok, body: { decision: "approved" } });
    assert.equal((await review(X.adminToken)).body.status, "pending");
    assert.equal((await review(Y.adminToken)).body.status, "approved");

    const count = async (sql) => (await pool.query(sql, [mover])).rows[0].n;
    assert.equal(await count("SELECT count(*)::int AS n FROM club_admins WHERE user_id = $1"), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM region_admins WHERE user_id = $1"), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM event_managers WHERE user_id = $1"), 0);
    assert.ok((await pool.query("SELECT 1 FROM club_admins WHERE club_id = $1 AND user_id = $2", [club, stayer])).rows.length);
    assert.ok((await tv()) > before, "the old token, carrying org X, is dead");
    // The co-admin hears about it; the region had nobody else, so X's admin does.
    const titles = async (u) => (await pool.query("SELECT title FROM notifications WHERE user_id = $1", [u])).rows.map((r) => r.title);
    assert.ok((await titles(stayer)).includes("Old Town Divers has one admin fewer"));
    assert.ok((await titles(X.adminId)).includes("Old Shire has no admin now"));
    const audit = (await pool.query(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'user.org_transferred'", [mover],
    )).rows[0].metadata;
    assert.deepEqual(audit.removed.club_admins, [club]);

    token = await signIn();
    assert.equal((await fetchJson("GET", `/api/events/${X.eventId}/score-audit`, { token })).status, 403);
    // A row an earlier transfer stranded doesn't bring the access back.
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [club, mover, X.orgId]);
    assert.equal((await fetchJson("GET", `/api/events/${X.eventId}/score-audit`, { token })).status, 403);
  } finally {
    await pool.query("DELETE FROM club_change_requests WHERE from_org_id = $1 OR to_org_id = $1", [X.orgId]).catch(() => {});
    await pool.query("DELETE FROM meets WHERE org_id = $1", [X.orgId]).catch(() => {});
    // The mover lives in Y now; move them back so X's teardown takes them.
    await pool.query("UPDATE users SET org_id = $1 WHERE username = $2", [X.orgId, `int-mv-${X.slug}`]).catch(() => {});
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [X.orgId]).catch(() => {});
    await teardownFixture(Y);
    await teardownFixture(X);
  }
});

// clubs.name runs to 255 characters and notifications.title to 160. The
// "has no admin now" notice used to go in uncut, from inside the
// transfer's transaction, and one failed insert there aborted the whole
// thing: the reviewer was told it went through and nothing had moved.
test("org transfer: a long club name can't sink the move with its notice", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const X = await setupFixture({ withEvent: false });
  const Y = await setupFixture({ withEvent: false });
  const longName = `Long Name Divers ${"of the Far Northern Coast ".repeat(9)}`.trim();
  assert.ok(longName.length > 160 && longName.length <= 255);
  try {
    const club = (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, $2) RETURNING id", [X.orgId, longName],
    )).rows[0].id;
    const mover = await insertUser({ orgId: X.orgId, username: `int-lm-${X.slug}`, fullName: "Long Mover", role: "diver" });
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [club, mover, X.orgId]);
    const token = (await fetchJson("POST", "/api/auth/login", {
      body: { username: `int-lm-${X.slug}`, password: "not-used-here" },
    })).body.token;

    const ask = await fetchJson("POST", "/api/club-change-requests", { token, body: { to_org_id: Y.orgId } });
    assert.equal(ask.status, 201, JSON.stringify(ask.body));
    const review = (tok) => fetchJson("POST", `/api/club-change-requests/${ask.body.id}/review`, { token: tok, body: { decision: "approved" } });
    assert.equal((await review(X.adminToken)).body.status, "pending");
    const done = await review(Y.adminToken);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, "approved");

    // The move committed, not just the response...
    assert.equal((await pool.query("SELECT org_id FROM users WHERE id = $1", [mover])).rows[0].org_id, Y.orgId);
    assert.equal((await pool.query(
      "SELECT status FROM club_change_requests WHERE id = $1", [ask.body.id],
    )).rows[0].status, "approved");
    assert.equal((await pool.query("SELECT 1 FROM club_admins WHERE user_id = $1", [mover])).rows.length, 0);
    // ...and X's admin still hears the club has nobody left, cut to fit.
    const notes = (await pool.query(
      "SELECT title FROM notifications WHERE user_id = $1 AND data->>'club_id' = $2", [X.adminId, club],
    )).rows;
    assert.equal(notes.length, 1);
    assert.ok(Array.from(notes[0].title).length <= 160);
    assert.ok(notes[0].title.startsWith("Long Name Divers of the Far Northern Coast"));
  } finally {
    await pool.query("DELETE FROM club_change_requests WHERE from_org_id = $1 OR to_org_id = $1", [X.orgId]).catch(() => {});
    await pool.query("UPDATE users SET org_id = $1 WHERE username = $2", [X.orgId, `int-lm-${X.slug}`]).catch(() => {});
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [X.orgId]).catch(() => {});
    await teardownFixture(Y);
    await teardownFixture(X);
  }
});

// lib/admin-rows.js recipient lookups, shared by region requests, club
// join requests, the transfer notices, club approvals and claims. Live
// means not deleted and not suspended; sysadminIds has no filter at all.
test("admin-rows: live admin lookups skip deleted and suspended accounts", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const adminRows = require("../lib/admin-rows");
  const X = await setupFixture({ withEvent: false });
  try {
    const club = (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, 'Lookup Divers') RETURNING id", [X.orgId],
    )).rows[0].id;
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Lookup Shire', 'LKS') RETURNING id", [X.orgId],
    )).rows[0].id;
    const mk = (tag) => insertUser({ orgId: X.orgId, username: `int-lk-${tag}-${X.slug}`, fullName: tag, role: "diver" });
    const [live, other, suspended, gone] = [await mk("live"), await mk("other"), await mk("susp"), await mk("gone")];
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [suspended]);
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [gone]);
    for (const u of [live, other, suspended, gone]) {
      await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [club, u, X.orgId]);
      await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [region, u, X.orgId]);
      await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'org_admin')", [u, X.orgId]);
    }
    const sorted = (ids) => [...ids].sort();
    assert.deepEqual(sorted(await adminRows.liveAdminIds(pool, "club", club)), sorted([live, other]));
    assert.deepEqual(await adminRows.liveAdminIds(pool, "region", region, { except: other }), [live]);
    assert.deepEqual(
      sorted(await adminRows.liveOrgAdminIds(pool, X.orgId)), sorted([X.adminId, live, other]),
      "the fixture's own org admin plus the two live ones",
    );
    const sys = await adminRows.sysadminIds(pool);
    const expected = (await pool.query("SELECT id FROM users WHERE is_system_admin = true")).rows.map((r) => r.id);
    assert.deepEqual(sorted(sys), sorted(expected));
    await assert.rejects(adminRows.liveAdminIds(pool, "meet", club), /unknown scope/);
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [X.orgId]).catch(() => {});
    await teardownFixture(X);
  }
});

// The fire-and-forget in-app heads-ups: a new federation (org_pending) and
// a new club where there's no federation (club_created) go to every
// sysadmin, and a decision on a federation (org_decision) to its admins.
test("heads-ups: new federations and clubs reach the sysadmins, decisions reach the federation", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const sysIds = (await pool.query("SELECT id FROM users WHERE is_system_admin = true")).rows.map((r) => r.id).sort();
  if (!sysIds.length) return t.skip("no sysadmin in this DB");
  // Nothing awaits these, so give them a moment to land. lib/push writes
  // one row per recipient, in turn, so with more than one sysadmin the
  // first poll can catch it halfway. Wait for the whole audience.
  const waitFor = async (sql, params, want = 1) => {
    let rows = [];
    for (let i = 0; i < 60; i++) {
      rows = (await pool.query(sql, params)).rows;
      if (rows.length >= want) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
    return rows;
  };
  const CODE = "NCL";
  await claimKit.wipe(CODE);
  const X = await setupFixture({ withEvent: false });
  try {
    const pending = await waitFor(
      "SELECT user_id, title, action_url FROM notifications WHERE category = 'org_pending' AND data->>'org_id' = $1", [X.orgId],
      sysIds.length,
    );
    assert.deepEqual(pending.map((n) => n.user_id).sort(), sysIds);
    assert.equal(pending[0].title, `Integration Test ${X.slug} is awaiting approval`);
    assert.equal(pending[0].action_url, "/users");

    const founder = await claimKit.founder(CODE, "Noumea Divers");
    const created = await waitFor(
      "SELECT user_id, title, body FROM notifications WHERE category = 'club_created' AND data->>'club_name' = 'Noumea Divers'", [],
      sysIds.length,
    );
    assert.deepEqual(created.map((n) => n.user_id).sort(), sysIds);
    assert.equal(created[0].title, "New club: Noumea Divers");
    assert.match(created[0].body, /^First club on DivingHQ from New Caledonia\./);
    assert.ok(founder.clubId);

    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return;
    const put = await fetchJson("PUT", `/api/orgs/${X.orgId}/status`, { token: sys.token, body: { status: "suspended" } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const decided = await waitFor(
      "SELECT user_id, title FROM notifications WHERE category = 'org_decision' AND data->>'org_id' = $1", [X.orgId],
    );
    assert.deepEqual(decided.map((n) => n.user_id), [X.adminId]);
    assert.equal(decided[0].title, `Integration Test ${X.slug} has been suspended`);
  } finally {
    await pool.query("DELETE FROM notifications WHERE data->>'org_id' = $1", [X.orgId]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE data->>'club_name' = 'Noumea Divers'").catch(() => {});
    await teardownFixture(X);
    await claimKit.wipe(CODE);
  }
});

// Signup used to store a new club's code as typed, cut to 8: no upper
// case, no format check, no clash check, and a club that goes live at once
// (no federation) never met the rule club setup and approval apply. The
// federation's Clubs screen skipped it too.
test("club short codes: signup and the Clubs screen follow the same rule as club setup", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "DZA";
  await claimKit.wipe(CODE);
  const fed = await setupFixture({ withEvent: false });
  try {
    const signUp = (clubName, code) => {
      const username = `int-sc-${crypto.randomBytes(4).toString("hex")}`;
      return fetchJson("POST", "/api/auth/register", {
        body: { username, full_name: `${clubName} Admin`, password: TEST_PASSWORD, email: `${username}@example.test`,
                country_code: CODE, new_club_name: clubName, new_club_short_code: code },
      });
    };
    const codeOf = async (name) => (await pool.query(
      "SELECT c.short_code FROM clubs c JOIN organisations o ON o.id = c.org_id WHERE o.country_code = $1 AND c.name = $2",
      [CODE, name],
    )).rows[0]?.short_code;

    assert.equal((await signUp("Algiers Divers", " sdc ")).status, 201);
    assert.equal(await codeOf("Algiers Divers"), "SDC", "upper-cased and trimmed");
    // No federation, so the club is live now: its code has to be free now.
    for (const clash of ["SDC", "sdc"]) {
      const r = await signUp("Oran Divers", clash);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, "short_code_taken");
    }
    // Too long is refused, not quietly cut to eight.
    const long = await signUp("Melbourne Divers", "MELBOURNE");
    assert.equal(long.status, 400);
    assert.equal(long.body.code, "bad_short_code");
    assert.equal(await codeOf("Melbourne Divers"), undefined, "nothing was created");
    assert.equal((await signUp("Blida Divers", "kab-1")).status, 201);
    assert.equal(await codeOf("Blida Divers"), "KAB-1");

    // The federation's own Clubs screen, same rule.
    const post = (code) => fetchJson("POST", `/api/orgs/${fed.orgId}/clubs`, { token: fed.adminToken, body: { name: `Club ${code}`, short_code: code } });
    const first = await post("cap");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.short_code, "CAP");
    assert.equal((await post("CAP")).body.code, "short_code_taken");
    assert.equal((await post("TOO LONG CODE")).body.code, "bad_short_code");
    const second = (await post("DUP")).body;
    // A pair that already share a code (from before the rule) can still be
    // renamed; only a change of code is checked.
    await pool.query("UPDATE clubs SET short_code = 'cap' WHERE id = $1", [second.id]);
    const rename = await fetchJson("PUT", `/api/clubs/${second.id}`, { token: fed.adminToken, body: { name: "Renamed", short_code: "cap" } });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
    assert.equal(rename.body.short_code, "CAP");
    const clash = await fetchJson("PUT", `/api/clubs/${first.body.id}`, { token: fed.adminToken, body: { name: "Club cap", short_code: "dup2" } });
    assert.equal(clash.status, 200);
    const taken = await fetchJson("PUT", `/api/clubs/${second.id}`, { token: fed.adminToken, body: { name: "Renamed", short_code: "DUP2" } });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, "short_code_taken");
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [fed.orgId]).catch(() => {});
    await teardownFixture(fed);
    await claimKit.wipe(CODE);
  }
});

// A dive's club and region records go to the club and region the diver was
// entered from, the same rule as the scoreboard label, in the live path and
// in rebuild-records. The live path used the diver's club at scoring time;
// the replay filled a club-less snapshot from the diver's current club and
// ignored whether a club was still waiting on its federation.
test("records: club and region come from the entry, live and in the replay", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { rebuildRecords } = require("../scripts/rebuild-records");
  const st = await setupFixture({ withEvent: false });
  const client = await pool.connect();
  try {
    const lib = recordKit.lib();
    const region = async (name, code) => (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [st.orgId, name, code],
    )).rows[0].id;
    const north = await region("Entry North", "ENN");
    const south = await region("Entry South", "ENS");
    const clubA = await recordKit.club(st.orgId, "Entry A Divers", "ENA", north);
    const clubB = await recordKit.club(st.orgId, "Entry B Divers", "ENB", south);
    const clubC = await recordKit.club(st.orgId, "Entry C Divers", "ENC", south);
    const waiting = await recordKit.club(st.orgId, "Entry Waiting Divers", "ENW", south);
    await pool.query("UPDATE clubs SET status = 'pending' WHERE id = $1", [waiting]);
    const dive = await recordKit.threeMetreDive();
    const women = await recordKit.event(st.orgId, { gender: "Female" });

    // Entered from A, moves to B before the dive completes.
    const mover = await recordKit.diver(st.orgId, clubA, "female", "Gia Entry");
    await recordKit.dive(women, mover, 1, dive, 6);
    await pool.query("UPDATE users SET club_id = $2 WHERE id = $1", [mover, clubB]);
    const broken = await lib.checkAndApplyRecords({ eventId: women.id, competitorId: mover, roundNumber: 1 });
    assert.equal(broken.find((b) => b.scope === "club")?.scope_id, clubA, JSON.stringify(broken));
    assert.equal(broken.find((b) => b.scope === "club").scope_code, "ENA");
    assert.equal(broken.find((b) => b.scope === "region")?.scope_id, north);
    const inBook = async (tbl, col, id) => (await pool.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE ${col} = $1`, [id])).rows[0].n;
    assert.equal(await inBook("records_club", "club_id", clubB), 0, "the club they moved to gets nothing");

    // Entered with no club, joins C (in the south) afterwards.
    const loner = await recordKit.diver(st.orgId, null, "female", "Hana Entry");
    await recordKit.dive(women, loner, 1, dive, 7);
    await pool.query("UPDATE users SET club_id = $2 WHERE id = $1", [loner, clubC]);
    // A founder whose club is still waiting.
    const founder = await recordKit.diver(st.orgId, waiting, "female", "Iva Entry");
    await recordKit.dive(women, founder, 1, dive, 8);
    for (const who of [loner, founder]) {
      await lib.checkAndApplyRecords({ eventId: women.id, competitorId: who, roundNumber: 1 });
    }
    assert.equal(await inBook("records_club", "club_id", clubC), 0);
    assert.equal(await inBook("records_club", "club_id", waiting), 0);
    // The waiting club's region still counts (only its name is unvetted);
    // the club-less entry never reaches the south at all.
    const southHolders = (await pool.query("SELECT holder_id FROM records_region WHERE region_id = $1", [south])).rows;
    assert.deepEqual(southHolders.map((r) => r.holder_id), [founder]);

    // The replay agrees with every one of those: nothing to add or change
    // in the club or region books.
    const dry = await rebuildRecords(client, { orgId: st.orgId });
    for (const scope of ["club", "region"]) {
      const c = dry.find((r) => r.scope === scope).counts;
      assert.equal(c.added + c.changed + c.removed, 0, `${scope}: ${JSON.stringify(c)}`);
    }
  } finally {
    client.release();
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Records only ever went up: a record-setting dive that was Failed,
// capped or corrected down kept its record, and one corrected up
// "beat" its own earlier total. recomputeRecordKeys replays the dive's
// books; a redive's stale panel doesn't count until every judge has
// scored again.
test("records: a changed dive's books are replayed, down as well as up", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const lib = recordKit.lib();
    const club = await recordKit.club(st.orgId, "Replay Divers", "RPD");
    const old = await recordKit.diver(st.orgId, club, "female", "Jo Standing");
    const star = await recordKit.diver(st.orgId, club, "female", "Kit Rising");
    const dive = await recordKit.threeMetreDive();
    const women = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(women, old, 1, dive, 6);
    await lib.checkAndApplyRecords({ eventId: women.id, competitorId: old, roundNumber: 1 });
    await recordKit.dive(women, star, 1, dive, 6.5);
    await lib.checkAndApplyRecords({ eventId: women.id, competitorId: star, roundNumber: 1 });
    const book = async () => (await pool.query(
      "SELECT holder_id, score::float, prev_score::float, event_id FROM records_club WHERE club_id = $1", [club],
    )).rows[0];
    const standing = (await pool.query(
      "SELECT score::float FROM records_personal WHERE user_id = $1", [old],
    )).rows[0].score;
    assert.equal((await book()).holder_id, star);
    const setScores = (v, extra = "") => pool.query(
      `UPDATE scores SET score = $3 ${extra} WHERE event_id = $1 AND competitor_id = $2 AND round_number = 1`,
      [women.id, star, v],
    );
    const replay = () => lib.recomputeRecordKeys({ eventId: women.id, competitorId: star, roundNumber: 1 });

    // Failed: the old holder gets the book back, first mark again.
    await setScores(0);
    let out = await replay();
    assert.deepEqual(out.broken, [], "nothing to announce on the way down");
    assert.equal(out.changed, true);
    assert.deepEqual(await book(), { holder_id: old, score: standing, prev_score: null, event_id: women.id });

    // Corrected up past it: announced, and what it beat is the other
    // diver's mark, never its own earlier total.
    await setScores(7);
    out = await replay();
    const mark = out.broken.find((b) => b.scope === "club");
    assert.ok(mark, JSON.stringify(out.broken));
    assert.equal(mark.prev_score, standing);
    assert.equal(mark.prev_holder_name, "Jo Standing");
    const raised = await book();
    assert.equal(raised.holder_id, star);
    await setScores(8);
    out = await replay();
    assert.equal((await book()).prev_score, standing, "still what it beat, not its own 7s");
    assert.ok(out.broken.some((b) => b.scope === "club"));
    // Unchanged scores: nothing written, nothing said.
    out = await replay();
    assert.deepEqual(out, { broken: [], changed: false });

    // Redive: the stale panel stops counting straight away, and one fresh
    // score isn't a completed dive.
    await setScores(8, ", status = 'redive'");
    await replay();
    assert.equal((await book()).holder_id, old);
    await pool.query(
      "UPDATE scores SET score = 9, status = 'active' WHERE event_id = $1 AND competitor_id = $2 AND judge_id = $3",
      [women.id, star, women.judges[0]],
    );
    assert.deepEqual((await lib.checkAndApplyRecords({ eventId: women.id, competitorId: star, roundNumber: 1 })), []);
    await replay();
    assert.equal((await book()).holder_id, old);
    await setScores(9, ", status = 'active'");
    await replay();
    assert.equal((await book()).holder_id, star);

    // The HTTP correction path replays too: two judges corrected to 0
    // (the first is trimmed, the second isn't) drops it below Jo's mark.
    const ids = (await pool.query(
      "SELECT s.id FROM scores s JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id WHERE s.event_id = $1 AND s.competitor_id = $2 ORDER BY ej.judge_number",
      [women.id, star],
    )).rows.map((r) => r.id);
    for (const id of ids.slice(0, 3)) {
      const r = await fetchJson("PUT", `/api/scores/${id}`, { token: st.adminToken, body: { score: 0, reason: "test" } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal((await book()).holder_id, old, "the correction took the record away");
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// scores reference competitor_dive_lists(event, competitor, round) with no
// ON UPDATE, so moving the dive lists and the scores in two statements
// failed the whole claim for anyone who had ever been scored.
test("claiming a past account with scored dives moves them", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const old = await recordKit.diver(st.orgId, null, "female", "Mo Scored");
    const meName = `int-me-${crypto.randomBytes(3).toString("hex")}`;
    const me = await insertUser({ orgId: st.orgId, role: "diver", username: meName, fullName: "Mo Scored" });
    const women = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(women, old, 1, await recordKit.threeMetreDive(), 6);
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [old]);
    const login = await fetchJson("POST", "/api/auth/login", { body: { username: meName, password: "not-used-here" } });
    const claim = await fetchJson("POST", "/api/users/me/claim", {
      token: login.body.token, body: { old_user_ids: [old], password: "not-used-here" },
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.equal(claim.body.counts.dives, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM scores WHERE competitor_id = $1", [me])).rows[0].n, 5);
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Claiming a past account hard-deletes the old user, and the record books
// cascade off users. The old account's records have to move over first,
// or a national record holder who deletes and comes back loses every one.
test("claiming a past account carries its records over", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const lib = recordKit.lib();
    const club = await recordKit.club(st.orgId, "Comeback Divers", "CBD");
    const old = await recordKit.diver(st.orgId, club, "female", "Lou Comeback");
    const meName = `int-me-${crypto.randomBytes(3).toString("hex")}`;
    const me = await insertUser({ orgId: st.orgId, role: "diver", username: meName, fullName: "Lou Comeback" });
    await pool.query("UPDATE users SET club_id = $2, gender = 'female' WHERE id = $1", [me, club]);
    const [d1, d2] = (await pool.query(
      "SELECT id FROM dive_directory WHERE height = 3 AND is_custom = FALSE ORDER BY dive_code, position LIMIT 2",
    )).rows.map((r) => r.id);
    const women = await recordKit.event(st.orgId, { gender: "Female" });
    // The old account holds the club and national record on d1, and a
    // personal best on d2. The new one has a lower personal best on d1.
    await recordKit.dive(women, old, 1, d1, 7);
    await lib.checkAndApplyRecords({ eventId: women.id, competitorId: old, roundNumber: 1 });
    await recordKit.dive(women, old, 2, d2, 5);
    await lib.checkAndApplyRecords({ eventId: women.id, competitorId: old, roundNumber: 2 });
    // Another event: a claim refuses two entries for the same round.
    const later = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(later, me, 1, d1, 6);
    await lib.checkAndApplyRecords({ eventId: later.id, competitorId: me, roundNumber: 1 });
    const oldBest = (await pool.query(
      "SELECT score::float FROM records_personal WHERE user_id = $1 AND dive_code = (SELECT dive_code FROM dive_directory WHERE id = $2)",
      [old, d1],
    )).rows[0].score;
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [old]);

    const login = await fetchJson("POST", "/api/auth/login", { body: { username: meName, password: "not-used-here" } });
    const claim = await fetchJson("POST", "/api/users/me/claim", {
      token: login.body.token, body: { old_user_ids: [old], password: "not-used-here" },
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));

    const holders = async (tbl) => (await pool.query(
      `SELECT holder_id FROM ${tbl} WHERE event_id = $1`, [women.id],
    )).rows.map((r) => r.holder_id);
    for (const tbl of ["records_club", "records_federation"]) {
      const h = await holders(tbl);
      assert.ok(h.length === 2 && h.every((id) => id === me), `${tbl} survived under the new account: ${JSON.stringify(h)}`);
    }
    // And the scores came with the dive lists (they used to trip the
    // scores -> dive list foreign key and fail the whole claim).
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM scores WHERE competitor_id = $1 AND event_id = $2", [me, women.id])).rows[0].n, 10);
    const pbs = (await pool.query(
      "SELECT dive_code, score::float FROM records_personal WHERE user_id = $1 ORDER BY dive_code", [me],
    )).rows;
    assert.equal(pbs.length, 2, JSON.stringify(pbs));
    assert.ok(pbs.some((r) => r.score === oldBest), "the better personal best on d1 is the one kept");
    const archived = (await pool.query(
      "SELECT score::float FROM records_personal_history WHERE user_id = $1", [me],
    )).rows.map((r) => r.score);
    assert.ok(archived.length >= 1 && archived.every((s) => s < oldBest), JSON.stringify(archived));
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Where there's no federation, joining a claimed region takes both sides
// (PUT /api/clubs/:id/region answers 202). Signup used to set the region
// straight away, so a founder could put a club in a state body's region,
// and into its official records, without it ever being asked.
test("signup into a claimed region asks it, once the founder has verified", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "AGO";
  await claimKit.wipe(CODE);
  try {
    const R = await claimKit.founder(CODE, "Benguela Divers");
    const orgId = (await pool.query("SELECT org_id FROM users WHERE id = $1", [R.id])).rows[0].org_id;
    const region = async (name, code, claimed) => (await pool.query(
      `INSERT INTO regions (org_id, name, short_code, claim_state, claimed_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, name, code, claimed ? "claimed" : "unclaimed", claimed ? `${name} Diving` : null],
    )).rows[0].id;
    const lu = await region("Luanda", "LU", true);
    const hu = await region("Huambo", "HU", false);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [lu, R.id, orgId]);

    const signUp = async (clubName, regionCode) => {
      const username = `int-ra-${crypto.randomBytes(4).toString("hex")}`;
      const r = await fetchJson("POST", "/api/auth/register", {
        body: { username, full_name: `${clubName} Admin`, password: TEST_PASSWORD, email: `${username}@example.test`,
                country_code: CODE, new_club_name: clubName, region_code: regionCode },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const u = (await pool.query("SELECT id, club_id FROM users WHERE username = $1", [username])).rows[0];
      return { id: u.id, clubId: u.club_id };
    };
    const clubRow = async (id) => (await pool.query(
      "SELECT region_id, requested_region_id FROM clubs WHERE id = $1", [id],
    )).rows[0];
    const asksFor = async () => (await pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND category = 'region_request'", [R.id],
    )).rows[0].n;
    const overview = async () => (await fetchJson("GET", `/api/regions/${lu}/overview`, { token: R.token })).body;

    const B = await signUp("Cacuaco Divers", "LU");
    assert.deepEqual(await clubRow(B.clubId), { region_id: null, requested_region_id: lu });
    // Not yet verified: nobody's pinged and the ask isn't listed.
    assert.equal(await asksFor(), 0);
    assert.deepEqual((await overview()).join_requests, []);
    await claimKit.verify(B.id);
    assert.equal(await asksFor(), 1);
    assert.deepEqual((await overview()).join_requests.map((c) => c.id), [B.clubId]);
    await claimKit.verify(B.id);
    assert.equal(await asksFor(), 1, "a second click doesn't ask again");
    // The region accepts the usual way.
    const ok = await fetchJson("PUT", `/api/clubs/${B.clubId}/region`, { token: R.token, body: { region_id: lu } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(await clubRow(B.clubId), { region_id: lu, requested_region_id: null });

    // An unclaimed region is still the founder's pick.
    const C = await signUp("Huambo Divers", "HU");
    assert.deepEqual(await clubRow(C.clubId), { region_id: hu, requested_region_id: null });
  } finally {
    await claimKit.wipe(CODE);
  }
});

// A claimed federation whose only admin has gone (deleted, or suspended)
// stays claimed. New role requests there emailed nobody; the sysadmin
// hears instead, the way club approvals already fall back.
test("role requests: a federation with no live admin sends new ones to DivingHQ", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { reviewersFor } = require("../lib/role-requests");
  const st = await setupFixture({ withEvent: false });
  try {
    const member = await insertUser({ orgId: st.orgId, role: "spectator", username: `int-rr-${st.slug}`, fullName: "Asking Member" });
    assert.equal((await reviewersFor(pool, member, st.orgId, "judge")).via, "org");
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [st.adminId]);
    const suspended = await reviewersFor(pool, member, st.orgId, "judge");
    assert.equal(suspended.via, "sysadmin", "not a suspended admin who can't act on it");
    await pool.query("UPDATE users SET suspended_at = NULL, deleted_at = now() WHERE id = $1", [st.adminId]);
    const gone = await reviewersFor(pool, member, st.orgId, "judge");
    assert.equal(gone.via, "sysadmin");
    assert.ok(!gone.recipients.some((r) => r.email === `${st.username}@example.test`));
  } finally {
    await teardownFixture(st);
  }
});

// A denied (or pulled) federation is 'suspended'. The verify link used to
// tell its members their organisation was waiting for approval and they'd
// be emailed when it was reviewed.
test("verify-email tells a suspended org's member it's suspended, not pending", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const u = await insertUser({ orgId: st.orgId, role: "diver", username: `int-vs-${st.slug}`, fullName: "Suspended Member" });
    const verify = async () => {
      const token = claimKit.jwt.sign({ sub: u, type: "email_verify" }, process.env.JWT_SECRET, { expiresIn: "1h" });
      return (await fetchJson("POST", "/api/auth/verify-email", { body: { token } })).body.next;
    };
    await pool.query("UPDATE organisations SET status = 'suspended' WHERE id = $1", [st.orgId]);
    assert.equal(await verify(), "org_suspended");
    await pool.query("UPDATE organisations SET status = 'pending' WHERE id = $1", [st.orgId]);
    assert.equal(await verify(), "org_pending");
    await pool.query("UPDATE organisations SET status = 'active' WHERE id = $1", [st.orgId]);
    assert.equal(await verify(), "sign_in");
  } finally {
    await teardownFixture(st);
  }
});

// 093 fixed organisations.country_code but not the entry snapshots taken
// from it, which event_rep_code prefers. 098 rewrites those too.
test("migration 098 rewrites alpha-2 entry snapshots so a country prints one code", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const fs = require("node:fs");
  const path = require("node:path");
  const st = await setupFixture({ withEvent: false });
  try {
    const diver = await recordKit.diver(st.orgId, null, "female", "Sina Samoa");
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(ev, diver, 1, await recordKit.threeMetreDive(), 6);
    // What an entry from a federation stored as 'WS' looks like after 093.
    await pool.query("UPDATE competitor_dive_lists SET rep_country = 'ws' WHERE event_id = $1", [ev.id]);
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "migrations", "098_rep_country_alpha3.sql"), "utf8"));
    const row = (await pool.query(
      "SELECT rep_country, event_rep_code($1, $2, 'XXX') AS code FROM competitor_dive_lists WHERE event_id = $1",
      [ev.id, diver],
    )).rows[0];
    assert.equal(row.rep_country, "WSM");
    assert.equal(row.code, "WSM");
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Same thing through the real route, following the live flags.
test("sitemap.xml lists the payments and classes guides only while they're switched on", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { features } = require("../server.js");
  const saved = { payments: features.enabled("payments"), classes: features.enabled("classes") };
  const sitemap = () => new Promise((resolve, reject) => {
    http.get(`${baseUrl}/sitemap.xml`, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
  try {
    await features.set("payments", false);
    await features.set("classes", false);
    let xml = await sitemap();
    assert.ok(!xml.includes("/guide/payments") && !xml.includes("/guide/classes"), "not while they'd say Topic not found");
    assert.ok(xml.includes("/guide/quick-start"));
    await features.set("payments", true);
    xml = await sitemap();
    assert.ok(xml.includes("/guide/payments") && !xml.includes("/guide/classes"));
  } finally {
    await features.set("payments", saved.payments);
    await features.set("classes", saved.classes);
  }
});

// =====================================================================
// Security and integrity sweep (area 7, 2026-09). Each test starts from
// its own setupFixture org, so nothing here leans on shared rows.
// =====================================================================
const sweepKit = {
  // A member of `orgId` with one role, signed in. insertUser's password
  // is "not-used-here".
  async member(orgId, role, fullName = `Sweep ${role}`) {
    const username = `int-sw-${role.replace(/_/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
    const id = await insertUser({ orgId, username, fullName, role });
    const login = await fetchJson("POST", "/api/auth/login", { body: { username, password: "not-used-here" } });
    if (login.status !== 200) throw new Error(`sweepKit.member login ${login.status} ${JSON.stringify(login.body)}`);
    return { id, username, token: login.body.token };
  },
  // One scored dive (a full panel) in a Live event of the org. Returns
  // the event, the diver and the first judge's score row.
  async scoredDive(orgId, score = 6) {
    const ev = await recordKit.event(orgId, { gender: "Female" });
    const diver = await recordKit.diver(orgId, null, "female", "Sweep Diver");
    await recordKit.dive(ev, diver, 1, await recordKit.threeMetreDive(), score);
    const row = (await pool.query(
      "SELECT id FROM scores WHERE event_id = $1 AND judge_id = $2", [ev.id, ev.judges[0]],
    )).rows[0];
    return { ev, diver, scoreId: row.id };
  },
};

// The conflict endpoint wrote any body-supplied value to any score in the
// caller's org, finished events included, and skipped the per-event check
// PUT /api/scores/:id does. It only exists to settle a manual entry the
// judge's late sync disagreed with.
test("conflict resolve only settles a real conflict, for someone who runs the event", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const referee = await sweepKit.member(st.orgId, "referee");
    const { ev, scoreId } = await sweepKit.scoredDive(st.orgId, 6);
    await pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [ev.id]);
    const resolve = (token, body) => fetchJson("POST", `/api/conflicts/${scoreId}/resolve`, { token, body });
    const current = async () => (await pool.query("SELECT score::float AS score, score_source FROM scores WHERE id = $1", [scoreId])).rows[0];

    // A referee who isn't on the event: refused, same as PUT /api/scores/:id.
    const outsider = await resolve(referee.token, { decision: "accept_proposed", proposed_score: 10 });
    assert.equal(outsider.status, 403, JSON.stringify(outsider.body));
    // Even the org admin can't use it on a score nobody disputed.
    const noConflict = await resolve(st.adminToken, { decision: "accept_proposed", proposed_score: 10 });
    assert.equal(noConflict.status, 409, JSON.stringify(noConflict.body));
    assert.deepEqual(await current(), { score: 6, score_source: "judge_direct" });

    // A real one: the operator typed 6, the judge's late sync said 7.5.
    await pool.query("UPDATE scores SET score_source = 'manual_entry' WHERE id = $1", [scoreId]);
    const { insertScoreAudit } = require("../lib/score-audit");
    const s = (await pool.query("SELECT * FROM scores WHERE id = $1", [scoreId])).rows[0];
    await insertScoreAudit(pool, {
      scoreId, eventId: s.event_id, competitorId: s.competitor_id, judgeId: s.judge_id,
      round: s.round_number, action: "rejected_duplicate", oldScore: 6, newScore: 7.5,
    });
    await pool.query("INSERT INTO event_managers (event_id, user_id) VALUES ($1, $2)", [ev.id, referee.id]);
    const invented = await resolve(referee.token, { decision: "accept_proposed", proposed_score: 10 });
    assert.equal(invented.status, 409, "only the judge's own value can be accepted");
    const ok = await resolve(referee.token, { decision: "accept_proposed", proposed_score: 7.5 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(await current(), { score: 7.5, score_source: "manual_then_reconciled" });
    // Settled, so there's nothing left to resolve.
    const again = await resolve(referee.token, { decision: "keep_existing" });
    assert.equal(again.status, 409);
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// claim-candidates only offers deleted accounts with the caller's name,
// and the privacy policy says as much, but the claim itself took any
// deleted id in the org and moved its results, panels and record books
// across before hard-deleting it.
test("claiming a past account needs the same name, not just the same org", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const me = await sweepKit.member(st.orgId, "diver", "Sophie Evans");
    const champ = await recordKit.diver(st.orgId, null, "female", "Olympic Champion");
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(ev, champ, 1, await recordKit.threeMetreDive(), 9);
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [champ]);

    const claim = await fetchJson("POST", "/api/users/me/claim", {
      token: me.token, body: { old_user_ids: [champ], password: "not-used-here" },
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.deepEqual(claim.body.claimed, [], "someone else's past account isn't claimable");
    const owner = (await pool.query(
      "SELECT competitor_id FROM competitor_dive_lists WHERE event_id = $1", [ev.id],
    )).rows[0].competitor_id;
    assert.equal(owner, champ, "the dive list stays with the tombstone");
    assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [champ])).rows.length, 1);

    // Same name (any case) still works, that's the whole feature.
    const mine = await recordKit.diver(st.orgId, null, "female", "sophie EVANS");
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [mine]);
    const ok = await fetchJson("POST", "/api/users/me/claim", {
      token: me.token, body: { old_user_ids: [mine], password: "not-used-here" },
    });
    assert.deepEqual(ok.body.claimed, [mine]);
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Custom dive-directory rows are an org's own drills, any DD from 0.1 to
// 9.9, and any staff member anywhere can add one. Competition dive lists
// took them from every org, so another federation's "101B at DD 9.9"
// could go on a real entry and multiply every judge's score.
test("a dive list can't use another org's custom dive, and the picker doesn't offer it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const home = await setupFixture({ withEvent: false });
  const away = await setupFixture({ withEvent: false });
  try {
    const coach = await sweepKit.member(away.orgId, "coach");
    const made = await fetchJson("POST", "/api/dive-directory", {
      // A DD no other run is using, since the directory is shared.
      token: coach.token, body: { dive_code: "101", height: "3m", position: "B", dd: 5 + crypto.randomInt(49) / 10 },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const diver = await sweepKit.member(home.orgId, "diver");
    const ev = (await pool.query(
      `INSERT INTO events (org_id, name, gender, height, number_of_judges, total_rounds, event_type, status)
       VALUES ($1, 'Sweep custom DD', 'Mixed', '3m', 5, 1, 'individual', 'Upcoming') RETURNING id`,
      [home.orgId],
    )).rows[0].id;
    const submit = (diveId) => fetchJson("POST", "/api/competitor/submit-list", {
      token: diver.token, body: { event_id: ev, dives: [{ round_number: 1, dive_id: diveId }] },
    });
    const foreign = await submit(made.body.id);
    assert.equal(foreign.status, 400, JSON.stringify(foreign.body));
    const core = (await pool.query(
      "SELECT id FROM dive_directory WHERE dive_code = '101' AND position = 'B' AND height = 3 AND NOT is_custom",
    )).rows[0].id;
    assert.equal((await submit(core)).status, 200);

    const listed = await fetchJson("GET", "/api/dive-directory", { token: diver.token });
    assert.ok(!listed.body.some((d) => d.id === made.body.id), "the other org's drill isn't in this org's picker");
    const theirs = await fetchJson("GET", "/api/dive-directory", { token: coach.token });
    assert.ok(theirs.body.some((d) => d.id === made.body.id), "its own org still sees it");
  } finally {
    // Home's events (and any dive list that used the drill) go first.
    await teardownFixture(home);
    await pool.query("DELETE FROM dive_directory WHERE created_org_id = $1", [away.orgId]);
    await teardownFixture(away);
  }
});

// Decisions read the pending row without a lock and then wrote their
// verdict unconditionally, so two admins (or one double-click) acting at
// once both "won": the role granted while the request read 'rejected', a
// guardian link flipping twice, a cancel overwriting a finished transfer.
// Exactly one decision per request may land.
test("overlapping decisions on one request: exactly one lands", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const both = (a, b) => Promise.all([a(), b()]);
    for (let i = 0; i < 4; i++) {
      // Role request: approve and reject at the same moment.
      const who = await insertUser({ orgId: st.orgId, role: "diver", username: `int-sw-rr-${st.slug}-${i}`, fullName: "Racing Request" });
      const rq = (await pool.query(
        "INSERT INTO role_requests (user_id, org_id, requested_role) VALUES ($1, $2, 'coach') RETURNING id",
        [who, st.orgId],
      )).rows[0].id;
      const review = (decision) => () => fetchJson("POST", `/api/role-requests/${rq}/review`, { token: st.adminToken, body: { decision } });
      const [ap, rj] = await both(review("approved"), review("rejected"));
      assert.equal([ap.status, rj.status].filter((s) => s === 200).length, 1, `role request run ${i}: ${ap.status}/${rj.status}`);
      const status = (await pool.query("SELECT status::text FROM role_requests WHERE id = $1", [rq])).rows[0].status;
      const granted = (await pool.query(
        "SELECT 1 FROM user_org_roles WHERE user_id = $1 AND org_id = $2 AND role = 'coach'", [who, st.orgId],
      )).rows.length === 1;
      assert.equal(granted, status === "approved", `role request run ${i}: status ${status}, granted ${granted}`);

      // Guardian request, the same race.
      const parent = await insertUser({ orgId: st.orgId, role: "spectator", username: `int-sw-gp-${st.slug}-${i}`, fullName: "Racing Parent" });
      const g = (await pool.query(
        "INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id) VALUES ($1, $2, $3) RETURNING id",
        [st.orgId, parent, who],
      )).rows[0].id;
      const decide = (decision) => () => fetchJson("POST", `/api/guardian-requests/${g}/review`, { token: st.adminToken, body: { decision } });
      const [ga, gr] = await both(decide("approved"), decide("rejected"));
      assert.equal([ga.status, gr.status].filter((s) => s === 200).length, 1, `guardian run ${i}: ${ga.status}/${gr.status}`);
    }

    // A club change: the admin approves (which finalises it) while the
    // diver cancels.
    const [from, to] = [await recordKit.club(st.orgId, "Race From", "RFR"), await recordKit.club(st.orgId, "Race To", "RTO")];
    for (let i = 0; i < 4; i++) {
      const diver = await sweepKit.member(st.orgId, "diver", "Racing Mover");
      await pool.query("UPDATE users SET club_id = $2 WHERE id = $1", [diver.id, from]);
      const made = await fetchJson("POST", "/api/club-change-requests", { token: diver.token, body: { to_club_id: to } });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const [ok, cancel] = await both(
        () => fetchJson("POST", `/api/club-change-requests/${made.body.id}/review`, { token: st.adminToken, body: { decision: "approved" } }),
        () => fetchJson("POST", `/api/club-change-requests/${made.body.id}/cancel`, { token: diver.token }),
      );
      assert.equal([ok.status, cancel.status].filter((s) => s === 200).length, 1, `club change run ${i}: ${ok.status}/${cancel.status}`);
      const row = (await pool.query("SELECT status::text FROM club_change_requests WHERE id = $1", [made.body.id])).rows[0];
      const club = (await pool.query("SELECT club_id FROM users WHERE id = $1", [diver.id])).rows[0].club_id;
      assert.equal(club === to, row.status === "approved", `club change run ${i}: ${row.status} with club ${club === to ? "moved" : "kept"}`);
    }
  } finally {
    await pool.query("DELETE FROM club_change_requests WHERE to_org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// PUT /api/users/me/password was the one password check with no limiter,
// and it held a pooled connection through bcrypt, so one signed-in user
// could stall the app with parallel wrong guesses, or a stolen session
// could guess the password without limit. A non-string password 500'd.
test("changing your password: wrong guesses are limited per account, junk is a 400", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  const saved = process.env.RATE_LIMIT_DISABLED;
  try {
    const me = await sweepKit.member(st.orgId, "spectator");
    const change = (current_password) => fetchJson("PUT", "/api/users/me/password", {
      token: me.token, body: { current_password, new_password: "a-brand-new-password-123" },
    });
    assert.equal((await change({ not: "a string" })).status, 400);
    process.env.RATE_LIMIT_DISABLED = "false";
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await change(`wrong-guess-${i}`)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  } finally {
    process.env.RATE_LIMIT_DISABLED = saved;
    await teardownFixture(st);
  }
});

// Accepting a synchro invite wrote both divers' lists (and deleted their
// other rounds) without asking whether the event still takes entries.
// Invites never expire, so one from weeks ago could rewrite two entries
// after the lists locked, or with the event Live.
test("accepting a synchro pairing runs the same entry gate as submitting", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const asker = await sweepKit.member(st.orgId, "diver", "Synchro Asker");
    const partner = await sweepKit.member(st.orgId, "diver", "Synchro Partner");
    const dive = (await pool.query(
      "SELECT id FROM dive_directory WHERE height = 3 AND NOT is_custom ORDER BY dive_code, position LIMIT 1",
    )).rows[0].id;
    const ev = (await pool.query(
      `INSERT INTO events (org_id, name, gender, height, number_of_judges, total_rounds, event_type, status, entries_close_at)
       VALUES ($1, 'Sweep synchro', 'Mixed', '3m', 9, 1, 'synchro_pair', 'Upcoming', now() - interval '1 day') RETURNING id`,
      [st.orgId],
    )).rows[0].id;
    const invite = async () => (await pool.query(
      `INSERT INTO pending_partner_pairings (event_id, requester_id, partner_id, dives)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [ev, asker.id, partner.id, JSON.stringify([{ dive_id: dive, round_number: 1 }])],
    )).rows[0].id;
    const accept = (id) => fetchJson("POST", `/api/competitor/pairings/${id}/accept`, { token: partner.token });
    const entries = async () => (await pool.query("SELECT count(*)::int AS n FROM competitor_dive_lists WHERE event_id = $1", [ev])).rows[0].n;

    const late = await invite();
    const closed = await accept(late);
    assert.equal(closed.status, 409, JSON.stringify(closed.body));
    assert.equal(await entries(), 0);
    assert.equal((await pool.query("SELECT status FROM pending_partner_pairings WHERE id = $1", [late])).rows[0].status, "pending");

    // Reopen entries and it goes through.
    await pool.query("UPDATE events SET entries_close_at = NULL WHERE id = $1", [ev]);
    assert.equal((await accept(late)).status, 200);
    assert.equal(await entries(), 2);
  } finally {
    await teardownFixture(st);
  }
});

// Through the real server: the 2FA step-up token /api/auth/login hands
// out for the password alone is not a session.
test("the 2FA step-up token (and a reset link) can't be used as a session", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const jwt = require("jsonwebtoken");
    for (const type of ["totp_pending", "password_reset", "email_verify"]) {
      const token = jwt.sign({ sub: st.adminId, type }, process.env.JWT_SECRET, { expiresIn: "5m" });
      for (const path of ["/api/dive-directory", "/api/divers/search?q=an", "/api/dashboard"]) {
        const r = await fetchJson("GET", path, { token });
        assert.equal(r.status, 401, `${type} on ${path}: ${r.status}`);
      }
    }
  } finally {
    await teardownFixture(st);
  }
});

// A recovery code is single-use. The login read the stored list, matched
// the code, then wrote the shorter list back unconditionally, so the same
// code sent a few times at once minted a session each time.
test("a 2FA recovery code signs in once, however many requests race it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const totp = require("../lib/totp");
    const jwt = require("jsonwebtoken");
    const { plain, hashes } = await totp.generateRecoveryCodes(3);
    await pool.query(
      `UPDATE users SET totp_secret = $2, totp_enabled_at = now(), totp_recovery_codes = $3::jsonb WHERE id = $1`,
      [st.adminId, "JBSWY3DPEHPK3PXP", JSON.stringify(hashes)],
    );
    const stepUp = () => jwt.sign({ sub: st.adminId, type: "totp_pending" }, process.env.JWT_SECRET, { expiresIn: "5m" });
    const tries = await Promise.all([0, 1, 2, 3].map(() => fetchJson("POST", "/api/auth/login/totp", {
      body: { totp_token: stepUp(), code: plain[1] },
    })));
    assert.equal(tries.filter((r) => r.status === 200).length, 1, tries.map((r) => r.status).join(","));
    const left = (await pool.query("SELECT totp_recovery_codes FROM users WHERE id = $1", [st.adminId])).rows[0].totp_recovery_codes;
    assert.equal(left.length, 2);
  } finally {
    await teardownFixture(st);
  }
});

// PUT /api/scores/:id read the old score, updated it and wrote the audit
// row as three separate statements with no lock, so two corrections at
// once both logged the same old score and the trail skipped a step.
test("score corrections at the same moment leave an unbroken audit chain", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const { scoreId } = await sweepKit.scoredDive(st.orgId, 6);
    const put = (score) => fetchJson("PUT", `/api/scores/${scoreId}`, { token: st.adminToken, body: { score } });
    for (let i = 0; i < 3; i++) {
      const [a, b] = await Promise.all([put(6.5 + i), put(8 + i)]);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(b.status, 200, JSON.stringify(b.body));
    }
    const trail = (await pool.query(
      `SELECT old_score::float AS o, new_score::float AS n FROM score_audit_log
        WHERE score_id = $1 AND action = 'update' ORDER BY created_at, id`,
      [scoreId],
    )).rows;
    assert.equal(trail.length, 6);
    // Each correction starts from where the one before it left the score:
    // the old values are the starting 6 plus every new value but the last.
    const final = Number((await pool.query("SELECT score FROM scores WHERE id = $1", [scoreId])).rows[0].score);
    const news = [6, ...trail.map((r) => r.n)];
    news.splice(news.indexOf(final), 1);
    assert.deepEqual(trail.map((r) => r.o).sort(), news.sort(), JSON.stringify(trail));
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});
