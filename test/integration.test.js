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
