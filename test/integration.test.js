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

// Before dotenv, which never overwrites a var that's already set (even to
// ""). A dev .env usually has real VAPID keys and the test DB has real
// browser subscriptions, so without this every fixture org that pinged
// the sysadmins landed on someone's actual phone. Set here and not only
// in scripts/run-tests.js, since `node --test` on this file skips that.
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";
// Same trick for the PDF fonts. pdfText() below reads the WinAnsi bytes
// Helvetica writes; once lib/pdf-fonts finds Noto on the box (it looks in
// the Debian paths by default) text goes out as glyph ids instead, and
// every PDF assertion in here would fail on a server that has the fonts.
// The font path is tested DB-less in test/pdf-document.test.js.
process.env.PDF_FONT_DIR = "none";
process.env.PDF_FONT_REGULAR = "";
process.env.PDF_FONT_BOLD = "";
process.env.PDF_FONT_ITALIC = "";

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
  // Run straight through `node --test` this file skips scripts/run-tests.js,
  // so it checks for itself that it isn't about to fill a real database
  // with fixture orgs (test/support/test-db.js).
  require("./support/test-db").assertTestDatabase();
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

      // ----- The four ranking widgets vs the queries they replaced -----
      // The endpoint runs FULL_FIELD_RANKING once and splits the rows
      // into recent_form / placings / streak / year_over_year in Node.
      // Add an older meet in an earlier calendar year (Diver 2, then
      // Diver 3, then Diver 1) so every widget has more than one row to
      // order or group, then hold each one to the standalone query it
      // used to be.
      const ev2 = await pool.query(
        `INSERT INTO events (org_id, name, gender, height, number_of_judges,
                             total_rounds, event_type, status, created_at)
         VALUES ($1, $2, 'Mixed', '3m', 5, 6, 'individual', 'Completed',
                 now() - INTERVAL '400 days')
         RETURNING id`,
        [state.orgId, `Integration Older Meet ${slug}`],
      );
      const ev2Id = ev2.rows[0].id;
      for (let i = 0; i < judgeIds.length; i++) {
        await pool.query(
          `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)`,
          [ev2Id, judgeIds[i], i + 1],
        );
      }
      const OLDER = [
        [6.0, 6.0, 6.5, 6.0, 6.0],   // Diver 1 → keep 18.0, 3rd
        [9.0, 9.0, 9.0, 9.0, 9.0],   // Diver 2 → keep 27.0, 1st
        [7.0, 7.0, 7.0, 7.0, 7.0],   // Diver 3 → keep 21.0, 2nd
      ];
      for (let di = 0; di < diverIds.length; di++) {
        await pool.query(
          `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number)
           VALUES ($1, $2, $3, 1)`,
          [ev2Id, diverIds[di], diveId],
        );
        for (let ji = 0; ji < judgeIds.length; ji++) {
          await pool.query(
            `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
             VALUES ($1, $2, $3, $4, 1, $5)`,
            [ev2Id, diverIds[di], judgeIds[ji], diveId, OLDER[di][ji]],
          );
        }
      }

      const { FULL_FIELD_RANKING } = require("../db/queries");
      const ref = async (tail, id) =>
        (await pool.query(`WITH ${FULL_FIELD_RANKING}${tail}`, [id, null, null])).rows;
      // pg hands back Dates; the endpoint hands back their JSON form.
      const asJson = (v) => JSON.parse(JSON.stringify(v));
      const expectedStreak = {
        [diverIds[0]]: { kind: "podium", length: 2 },   // 2nd, then 3rd
        [diverIds[1]]: { kind: "win",    length: 2 },   // 1st, then 1st
        [diverIds[2]]: { kind: "podium", length: 2 },   // 3rd, then 2nd
      };
      for (const id of diverIds) {
        const r = await fetchJson("GET", `/api/divers/${id}/analytics`, { token: state.adminToken });
        assert.equal(r.status, 200);

        const recentRef = await ref(`
          SELECT e.id AS event_id, e.name AS event_name, e.created_at,
                 r.total, r.rank, r.field_size
          FROM ranked r JOIN events e ON e.id = r.event_id
          WHERE r.competitor_id = $1
          ORDER BY e.created_at DESC LIMIT 5`, id);
        assert.equal(recentRef.length, 2);
        assert.deepEqual(
          r.body.recent_form.map(({ dives, ...row }) => { assert.ok(Array.isArray(dives)); return row; }),
          asJson(recentRef),
          `diver ${id} recent_form`,
        );

        const [placingsRef] = await ref(`
          SELECT
            COUNT(*) FILTER (WHERE rank = 1)::int AS gold,
            COUNT(*) FILTER (WHERE rank = 2)::int AS silver,
            COUNT(*) FILTER (WHERE rank = 3)::int AS bronze,
            COUNT(*) FILTER (WHERE rank BETWEEN 4 AND 8)::int  AS finalist,
            COUNT(*) FILTER (WHERE rank > 8)::int              AS further,
            COUNT(*)::int                                      AS total_meets
          FROM ranked WHERE competitor_id = $1`, id);
        assert.deepEqual(r.body.placings, placingsRef, `diver ${id} placings`);

        const yearsRef = await ref(`,
          my_events AS (
            SELECT r.event_id, r.total, r.rank, e.created_at
            FROM ranked r JOIN events e ON e.id = r.event_id
            WHERE r.competitor_id = $1
          )
          SELECT EXTRACT(YEAR FROM created_at)::int    AS year,
                 COUNT(DISTINCT event_id)::int         AS meets,
                 AVG(total)::numeric(8,2)              AS avg_meet_total,
                 MAX(total)::numeric(8,2)              AS best_meet_total,
                 COUNT(*) FILTER (WHERE rank = 1)::int  AS wins,
                 COUNT(*) FILTER (WHERE rank <= 3)::int AS podiums
          FROM my_events
          GROUP BY EXTRACT(YEAR FROM created_at)
          ORDER BY year DESC`, id);
        assert.equal(yearsRef.length, 2);
        assert.deepEqual(r.body.year_over_year, yearsRef, `diver ${id} year_over_year`);

        assert.deepEqual(r.body.streak, expectedStreak[id], `diver ${id} streak`);
      }
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
    // Gatineau has two region_decision notices by now (the decline above,
    // then this one), and nothing orders them, so look for the right one.
    const heard = await pool.query(
      "SELECT title FROM notifications WHERE user_id = $1 AND category = 'region_decision'", [B.id]);
    assert.ok(heard.rows.some((r) => /now in Diving Ontario/.test(r.title)), JSON.stringify(heard.rows));

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

// WA 8.6.6: a failed dive gets 0 points, and 0 points isn't anybody's
// record. A first go at a dive that the referee failed used to land in the
// personal, club and national books as 0.00, either from the last held
// award (checkAndApplyRecords only asked whether it beat something) or from
// the replay after the call, which also swapped a mark the dive had just
// set for its own 0.00.
test("records: a dive worth 0 points never sets or keeps a record", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const lib = recordKit.lib();
    const club = await recordKit.club(st.orgId, "Zero Divers", "ZRD");
    const failed = await recordKit.diver(st.orgId, club, "female", "Ada Failed");
    const early = await recordKit.diver(st.orgId, club, "female", "Bea Early");
    const star = await recordKit.diver(st.orgId, club, "female", "Cat Star");
    const dive = await recordKit.threeMetreDive();
    const women = await recordKit.event(st.orgId, { gender: "Female" });
    const at = (who) => ({ eventId: women.id, competitorId: who, roundNumber: 1 });
    const personal = async (who) => (await pool.query(
      "SELECT score::float FROM records_personal WHERE user_id = $1", [who],
    )).rows;
    const book = async (tbl, col, id) => (await pool.query(
      `SELECT holder_id, score::float, prev_score::float, set_at FROM ${tbl} WHERE ${col} = $1`, [id],
    )).rows;

    // Failed before the panel scored, so every award was held to 0.
    await recordKit.dive(women, failed, 1, dive, 0);
    assert.deepEqual(await lib.checkAndApplyRecords(at(failed)), []);
    assert.deepEqual(await lib.recomputeRecordKeys(at(failed)), { broken: [], changed: false });
    assert.deepEqual(await personal(failed), []);
    assert.deepEqual(await book("records_club", "club_id", club), []);

    // The next real dive is a first mark, not a record that beat 0.00.
    // Its scores are backdated so the replay below can show it keeps the
    // dive's own date when it comes back.
    await recordKit.dive(women, early, 1, dive, 6);
    await pool.query(
      "UPDATE scores SET created_at = '2026-01-02T10:00:00Z' WHERE event_id = $1 AND competitor_id = $2",
      [women.id, early],
    );
    const first = await lib.checkAndApplyRecords(at(early));
    assert.equal(first.find((b) => b.scope === "club")?.prev_score, null, JSON.stringify(first));
    const earlyMark = (await book("records_club", "club_id", club))[0].score;
    await recordKit.dive(women, star, 1, dive, 7);
    await lib.checkAndApplyRecords(at(star));
    assert.equal((await book("records_club", "club_id", club))[0].holder_id, star);

    // The referee fails the record holder's dive after it was scored: the
    // book goes back to the mark it beat, dated when that dive was scored,
    // and the failed dive keeps no personal best either.
    await pool.query("UPDATE scores SET score = 0 WHERE event_id = $1 AND competitor_id = $2", [women.id, star]);
    let out = await lib.recomputeRecordKeys(at(star));
    assert.deepEqual(out.broken, []);
    assert.equal(out.changed, true);
    for (const [tbl, col, id] of [["records_club", "club_id", club], ["records_federation", "org_id", st.orgId]]) {
      const rows = await book(tbl, col, id);
      assert.equal(rows.length, 1, tbl);
      assert.equal(rows[0].holder_id, early, tbl);
      assert.equal(rows[0].score, earlyMark, tbl);
      assert.equal(rows[0].prev_score, null, tbl);
      assert.equal(rows[0].set_at.toISOString(), "2026-01-02T10:00:00.000Z", `${tbl} keeps the dive's date`);
    }
    assert.deepEqual(await personal(star), []);

    // And with nobody else left in the book, failing that dive empties it.
    // The rows go to history, same as any replaced record.
    await pool.query("UPDATE scores SET score = 0 WHERE event_id = $1 AND competitor_id = $2", [women.id, early]);
    out = await lib.recomputeRecordKeys(at(early));
    assert.equal(out.changed, true);
    assert.deepEqual(await book("records_club", "club_id", club), []);
    assert.deepEqual(await book("records_federation", "org_id", st.orgId), []);
    assert.deepEqual(await personal(early), []);
    const archived = (await pool.query(
      "SELECT holder_id FROM records_club_history WHERE club_id = $1 ORDER BY score", [club],
    )).rows.map((r) => r.holder_id);
    assert.ok(archived.includes(early) && archived.includes(star), JSON.stringify(archived));
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Production may still hold 0.00 marks from failed dives, written before
// the live path learned to skip them. rebuild-records is the repair: the
// dry run lists them, --apply takes them out (history keeps a copy) and
// clears the prev_score of any record that "beat" one.
test("records: rebuild-records reports 0.00 marks from failed dives and --apply clears them", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { rebuildRecords, report } = require("../scripts/rebuild-records");
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const st = await setupFixture({ withEvent: false });
  const client = await pool.connect();
  try {
    const lib = recordKit.lib();
    const club = await recordKit.club(st.orgId, "Leftover Divers", "LOD");
    const her = await recordKit.diver(st.orgId, club, "female", "Dot Leftover");
    const [d1, d2] = (await pool.query(
      "SELECT id FROM dive_directory WHERE height = 3 AND is_custom = FALSE ORDER BY dive_code, position LIMIT 2",
    )).rows.map((r) => r.id);
    const women = await recordKit.event(st.orgId, { gender: "Female" });
    // What the old code left behind. d1: a failed first go, filed as 0.00
    // in every book. d2: the same, and then a real dive that "beat" it, so
    // that record carries prev_score 0.
    const zeroMarks = async (diveId) => {
      const params = [her, women.id, diveId];
      await pool.query(
        `INSERT INTO records_personal (user_id, gender, height, dive_code, position, score, event_id)
         SELECT $1, 'Female', '3m', dive_code, position, 0, $2 FROM dive_directory WHERE id = $3`, params);
      await pool.query(
        `INSERT INTO records_club (club_id, holder_id, gender, height, dive_code, position, score, event_id)
         SELECT $4, $1, 'Female', '3m', dive_code, position, 0, $2 FROM dive_directory WHERE id = $3`, [...params, club]);
      await pool.query(
        `INSERT INTO records_federation (org_id, holder_id, gender, height, dive_code, position, score, event_id)
         SELECT $4, $1, 'Female', '3m', dive_code, position, 0, $2 FROM dive_directory WHERE id = $3`, [...params, st.orgId]);
    };
    await recordKit.dive(women, her, 1, d1, 0);
    await zeroMarks(d1);
    await recordKit.dive(women, her, 2, d2, 0);
    await zeroMarks(d2);
    await recordKit.dive(women, her, 3, d2, 6);
    await lib.checkAndApplyRecords({ eventId: women.id, competitorId: her, roundNumber: 3 });
    const snapshot = async () => (await pool.query(
      `SELECT 'club' AS book, score::float, prev_score::float FROM records_club WHERE club_id = $1
       UNION ALL SELECT 'national', score::float, prev_score::float FROM records_federation WHERE org_id = $2
       UNION ALL SELECT 'personal', score::float, prev_score::float FROM records_personal WHERE user_id = $3
       ORDER BY 1, 2`, [club, st.orgId, her])).rows;
    const before = await snapshot();
    assert.equal(before.filter((r) => r.score === 0).length, 3, JSON.stringify(before));
    assert.equal(before.filter((r) => r.prev_score === 0).length, 3, JSON.stringify(before));

    const dry = await rebuildRecords(client, { orgId: st.orgId });
    for (const scope of ["personal", "club", "federation"]) {
      const c = dry.find((r) => r.scope === scope).counts;
      assert.equal(c.removed, 1, `${scope}: ${JSON.stringify(c)}`);
      assert.equal(c.prev, 1, `${scope}: ${JSON.stringify(c)}`);
      assert.equal(c.added + c.changed, 0, `${scope}: ${JSON.stringify(c)}`);
    }
    assert.deepEqual(await snapshot(), before, "a dry run writes nothing");
    assert.match(report(dry, { apply: false, verbose: true }), /removed .* was 0(\.00)?\b/);

    // The command the operator runs, same database through the same env.
    const cli = spawnSync(process.execPath,
      [path.join(__dirname, "..", "scripts", "rebuild-records.js"), "--org", st.orgId, "--verbose"],
      { env: { ...process.env }, encoding: "utf8", timeout: 60_000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /DRY RUN/);
    assert.match(cli.stdout, /removed .* was 0(\.00)?\b/);
    assert.deepEqual(await snapshot(), before, "the CLI dry run writes nothing either");

    await rebuildRecords(client, { orgId: st.orgId, apply: true });
    const after = await snapshot();
    assert.deepEqual(after.map((r) => r.book), ["club", "national", "personal"], JSON.stringify(after));
    assert.ok(after.every((r) => r.score > 0 && r.prev_score === null), JSON.stringify(after));
    const kept = (await pool.query(
      "SELECT count(*)::int AS n FROM records_club_history WHERE club_id = $1 AND score = 0", [club],
    )).rows[0].n;
    assert.equal(kept, 2, "both 0.00 club rows are in history");

    const again = await rebuildRecords(client, { orgId: st.orgId });
    for (const r of again) {
      const c = r.counts;
      assert.equal(c.changed + c.added + c.removed + c.prev, 0, `${r.scope}: ${JSON.stringify(c)}`);
    }
  } finally {
    client.release();
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});
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
  // 098 ends by stamping schema_meta.version = 98, and it carries its own
  // BEGIN/COMMIT so a wrapping transaction can't roll that back. Note what
  // was there and put it back, or every run leaves the shared test DB
  // claiming v98 (health check, boot log) while the ledger says 101+.
  const metaBefore = (await pool.query("SELECT version FROM schema_meta WHERE id = 1")).rows[0]?.version;
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
    if (metaBefore != null) await pool.query("UPDATE schema_meta SET version = $1 WHERE id = 1", [metaBefore]);
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
  const metaAfter = (await pool.query("SELECT version FROM schema_meta WHERE id = 1")).rows[0]?.version;
  assert.equal(metaAfter, metaBefore, "the test must leave schema_meta as it found it");
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
// Server-core hardening (bug sweep, area B1). These drive the socket
// engine through a real socket.io client against the in-process server,
// and a few boot and shutdown paths through a spawned server.js.
// =====================================================================
const b1Kit = {
  io: require("socket.io-client").io,
  connect({ token, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const s = b1Kit.io(baseUrl, {
        transports: ["websocket"], reconnection: false, timeout: 4000,
        ...(token ? { auth: { token } } : {}),
        ...(cookie ? { extraHeaders: { cookie } } : {}),
      });
      const timer = setTimeout(() => { s.close(); reject(new Error("socket never connected")); }, 5000);
      s.on("connect", () => { clearTimeout(timer); resolve(s); });
      s.on("connect_error", (e) => { clearTimeout(timer); s.close(); reject(e); });
    });
  },
  ack(s, event, data, ms = 4000) {
    return s.timeout(ms).emitWithAck(event, data);
  },
  // Resolves with the next payload of `event`, or null after ms.
  next(s, event, ms = 2000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { s.off(event, on); resolve(null); }, ms);
      const on = (p) => { clearTimeout(timer); resolve(p); };
      s.once(event, on);
    });
  },
  async login(username, password = "not-used-here") {
    const r = await fetchJson("POST", "/api/auth/login", { body: { username, password } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
  },
  async alive() {
    return (await fetchJson("GET", "/api/health")).status === 200;
  },
  // fetchJson plus request headers.
  request(method, path, { body, token, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const data = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
      const h = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
      if (data) h["Content-Length"] = Buffer.byteLength(data);
      const req = http.request({ method, host: url.hostname, port: url.port, path: url.pathname + url.search, headers: h }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = text;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  },
  // A round-1 dive-list row, which scores hang off (FK).
  async enter(ev, diver) {
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
      [ev.id, diver, await recordKit.threeMetreDive()],
    );
  },
};

test("socket handshake with a malformed session cookie connects as a guest instead of crashing", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const s = await b1Kit.connect({ cookie: "dhq_session=%E0%A4%A" });
  try {
    assert.ok(s.connected);
    assert.ok(await b1Kit.alive());
  } finally {
    s.close();
  }
});

test("Control Room socket events refuse a non-UUID event_id instead of crashing the server", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  const s = await b1Kit.connect({ token: st.adminToken });
  try {
    const refusal = b1Kit.next(s, "unauthorized");
    s.emit("claim_event_control", { event_id: "not-a-uuid" });
    assert.equal((await refusal)?.reason, "bad_event_id");
    for (const ev of ["meet_hold", "set_active_diver", "referee_failed_dive", "announce_score"]) {
      const out = await b1Kit.ack(s, ev, { event_id: "x'; --", competitor_id: "c", round_number: 1 });
      assert.equal(out.ok, false, ev);
    }
    assert.ok(await b1Kit.alive());
  } finally {
    s.close();
    await teardownFixture(st);
  }
});

test("maintenance mode refuses socket score submits and Control Room actions from non-admins", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { features } = require("../server.js");
  const st = await setupFixture({ withEvent: false });
  const ev = await recordKit.event(st.orgId, { gender: "Female" });
  const diver = await recordKit.diver(st.orgId, null, "female", "Maintenance Diver");
  await b1Kit.enter(ev, diver);
  const judgeName = (await pool.query("SELECT username FROM users WHERE id = $1", [ev.judges[0]])).rows[0].username;
  const judge = await b1Kit.connect({ token: await b1Kit.login(judgeName) });
  const admin = await b1Kit.connect({ token: st.adminToken });
  try {
    await features.set("maintenance", true);
    const sub = await b1Kit.ack(judge, "submit_score", { event_id: ev.id, competitor_id: diver, round_number: 1, score: 7 });
    assert.equal(sub.ok, false);
    assert.equal(sub.error, "maintenance");
    const held = await b1Kit.ack(admin, "meet_hold", { event_id: ev.id, reason: "x" });
    assert.equal(held.ok, false);
    const stored = await pool.query("SELECT 1 FROM scores WHERE event_id = $1", [ev.id]);
    assert.equal(stored.rows.length, 0, "nothing reached the scores table");

    // Off again, the same submit goes through.
    await features.set("maintenance", false);
    const again = await b1Kit.ack(judge, "submit_score", { event_id: ev.id, competitor_id: diver, round_number: 1, score: 7 });
    assert.equal(again.ok, true, JSON.stringify(again));
  } finally {
    await features.set("maintenance", false);
    judge.close();
    admin.close();
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// notification:ack is a write too; its HTTP twin gets a 503 in
// maintenance, so the socket one mustn't slip through.
test("maintenance mode drops a socket notification ack, like the HTTP route", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { features } = require("../server.js");
  const st = await setupFixture({ withEvent: false });
  const s = await b1Kit.connect({ token: st.adminToken });
  const statusOf = async (id) => (await pool.query("SELECT status FROM notifications WHERE id = $1", [id])).rows[0].status;
  try {
    const id = (await pool.query(
      "INSERT INTO notifications (user_id, category, title, status) VALUES ($1, 'generic', 'b1 ack', 'sent') RETURNING id",
      [st.adminId],
    )).rows[0].id;
    await features.set("maintenance", true);
    s.emit("notification:ack", { id });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await statusOf(id), "sent", "no write while maintenance is on");

    // And once it's off the same ack lands, so the check above means something.
    await features.set("maintenance", false);
    s.emit("notification:ack", { id });
    const until = Date.now() + 3000;
    while (Date.now() < until && (await statusOf(id)) !== "acknowledged") {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(await statusOf(id), "acknowledged");
  } finally {
    await features.set("maintenance", false);
    s.close();
    await pool.query("DELETE FROM notifications WHERE user_id = $1 AND title = 'b1 ack'", [st.adminId]);
    await teardownFixture(st);
  }
});

test("a null, empty or boolean score is refused on the socket and HTTP paths, never stored as 0", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  const ev = await recordKit.event(st.orgId, { gender: "Female" });
  const diver = await recordKit.diver(st.orgId, null, "female", "Null Score Diver");
  await b1Kit.enter(ev, diver);
  const judgeName = (await pool.query("SELECT username FROM users WHERE id = $1", [ev.judges[0]])).rows[0].username;
  const judge = await b1Kit.connect({ token: await b1Kit.login(judgeName) });
  try {
    for (const score of [null, "", " ", false, true, []]) {
      const out = await b1Kit.ack(judge, "submit_score", { event_id: ev.id, competitor_id: diver, round_number: 1, score });
      assert.equal(out.ok, false, JSON.stringify(score));
      assert.equal(out.error, "bad_score", JSON.stringify(score));
    }
    assert.equal((await pool.query("SELECT 1 FROM scores WHERE event_id = $1", [ev.id])).rows.length, 0);

    const ok = await b1Kit.ack(judge, "submit_score", { event_id: ev.id, competitor_id: diver, round_number: 1, score: "6.5" });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const id = (await pool.query("SELECT id FROM scores WHERE event_id = $1", [ev.id])).rows[0].id;
    for (const score of [null, "", false]) {
      const put = await fetchJson("PUT", `/api/scores/${id}`, { token: st.adminToken, body: { score, reason: "typo" } });
      assert.equal(put.status, 400, `${JSON.stringify(score)}: ${JSON.stringify(put.body)}`);
    }
    const kept = await pool.query("SELECT score::float AS score FROM scores WHERE id = $1", [id]);
    assert.equal(kept.rows[0].score, 6.5);
  } finally {
    judge.close();
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

test("an audit insert that fails inside a transaction doesn't roll the caller's work back", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    // End to end: the proxy hop the app trusts isn't an IP, the event
    // create writes its audit row with it, and the event still has to exist.
    const res = await b1Kit.request("POST", "/api/events", {
      token: st.adminToken,
      headers: { "X-Forwarded-For": "not-an-ip" },
      body: { name: "Audit Rollback Event", gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 6, event_type: "individual" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const ev = await pool.query("SELECT 1 FROM events WHERE id = $1", [res.body.id]);
    assert.equal(ev.rows.length, 1, "the created event was persisted");

    // Straight at the helper: an audit row that can't be written (org_id
    // points nowhere) mustn't turn the parent COMMIT into a ROLLBACK.
    const { recordAudit } = require("../lib/audit");
    const client = await pool.connect();
    const name = `audit-sp-${st.slug}`;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE organisations SET name = $2 WHERE id = $1", [st.orgId, name]);
      await recordAudit(client, {
        org_id: "00000000-0000-4000-8000-000000000000", entity_type: "org", action: "org.renamed",
        entity_name: "x".repeat(300), ip_address: "also-not-an-ip",
      });
      const done = await client.query("COMMIT");
      assert.equal(done.command, "COMMIT");
    } finally {
      client.release();
    }
    const org = await pool.query("SELECT name FROM organisations WHERE id = $1", [st.orgId]);
    assert.equal(org.rows[0].name, name);

    // Outside a transaction (a bare client, no BEGIN) it still writes.
    const bare = await pool.connect();
    try {
      await recordAudit(bare, { org_id: st.orgId, entity_type: "org", action: "org.poked", ip_address: "::ffff:10.0.0.1" });
    } finally {
      bare.release();
    }
    const row = await pool.query("SELECT host(ip_address) AS ip FROM audit_log WHERE org_id = $1 AND action = 'org.poked'", [st.orgId]);
    assert.equal(row.rows.length, 1);
  } finally {
    await pool.query("DELETE FROM audit_log WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// A real `node server.js` in a child process, for the paths that only run
// when server.js is the entry point (boot order, shutdown, env parsing).
const b1Boot = {
  path: require("node:path"),
  // The child's port comes from 20000-29999, below every ephemeral range
  // (Linux 32768-60999, macOS and Windows 49152-65535). Checking a port is
  // free and then letting go of it leaves a gap before the child binds it,
  // and a listen(0) in another test file (they run in parallel) or any
  // outgoing connection draws from the ephemeral range, so a port picked
  // there can be handed straight to someone else. It was on 30 Sep:
  // EADDRINUSE on 56815. The check binds the way server.js does (every
  // interface, no host) and on 127.0.0.1, which the tests call it on: macOS
  // lets the any-address bind succeed next to someone holding 127.0.0.1,
  // and then the health checks would be talking to them.
  async freePort() {
    const net = require("node:net");
    const bindable = (port, host) => new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    for (let i = 0; i < 50; i++) {
      const port = 20000 + Math.floor(Math.random() * 10000);
      if ((await bindable(port)) && (await bindable(port, "127.0.0.1"))) return port;
    }
    throw new Error("no free port in 20000-29999 after 50 tries");
  },
  // A handle on the child that survives a relaunch: waitHealthy() starts it
  // again on a new port if the first one was taken after all, and callers
  // keep using srv.url / srv.child / srv.stop() as before. `firstPort` is
  // only for the test that proves the relaunch works.
  async spawn(env = {}, { firstPort } = {}) {
    const { spawn } = require("node:child_process");
    const root = b1Boot.path.join(__dirname, "..");
    const srv = {
      spawns: 0,
      takenPorts: [],
      async start(port) {
        this.port = port ?? (await b1Boot.freePort());
        this.url = `http://127.0.0.1:${this.port}`;
        this.spawns += 1;
        const childEnv = { ...process.env, PORT: String(this.port), DR_IMPORT_SYNC_HOURS: "0", AUDIT_SNAPSHOT_DIR: "" };
        for (const [k, v] of Object.entries(env)) {
          if (v === null) delete childEnv[k]; else childEnv[k] = String(v);
        }
        const child = spawn(process.execPath, [b1Boot.path.join(root, "server.js")], {
          cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
        });
        this.child = child;
        this._log = "";
        this._gone = false;
        child.stdout.on("data", (d) => { if (this.child === child) this._log += d; });
        child.stderr.on("data", (d) => { if (this.child === child) this._log += d; });
        // 'close', not 'exit': it waits for stdout and stderr to drain, so
        // lostItsPort() never looks at a log that's still missing the error.
        this.exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
        this.exited.then(() => { if (this.child === child) this._gone = true; });
      },
      log() { return this._log; },
      get gone() { return this._gone; },
      // Died at boot because somebody else had the port: worth another go.
      // Any other exit is what the test is there to see.
      lostItsPort() { return this._gone && /EADDRINUSE/.test(this._log); },
      async stop() { if (!this._gone) { this.child.kill("SIGKILL"); await this.exited; } },
    };
    await srv.start(firstPort);
    return srv;
  },
  // GET against a spawned server. Resolves { status, body } or null when
  // nothing is listening (yet).
  get(url, path) {
    return new Promise((resolve) => {
      const req = http.get(url + path, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body = text;
          try { body = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on("error", () => resolve(null));
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
  },
  async waitHealthy(srv, ms = 15000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (srv.gone && srv.lostItsPort() && srv.spawns < 5) {
        srv.takenPorts.push(srv.port);
        await srv.start();
        continue;
      }
      if (srv.gone) throw new Error(`server exited during boot:\n${srv.log()}`);
      const r = await b1Boot.get(srv.url, "/api/health");
      if (r && r.status === 200) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`server never became healthy:\n${srv.log()}`);
  },
};

test("a spawned server whose port gets taken before it binds starts again on another", { timeout: 60000 }, async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  // Stand in for the stranger that grabbed the port: hold one, and hand
  // it to the child as its first port. It hangs up on anyone who calls
  // (the health polls hit it too until the child moves); a socket nobody
  // reads never sees the other end go, and close() would wait on it.
  const net = require("node:net");
  const squatter = net.createServer((conn) => conn.destroy());
  await new Promise((resolve) => squatter.listen(0, resolve));
  const taken = squatter.address().port;
  const srv = await b1Boot.spawn({}, { firstPort: taken });
  try {
    await b1Boot.waitHealthy(srv);
    assert.deepEqual(srv.takenPorts, [taken]);
    assert.equal(srv.spawns, 2);
    assert.notEqual(srv.port, taken);
    assert.ok(srv.port >= 20000 && srv.port < 30000, `port ${srv.port} is outside the ephemeral ranges`);
    assert.equal((await b1Boot.get(srv.url, "/api/health"))?.status, 200);
  } finally {
    await srv.stop();
    await new Promise((resolve) => squatter.close(resolve));
  }
});

test("SIGTERM with a socket connected shuts down cleanly and quickly", { timeout: 60000 }, async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const srv = await b1Boot.spawn();
  let sock;
  try {
    await b1Boot.waitHealthy(srv);
    sock = b1Kit.io(srv.url, { transports: ["websocket"], reconnection: false });
    await new Promise((resolve, reject) => { sock.on("connect", resolve); sock.on("connect_error", reject); });
    const started = Date.now();
    srv.child.kill("SIGTERM");
    const out = await Promise.race([srv.exited, new Promise((r) => setTimeout(() => r(null), 30000))]);
    const took = Date.now() - started;
    assert.ok(out, `still running 30s after SIGTERM:\n${srv.log()}`);
    assert.equal(out.code, 0, srv.log());
    // PM2's kill_timeout is 5s; anything slower gets SIGKILLed mid-drain.
    assert.ok(took < 5000, `took ${took}ms`);
    assert.match(srv.log(), /pg pool drained/);
  } finally {
    sock?.close();
    await srv.stop();
  }
});

test("no request is served before the feature flags have loaded", { timeout: 60000 }, async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { features } = require("../server.js");
  if (!features.enabled("signups")) await features.set("signups", true);
  // Hold feature_flags so the spawned server's features.load() blocks. A
  // server listening in the meantime answers with every flag off
  // (signups is on in this DB), which is the bug.
  const lock = await pool.connect();
  const srv = await b1Boot.spawn();
  const seen = [];
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE feature_flags IN ACCESS EXCLUSIVE MODE");
    const until = Date.now() + 2500;
    while (Date.now() < until && !srv.gone) {
      const r = await b1Boot.get(srv.url, "/api/auth/signups-status");
      if (r) seen.push(r.body);
      await new Promise((res) => setTimeout(res, 25));
    }
    await lock.query("COMMIT");
    await b1Boot.waitHealthy(srv);
    const r = await b1Boot.get(srv.url, "/api/auth/signups-status");
    seen.push(r.body);
    assert.deepEqual(seen.filter((b) => !b || b.enabled !== true), [], "every answer saw the real flag");
  } finally {
    await lock.query("ROLLBACK").catch(() => {});
    lock.release();
    await srv.stop();
  }
});

test("an unwritable AUDIT_SNAPSHOT_DIR only logs a warning, the server stays up", { timeout: 60000 }, async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  // root writes through a 0555 directory, so there'd be no failure to see.
  if (process.getuid?.() === 0) return t.skip("running as root, permissions don't bite");
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(b1Boot.path.join(os.tmpdir(), "b1-snap-"));
  fs.chmodSync(dir, 0o555);
  // Something to write, so the snapshot really opens a file.
  const st = await setupFixture({ withEvent: false });
  await pool.query(
    "INSERT INTO audit_log (org_id, entity_type, action, created_at) VALUES ($1, 'org', 'org.poked', now() - interval '1 hour')",
    [st.orgId],
  );
  const srv = await b1Boot.spawn({ AUDIT_SNAPSHOT_DIR: dir });
  try {
    await b1Boot.waitHealthy(srv);
    const until = Date.now() + 5000;
    while (Date.now() < until && !srv.gone && !/audit snapshot failed/.test(srv.log())) {
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(srv.gone, false, `server died:\n${srv.log()}`);
    assert.match(srv.log(), /audit snapshot failed/);
    const r = await b1Boot.get(srv.url, "/api/health");
    assert.equal(r?.status, 200);
  } finally {
    await srv.stop();
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
    await pool.query("DELETE FROM audit_log WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("audit snapshots pick up where the last one stopped, with no gaps and no repeats", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(b1Boot.path.join(os.tmpdir(), "b1-snap-"));
  const st = await setupFixture({ withEvent: false });
  const add = async (action, age) => (await pool.query(
    `INSERT INTO audit_log (org_id, entity_type, action, created_at)
     VALUES ($1, 'org', $2, now() - $3::interval) RETURNING id`,
    [st.orgId, action, age],
  )).rows[0].id;
  const lines = () => fs.readdirSync(dir).filter((f) => f.startsWith("audit_") && f.endsWith(".jsonl"))
    .flatMap((f) => fs.readFileSync(b1Boot.path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((r) => r.org_id === st.orgId);
  try {
    // A one-second settle window instead of five minutes, so the test
    // doesn't have to wait.
    const snap = require("../lib/audit-snapshot")({ pool, dir, settleSeconds: 1 });
    // Three days old: the boot-time version only ever looked back 24h.
    const old = await add("org.old", "3 days");
    const settled = await add("org.settled", "1 hour");
    await snap.snapshot();
    assert.deepEqual(lines().map((r) => r.id).sort(), [old, settled].sort());
    assert.ok(JSON.parse(fs.readFileSync(b1Boot.path.join(dir, ".snapshot-marks.json"), "utf8")).audit_log);

    const later = await add("org.later", "0 seconds");
    await new Promise((r) => setTimeout(r, 1200));
    const fresh = await add("org.fresh", "0 seconds");
    await snap.snapshot();
    const ids = lines().map((r) => r.id);
    assert.equal(ids.filter((id) => id === old).length, 1, "nothing copied twice");
    assert.ok(ids.includes(later));
    assert.ok(!ids.includes(fresh), "rows younger than the settle window wait for the next run");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await pool.query("DELETE FROM audit_log WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// The rate limits as production runs them (the suite otherwise switches
// them off). A venue's phones share one public IP, so ordinary use from
// one address has to fit.
test("rate limits: a venue's scoreboard loads and sign-ins don't run each other out", { timeout: 90000 }, async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  const srv = await b1Boot.spawn({ RATE_LIMIT_DISABLED: null });
  const post = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(srv.url + p, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(data);
  });
  try {
    await b1Boot.waitHealthy(srv);
    // Forty spectators opening the scoreboard: the (cached) listing, then
    // a completed event's recap and a results CSV.
    for (let i = 0; i < 40; i++) {
      assert.equal((await b1Boot.get(srv.url, "/api/archive"))?.status, 200, `listing #${i + 1}`);
    }
    const nope = "00000000-0000-4000-8000-000000000000";
    assert.notEqual((await b1Boot.get(srv.url, `/api/archive/${nope}/results`))?.status, 429);
    assert.notEqual((await b1Boot.get(srv.url, `/api/events/${nope}/results.csv`))?.status, 429);

    // Twenty-five officials signing in from the venue wifi.
    for (let i = 0; i < 25; i++) {
      assert.equal(await post("/api/auth/login", { username: st.username, password: TEST_PASSWORD }), 200, `login #${i + 1}`);
    }
    // Failed attempts still count, so guessing is still throttled...
    const bad = [];
    for (let i = 0; i < 22; i++) bad.push(await post("/api/auth/login", { username: st.username, password: "wrong-password" }));
    assert.equal(bad.at(-1), 429, JSON.stringify(bad));
    // Routing ignores case and a trailing slash, so those spellings reach
    // the same handler and have to land in the same bucket.
    for (const p of ["/api/auth/login/", "/API/Auth/Login"]) {
      assert.equal(await post(p, { username: st.username, password: "wrong-password" }), 429, p);
    }
    // ...without taking the password-reset flow down with it.
    assert.notEqual(await post("/api/auth/forgot-password", { email: `nobody-${st.slug}@example.test` }), 429);
  } finally {
    await srv.stop();
    await teardownFixture(st);
  }
});

test("a JWT for a user that no longer exists, or a link token, isn't a session", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const ghost = claimKit.jwt.sign(
      { id: crypto.randomUUID(), org_id: st.orgId, org_roles: ["org_admin"], is_system_admin: false, tv: 0 },
      process.env.JWT_SECRET, { expiresIn: "1h" },
    );
    const users = await fetchJson("GET", "/api/users", { token: ghost });
    assert.equal(users.status, 401, JSON.stringify(users.body).slice(0, 200));

    const link = claimKit.jwt.sign({ sub: st.adminId, type: "email_verify" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const inbox = await fetchJson("GET", "/api/notifications/me", { token: link });
    assert.equal(inbox.status, 401);

    // The real session still works.
    assert.equal((await fetchJson("GET", "/api/notifications/me", { token: st.adminToken })).status, 200);
  } finally {
    await teardownFixture(st);
  }
});

// World Aquatics Art 4.1.5: "If two or more Athletes or teams score the
// same number of total points at the end of an event or stage of an
// event, a tie is declared for that particular place." The analytics
// widgets have to agree with the scoreboard on that.
test("diver analytics ranks equal totals as a shared place, like the scoreboard", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    const top = await recordKit.diver(st.orgId, null, "female", "Tie Top");
    const spiky = await recordKit.diver(st.orgId, null, "female", "Tie Spiky");
    const steady = await recordKit.diver(st.orgId, null, "female", "Tie Steady");
    await recordKit.dive(ev, top, 1, dive, 9);
    await recordKit.dive(ev, top, 2, dive, 9);
    // Same total, different shape: 8 + 4 against 6 + 6.
    await recordKit.dive(ev, spiky, 1, dive, 8);
    await recordKit.dive(ev, spiky, 2, dive, 4);
    await recordKit.dive(ev, steady, 1, dive, 6);
    await recordKit.dive(ev, steady, 2, dive, 6);
    const rankOf = async (id) => {
      const r = await fetchJson("GET", `/api/divers/${id}/analytics`, { token: st.adminToken });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.recent_form.find((x) => x.event_id === ev.id)?.rank;
    };
    assert.equal(Number(await rankOf(spiky)), 2);
    assert.equal(Number(await rankOf(steady)), 2, "no single-dive tie-break in WA diving");
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// The live trim drops exactly k marks at each end (lowest judge number
// first on a tie, same as the scoreboard's chips); the judge analytics
// flags have to count the same drops.
test("judge analytics flags exactly the marks the trim drops, ties included", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { JUDGE_PER_DIVE } = require("../db/queries");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    const diver = await recordKit.diver(st.orgId, null, "female", "Unanimous Diver");
    // A unanimous panel: every judge 7.0.
    await recordKit.dive(ev, diver, 1, dive, 7);
    const flags = [];
    for (const j of ev.judges) {
      const r = await pool.query(`SELECT is_dropped, is_dropped_high, is_dropped_low FROM (${JUDGE_PER_DIVE}) x WHERE event_id = '${ev.id}'`, [j, null, null]);
      flags.push(r.rows[0]);
    }
    assert.equal(flags.filter((f) => f.is_dropped).length, 2, JSON.stringify(flags));
    assert.equal(flags.filter((f) => f.is_dropped_high).length, 1);
    assert.equal(flags.filter((f) => f.is_dropped_low).length, 1);
    // Judges 1..5 in order: judge 1 is the low drop, judge 5 the high.
    assert.equal(flags[0].is_dropped_low, true);
    assert.equal(flags[4].is_dropped_high, true);
    assert.deepEqual(flags.slice(1, 4).map((f) => f.is_dropped), [false, false, false]);

    // Two marks in: fewer than 2k+1, so nothing is trimmed and nothing flagged.
    await pool.query("INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 2)", [ev.id, diver, dive]);
    for (const j of ev.judges.slice(0, 2)) {
      await pool.query("INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, 2, 5)", [ev.id, diver, j, dive]);
    }
    const partial = await pool.query(`SELECT is_dropped FROM (${JUDGE_PER_DIVE}) x WHERE event_id = '${ev.id}' AND round_number = 2`, [ev.judges[0], null, null]);
    assert.equal(partial.rows[0].is_dropped, false);
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Events exist weeks before anyone dives in them, so "when" for the
// analytics is when the event took place (its scheduled time, else its
// meet's start date), not when the row was created.
test("analytics date ranges and years follow when the event happened, not when it was created", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { JUDGE_PER_DIVE } = require("../db/queries");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const diver = await recordKit.diver(st.orgId, null, "female", "Dated Diver");
    // Created today, held on 1 June 2020.
    const held = await recordKit.event(st.orgId, { gender: "Female" });
    await pool.query("UPDATE events SET scheduled_at = '2020-06-01T10:00:00Z' WHERE id = $1", [held.id]);
    await recordKit.dive(held, diver, 1, dive, 7);
    // No time of its own, but its meet started on 3 March 2019.
    const meet = (await pool.query(
      "INSERT INTO meets (org_id, name, start_date) VALUES ($1, 'Dated Meet', '2019-03-03') RETURNING id", [st.orgId],
    )).rows[0].id;
    const inMeet = await recordKit.event(st.orgId, { gender: "Female" });
    await pool.query("UPDATE events SET meet_id = $2, scheduled_at = NULL WHERE id = $1", [inMeet.id, meet]);
    await recordKit.dive(inMeet, diver, 1, dive, 6);

    const range = async (from, to) => {
      const r = await fetchJson("GET", `/api/divers/${diver}/analytics?from_date=${from}&to_date=${to}`, { token: st.adminToken });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    const y2020 = await range("2020-01-01", "2020-12-31");
    assert.deepEqual(y2020.recent_form.map((x) => x.event_id), [held.id]);
    assert.deepEqual(y2020.year_over_year.map((x) => x.year), [2020]);
    const y2019 = await range("2019-01-01", "2019-12-31");
    assert.deepEqual(y2019.recent_form.map((x) => x.event_id), [inMeet.id]);
    const all = await range("2000-01-01", "2100-01-01");
    assert.deepEqual(all.year_over_year.map((x) => x.year), [2020, 2019]);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal((await range(today, today)).recent_form.length, 0, "created today, but not held today");

    const profile = await fetchJson("GET", `/api/divers/${diver}/profile?from_date=2020-01-01&to_date=2020-12-31`, { token: st.adminToken });
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body.score_trend.map((x) => x.event_id), [held.id]);

    const judged = await pool.query(`SELECT event_id FROM (${JUDGE_PER_DIVE}) x`, [held.judges[0], "2020-01-01", "2020-12-31"]);
    assert.deepEqual(judged.rows.map((r) => r.event_id), [held.id]);
  } finally {
    await recordKit.cleanup(st.orgId);
    await pool.query("DELETE FROM events WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM meets WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("an impossible from_date is a 400 on the diver profile and analytics", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    for (const p of ["profile", "analytics"]) {
      const r = await fetchJson("GET", `/api/divers/${st.adminId}/${p}?from_date=2026-02-31`, { token: st.adminToken });
      assert.equal(r.status, 400, `${p}: ${JSON.stringify(r.body)}`);
    }
  } finally {
    await teardownFixture(st);
  }
});

test("a malformed or oversized JSON body gets a JSON error, not Express's HTML page", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const bad = await b1Kit.request("POST", "/api/auth/login", { body: "{bad" });
  assert.equal(bad.status, 400);
  assert.match(bad.headers["content-type"], /application\/json/);
  assert.equal(typeof bad.body.error, "string");
  assert.equal(bad.body.code, "bad_json");

  const big = await b1Kit.request("POST", "/api/auth/login", { body: JSON.stringify({ username: "x".repeat(300 * 1024) }) });
  assert.equal(big.status, 413);
  assert.match(big.headers["content-type"], /application\/json/);
  assert.equal(big.body.code, "body_too_large");
  assert.doesNotMatch(big.text, /<html|at \w+ \(/i, "no HTML page, no stack trace");
});

// A hashed chunk that isn't on disk (an old build's, after a deploy) has
// to be a 404. The SPA fallback used to answer it with index.html and a
// 200, which the service worker then cached under the .js URL for good.
test("a missing /assets file is a 404, never the SPA shell", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  for (const p of ["/assets/ManagerView-OLDHASH.js", "/assets/app-OLD.css", "/assets/nested/x.js"]) {
    const r = await b1Kit.request("GET", p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.headers["content-type"] || "", /text\/html/, p);
  }
});

test("TRUST_PROXY=true boots, the way the socket layer already read it", { timeout: 60000 }, async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const srv = await b1Boot.spawn({ TRUST_PROXY: "true" });
  try {
    await b1Boot.waitHealthy(srv);
  } finally {
    await srv.stop();
  }
});

test("event live and results emails skip withdrawn divers and reserves", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  // Put back just the keys we set. Swapping process.env for a plain copy
  // would drop its string coercion for every later test in this file.
  const mailEnv = ["CF_ACCOUNT_ID", "CF_EMAIL_TOKEN", "EMAIL_FROM"];
  const saved = { fetch: global.fetch, env: Object.fromEntries(mailEnv.map((k) => [k, process.env[k]])) };
  try {
    const dive = await recordKit.threeMetreDive();
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    const who = {};
    for (const name of ["diving", "withdrawn", "reserve"]) {
      who[name] = await recordKit.diver(st.orgId, null, "female", `Mail ${name}`);
      await pool.query("UPDATE users SET email = $2 WHERE id = $1", [who[name], `${name}-${st.slug}@example.test`]);
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number, withdrawn_at, is_reserve)
         VALUES ($1, $2, $3, 1, $4, $5)`,
        [ev.id, who[name], dive, name === "withdrawn" ? new Date() : null, name === "reserve"],
      );
    }
    Object.assign(process.env, { CF_ACCOUNT_ID: "acct-test", CF_EMAIL_TOKEN: "token-test", EMAIL_FROM: "noreply@example.test" });
    const sent = [];
    global.fetch = async (_url, opts) => { sent.push(JSON.parse(opts.body).to); return { ok: true, json: async () => ({}) }; };
    const email = require("../lib/email")({ pool });
    await email.sendEventStartedEmails({ id: ev.id, name: "Mail Test 3m" });
    await email.sendEventResultsEmails({ id: ev.id, name: "Mail Test 3m" });
    assert.deepEqual(sent, [`diving-${st.slug}@example.test`, `diving-${st.slug}@example.test`]);
  } finally {
    global.fetch = saved.fetch;
    for (const [k, v] of Object.entries(saved.env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// =====================================================================
// Competition fixtures (Control Room, sockets, stages). One BRN org
// per test, built straight in SQL with signed tokens, so the socket
// tests don't spend the login limiter or wait on bcrypt. BRN isn't
// used by any other suite, so a stray row can't leak into someone
// else's country lookups.
// =====================================================================
const compKit = {
  jwt: require("jsonwebtoken"),
  ioClient: require("socket.io-client").io,
  async org(tag) {
    const slug = `brn-${tag}-${crypto.randomBytes(3).toString("hex")}`;
    const r = await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status, claim_state)
       VALUES ($1, 'BRN', $2, 'active', 'claimed') RETURNING id`,
      [`Brunei ${slug}`, slug],
    );
    return r.rows[0].id;
  },
  async user(orgId, name, roles, { sysadmin = false, clubId = null } = {}) {
    const r = await pool.query(
      `INSERT INTO users (username, full_name, org_id, email_verified_at, is_system_admin, club_id)
       VALUES ($1, $2, $3, now(), $4, $5) RETURNING id, token_version`,
      [`${name}-${crypto.randomBytes(4).toString("hex")}`.slice(0, 50), name, orgId, sysadmin, clubId],
    );
    for (const role of roles) {
      await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)", [r.rows[0].id, orgId, role]);
    }
    const u = { id: r.rows[0].id, full_name: name, org_id: orgId, org_roles: roles, is_system_admin: sysadmin, tv: r.rows[0].token_version };
    u.token = compKit.jwt.sign(
      { id: u.id, username: name, full_name: name, org_id: orgId, org_roles: roles, is_system_admin: sysadmin, tv: u.tv },
      process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" },
    );
    return u;
  },
  async event(orgId, fields = {}) {
    const f = {
      name: "BRN event", gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 3,
      event_type: "individual", event_format: "final", status: "Upcoming", ...fields,
    };
    const cols = Object.keys(f);
    const r = await pool.query(
      `INSERT INTO events (org_id, ${cols.join(", ")})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`,
      [orgId, ...cols.map((c) => f[c])],
    );
    return r.rows[0].id;
  },
  async dives(n) {
    return (await pool.query("SELECT id FROM dive_directory WHERE height = 3 ORDER BY dive_code, id LIMIT $1", [n]))
      .rows.map((r) => r.id);
  },
  // One competitor_dive_lists row per round.
  async enter(eventId, competitorId, diveIds, extra = {}) {
    for (let i = 0; i < diveIds.length; i++) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id, display_order, partner_id, team_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [eventId, competitorId, i + 1, diveIds[i], extra.display_order ?? null, extra.partner_id ?? null, extra.team_id ?? null],
      );
    }
  },
  async panel(eventId, judges) {
    for (let i = 0; i < judges.length; i++) {
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)",
        [eventId, judges[i].id, i + 1]);
    }
  },
  async score(eventId, competitorId, round, judge, score) {
    await pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, round_number, score)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, competitorId, judge.id, round, score],
    );
  },
  socket(token) {
    const s = compKit.ioClient(baseUrl, {
      auth: { token: token || "spectator" }, transports: ["websocket"], reconnection: false, forceNew: true,
    });
    return new Promise((resolve, reject) => {
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });
  },
  // Emit and resolve with the ack, or "timeout" if none comes.
  ask(sock, name, data, ms = 3000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), ms);
      sock.emit(name, data, (reply) => { clearTimeout(timer); resolve(reply); });
    });
  },
  // Collect every payload of one event a socket hears for `ms`.
  listen(sock, name, ms = 400) {
    const got = [];
    const fn = (p) => got.push(p);
    sock.on(name, fn);
    return new Promise((resolve) => setTimeout(() => { sock.off(name, fn); resolve(got); }, ms));
  },
  async cleanup(...orgIds) {
    const ids = orgIds.filter(Boolean);
    if (!ids.length) return;
    try {
      await pool.query("DELETE FROM events WHERE org_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM meets WHERE org_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM users WHERE org_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM clubs WHERE org_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM organisations WHERE id = ANY($1::uuid[])", [ids]);
    } catch (err) {
      console.warn(`[cleanup] BRN orgs: ${err.message}`);
    }
  },
};

test("sockets: a junk event id is refused and the server stays up", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("junk");
  const socks = [];
  try {
    // A plain diver, no Control Room role at all.
    const diver = await compKit.user(orgId, "Junk Diver", ["diver"]);
    const s = await compKit.socket(diver.token);
    socks.push(s);
    for (const ev of ["set_active_diver", "meet_hold", "meet_resume", "announce_score",
      "referee_failed_dive", "referee_cap_scores", "referee_redive"]) {
      const reply = await compKit.ask(s, ev, { event_id: "not-a-uuid", competitor_id: "x", round_number: 1 });
      assert.equal(reply?.ok, false, `${ev} answers, and says no`);
    }
    s.emit("claim_event_control", { event_id: "not-a-uuid" });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(s.connected, "still connected after every junk emit");
    // The server's still there to answer an ordinary request.
    const health = await fetchJson("GET", "/api/health");
    assert.equal(health.status, 200);
  } finally {
    socks.forEach((s) => s.close());
    await compKit.cleanup(orgId);
  }
});

test("sockets: maintenance mode refuses every live write except a sysadmin's", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { features } = require("../server.js");
  const realEnabled = features.enabled;
  const orgId = await compKit.org("maint");
  const socks = [];
  try {
    const manager = await compKit.user(orgId, "Maint Manager", ["meet_manager"]);
    const judge = await compKit.user(orgId, "Maint Judge", ["judge"]);
    const diver = await compKit.user(orgId, "Maint Diver", ["diver"]);
    const sys = await compKit.user(orgId, "Maint Sysadmin", [], { sysadmin: true });
    const eventId = await compKit.event(orgId, { status: "Live" });
    await compKit.enter(eventId, diver.id, await compKit.dives(3), { display_order: 1 });
    await compKit.panel(eventId, [judge]);
    const [ms, js, ss] = await Promise.all([manager, judge, sys].map((u) => compKit.socket(u.token)));
    socks.push(ms, js, ss);
    js.emit("subscribe_event", { event_id: eventId });

    // Only this process sees the flag, so no other suite's server is
    // locked down while this runs.
    features.enabled = (k) => (k === "maintenance" ? true : realEnabled.call(features, k));
    const payload = { event_id: eventId, competitor_id: diver.id, round_number: 1 };
    for (const ev of ["meet_hold", "set_active_diver", "announce_score", "referee_failed_dive", "meet_resume"]) {
      assert.deepEqual(await compKit.ask(ms, ev, payload), { ok: false, error: "maintenance" }, ev);
    }
    const sub = await compKit.ask(js, "submit_score", { ...payload, score: 6.5 });
    assert.equal(sub.ok, false);
    assert.equal(sub.error, "maintenance");
    const signals = compKit.listen(js, "judge_signal");
    js.emit("judge_signal", { ...payload, signaled: true });
    assert.equal((await signals).length, 0, "no judge signal goes out");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM scores WHERE event_id = $1", [eventId])).rows[0].n, 0);
    // A sysadmin keeps working, on purpose.
    assert.deepEqual(await compKit.ask(ss, "meet_hold", payload), { ok: true });
    assert.deepEqual(await compKit.ask(ss, "meet_resume", payload), { ok: true });

    features.enabled = realEnabled;
    const after = await compKit.ask(js, "submit_score", { ...payload, score: 6.5 });
    assert.equal(after.ok, true, "back to normal once it's off");
  } finally {
    features.enabled = realEnabled;
    socks.forEach((s) => s.close());
    await compKit.cleanup(orgId);
  }
});

test("referee calls hold the awards that land after them (WA 8.6.6, 8.4.7)", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("ref");
  const socks = [];
  try {
    const referee = await compKit.user(orgId, "Ref Referee", ["referee"]);
    const j1 = await compKit.user(orgId, "Ref Judge One", ["judge"]);
    const j2 = await compKit.user(orgId, "Ref Judge Two", ["judge"]);
    const diver = await compKit.user(orgId, "Ref Diver", ["diver"]);
    const eventId = await compKit.event(orgId, { status: "Live" });
    await compKit.enter(eventId, diver.id, await compKit.dives(3), { display_order: 1 });
    await compKit.panel(eventId, [j1, j2]);
    const [rs, s1, s2] = await Promise.all([referee, j1, j2].map((u) => compKit.socket(u.token)));
    socks.push(rs, s1, s2);
    const dive = (round) => ({ event_id: eventId, competitor_id: diver.id, round_number: round });
    const stored = async (round) => Object.fromEntries((await pool.query(
      "SELECT judge_id, score::float AS score FROM scores WHERE event_id = $1 AND round_number = $2",
      [eventId, round],
    )).rows.map((r) => [r.judge_id, r.score]));

    // Round 1: one award in, Failed, then the rest of the panel.
    assert.equal((await compKit.ask(s1, "submit_score", { ...dive(1), score: 7.5 })).ok, true);
    assert.deepEqual(await compKit.ask(rs, "referee_failed_dive", dive(1)), { ok: true });
    const late = await compKit.ask(s2, "submit_score", { ...dive(1), score: 8 });
    assert.equal(late.ok, true);
    assert.equal(late.response.score, 0, "the judge is told what was stored");
    assert.deepEqual(await stored(1), { [j1.id]: 0, [j2.id]: 0 });

    // Round 2: the cap goes in before anyone scores, which is the
    // order WA 8.4.7 describes. It's still on the record.
    assert.deepEqual(await compKit.ask(rs, "referee_cap_scores", { ...dive(2), cap_value: 2 }), { ok: true });
    const callRow = (await pool.query(
      "SELECT judge_id, reason FROM score_audit_log WHERE event_id = $1 AND round_number = 2",
      [eventId],
    )).rows;
    assert.deepEqual(callRow, [{ judge_id: null, reason: "referee:cap(2)" }]);
    await compKit.ask(s1, "submit_score", { ...dive(2), score: 6 });
    await compKit.ask(s2, "submit_score", { ...dive(2), score: 1.5 });
    assert.deepEqual(await stored(2), { [j1.id]: 2, [j2.id]: 1.5 });
    // Scoring again after the call doesn't get round it either.
    await compKit.ask(s1, "submit_score", { ...dive(2), score: 9 });
    assert.deepEqual(await stored(2), { [j1.id]: 2, [j2.id]: 1.5 });
    const heldReason = (await pool.query(
      `SELECT reason FROM score_audit_log
        WHERE event_id = $1 AND round_number = 2 AND judge_id = $2 AND action = 'insert'`,
      [eventId, j1.id],
    )).rows[0]?.reason;
    assert.match(heldReason || "", /referee:cap\(2\).*6.*2/);

    // Round 3: Failed, then a redive. The new dive is scored as it comes.
    await compKit.ask(rs, "referee_failed_dive", dive(3));
    await compKit.ask(rs, "referee_redive", dive(3));
    await compKit.ask(s1, "submit_score", { ...dive(3), score: 7 });
    assert.deepEqual(await stored(3), { [j1.id]: 7 });
  } finally {
    socks.forEach((s) => s.close());
    await compKit.cleanup(orgId);
  }
});

// The same thing through the sockets a meet actually uses. The rehearsal
// found "403C 0.00" in the national, club and personal books after a
// Failed call. A dive that holds a book has to lose it the moment the call
// lands, and one failed before the panel scored can't get into one.
test("records: a referee Failed call takes a dive's record away and never sets one", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("zero");
  const socks = [];
  try {
    const referee = await compKit.user(orgId, "Zero Referee", ["referee"]);
    const judges = [];
    for (let i = 1; i <= 5; i++) judges.push(await compKit.user(orgId, `Zero Judge ${i}`, ["judge"]));
    const ada = await compKit.user(orgId, "Zero Ada", ["diver"]);
    const bea = await compKit.user(orgId, "Zero Bea", ["diver"]);
    const cat = await compKit.user(orgId, "Zero Cat", ["diver"]);
    const eventId = await compKit.event(orgId, { status: "Live", gender: "Female", total_rounds: 1 });
    const dives = await compKit.dives(1);
    for (const d of [ada, bea, cat]) await compKit.enter(eventId, d.id, dives);
    await compKit.panel(eventId, judges);
    const rs = await compKit.socket(referee.token);
    socks.push(rs);
    const js = await Promise.all(judges.map((j) => compKit.socket(j.token)));
    socks.push(...js);
    const dive = (who) => ({ event_id: eventId, competitor_id: who.id, round_number: 1 });
    const scoreAll = async (who, score) => {
      for (const j of js) assert.equal((await compKit.ask(j, "submit_score", { ...dive(who), score })).ok, true);
    };
    const national = async () => (await pool.query(
      "SELECT holder_id, prev_score::float FROM records_federation WHERE org_id = $1", [orgId],
    )).rows;
    const personal = async (who) => (await pool.query(
      "SELECT score::float FROM records_personal WHERE user_id = $1", [who.id],
    )).rows;
    // The records check runs after the ack, not before it.
    const settle = async (ok) => {
      for (let i = 0; i < 60; i++) {
        if (await ok()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };

    await scoreAll(ada, 6);
    assert.ok(await settle(async () => (await national())[0]?.holder_id === ada.id), "Ada sets the first mark");
    await scoreAll(bea, 7);
    assert.ok(await settle(async () => (await national())[0]?.holder_id === bea.id), "Bea beats it");

    // Failed after the panel scored: the book goes back to Ada, and Bea
    // doesn't keep a 0.00 personal best.
    assert.deepEqual(await compKit.ask(rs, "referee_failed_dive", dive(bea)), { ok: true });
    assert.ok(await settle(async () => (await national())[0]?.holder_id === ada.id), JSON.stringify(await national()));
    assert.deepEqual(await national(), [{ holder_id: ada.id, prev_score: null }]);
    assert.ok(await settle(async () => (await personal(bea)).length === 0), JSON.stringify(await personal(bea)));

    // Failed before anyone scored: the held awards come to nothing.
    assert.deepEqual(await compKit.ask(rs, "referee_failed_dive", dive(cat)), { ok: true });
    await scoreAll(cat, 9);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(await personal(cat), []);
    assert.deepEqual(await national(), [{ holder_id: ada.id, prev_score: null }]);
  } finally {
    socks.forEach((s) => s.close());
    await recordKit.cleanup(orgId);
    await compKit.cleanup(orgId);
  }
});

test("synchro pairs entered through the portal are one entry per round", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("sync");
  try {
    const manager = await compKit.user(orgId, "Sync Manager", ["meet_manager"]);
    const a = await compKit.user(orgId, "Sync Diver A", ["diver"]);
    const b = await compKit.user(orgId, "Sync Diver B", ["diver"]);
    const c = await compKit.user(orgId, "Sync Diver C", ["diver"]);
    const eventId = await compKit.event(orgId, { event_type: "synchro_pair", number_of_judges: 9 });
    const list = (await compKit.dives(3)).map((dive_id, i) => ({ dive_id, round_number: i + 1 }));
    const submit = (u, partner) => fetchJson("POST", "/api/competitor/submit-list", {
      token: u.token, body: { event_id: eventId, dives: list, partner_id: partner.id },
    });

    // B invites A, A answers with B: the pair is confirmed.
    assert.equal((await submit(b, a)).body.pairing.status, "pending");
    assert.equal((await submit(a, b)).body.pairing.status, "auto_confirmed");
    const rows = async () => (await pool.query(
      `SELECT competitor_id, partner_id, round_number FROM competitor_dive_lists
        WHERE event_id = $1 ORDER BY round_number`, [eventId])).rows;
    assert.deepEqual((await rows()).map((r) => [r.competitor_id, r.partner_id]),
      [[b.id, a.id], [b.id, a.id], [b.id, a.id]], "the inviter leads, one row a round");

    // The Control Room queue has the pair once per round.
    const roster = await fetchJson("GET", `/api/events/${eventId}/roster`, { token: manager.token });
    assert.equal(roster.status, 200);
    assert.equal(roster.body.length, 3);

    // The partner still finds the entry from their side.
    const status = await fetchJson("GET", `/api/competitor/list-status?event_id=${eventId}`, { token: a.token });
    assert.equal(status.body.entered, true);
    assert.equal(status.body.dives.length, 3);
    const dash = await fetchJson("GET", "/api/dashboard", { token: a.token });
    assert.ok(dash.body.diver_event_ids.includes(eventId));

    // A re-pairs with C. B's old pair goes; A's new one is one row a round.
    assert.equal((await submit(a, c)).body.pairing.status, "pending");
    const pending = await fetchJson("GET", "/api/competitor/pending-pairings", { token: c.token });
    const invite = (pending.body.incoming || pending.body).find((p) => p.event_id === eventId);
    assert.ok(invite, "C sees A's invite");
    const acc = await fetchJson("POST", `/api/competitor/pairings/${invite.id}/accept`, { token: c.token });
    assert.equal(acc.status, 200);
    assert.deepEqual((await rows()).map((r) => [r.competitor_id, r.partner_id]),
      [[a.id, c.id], [a.id, c.id], [a.id, c.id]]);
  } finally {
    await compKit.cleanup(orgId);
  }
});

// A Completed preliminary with a final hanging off it, and `divers`
// scored by a 3-judge panel: `totals[i]` is what each judge gave
// diver i in every round. Returns ids for the advance tests.
compKit.stage = async function stage(orgId, tag, { divers, totals, eventType = "individual", partners = [] }) {
  const manager = await compKit.user(orgId, `${tag} Manager`, ["org_admin"]);
  const judges = [];
  for (let i = 0; i < 3; i++) judges.push(await compKit.user(orgId, `${tag} Judge ${i + 1}`, ["judge"]));
  const prelim = await compKit.event(orgId, {
    name: `${tag} prelim`, event_format: "preliminary", event_type: eventType,
    number_of_judges: 3, total_rounds: 2,
  });
  const final = await compKit.event(orgId, {
    name: `${tag} final`, event_format: "final", event_type: eventType,
    number_of_judges: 3, total_rounds: 2, parent_event_id: prelim,
  });
  await compKit.panel(prelim, judges);
  const dives = await compKit.dives(2);
  for (let i = 0; i < divers.length; i++) {
    await compKit.enter(prelim, divers[i].id, dives, { display_order: i + 1, partner_id: partners[i]?.id ?? null });
    for (const round of [1, 2]) {
      for (const j of judges) await compKit.score(prelim, divers[i].id, round, j, totals[i]);
    }
  }
  await pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [prelim]);
  return { manager, prelim, final };
};

test("advance: a field smaller than top_n takes everyone, with no reserves to spare", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("adv");
  try {
    const divers = [];
    for (let i = 0; i < 4; i++) divers.push(await compKit.user(orgId, `Adv Diver ${i + 1}`, ["diver"]));
    const { manager, prelim, final } = await compKit.stage(orgId, "Adv", { divers, totals: [8, 7, 6, 5] });
    // The usual WA final shape, 12 plus 2 reserves, on a club-sized field.
    const r = await fetchJson("POST", `/api/events/${prelim}/advance`, {
      token: manager.token, body: { top_n: 12, reserves: 2, dive_order: "reverse" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const seeded = (await pool.query(
      `SELECT competitor_id, bool_or(is_reserve) AS reserve FROM competitor_dive_lists
        WHERE event_id = $1 GROUP BY competitor_id`, [final])).rows;
    assert.equal(seeded.length, 4);
    assert.ok(seeded.every((s) => !s.reserve), "nobody's left over to be a reserve");
  } finally {
    await compKit.cleanup(orgId);
  }
});

test("advance and H2H seeding leave a withdrawn diver out", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("wd");
  try {
    const divers = [];
    for (let i = 0; i < 3; i++) divers.push(await compKit.user(orgId, `Wd Diver ${i + 1}`, ["diver"]));
    const { manager, prelim, final } = await compKit.stage(orgId, "Wd", { divers, totals: [8, 7, 6] });
    // The second diver pulled out injured after scoring (coach withdraw
    // marks every row).
    await pool.query(
      "UPDATE competitor_dive_lists SET withdrawn_at = now() WHERE event_id = $1 AND competitor_id = $2",
      [prelim, divers[1].id],
    );
    const r = await fetchJson("POST", `/api/events/${prelim}/advance`, {
      token: manager.token, body: { top_n: 3, reserves: 0 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const seeded = (await pool.query(
      "SELECT DISTINCT competitor_id FROM competitor_dive_lists WHERE event_id = $1", [final])).rows
      .map((row) => row.competitor_id).sort();
    assert.deepEqual(seeded, [divers[0].id, divers[2].id].sort());

    const h2h = await compKit.event(orgId, {
      name: "Wd H2H", event_format: "super_final_h2h", number_of_judges: 3, total_rounds: 3,
      parent_event_id: prelim,
    });
    const preview = await fetchJson("GET", `/api/events/${h2h}/seed-h2h/preview?max_per_org=12`, { token: manager.token });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.ranked.map((row) => row.competitor_id).sort(), [divers[0].id, divers[2].id].sort());
  } finally {
    await compKit.cleanup(orgId);
  }
});

test("advance carries a synchro pair's partner, and won't split up a team event", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("advsync");
  try {
    const leads = [];
    const partners = [];
    for (let i = 0; i < 2; i++) {
      leads.push(await compKit.user(orgId, `AdvSync Lead ${i + 1}`, ["diver"]));
      partners.push(await compKit.user(orgId, `AdvSync Partner ${i + 1}`, ["diver"]));
    }
    const { manager, prelim, final } = await compKit.stage(orgId, "AdvSync", {
      divers: leads, partners, totals: [8, 7], eventType: "synchro_pair",
    });
    const r = await fetchJson("POST", `/api/events/${prelim}/advance`, {
      token: manager.token, body: { top_n: 2, reserves: 0 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pairs = (await pool.query(
      `SELECT DISTINCT competitor_id, partner_id FROM competitor_dive_lists WHERE event_id = $1`, [final])).rows;
    assert.deepEqual(
      pairs.map((p) => `${p.competitor_id}|${p.partner_id}`).sort(),
      [0, 1].map((i) => `${leads[i].id}|${partners[i].id}`).sort(),
    );

    // A team event ranks its members one by one, which isn't how teams
    // go through. Refuse rather than seed a final of loose divers.
    const team = await compKit.stage(orgId, "AdvTeam", { divers: partners, totals: [6, 5], eventType: "team" });
    const tr = await fetchJson("POST", `/api/events/${team.prelim}/advance`, {
      token: team.manager.token, body: { top_n: 2, reserves: 0 },
    });
    assert.equal(tr.status, 400);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM competitor_dive_lists WHERE event_id = $1", [team.final])).rows[0].n, 0);
  } finally {
    await compKit.cleanup(orgId);
  }
});

test("a visiting federation's divers see an Upcoming event's prescribed dives", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const hostOrg = await compKit.org("host");
  const guestOrg = await compKit.org("guest");
  const otherOrg = await compKit.org("other");
  try {
    const guest = await compKit.user(guestOrg, "Guest Diver", ["diver"]);
    const outsider = await compKit.user(otherOrg, "Outside Diver", ["diver"]);
    const eventId = await compKit.event(hostOrg, { name: "BRN International" });
    await pool.query("INSERT INTO event_participating_orgs (event_id, org_id) VALUES ($1, $2)", [eventId, guestOrg]);
    const [dive] = await compKit.dives(1);
    await pool.query("INSERT INTO event_round_dives (event_id, round_number, dive_id) VALUES ($1, 1, $2)", [eventId, dive]);

    const rd = await fetchJson("GET", `/api/events/${eventId}/round-dives`, { token: guest.token });
    assert.equal(rd.status, 200, JSON.stringify(rd.body));
    assert.equal(rd.body.length, 1);
    assert.equal(rd.body[0].dive_id, dive);
    const po = await fetchJson("GET", `/api/events/${eventId}/participating-orgs`, { token: guest.token });
    assert.deepEqual(po.body.map((o) => o.org_id), [guestOrg]);

    // A federation that isn't on the list still sees nothing.
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/round-dives`, { token: outsider.token })).status, 404);
    assert.deepEqual((await fetchJson("GET", `/api/events/${eventId}/participating-orgs`, { token: outsider.token })).body, []);
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/round-dives`)).status, 404);
  } finally {
    await compKit.cleanup(hostOrg, guestOrg, otherOrg);
  }
});

test("an event's dive-by-dive history is hidden while the scoreboard hides it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("hist");
  const otherOrg = await compKit.org("histx");
  try {
    const manager = await compKit.user(orgId, "Hist Manager", ["meet_manager"]);
    const outsider = await compKit.user(otherOrg, "Hist Outsider", ["meet_manager"]);
    const judge = await compKit.user(orgId, "Hist Judge", ["judge"]);
    const diver = await compKit.user(orgId, "Hist Diver", ["diver"]);
    // A dry run: scored while Live, then flipped back to Upcoming.
    const eventId = await compKit.event(orgId, { number_of_judges: 3 });
    await compKit.enter(eventId, diver.id, await compKit.dives(3), { display_order: 1 });
    await compKit.panel(eventId, [judge]);
    await compKit.score(eventId, diver.id, 1, judge, 7);

    assert.equal((await fetchJson("GET", `/api/scoreboard/${eventId}`)).status, 404, "the scoreboard hides it");
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/history`)).status, 404);
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/history`, { token: outsider.token })).status, 404);
    const own = await fetchJson("GET", `/api/events/${eventId}/history`, { token: manager.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.length, 1, "the host's staff still see the dry run");

    await pool.query("UPDATE events SET status = 'Live' WHERE id = $1", [eventId]);
    assert.equal((await fetchJson("GET", `/api/events/${eventId}/history`)).body.length, 1, "public once Live");
    assert.equal((await fetchJson("GET", "/api/events/not-a-uuid/history")).status, 400);
  } finally {
    await compKit.cleanup(orgId, otherOrg);
  }
});

test("sockets: the live diver goes out without payment or pending-club details", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("pay");
  const socks = [];
  try {
    const manager = await compKit.user(orgId, "Pay Manager", ["meet_manager"]);
    const club = (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code, status) VALUES ($1, 'Waiting Club', $2, 'pending') RETURNING id",
      [orgId, `W${crypto.randomBytes(2).toString("hex")}`.toUpperCase()],
    )).rows[0].id;
    const diver = await compKit.user(orgId, "Pay Diver", ["diver"], { clubId: club });
    const eventId = await compKit.event(orgId, { status: "Live" });
    await compKit.enter(eventId, diver.id, await compKit.dives(3), { display_order: 1 });
    const roster = await fetchJson("GET", `/api/events/${eventId}/roster`, { token: manager.token });
    const row = roster.body[0];
    assert.equal(row.club_name, "Waiting Club", "staff see the pending club, on purpose");

    const [ms, spectator] = await Promise.all([compKit.socket(manager.token), compKit.socket()]);
    socks.push(ms, spectator);
    spectator.emit("subscribe_event", { event_id: eventId });
    await new Promise((r) => setTimeout(r, 100));
    const heard = compKit.listen(spectator, "state_update");
    // What ControlViewV2 sends: the roster row as it came.
    assert.deepEqual(await compKit.ask(ms, "set_active_diver", { ...row, status: "ready" }), { ok: true });
    const [payload] = await heard;
    assert.ok(payload, "the spectator hears the new diver");
    assert.equal(payload.competitor_id, diver.id);
    assert.equal(payload.full_name, "Pay Diver");
    for (const k of ["paid_entry", "competitor_org_id", "competitor_org_name", "dive_list_id"]) {
      assert.ok(!(k in payload), `${k} stays in the Control Room`);
    }
    assert.equal(payload.club_name, null);
    assert.equal(payload.club_code, null);
    // Same on the copy kept for late joiners (and event_live_state).
    const late = await compKit.socket();
    socks.push(late);
    const replay = compKit.listen(late, "state_update");
    late.emit("get_active_diver", { event_id: eventId });
    const [kept] = await replay;
    assert.ok(kept && !("paid_entry" in kept));
    assert.equal(kept.club_name, null);
  } finally {
    socks.forEach((s) => s.close());
    await compKit.cleanup(orgId);
  }
});

test("sockets: a new connection only hears its own events' live state", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("scope");
  const otherOrg = await compKit.org("scopex");
  const socks = [];
  const open = async (token) => { const s = await compKit.socket(token); socks.push(s); return s; };
  // Listening from before the handshake, so a replay sent straight on
  // connect is caught.
  const connectAndHear = (token, name) => new Promise((resolve) => {
    const s = compKit.ioClient(baseUrl, {
      auth: { token: token || "spectator" }, transports: ["websocket"], reconnection: false, forceNew: true,
    });
    socks.push(s);
    const got = [];
    s.on(name, (p) => got.push(p));
    s.once("connect", () => setTimeout(() => resolve(got), 500));
  });
  try {
    const manager = await compKit.user(orgId, "Scope Manager", ["meet_manager"]);
    const judge = await compKit.user(orgId, "Scope Judge", ["judge"]);
    const clubDiver = await compKit.user(orgId, "Scope Fan", ["diver"]);
    const stranger = await compKit.user(otherOrg, "Scope Stranger", ["meet_manager"]);
    const diver = await compKit.user(orgId, "Scope Diver", ["diver"]);
    const eventId = await compKit.event(orgId, { status: "Live" });
    await compKit.enter(eventId, diver.id, await compKit.dives(3), { display_order: 1 });
    await compKit.panel(eventId, [judge]);
    const ms = await open(manager.token);
    const row = (await fetchJson("GET", `/api/events/${eventId}/roster`, { token: manager.token })).body[0];
    assert.deepEqual(await compKit.ask(ms, "set_active_diver", { ...row, status: "ready" }), { ok: true });

    const mine = (got) => got.filter((p) => p.event_id === eventId);
    assert.equal(mine(await connectAndHear(null, "state_update")).length, 0, "an anonymous socket hears nothing unasked");
    assert.equal(mine(await connectAndHear(stranger.token, "state_update")).length, 0, "nor does another federation");
    assert.equal(mine(await connectAndHear(clubDiver.token, "state_update")).length, 0, "nor a diver who isn't running it");
    assert.equal(mine(await connectAndHear(judge.token, "state_update")).length, 1, "the panel judge gets it back on reconnect");
    assert.equal(mine(await connectAndHear(manager.token, "state_update")).length, 1, "so does the Control Room");
    // Anyone can still ask for one event by id, the scoreboard does.
    const asker = await open(null);
    const asked = compKit.listen(asker, "state_update");
    asker.emit("get_active_diver", { event_id: eventId });
    assert.equal(mine(await asked).length, 1);

    // Status flips go to the host's people, not to every socket.
    const flipId = await compKit.event(orgId, { name: "Scope flip" });
    const [anon, other, same] = await Promise.all([open(null), open(stranger.token), open(clubDiver.token)]);
    const heard = [anon, other, same].map((s) => compKit.listen(s, "event_status_changed", 600));
    const flip = await fetchJson("PUT", `/api/events/${flipId}/status`, {
      token: (await compKit.user(orgId, "Scope Admin", ["org_admin"])).token, body: { status: "Live" },
    });
    assert.equal(flip.status, 200, JSON.stringify(flip.body));
    const [a, o, s] = await Promise.all(heard);
    assert.equal(a.filter((p) => p.event_id === flipId).length, 0, "not to anonymous sockets");
    assert.equal(o.filter((p) => p.event_id === flipId).length, 0, "not to another federation");
    assert.equal(s.filter((p) => p.event_id === flipId).length, 1, "the host org's dashboards hear it");
  } finally {
    socks.forEach((s) => s.close());
    await compKit.cleanup(orgId, otherOrg);
  }
});

test("score correction: the new score and its audit row land together", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("corr");
  try {
    const admin = await compKit.user(orgId, "Corr Admin", ["org_admin"]);
    const judge = await compKit.user(orgId, "Corr Judge", ["judge"]);
    const diver = await compKit.user(orgId, "Corr Diver", ["diver"]);
    const eventId = await compKit.event(orgId, { status: "Live", number_of_judges: 3 });
    await compKit.enter(eventId, diver.id, await compKit.dives(3), { display_order: 1 });
    await compKit.panel(eventId, [judge]);
    await compKit.score(eventId, diver.id, 1, judge, 7);
    const scoreId = (await pool.query("SELECT id FROM scores WHERE event_id = $1", [eventId])).rows[0].id;

    // A half-filled form's null isn't a zero.
    const bad = await fetchJson("PUT", `/api/scores/${scoreId}`, { token: admin.token, body: { score: null } });
    assert.equal(bad.status, 400);

    const r = await fetchJson("PUT", `/api/scores/${scoreId}`, {
      token: admin.token, body: { score: 6.5, reason: "judge typo" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.old_score, r.body.new_score], [7, 6.5]);
    const audit = (await pool.query(
      `SELECT old_score::float AS old_score, new_score::float AS new_score, reason,
              server_committed_at IS NOT NULL AS committed
         FROM score_audit_log WHERE score_id = $1`, [scoreId])).rows;
    assert.deepEqual(audit, [{ old_score: 7, new_score: 6.5, reason: "judge typo", committed: true }]);
    assert.equal((await pool.query("SELECT score::float AS s FROM scores WHERE id = $1", [scoreId])).rows[0].s, 6.5);
  } finally {
    await compKit.cleanup(orgId);
  }
});

test("sockets: a judge's sync that loses to a manual entry is acked once", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("manual");
  const socks = [];
  try {
    const manager = await compKit.user(orgId, "Manual Manager", ["meet_manager"]);
    const judge = await compKit.user(orgId, "Manual Judge", ["judge"]);
    const diver = await compKit.user(orgId, "Manual Diver", ["diver"]);
    const eventId = await compKit.event(orgId, { status: "Live", number_of_judges: 3 });
    await compKit.enter(eventId, diver.id, await compKit.dives(3), { display_order: 1 });
    await compKit.panel(eventId, [judge]);
    // Typed in by the operator during an outage.
    const me = await fetchJson("POST", "/api/scores/manual-entry", {
      token: manager.token,
      body: { event_id: eventId, competitor_id: diver.id, round_number: 1, judge_id: judge.id, score: 7, reason: "outage" },
    });
    assert.ok([200, 201].includes(me.status), JSON.stringify(me.body));

    const js = await compKit.socket(judge.token);
    socks.push(js);
    // The judge's outbox catches up with a different award.
    const entry = {
      event_id: eventId, competitor_id: diver.id, round_number: 1, score: 8,
      idempotency_key: crypto.randomUUID(), actor_local_time: new Date().toISOString(),
    };
    const first = await compKit.ask(js, "submit_score", entry);
    assert.notEqual(first, "timeout", "the outbox hears back instead of retrying");
    assert.equal(first.ok, true);
    assert.equal(first.superseded_by, "manual_entry");
    assert.equal(first.response.score, 7, "the operator's value stands");
    // A retry replays that answer rather than logging the clash again.
    // (The cache write is fire-and-forget; a real outbox retry comes
    // well after it.)
    await new Promise((r) => setTimeout(r, 300));
    const again = await compKit.ask(js, "submit_score", entry);
    assert.equal(again.ok, true);
    assert.equal(again.replay, true);
    assert.equal(again.superseded_by, "manual_entry", "the replay reads like the first answer");
    const rejected = (await pool.query(
      "SELECT COUNT(*)::int AS n FROM score_audit_log WHERE event_id = $1 AND action = 'rejected_duplicate'",
      [eventId])).rows[0].n;
    assert.equal(rejected, 1);
    assert.equal((await pool.query("SELECT score::float AS s FROM scores WHERE event_id = $1", [eventId])).rows[0].s, 7);
  } finally {
    socks.forEach((s) => s.close());
    await compKit.cleanup(orgId);
  }
});

// A meet whose divers represent their club, with one approved club.
compKit.clubMeet = async function clubMeet(orgId, tag) {
  const code = `C${crypto.randomBytes(2).toString("hex")}`.toUpperCase();
  const club = (await pool.query(
    "INSERT INTO clubs (org_id, name, short_code, status) VALUES ($1, $2, $3, 'active') RETURNING id",
    [orgId, `${tag} Club`, code],
  )).rows[0].id;
  const meet = (await pool.query(
    "INSERT INTO meets (org_id, name, represent_as) VALUES ($1, $2, 'club') RETURNING id",
    [orgId, `${tag} Meet`],
  )).rows[0].id;
  return { club, code, meet };
};

test("venue board: the diver on the board carries the meet's representation code", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("venue");
  const socks = [];
  try {
    const { club, code, meet } = await compKit.clubMeet(orgId, "Venue");
    const manager = await compKit.user(orgId, "Venue Manager", ["meet_manager"]);
    const diver = await compKit.user(orgId, "Venue Diver", ["diver"], { clubId: club });
    const eventId = await compKit.event(orgId, { status: "Live", meet_id: meet });
    await compKit.enter(eventId, diver.id, await compKit.dives(3), { display_order: 1 });
    const ms = await compKit.socket(manager.token);
    socks.push(ms);
    const row = (await fetchJson("GET", `/api/events/${eventId}/roster`, { token: manager.token })).body[0];
    assert.equal(row.country_code, code, "the roster already speaks club");
    assert.deepEqual(await compKit.ask(ms, "set_active_diver", { ...row, status: "ready" }), { ok: true });
    const state = await fetchJson("GET", `/api/venue/scoreboard-state/${eventId}`);
    assert.equal(state.status, 200);
    assert.equal(state.body.active_diver.country_code, code);
  } finally {
    socks.forEach((s) => s.close());
    await compKit.cleanup(orgId);
  }
});

// A Super Final chain, H2H -> SF -> F, all Completed and scored on one
// round by a 3-judge panel, over 12 divers d0..d11 (Appendix 3 §2):
// H2H pairs (0,1) (2,3) (4,5) in group 1 and (6,7) (8,9) (10,11) in
// group 2, evens win; the SF puts d0, d2 through in group 1 and d6, d8
// in group 2. `final: 'upcoming'` leaves F Upcoming and empty, with a
// Stop-1 event under the H2H, for seed-final.
compKit.superFinal = async function superFinal(orgId, tag, { meet = null, clubOf = () => null, final = "scored" } = {}) {
  const judges = [];
  for (let i = 0; i < 3; i++) judges.push(await compKit.user(orgId, `${tag} Judge ${i}`, ["judge"]));
  const d = [];
  for (let i = 0; i < 12; i++) {
    d.push(await compKit.user(orgId, `${tag} Diver ${String(i).padStart(2, "0")}`, ["diver"], { clubId: clubOf(i) }));
  }
  const [dive] = await compKit.dives(1);
  const mk = (format, parent, carry, extra = {}) => compKit.event(orgId, {
    name: `${tag} ${format}`, event_format: format, number_of_judges: 3, total_rounds: 1,
    status: "Completed", meet_id: meet, parent_event_id: parent, score_carry_from: carry, ...extra,
  });
  const stageRows = async (eventId, entries) => {
    await compKit.panel(eventId, judges);
    for (const [i, group, order, pts] of entries) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id, display_order, group_number)
         VALUES ($1, $2, 1, $3, $4, $5)`, [eventId, d[i].id, dive, order, group]);
      for (const j of judges) await compKit.score(eventId, d[i].id, 1, j, pts);
    }
  };
  const stop1 = final === "upcoming" ? await mk("final", null, null) : null;
  const h2h = await mk("super_final_h2h", stop1, null);
  await stageRows(h2h, d.map((_, i) => [i, i < 6 ? 1 : 2, (i % 6) + 1, i % 2 === 0 ? 8 : 5]));
  const sf = await mk("super_final_semi", h2h, h2h);
  await stageRows(sf, [[0, 1, 1, 9], [2, 1, 2, 8], [4, 1, 3, 7], [6, 2, 1, 9], [8, 2, 2, 8], [10, 2, 3, 7]]);
  if (final === "upcoming") {
    const fin = await mk("super_final_final", sf, null, { status: "Upcoming", total_rounds: 5 });
    return { d, h2h, sf, fin, stop1 };
  }
  const fin = await mk("super_final_final", sf, null);
  await stageRows(fin, [[0, null, 1, 9], [2, null, 2, 8], [6, null, 3, 7], [8, null, 4, 6]]);
  return { d, h2h, sf, fin };
};

test("Super Final rankings: representation codes, and no pending club names in public", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("sfrank");
  try {
    const { club, code, meet } = await compKit.clubMeet(orgId, "SfRank");
    const pending = (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code, status) VALUES ($1, 'Unvetted Club', $2, 'pending') RETURNING id",
      [orgId, `P${crypto.randomBytes(2).toString("hex")}`.toUpperCase()],
    )).rows[0].id;
    const { d, fin } = await compKit.superFinal(orgId, "SfRank", {
      meet,
      // d0 in the approved club; d2 and d1 (an H2H loser) in the pending one.
      clubOf: (i) => (i === 0 ? club : (i === 1 || i === 2) ? pending : null),
    });
    const r = await fetchJson("GET", `/api/events/${fin}/super-final/rankings`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const by = Object.fromEntries(r.body.rankings.map((row) => [row.competitor_id, row]));
    assert.equal(r.body.rankings.length, 12);
    assert.equal(by[d[0].id].country_code, code, "a club meet shows the club code");
    assert.equal(by[d[0].id].club_name, "SfRank Club");
    assert.equal(by[d[2].id].club_name, null, "a club still waiting on its federation isn't published");
    assert.equal(by[d[1].id].club_name, null, "nor for an H2H loser");
    assert.equal(by[d[4].id].country_code, "BRN", "no club, the country it is");
  } finally {
    await compKit.cleanup(orgId);
  }
});

test("roster: an entry a guardian paid for counts as paid", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("paid");
  try {
    const manager = await compKit.user(orgId, "Paid Manager", ["meet_manager"]);
    const parent = await compKit.user(orgId, "Paid Parent", ["spectator"]);
    const junior = await compKit.user(orgId, "Paid Junior", ["diver"]);
    const self = await compKit.user(orgId, "Paid Senior", ["diver"]);
    const unpaid = await compKit.user(orgId, "Paid Not", ["diver"]);
    const eventId = await compKit.event(orgId);
    const dives = await compKit.dives(3);
    for (const [i, u] of [junior, self, unpaid].entries()) await compKit.enter(eventId, u.id, dives, { display_order: i + 1 });
    const pay = (payer, subject) => pool.query(
      `INSERT INTO payments (org_id, subject_type, amount_cents, currency, status, payer_user_id, subject_user_id, event_id)
       VALUES ($1, 'event_entry', 2500, 'AUD', 'paid', $2, $3, $4)`, [orgId, payer.id, subject?.id ?? null, eventId]);
    await pay(parent, junior);   // guardian checkout: payer is the parent
    await pay(self, null);       // a diver paying their own way

    const roster = await fetchJson("GET", `/api/events/${eventId}/roster`, { token: manager.token });
    const paid = Object.fromEntries(roster.body.map((r) => [r.competitor_id, r.paid_entry]));
    assert.deepEqual([paid[junior.id], paid[self.id], paid[unpaid.id]], [true, true, false]);
  } finally {
    await pool.query("DELETE FROM payments WHERE org_id = $1", [orgId]);
    await compKit.cleanup(orgId);
  }
});

test("team dive lists are held to the event's voluntary DD cap, per member", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("ddcap");
  try {
    const manager = await compKit.user(orgId, "Cap Manager", ["meet_manager"]);
    const m1 = await compKit.user(orgId, "Cap Member One", ["diver"]);
    const m2 = await compKit.user(orgId, "Cap Member Two", ["diver"]);
    const eventId = await compKit.event(orgId, {
      event_type: "team", total_rounds: 2, dd_limit_rounds: 2, dd_limit_value: 5.0,
    });
    const team = (await pool.query("INSERT INTO teams (org_id, name) VALUES ($1, 'Cap Team') RETURNING id", [orgId])).rows[0].id;
    await pool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($1, $3)", [team, m1.id, m2.id]);
    const dd = async (limit) => (await pool.query(
      "SELECT id FROM dive_directory WHERE height = 3 AND dd = $1 ORDER BY dive_code, id LIMIT 2", [limit])).rows.map((r) => r.id);
    const [easyA, easyB] = await dd(2.0);
    const hard = (await pool.query(
      "SELECT id FROM dive_directory WHERE height = 3 AND dd >= 4.0 ORDER BY dive_code, id LIMIT 2")).rows.map((r) => r.id);
    const post = (lists) => fetchJson("POST", `/api/teams/${team}/dive-lists`, {
      token: manager.token,
      body: { event_id: eventId, dives: lists.flatMap(([member, ids]) => ids.map((dive_id, i) => ({ competitor_id: member.id, dive_id, round_number: i + 1 }))) },
    });
    // 4.0 each: fine, though the team adds up to 8.0.
    const ok = await post([[m1, [easyA, easyB]], [m2, [easyA, easyB]]]);
    assert.ok(ok.status < 300, JSON.stringify(ok.body));
    // One member over the cap: the same list the diver portal refuses.
    const over = await post([[m1, [easyA, easyB]], [m2, hard]]);
    assert.equal(over.status, 400, JSON.stringify(over.body));
    assert.match(over.body.error, /exceeds the 5\.0 limit/);
  } finally {
    await pool.query("DELETE FROM events WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM teams WHERE org_id = $1", [orgId]).catch(() => {});
    await compKit.cleanup(orgId);
  }
});

test("duplicating a session moves its blocks by exactly the days asked, east of UTC too", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("dup");
  // node-pg reads a DATE as local midnight, so the bug only shows on a
  // host ahead of UTC. Run this one as if the box were in Sydney.
  const savedTz = process.env.TZ;
  process.env.TZ = "Australia/Sydney";
  try {
    const manager = await compKit.user(orgId, "Dup Manager", ["meet_manager"]);
    const meet = (await pool.query("INSERT INTO meets (org_id, name) VALUES ($1, 'Dup Meet') RETURNING id", [orgId])).rows[0].id;
    const sess = (await pool.query(
      "INSERT INTO sessions (meet_id, name, session_date) VALUES ($1, 'Day 1', '2026-06-02') RETURNING id", [meet])).rows[0].id;
    await pool.query(
      `INSERT INTO schedule_blocks (session_id, block_type, starts_at, ends_at)
       VALUES ($1, 'break', '2026-06-02 09:42:00+10', '2026-06-02 10:00:00+10')`, [sess]);
    const r = await fetchJson("POST", `/api/sessions/${sess}/duplicate`, {
      token: manager.token, body: { target_date: "2026-06-03" },
    });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    const moved = (await pool.query(
      `SELECT b.starts_at = '2026-06-03 09:42:00+10'::timestamptz AS on_the_day
         FROM schedule_blocks b JOIN sessions s ON s.id = b.session_id
        WHERE s.meet_id = $1 AND s.id <> $2`, [meet, sess])).rows;
    assert.deepEqual(moved, [{ on_the_day: true }], "one day on, not two");
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    await compKit.cleanup(orgId);
  }
});

test("synchro reserve swap takes either diver of a pair, never the other gender's", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("swap");
  const guestOrg = await compKit.org("swapg");
  try {
    const admin = await compKit.user(orgId, "Swap Admin", ["org_admin"]);
    const meet = (await pool.query("INSERT INTO meets (org_id, name) VALUES ($1, 'Swap Meet') RETURNING id", [orgId])).rows[0].id;
    const withdrawing = await compKit.user(orgId, "Swap Withdrawing", ["diver"]);
    const lead = await compKit.user(guestOrg, "Swap Lead", ["diver"]);
    const partner = await compKit.user(guestOrg, "Swap Partner", ["diver"]);
    const manLead = await compKit.user(guestOrg, "Swap Man Lead", ["diver"]);
    const manPartner = await compKit.user(guestOrg, "Swap Man Partner", ["diver"]);
    const dives = await compKit.dives(3);
    const h2h = await compKit.event(orgId, {
      name: "Swap H2H", gender: "Female", event_format: "super_final_h2h", meet_id: meet, number_of_judges: 5,
    });
    await compKit.enter(h2h, withdrawing.id, dives, { display_order: 1 });
    const women = await compKit.event(orgId, { name: "Swap W synchro", gender: "Female", event_type: "synchro_pair", meet_id: meet, number_of_judges: 9 });
    const men = await compKit.event(orgId, { name: "Swap M synchro", gender: "Male", event_type: "synchro_pair", meet_id: meet, number_of_judges: 9 });
    // A pair is one row a round, the partner in partner_id.
    await compKit.enter(women, lead.id, dives, { partner_id: partner.id });
    await compKit.enter(men, manLead.id, dives, { partner_id: manPartner.id });
    const swap = (replacement) => fetchJson("POST", `/api/events/${h2h}/replace-from-synchro`, {
      token: admin.token,
      body: { withdraw_competitor_id: withdrawing.id, replacement_competitor_id: replacement.id },
    });
    // A Male synchro diver can't take a slot in a Female H2H.
    const wrong = await swap(manLead);
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
    // The pair's second diver, listed by the reserve pool, is accepted.
    const ok = await swap(partner);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const inH2h = (await pool.query(
      "SELECT DISTINCT competitor_id FROM competitor_dive_lists WHERE event_id = $1 AND withdrawn_at IS NULL", [h2h])).rows;
    assert.deepEqual(inH2h.map((r) => r.competitor_id), [partner.id]);
  } finally {
    await compKit.cleanup(orgId, guestOrg);
  }
});

test("seed-final with the minimum lock window locks the lists now, not never", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("flock");
  try {
    const admin = await compKit.user(orgId, "Flock Admin", ["org_admin"]);
    const { fin } = await compKit.superFinal(orgId, "Flock", { final: "upcoming" });
    const lock = async () => (await pool.query(
      `SELECT dive_list_locks_at IS NOT NULL AS locked,
              dive_list_locks_at <= now() + interval '1 minute' AS soon
         FROM events WHERE id = $1`, [fin])).rows[0];
    // The F starts in 5 minutes: change of dives closes 5 minutes before
    // it (Appendix 3 §4.1), which is right now.
    const r = await fetchJson("POST", `/api/events/${fin}/seed-final`, { token: admin.token, body: { lock_minutes: 5 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await lock(), { locked: true, soon: true });
    // A longer window still lands 5 minutes before the F.
    const r2 = await fetchJson("POST", `/api/events/${fin}/seed-final`, { token: admin.token, body: { lock_minutes: 15 } });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(await lock(), { locked: true, soon: false });
  } finally {
    await compKit.cleanup(orgId);
  }
});

test("coach up-next pushes skip rehearsal events", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { maybeNotifyCoachesOfNextDivers, resetDedupeForTest } = require("../lib/coach-alerts");
  const orgId = await compKit.org("rehearse");
  try {
    const coach = await compKit.user(orgId, "Rehearse Coach", ["coach"]);
    const divers = [];
    for (let i = 0; i < 3; i++) divers.push(await compKit.user(orgId, `Rehearse Diver ${i + 1}`, ["diver"]));
    await pool.query(
      "INSERT INTO coach_diver_links (coach_id, diver_id, org_id) SELECT $1, unnest($2::uuid[]), $3",
      [coach.id, divers.map((d) => d.id), orgId],
    );
    const dives = await compKit.dives(3);
    const run = async (isRehearsal) => {
      const eventId = await compKit.event(orgId, { status: "Live", is_rehearsal: isRehearsal });
      for (const [i, d] of divers.entries()) await compKit.enter(eventId, d.id, dives, { display_order: i + 1 });
      const sent = [];
      resetDedupeForTest();
      await maybeNotifyCoachesOfNextDivers(
        { pool, push: { sendNotification: async (ids, p) => { sent.push({ ids, p }); } } },
        eventId, { event_id: eventId, competitor_id: divers[0].id, round_number: 1 },
      );
      return sent;
    };
    // Diver 3 is two dives away, the default heads-up distance.
    assert.equal((await run(false)).length, 1, "a real meet pushes");
    assert.equal((await run(true)).length, 0, "a dry run doesn't");
  } finally {
    await compKit.cleanup(orgId);
  }
});

// ---------------------------------------------------------------------
// Accounts and orgs bug sweep (area 3). Each test below failed before
// its fix landed.
// ---------------------------------------------------------------------

// A second org admin (or any fixture user) signs in with the password
// insertUser gives everyone.
async function b3Login(username) {
  const r = await fetchJson("POST", "/api/auth/login", { body: { username, password: "not-used-here" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

test("two admins deciding one role request at once: one wins, the other gets a 409", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    await insertUser({ orgId: st.orgId, role: "org_admin", username: `int-b3a2-${st.slug}`, fullName: "Second Admin" });
    const other = await b3Login(`int-b3a2-${st.slug}`);
    for (let i = 0; i < 6; i++) {
      const asker = await insertUser({ orgId: st.orgId, role: "spectator", username: `int-b3rr${i}-${st.slug}`, fullName: `Asker ${i}` });
      const rq = (await pool.query(
        "INSERT INTO role_requests (user_id, org_id, requested_role) VALUES ($1, $2, 'judge') RETURNING id", [asker, st.orgId],
      )).rows[0].id;
      const second = i % 2 ? "approved" : "rejected";
      const [x, y] = await Promise.all([
        fetchJson("POST", `/api/role-requests/${rq}/review`, { token: st.adminToken, body: { decision: "approved" } }),
        fetchJson("POST", `/api/role-requests/${rq}/review`, { token: other, body: { decision: second } }),
      ]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409], `round ${i}: ${JSON.stringify([x.body, y.body])}`);
      const status = (await pool.query("SELECT status::text FROM role_requests WHERE id = $1", [rq])).rows[0].status;
      const held = (await pool.query("SELECT 1 FROM user_org_roles WHERE user_id = $1 AND role = 'judge'", [asker])).rows.length > 0;
      const grants = (await pool.query(
        "SELECT count(*)::int AS n FROM role_audit_log WHERE user_id = $1 AND role = 'judge' AND action = 'granted'", [asker],
      )).rows[0].n;
      assert.equal(held, status === "approved", `round ${i}: role ${held} but request ${status}`);
      assert.equal(grants, held ? 1 : 0);
    }
  } finally {
    await teardownFixture(st);
  }
});

test("a club change decided twice at once is applied once and reads the way it went", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    await insertUser({ orgId: st.orgId, role: "org_admin", username: `int-b3c2-${st.slug}`, fullName: "Second Admin" });
    const other = await b3Login(`int-b3c2-${st.slug}`);
    const club = async (name) => (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, $2) RETURNING id", [st.orgId, name],
    )).rows[0].id;
    for (let i = 0; i < 6; i++) {
      const from = await club(`From ${i}`);
      const to = await club(`To ${i}`);
      const uname = `int-b3cc${i}-${st.slug}`;
      const diver = await insertUser({ orgId: st.orgId, role: "diver", username: uname, fullName: `Mover ${i}` });
      await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [from, diver]);
      const dt = await b3Login(uname);
      const made = await fetchJson("POST", "/api/club-change-requests", { token: dt, body: { to_club_id: to } });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const [x, y] = await Promise.all([
        fetchJson("POST", `/api/club-change-requests/${made.body.id}/review`, { token: st.adminToken, body: { decision: "approved" } }),
        i % 2
          ? fetchJson("POST", `/api/club-change-requests/${made.body.id}/review`, { token: other, body: { decision: "rejected" } })
          : fetchJson("POST", `/api/club-change-requests/${made.body.id}/cancel`, { token: dt }),
      ]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409], `round ${i}: ${JSON.stringify([x.body, y.body])}`);
      const status = (await pool.query("SELECT status::text FROM club_change_requests WHERE id = $1", [made.body.id])).rows[0].status;
      const now = (await pool.query("SELECT club_id FROM users WHERE id = $1", [diver])).rows[0].club_id;
      assert.equal(now === to, status === "approved", `round ${i}: in ${now === to ? "new" : "old"} club, request ${status}`);
      const told = (await pool.query(
        "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND category = 'club_change'", [diver],
      )).rows[0].n;
      assert.ok(told <= 1, `round ${i}: the diver heard ${told} outcomes`);
    }
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("a guardian link approved and rejected at once keeps the first decision", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    await insertUser({ orgId: st.orgId, role: "org_admin", username: `int-b3g2-${st.slug}`, fullName: "Second Admin" });
    const other = await b3Login(`int-b3g2-${st.slug}`);
    const parent = await insertUser({ orgId: st.orgId, role: "spectator", username: `int-b3gp-${st.slug}`, fullName: "Parent" });
    for (let i = 0; i < 6; i++) {
      const kid = await insertUser({ orgId: st.orgId, role: "diver", username: `int-b3gk${i}-${st.slug}`, fullName: `Kid ${i}` });
      const link = (await pool.query(
        "INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id) VALUES ($1, $2, $3) RETURNING id",
        [st.orgId, parent, kid],
      )).rows[0].id;
      const [x, y] = await Promise.all([
        fetchJson("POST", `/api/guardian-requests/${link}/review`, { token: st.adminToken, body: { decision: "approved" } }),
        fetchJson("POST", `/api/guardian-requests/${link}/review`, { token: other, body: { decision: "rejected" } }),
      ]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409], `round ${i}: ${JSON.stringify([x.body, y.body])}`);
      const status = (await pool.query("SELECT status FROM guardians WHERE id = $1", [link])).rows[0].status;
      assert.equal(status, x.status === 200 ? "approved" : "rejected");
    }
  } finally {
    await teardownFixture(st);
  }
});

test("transferring away drops the old org's roles, so coming back doesn't restore org_admin", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const X = await setupFixture({ withEvent: false });
  const Y = await setupFixture({ withEvent: false });
  try {
    const sys = await claimKit.login("admin", "admin");
    const uname = `int-b3tr-${X.slug}`;
    const mover = await insertUser({ orgId: X.orgId, role: "org_admin", username: uname, fullName: "Travelling Admin" });
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'meet_manager')", [mover, X.orgId]);
    const move = async (toOrg) => {
      const tok = await b3Login(uname);
      const made = await fetchJson("POST", "/api/club-change-requests", { token: tok, body: { to_org_id: toOrg } });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const ok = await fetchJson("POST", `/api/club-change-requests/${made.body.id}/review`, { token: sys.token, body: { decision: "approved" } });
      assert.equal(ok.body.status, "approved", JSON.stringify(ok.body));
    };
    const rolesNow = async () => (await fetchJson("GET", "/api/auth/me", { token: await b3Login(uname) })).body.user.org_roles.slice().sort();

    await move(Y.orgId);
    assert.deepEqual(await rolesNow(), ["diver"]);
    const left = (await pool.query(
      "SELECT role::text FROM user_org_roles WHERE user_id = $1 AND org_id = $2", [mover, X.orgId],
    )).rows;
    assert.deepEqual(left, [], "nothing left behind in the old org");
    const revoked = (await pool.query(
      "SELECT role::text FROM role_audit_log WHERE user_id = $1 AND org_id = $2 AND action = 'revoked' ORDER BY role::text",
      [mover, X.orgId],
    )).rows.map((r) => r.role);
    assert.deepEqual(revoked, ["meet_manager", "org_admin"]);

    // Coming home is joining as a diver, nothing more.
    await move(X.orgId);
    assert.deepEqual(await rolesNow(), ["diver"]);

    // Rows a transfer from before this fix left behind don't come back
    // to life either.
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'org_admin')", [mover, Y.orgId]);
    await move(Y.orgId);
    assert.deepEqual(await rolesNow(), ["diver"]);
  } finally {
    await pool.query("DELETE FROM users WHERE username = $1", [`int-b3tr-${X.slug}`]);
    await teardownFixture(X);
    await teardownFixture(Y);
  }
});

// Rows like these are what transfers before the fix above left behind:
// org_admin in a federation the person has since left.
test("someone who left a federation isn't counted as its admin or told about its business", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { liveOrgAdminIds } = require("../lib/admin-rows");
  const clubApprovals = require("../lib/club-approvals");
  const CODE = "GUY";
  await claimKit.wipe(CODE);
  const X = await setupFixture({ withEvent: false });
  const Y = await setupFixture({ withEvent: false });
  try {
    const gone = await insertUser({ orgId: Y.orgId, role: "diver", username: `int-b3gone-${X.slug}`, fullName: "Former Admin" });
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'org_admin')", [gone, X.orgId]);

    assert.deepEqual(await liveOrgAdminIds(pool, X.orgId), [X.adminId]);
    assert.deepEqual(await clubApprovals.reviewerIds(pool, X.orgId), [X.adminId]);

    // A region claim the federation decides: its admins hear when it goes
    // live and again when it's decided. The one who left hears neither.
    await pool.query("UPDATE organisations SET country_code = $2 WHERE id = $1", [X.orgId, CODE]);
    await pool.query("INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Demerara', 'DE')", [X.orgId]);
    const body = await claimKit.claim({ org_name: "Demerara Diving", country_code: CODE, region_code: "de" });
    assert.equal(body.res.status, 201, JSON.stringify(body.res.body));
    assert.equal(body.res.body.approver, "parent");
    await claimKit.verify(body.id);
    const told = async (id) => (await pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [id],
    )).rows[0].n;
    assert.ok(await told(X.adminId) >= 1, "the federation's real admin hears about it");
    const decided = await fetchJson("POST", `/api/claims/${body.res.body.claim_id}/decide`, {
      token: X.adminToken, body: { decision: "approve" },
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(await told(gone), 0, "nothing reaches someone who's left");
  } finally {
    await pool.query("DELETE FROM claims WHERE org_id = $1", [X.orgId]).catch(() => {});
    await pool.query("DELETE FROM users WHERE username = $1", [`int-b3gone-${X.slug}`]);
    await teardownFixture(X);
    await teardownFixture(Y);
    await claimKit.wipe(CODE);
  }
});

test("forgot-password finds an account whatever case its email was typed in, and every account on it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { resetAccountsFor } = require("../routes/auth");
  const st = await setupFixture({ withEvent: false });
  try {
    const tag = crypto.randomBytes(3).toString("hex");
    const typed = `John.Smith.${tag}@Example.test`;
    const reg = await fetchJson("POST", "/api/auth/register", {
      body: { username: `int-b3fp-${tag}`, password: TEST_PASSWORD, full_name: "John Smith", email: typed, org_id: st.orgId },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const found = await resetAccountsFor(pool, `  john.smith.${tag}@example.test `);
    assert.deepEqual(found.map((u) => u.full_name), ["John Smith"]);

    // A parent's address on two children's accounts: each gets a link.
    const sibling = await insertUser({ orgId: st.orgId, role: "diver", username: `int-b3fp2-${tag}`, fullName: "Jane Smith" });
    await pool.query("UPDATE users SET email = $2 WHERE id = $1", [sibling, typed.toLowerCase()]);
    const both = await resetAccountsFor(pool, typed.toUpperCase());
    assert.deepEqual(both.map((u) => u.full_name).sort(), ["Jane Smith", "John Smith"]);

    const res = await fetchJson("POST", "/api/auth/forgot-password", { body: { email: typed.toLowerCase() } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  } finally {
    await teardownFixture(st);
  }
});

test("deleting a club closes requests to join it instead of turning them into 'leave your club'", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const club = async (name) => (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, $2) RETURNING id", [st.orgId, name],
    )).rows[0].id;
    const home = await club("Home Divers");
    const doomed = await club("Doomed Divers");
    const uname = `int-b3dc-${st.slug}`;
    const diver = await insertUser({ orgId: st.orgId, role: "diver", username: uname, fullName: "Hopeful Diver" });
    await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [home, diver]);
    const made = await fetchJson("POST", "/api/club-change-requests", { token: await b3Login(uname), body: { to_club_id: doomed } });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const del = await fetchJson("DELETE", `/api/clubs/${doomed}`, { token: st.adminToken });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const rq = (await pool.query("SELECT status::text FROM club_change_requests WHERE id = $1", [made.body.id])).rows[0];
    assert.equal(rq.status, "rejected");
    const late = await fetchJson("POST", `/api/club-change-requests/${made.body.id}/review`, { token: st.adminToken, body: { decision: "approved" } });
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal((await pool.query("SELECT club_id FROM users WHERE id = $1", [diver])).rows[0].club_id, home, "still in their own club");
    const told = (await pool.query(
      "SELECT title, body FROM notifications WHERE user_id = $1 AND category = 'club_change'", [diver],
    )).rows;
    assert.equal(told.length, 1);
    assert.match(told[0].body, /Doomed Divers/);
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("claiming a deleted account brings its payments, team places, memberships, fines and enrolments along", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: true });
  try {
    const name = `Returning Diver ${st.slug}`;
    const oldName = `int-b3old-${st.slug}`;
    const old = await insertUser({ orgId: st.orgId, role: "diver", username: oldName, fullName: name });
    const clubId = (await pool.query("INSERT INTO clubs (org_id, name) VALUES ($1, 'Claim Club') RETURNING id", [st.orgId])).rows[0].id;
    const team = (await pool.query("INSERT INTO teams (org_id, name) VALUES ($1, 'Claim Team') RETURNING id", [st.orgId])).rows[0].id;
    await pool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [team, old]);
    await pool.query(
      `INSERT INTO payments (org_id, subject_type, amount_cents, currency, payer_user_id, status)
       VALUES ($1, 'donation', 500, 'aud', $2, 'paid')`, [st.orgId, old]);
    await pool.query(
      "INSERT INTO memberships (org_id, user_id, period_start, period_end) VALUES ($1, $2, '2025-01-01', '2026-01-01')", [st.orgId, old]);
    await pool.query("INSERT INTO official_accreditations (org_id, user_id, role_type) VALUES ($1, $2, 'judge')", [st.orgId, old]);
    await pool.query("INSERT INTO fines (org_id, liable_user_id, amount_cents, currency) VALUES ($1, $2, 2500, 'aud')", [st.orgId, old]);
    await pool.query(
      "INSERT INTO entry_charges (org_id, event_id, entrant_user_id, kind, amount_cents) VALUES ($1, $2, $3, 'scratch', 1000)",
      [st.orgId, st.eventId, old]);
    const cls = (await pool.query(
      "INSERT INTO classes (club_id, org_id, name) VALUES ($1, $2, 'Squad') RETURNING id", [clubId, st.orgId])).rows[0].id;
    await pool.query(
      "INSERT INTO class_enrolments (class_id, diver_user_id, club_id, org_id) VALUES ($1, $2, $3, $4)", [cls, old, clubId, st.orgId]);

    const gone = await fetchJson("POST", "/api/users/me/delete", { token: await b3Login(oldName), body: { password: "not-used-here" } });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));

    const newName = `int-b3new-${st.slug}`;
    const me = await insertUser({ orgId: st.orgId, role: "diver", username: newName, fullName: name });
    const claim = await fetchJson("POST", "/api/users/me/claim", {
      token: await b3Login(newName), body: { old_user_ids: [old], password: "not-used-here" },
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.deepEqual(claim.body.claimed, [old]);

    const owner = async (sql) => (await pool.query(sql, [me])).rows[0].n;
    assert.equal(await owner("SELECT count(*)::int AS n FROM team_members WHERE user_id = $1"), 1, "still on the team");
    assert.equal(await owner("SELECT count(*)::int AS n FROM payments WHERE payer_user_id = $1"), 1);
    assert.equal(await owner("SELECT count(*)::int AS n FROM memberships WHERE user_id = $1"), 1);
    assert.equal(await owner("SELECT count(*)::int AS n FROM official_accreditations WHERE user_id = $1"), 1);
    assert.equal(await owner("SELECT count(*)::int AS n FROM fines WHERE liable_user_id = $1"), 1, "a fine still owed stays owed");
    assert.equal(await owner("SELECT count(*)::int AS n FROM entry_charges WHERE entrant_user_id = $1"), 1);
    assert.equal(await owner("SELECT count(*)::int AS n FROM class_enrolments WHERE diver_user_id = $1"), 1);
  } finally {
    for (const tbl of ["payments", "memberships", "official_accreditations", "fines", "entry_charges", "class_enrolments", "classes", "teams"]) {
      await pool.query(`DELETE FROM ${tbl} WHERE org_id = $1`, [st.orgId]).catch(() => {});
    }
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("claiming an account that overlaps the new one on a live charge is a 409, not a 500", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: true });
  try {
    const name = `Twice Charged ${st.slug}`;
    const oldName = `int-b3old2-${st.slug}`;
    const old = await insertUser({ orgId: st.orgId, role: "diver", username: oldName, fullName: name });
    const newName = `int-b3new2-${st.slug}`;
    const me = await insertUser({ orgId: st.orgId, role: "diver", username: newName, fullName: name });
    for (const who of [old, me]) {
      await pool.query(
        "INSERT INTO entry_charges (org_id, event_id, entrant_user_id, kind, amount_cents) VALUES ($1, $2, $3, 'scratch', 1000)",
        [st.orgId, st.eventId, who]);
    }
    assert.equal((await fetchJson("POST", "/api/users/me/delete", { token: await b3Login(oldName), body: { password: "not-used-here" } })).status, 200);
    const claim = await fetchJson("POST", "/api/users/me/claim", {
      token: await b3Login(newName), body: { old_user_ids: [old], password: "not-used-here" },
    });
    assert.equal(claim.status, 409, JSON.stringify(claim.body));
    assert.equal(claim.body.code, "claim_conflict");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE id = $1", [old])).rows[0].n, 1, "nothing half-merged");
  } finally {
    await pool.query("DELETE FROM entry_charges WHERE org_id = $1", [st.orgId]).catch(() => {});
    await teardownFixture(st);
  }
});

test("guardian linking works for a parent: scoped search, pending shown, withdraw, admin queue", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  const other = await setupFixture({ withEvent: false });
  try {
    const kid = await insertUser({ orgId: st.orgId, role: "diver", username: `int-b3kid-${st.slug}`, fullName: `Ivy Marsh ${st.slug}` });
    await pool.query("UPDATE users SET date_of_birth = (CURRENT_DATE - interval '11 years')::date WHERE id = $1", [kid]);
    await insertUser({ orgId: other.orgId, role: "diver", username: `int-b3far-${st.slug}`, fullName: `Ivy Marsh ${st.slug} Abroad` });
    await insertUser({ orgId: st.orgId, role: "spectator", username: `int-b3par-${st.slug}`, fullName: "Rosa Marsh" });
    const parent = await b3Login(`int-b3par-${st.slug}`);

    // A parent can search (GET /api/users is the admin's member list and
    // 403s for them), only in their own federation, and only names come back.
    const found = await fetchJson("GET", `/api/guardians/search?q=${encodeURIComponent(`ivy marsh ${st.slug}`)}`, { token: parent });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual(found.body.map((u) => u.id), [kid]);
    assert.deepEqual(Object.keys(found.body[0]).sort(), ["club_name", "full_name", "id"]);
    assert.deepEqual((await fetchJson("GET", "/api/guardians/search?q=i", { token: parent })).body, [], "two characters at least");

    const asked = await fetchJson("POST", "/api/guardians/request", { token: parent, body: { dependent_user_id: kid } });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    // The payment picker still only sees approved links; the page sees the wait.
    assert.deepEqual((await fetchJson("GET", "/api/guardians/my-dependents", { token: parent })).body, []);
    const mine = (await fetchJson("GET", "/api/guardians/my-dependents?include_pending=1", { token: parent })).body;
    assert.deepEqual(mine.map((d) => [d.id, d.status]), [[kid, "pending"]]);

    // Asked the wrong way? Withdraw it and ask again.
    const withdrawn = await fetchJson("POST", `/api/guardians/${mine[0].guardian_link_id}/revoke`, { token: parent });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal((await fetchJson("POST", "/api/guardians/request", { token: parent, body: { dependent_user_id: kid } })).status, 201);

    const queue = await fetchJson("GET", "/api/guardian-requests", { token: st.adminToken });
    const rq = queue.body.find((g) => g.dependent_id === kid);
    assert.ok(rq, "the org admin sees it");
    assert.equal((await fetchJson("POST", `/api/guardian-requests/${rq.id}/review`, { token: st.adminToken, body: { decision: "approved" } })).status, 200);
    assert.deepEqual((await fetchJson("GET", "/api/guardians/my-dependents", { token: parent })).body.map((d) => d.id), [kid]);
  } finally {
    await teardownFixture(st);
    await teardownFixture(other);
  }
});

test("a 2FA recovery code opens one session however many logins race for it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const speakeasy = require("speakeasy");
  const st = await setupFixture({ withEvent: false });
  try {
    const uname = `int-b3tf-${st.slug}`;
    const u = await insertUser({ orgId: st.orgId, role: "diver", username: uname, fullName: "Two Factor" });
    const tok = await b3Login(uname);
    const setup = await fetchJson("POST", "/api/auth/2fa/setup", { token: tok });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    const code = speakeasy.totp({ secret: setup.body.base32, encoding: "base32" });
    assert.equal((await fetchJson("POST", "/api/auth/2fa/confirm", { token: tok, body: { code } })).status, 200);
    const codes = setup.body.recovery_codes;
    const stepUp = async () => (await fetchJson("POST", "/api/auth/login", {
      body: { username: uname, password: "not-used-here" },
    })).body.totp_token;
    const left = async () => (await pool.query(
      "SELECT jsonb_array_length(totp_recovery_codes) AS n FROM users WHERE id = $1", [u],
    )).rows[0].n;

    // The same code twice at once: one session, not two.
    const [a, b] = await Promise.all([stepUp(), stepUp()]);
    const same = await Promise.all([a, b].map((totp_token) =>
      fetchJson("POST", "/api/auth/login/totp", { body: { totp_token, code: codes[0] } })));
    assert.deepEqual(same.map((r) => r.status).sort(), [200, 401], JSON.stringify(same.map((r) => r.body?.error || "ok")));
    assert.equal(await left(), codes.length - 1);

    // Two different codes at once: both work, and both are used up (a lost
    // update used to write one of them back).
    const [c, d] = await Promise.all([stepUp(), stepUp()]);
    const both = await Promise.all([[c, codes[1]], [d, codes[2]]].map(([totp_token, rc]) =>
      fetchJson("POST", "/api/auth/login/totp", { body: { totp_token, code: rc } })));
    assert.deepEqual(both.map((r) => r.status), [200, 200], JSON.stringify(both.map((r) => r.body?.error || "ok")));
    assert.equal(await left(), codes.length - 3);
  } finally {
    await teardownFixture(st);
  }
});

test("register refuses an email longer than the column with a 400, not a 500", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const r = await fetchJson("POST", "/api/auth/register", {
      body: { username: `int-b3le-${st.slug}`, password: TEST_PASSWORD, full_name: "Long Mail",
              email: `${"a".repeat(290)}@example.test`, org_id: st.orgId },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  } finally {
    await teardownFixture(st);
  }
});

test("a taken username at signup is a 409 username_taken without the database's wording", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const again = await fetchJson("POST", "/api/auth/register", {
      body: { username: st.username, password: TEST_PASSWORD, full_name: "Copy Cat",
              email: `copy-${st.slug}@example.test`, org_id: st.orgId },
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.code, "username_taken");
    assert.doesNotMatch(again.body.error, /Key \(|already exists/);

    const org = await fetchJson("POST", "/api/auth/register-org", {
      body: { org_name: `Copy Fed ${st.slug}`, country_code: "TST", username: st.username, password: TEST_PASSWORD,
              full_name: "Copy Cat", email: `copy2-${st.slug}@example.test` },
    });
    assert.equal(org.status, 409, JSON.stringify(org.body));
    assert.equal(org.body.code, "username_taken");
    assert.doesNotMatch(org.body.error, /Key \(|already exists/);
  } finally {
    await pool.query("DELETE FROM organisations WHERE name = $1", [`Copy Fed ${st.slug}`]);
    await teardownFixture(st);
  }
});

test("the event-is-live email skips withdrawn divers and reserves", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: true });
  const saved = { fetch: global.fetch, env: { ...process.env } };
  try {
    const dive = (await pool.query("SELECT id FROM dive_directory LIMIT 1")).rows[0].id;
    const entrant = async (name, extra) => {
      const id = await insertUser({ orgId: st.orgId, role: "diver", username: `int-b3ev-${name}-${st.slug}`, fullName: name });
      await pool.query("UPDATE users SET email = $2 WHERE id = $1", [id, `${name.toLowerCase()}-${st.slug}@example.test`]);
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number, withdrawn_at, is_reserve)
         VALUES ($1, $2, $3, 1, $4, $5)`,
        [st.eventId, id, dive, extra.withdrawn ? new Date() : null, !!extra.reserve],
      );
    };
    await entrant("Competing", {});
    await entrant("Withdrawn", { withdrawn: true });
    await entrant("Reserve", { reserve: true });

    const sent = [];
    Object.assign(process.env, { CF_ACCOUNT_ID: "acct-test", CF_EMAIL_TOKEN: "token-test", EMAIL_FROM: "noreply@example.test" });
    global.fetch = async (_url, opts) => { sent.push(JSON.parse(opts.body).to); return { ok: true, json: async () => ({}) }; };
    const email = require("../lib/email")({ pool });
    await email.sendEventStartedEmails({ id: st.eventId, name: "B3 Open" });
    assert.deepEqual(sent, [`competing-${st.slug}@example.test`]);
  } finally {
    global.fetch = saved.fetch;
    process.env = saved.env;
    await teardownFixture(st);
  }
});

test("role requests in an unclaimed country skip a suspended club admin and reach the region", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { reviewersFor } = require("../lib/role-requests");
  const st = await setupFixture({ withEvent: false });
  try {
    await pool.query("UPDATE organisations SET claim_state = 'unclaimed' WHERE id = $1", [st.orgId]);
    const region = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Paramaribo', 'PM') RETURNING id", [st.orgId],
    )).rows[0].id;
    const club = (await pool.query(
      "INSERT INTO clubs (org_id, name, region_id) VALUES ($1, 'Suriname Divers', $2) RETURNING id", [st.orgId, region],
    )).rows[0].id;
    const mk = async (tag, name) => {
      const id = await insertUser({ orgId: st.orgId, role: "spectator", username: `int-b3rv${tag}-${st.slug}`, fullName: name });
      await pool.query("UPDATE users SET email = $2, club_id = $3 WHERE id = $1", [id, `${tag}-${st.slug}@example.test`, club]);
      return id;
    };
    const clubAdmin = await mk("ca", "Club Admin");
    const regionAdmin = await mk("ra", "Region Admin");
    const member = await mk("m", "Member");
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [club, clubAdmin, st.orgId]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [region, regionAdmin, st.orgId]);

    assert.equal((await reviewersFor(pool, member, st.orgId, "judge")).via, "club");
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [clubAdmin]);
    const next = await reviewersFor(pool, member, st.orgId, "judge");
    assert.equal(next.via, "region", "not the club admin who can't sign in");
    assert.deepEqual(next.recipients.map((r) => r.full_name), ["Region Admin"]);
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [regionAdmin]);
    assert.equal((await reviewersFor(pool, member, st.orgId, "judge")).via, "sysadmin");
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM regions WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("the inbox pages newest-first without skipping or repeating, and bad paging input is a 400", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    // Ids are random uuids, so their order has nothing to do with time.
    for (let i = 0; i < 7; i++) {
      await pool.query(
        `INSERT INTO notifications (user_id, category, title, created_at)
         VALUES ($1, 'generic', $2, now() - make_interval(mins => $3::int))`,
        [st.adminId, `note ${i}`, i],
      );
    }
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const r = await fetchJson("GET", `/api/notifications/me?limit=3${cursor ? `&before_id=${cursor}` : ""}`, { token: st.adminToken });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      if (!r.body.length) break;
      seen.push(...r.body.map((n) => n.title));
      cursor = r.body[r.body.length - 1].id;
    }
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6].map((i) => `note ${i}`));

    const one = await fetchJson("GET", "/api/notifications/me?limit=-1", { token: st.adminToken });
    assert.equal(one.status, 200);
    assert.equal(one.body.length, 1, "a silly limit is clamped, not passed to Postgres");
    assert.equal((await fetchJson("GET", "/api/notifications/me?before_id=nope", { token: st.adminToken })).status, 400);
    assert.equal((await fetchJson("GET", "/api/notifications/me?since_id=nope", { token: st.adminToken })).status, 400);
  } finally {
    await teardownFixture(st);
  }
});

test("the dashboard's recent activity keeps audit rows whose event or org has since been deleted", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const sys = await claimKit.login("admin", "admin");
  // Dated ahead so they're the newest rows whatever else the test DB holds.
  const score = (await pool.query(
    `INSERT INTO score_audit_log (event_id, round_number, action, old_score, new_score, created_at)
     VALUES (NULL, 1, 'update', 6.5, 7.0, now() + interval '1 hour') RETURNING id`,
  )).rows[0].id;
  const role = (await pool.query(
    `INSERT INTO role_audit_log (org_id, role, action, created_at)
     VALUES (NULL, 'judge', 'granted', now() + interval '1 hour') RETURNING id`,
  )).rows[0].id;
  try {
    const dash = await fetchJson("GET", "/api/dashboard", { token: sys.token });
    assert.equal(dash.status, 200, JSON.stringify(dash.body));
    const ids = (dash.body.recent_activity || []).map((a) => `${a.kind}:${a.id}`);
    assert.ok(ids.includes(`score:${score}`), "the score correction from a deleted event is listed");
    assert.ok(ids.includes(`role:${role}`), "the role change from a deleted org is listed");
  } finally {
    await pool.query("DELETE FROM score_audit_log WHERE id = $1", [score]);
    await pool.query("DELETE FROM role_audit_log WHERE id = $1", [role]);
  }
});

test("clubs let in by a revoked claim don't come live sharing another club's code", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const clubApprovals = require("../lib/club-approvals");
  const st = await setupFixture({ withEvent: false });
  try {
    await pool.query("INSERT INTO clubs (org_id, name, short_code, status) VALUES ($1, 'Sydney Divers', 'SYD', 'active')", [st.orgId]);
    const founder = await insertUser({ orgId: st.orgId, role: "diver", username: `int-b3cc-${st.slug}`, fullName: "Second Founder" });
    const waiting = (await pool.query(
      `INSERT INTO clubs (org_id, name, short_code, status, created_by)
       VALUES ($1, 'Sydney Springboard', 'syd', 'pending', $2) RETURNING id`, [st.orgId, founder],
    )).rows[0].id;
    const fine = (await pool.query(
      "INSERT INTO clubs (org_id, name, short_code, status) VALUES ($1, 'Bondi Divers', 'BON', 'pending') RETURNING id", [st.orgId],
    )).rows[0].id;
    await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [waiting, founder]);

    const out = await clubApprovals.withTx(pool, (c) => clubApprovals.activateAllPending(c, st.orgId, { actorId: st.adminId }));
    const row = async (id) => (await pool.query("SELECT status, short_code FROM clubs WHERE id = $1", [id])).rows[0];
    assert.deepEqual(await row(waiting), { status: "active", short_code: null }, "the clashing code is cleared");
    assert.deepEqual(await row(fine), { status: "active", short_code: "BON" }, "a free code is kept");
    const note = out.notes.find((n) => n.userIds.includes(founder));
    assert.match(note.email.body, /SYD/);
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("asking for 'no club' just clears it, rather than a request nobody in the country can decide", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    await pool.query("UPDATE organisations SET claim_state = 'unclaimed' WHERE id = $1", [st.orgId]);
    const club = async (name) => (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, $2) RETURNING id", [st.orgId, name],
    )).rows[0].id;
    const a = await club("Georgetown Divers");
    const b = await club("Linden Divers");
    const uname = `int-b3nc-${st.slug}`;
    const diver = await insertUser({ orgId: st.orgId, role: "diver", username: uname, fullName: "Leaving Diver" });
    await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [a, diver]);
    const tok = await b3Login(uname);

    const leave = await fetchJson("POST", "/api/club-change-requests", { token: tok, body: { to_club_id: null } });
    assert.equal(leave.status, 201, JSON.stringify(leave.body));
    assert.equal(leave.body.finalised, true);
    assert.equal((await pool.query("SELECT club_id FROM users WHERE id = $1", [diver])).rows[0].club_id, null);

    const join = await fetchJson("POST", "/api/club-change-requests", { token: tok, body: { to_club_id: b } });
    assert.equal(join.status, 201, `nothing stuck in the way: ${JSON.stringify(join.body)}`);
    assert.equal(join.body.status, "pending");
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("deleting your account closes your pending club requests, and a tombstone can't be moved", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const X = await setupFixture({ withEvent: false });
  const Y = await setupFixture({ withEvent: false });
  try {
    const sys = await claimKit.login("admin", "admin");
    const uname = `int-b3sd-${X.slug}`;
    const diver = await insertUser({ orgId: X.orgId, role: "diver", username: uname, fullName: "Leaving For Good" });
    const tok = await b3Login(uname);
    const made = await fetchJson("POST", "/api/club-change-requests", { token: tok, body: { to_org_id: Y.orgId } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await fetchJson("POST", "/api/users/me/delete", { token: tok, body: { password: "not-used-here" } })).status, 200);

    assert.equal((await pool.query("SELECT status::text FROM club_change_requests WHERE id = $1", [made.body.id])).rows[0].status, "rejected");
    const late = await fetchJson("POST", `/api/club-change-requests/${made.body.id}/review`, { token: sys.token, body: { decision: "approved" } });
    assert.equal(late.status, 409, JSON.stringify(late.body));

    // One left open from before this fix: approving it still doesn't move
    // the tombstone.
    const legacy = (await pool.query(
      `INSERT INTO club_change_requests (user_id, kind, from_org_id, to_org_id, diver_confirmed_at, requested_by)
       VALUES ($1, 'org_transfer', $2, $3, now(), $1) RETURNING id`,
      [diver, X.orgId, Y.orgId],
    )).rows[0].id;
    const refused = await fetchJson("POST", `/api/club-change-requests/${legacy}/review`, { token: sys.token, body: { decision: "approved" } });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((await pool.query("SELECT org_id FROM users WHERE id = $1", [diver])).rows[0].org_id, X.orgId);
  } finally {
    await teardownFixture(X);
    await teardownFixture(Y);
  }
});

test("club member counts leave out deleted accounts", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const club = (await pool.query("INSERT INTO clubs (org_id, name) VALUES ($1, 'Ghost Divers') RETURNING id", [st.orgId])).rows[0].id;
    await pool.query(
      "INSERT INTO users (username, full_name, org_id, club_id, deleted_at) VALUES ($1, 'Gone', $2, $3, now())",
      [`deleted-b3-${st.slug}`, st.orgId, club],
    );
    const list = await fetchJson("GET", "/api/clubs", { token: st.adminToken });
    assert.equal(list.body.find((c) => c.id === club).member_count, 0);
    const del = await fetchJson("DELETE", `/api/clubs/${club}`, { token: st.adminToken });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.unassigned_members, 0);
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("malformed ids and impossible dates in the accounts and org routes are 4xx, never 500", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const sys = (await claimKit.login("admin", "admin")).token;
    const tok = st.adminToken;
    const probes = [
      ["GET", "/api/orgs/nope/clubs", null, null],
      ["POST", "/api/auth/register", null, { username: `int-b3bad-${st.slug}`, password: TEST_PASSWORD, full_name: "X", email: `bad-${st.slug}@example.test`, org_id: "nope" }],
      ["POST", "/api/auth/register", null, { username: `int-b3bad2-${st.slug}`, password: TEST_PASSWORD, full_name: "X", email: `bad2-${st.slug}@example.test`, org_id: st.orgId, club_id: "nope" }],
      ["PUT", "/api/users/nope/roles", sys, { roles: ["diver"] }],
      ["PUT", "/api/users/nope/profile", tok, { full_name: "X" }],
      ["POST", "/api/users/nope/suspend", tok, {}],
      ["POST", "/api/users/nope/reactivate", tok, {}],
      ["GET", "/api/users/nope/role-audit", tok, null],
      ["PUT", "/api/users/nope/club", tok, { club_id: null }],
      ["POST", "/api/role-requests/nope/review", tok, { decision: "approved" }],
      ["POST", "/api/club-change-requests/nope/review", sys, { decision: "approved" }],
      ["POST", "/api/club-change-requests/nope/confirm", tok, {}],
      ["POST", "/api/club-change-requests/nope/cancel", tok, {}],
      ["POST", "/api/club-change-requests", tok, { to_club_id: "nope" }],
      ["POST", "/api/club-change-requests", tok, { to_org_id: "nope" }],
      ["POST", "/api/club-change-requests", tok, { user_id: "nope" }],
      ["POST", "/api/guardian-requests/nope/review", sys, { decision: "approved" }],
      ["POST", "/api/guardians/nope/revoke", tok, {}],
      ["POST", "/api/guardians/request", tok, { dependent_user_id: "nope" }],
      ["POST", "/api/notifications/nope/acknowledge", tok, {}],
      ["DELETE", "/api/clubs/nope", tok, null],
      ["PUT", "/api/clubs/nope", tok, { name: "X" }],
      ["GET", "/api/orgs/nope/divers", tok, null],
      ["GET", "/api/orgs/nope/members", tok, null],
      ["POST", "/api/claims/nope/vote", tok, { vote: "approve" }],
      ["POST", "/api/claims/nope/decide", sys, { decision: "approve" }],
      ["POST", "/api/claims/nope/revoke", sys, {}],
    ];
    const bad = [];
    for (const [method, path, token, body] of probes) {
      const r = await fetchJson(method, path, { token, body });
      if (r.status >= 500 || r.status < 400) bad.push(`${method} ${path} ${JSON.stringify(body)} -> ${r.status}`);
    }
    assert.deepEqual(bad, []);

    const member = await insertUser({ orgId: st.orgId, role: "diver", username: `int-b3dob-${st.slug}`, fullName: "Leap Day" });
    for (const date_of_birth of ["2020-02-30", "2020-13-01", 20200101]) {
      const dob = await fetchJson("PUT", `/api/users/${member}/profile`, { token: tok, body: { date_of_birth } });
      assert.equal(dob.status, 400, `${date_of_birth}: ${JSON.stringify(dob.body)}`);
    }
    const ok = await fetchJson("PUT", `/api/users/${member}/profile`, { token: tok, body: { date_of_birth: "2020-02-29" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  } finally {
    await teardownFixture(st);
  }
});

test("deleting a club that has paid for things is a 409 club_has_payments, not a 500", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const club = (await pool.query("INSERT INTO clubs (org_id, name) VALUES ($1, 'Paying Club') RETURNING id", [st.orgId])).rows[0].id;
    await pool.query(
      `INSERT INTO payments (org_id, subject_type, amount_cents, currency, payer_type, payer_club_id, status)
       VALUES ($1, 'club_affiliation', 500, 'aud', 'club', $2, 'paid')`, [st.orgId, club]);
    const del = await fetchJson("DELETE", `/api/clubs/${club}`, { token: st.adminToken });
    assert.equal(del.status, 409, JSON.stringify(del.body));
    assert.equal(del.body.code, "club_has_payments");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM clubs WHERE id = $1", [club])).rows[0].n, 1);
  } finally {
    await pool.query("DELETE FROM payments WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("the judge picker leaves out judges who have moved to another federation", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const X = await setupFixture({ withEvent: false });
  const Y = await setupFixture({ withEvent: false });
  try {
    const here = await insertUser({ orgId: X.orgId, role: "judge", username: `int-b3jh-${X.slug}`, fullName: "Judge Here" });
    const gone = await insertUser({ orgId: Y.orgId, role: "judge", username: `int-b3jg-${X.slug}`, fullName: "Judge Gone" });
    // What a transfer before the role fix left behind.
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'judge')", [gone, X.orgId]);
    const list = await fetchJson("GET", "/api/judges", { token: X.adminToken });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const ids = list.body.map((j) => j.id);
    assert.ok(ids.includes(here));
    assert.ok(!ids.includes(gone), "not someone who left");
  } finally {
    await pool.query("DELETE FROM users WHERE username = $1", [`int-b3jg-${X.slug}`]);
    await teardownFixture(X);
    await teardownFixture(Y);
  }
});

test("a role request left waiting in the federation someone moved out of can't grant a role there", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const X = await setupFixture({ withEvent: false });
  const Y = await setupFixture({ withEvent: false });
  const uname = `int-b3rq-${X.slug}`;
  try {
    const sys = await claimKit.login("admin", "admin");
    const mover = await insertUser({ orgId: X.orgId, role: "diver", username: uname, fullName: "Moving Judge" });
    const ask = async (role) => (await pool.query(
      "INSERT INTO role_requests (user_id, org_id, requested_role) VALUES ($1, $2, $3) RETURNING id", [mover, X.orgId, role],
    )).rows[0].id;
    const judgeRq = await ask("judge");

    // A finished transfer closes what they left waiting behind.
    const tok = await b3Login(uname);
    const made = await fetchJson("POST", "/api/club-change-requests", { token: tok, body: { to_org_id: Y.orgId } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const moved = await fetchJson("POST", `/api/club-change-requests/${made.body.id}/review`, { token: sys.token, body: { decision: "approved" } });
    assert.equal(moved.body.status, "approved", JSON.stringify(moved.body));
    const st = (await pool.query("SELECT status::text FROM role_requests WHERE id = $1", [judgeRq])).rows[0].status;
    assert.equal(st, "rejected", "closed with the move");

    // One that slipped through (from before this) is refused on approval.
    const coachRq = await ask("coach");
    const late = await fetchJson("POST", `/api/role-requests/${coachRq}/review`, { token: X.adminToken, body: { decision: "approved" } });
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(late.body.code, "not_a_member");
    const held = (await pool.query("SELECT role::text FROM user_org_roles WHERE user_id = $1 AND org_id = $2", [mover, X.orgId])).rows;
    assert.deepEqual(held, [], "no role minted in the org they left");
    // Declining it still works, so it can leave the queue.
    const no = await fetchJson("POST", `/api/role-requests/${coachRq}/review`, { token: X.adminToken, body: { decision: "rejected" } });
    assert.equal(no.status, 200, JSON.stringify(no.body));
  } finally {
    await pool.query("DELETE FROM users WHERE username = $1", [uname]);
    await teardownFixture(X);
    await teardownFixture(Y);
  }
});

test("an admin profile edit refuses a year-zero birth date with a 400", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const diver = await insertUser({ orgId: st.orgId, role: "diver", username: `int-b3dob-${st.slug}`, fullName: "Old Timer" });
    for (const dob of ["0000-01-01", "1850-06-01", "2999-01-01"]) {
      const r = await fetchJson("PUT", `/api/users/${diver}/profile`, { token: st.adminToken, body: { date_of_birth: dob } });
      assert.equal(r.status, 400, `${dob}: ${JSON.stringify(r.body)}`);
    }
    const ok = await fetchJson("PUT", `/api/users/${diver}/profile`, { token: st.adminToken, body: { date_of_birth: "2012-02-29" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  } finally {
    await teardownFixture(st);
  }
});

// Saved event templates in the Meet Manager. The router was dropped in the
// server.js split (b63a883) while the Manager kept calling it, so the strip
// was always empty and Save / Delete failed with a 404. Org-scoped: a
// federation's templates are its own.
test("event templates: save, upsert by name, list and delete, scoped to the caller's org", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const mine = await setupFixture({ withEvent: false });
  const theirs = await setupFixture({ withEvent: false });
  try {
    await pool.query("UPDATE organisations SET country_code = 'BLZ' WHERE id = ANY($1)", [[mine.orgId, theirs.orgId]]);
    const list = async (token) => fetchJson("GET", "/api/event-templates", { token });

    const empty = await list(mine.adminToken);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body, []);

    const config = { gender: "Female", height: "3m", number_of_judges: 5, total_rounds: 5, event_type: "individual" };
    const saved = await fetchJson("POST", "/api/event-templates", {
      token: mine.adminToken, body: { name: "  Belize Women 3m  ", config },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.name, "Belize Women 3m");
    assert.deepEqual(saved.body.config, config);

    // Same name again overwrites rather than duplicating
    const again = await fetchJson("POST", "/api/event-templates", {
      token: mine.adminToken, body: { name: "Belize Women 3m", config: { ...config, total_rounds: 6 } },
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.id, saved.body.id);
    const one = await list(mine.adminToken);
    assert.equal(one.body.length, 1);
    assert.equal(one.body[0].config.total_rounds, 6);

    // bad input
    assert.equal((await fetchJson("POST", "/api/event-templates", { token: mine.adminToken, body: { name: " ", config } })).status, 400);
    assert.equal((await fetchJson("POST", "/api/event-templates", { token: mine.adminToken, body: { name: "x", config: [1] } })).status, 400);

    // Another org sees none of it and can't delete it
    assert.deepEqual((await list(theirs.adminToken)).body, []);
    assert.equal((await fetchJson("DELETE", `/api/event-templates/${saved.body.id}`, { token: theirs.adminToken })).status, 404);

    // A diver in the same org can't use them at all
    const diverName = `int-tpl-diver-${mine.slug}`;
    await insertUser({ orgId: mine.orgId, role: "diver", username: diverName, fullName: "Template Diver" });
    const diverLogin = await fetchJson("POST", "/api/auth/login", { body: { username: diverName, password: "not-used-here" } });
    assert.equal((await list(diverLogin.body.token)).status, 403);

    // Anonymous: no (verifyToken answers a missing token with 403)
    assert.equal((await fetchJson("GET", "/api/event-templates")).status, 403);

    const del = await fetchJson("DELETE", `/api/event-templates/${saved.body.id}`, { token: mine.adminToken });
    assert.equal(del.status, 200);
    assert.deepEqual((await list(mine.adminToken)).body, []);
  } finally {
    await teardownFixture(mine);
    await teardownFixture(theirs);
  }
});

// A6-07. node-pg hands DATE back as a JS Date at local midnight, which
// serialises as an ISO instant ('2006-06-10T14:00:00.000Z' on a UTC+10
// box). The User Manager drawer can't show that in <input type=date> and
// PUT /api/users/:id/profile refuses it, so saving a user with a DOB
// failed. The listing has to send the plain calendar date.
test("GET /api/users sends date_of_birth as a plain YYYY-MM-DD date", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    await pool.query("UPDATE organisations SET country_code = 'MWI' WHERE id = $1", [st.orgId]);
    const diverId = await insertUser({ orgId: st.orgId, role: "diver", username: `int-dob-${st.slug}`, fullName: "Chikondi Banda" });
    await pool.query("UPDATE users SET date_of_birth = '2006-06-11' WHERE id = $1", [diverId]);
    const r = await fetchJson("GET", "/api/users", { token: st.adminToken });
    assert.equal(r.status, 200);
    const row = r.body.find((u) => u.id === diverId);
    assert.equal(row.date_of_birth, "2006-06-11");

    // And the drawer's round trip: send back what the listing gave us.
    const put = await fetchJson("PUT", `/api/users/${diverId}/profile`, {
      token: st.adminToken,
      body: { full_name: "Chikondi Banda", date_of_birth: row.date_of_birth, gender: null, nationality: null },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const after = await pool.query("SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS dob FROM users WHERE id = $1", [diverId]);
    assert.equal(after.rows[0].dob, "2006-06-11");
  } finally {
    await teardownFixture(st);
  }
});

// The suite registers orgs (which pushes "new federation pending" to every
// sysadmin) and notifies seeded users. A local .env usually carries real
// VAPID keys and the test DB carries real browser subscriptions, so those
// were going out to real phones. Push has to be off for the whole run.
test("web push is switched off for the test run", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const r = await fetchJson("GET", "/api/push/vapid-public-key");
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.equal(r.body.key, "");
});

// If schema_meta has slipped behind the ledger (the 098 test above used to
// do exactly that), `npm run migrate` with nothing pending should still
// put it right rather than printing "up to date" over a wrong number.
test("migrate resyncs a drifted schema_meta even when nothing is pending", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const fs = require("node:fs");
  // This runs the real migrator against the suite's database. With a
  // migration file the DB hasn't had yet (a fresh branch, before `npm run
  // migrate`) it would apply it halfway through the run, under every other
  // test file, and then fail for not saying "up to date". Only the
  // nothing-pending path is under test, so stay out of the way otherwise.
  const ledger = await pool.query("SELECT version FROM applied_migrations").catch(() => null);
  if (!ledger) return t.skip("no applied_migrations ledger, run npm run migrate first");
  const applied = new Set(ledger.rows.map((r) => r.version));
  const pending = fs.readdirSync(path.join(__dirname, "..", "migrations"))
    .map((f) => f.match(/^(\d+)_.*\.sql$/)).filter(Boolean).map((m) => Number(m[1]))
    .filter((v) => !applied.has(v));
  if (pending.length) return t.skip(`migrations ${pending.join(", ")} not applied yet, run npm run migrate first`);
  const ledgerMax = Math.max(...applied);
  const before = (await pool.query("SELECT version FROM schema_meta WHERE id = 1")).rows[0].version;
  try {
    await pool.query("UPDATE schema_meta SET version = 98 WHERE id = 1");
    const run = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "migrate.js")], {
      env: process.env, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /up to date/);
    const now = (await pool.query("SELECT version FROM schema_meta WHERE id = 1")).rows[0].version;
    assert.equal(now, ledgerMax);
  } finally {
    await pool.query("UPDATE schema_meta SET version = $1 WHERE id = 1", [before]);
  }
});

// Super Final Appendix 3 §3.1: Head-to-Head scores carry into the Semi
// Final. The live scoreboard added them; the recap, results.csv and
// results.pdf didn't, so a finished SF showed different totals and a
// different order from what spectators had just watched. The same
// standings also drop a diver who withdrew after diving, then put them
// back once the event completes; prior dives count everywhere now.
test("a Super Final stage keeps its carried scores, and a withdrawn diver keeps their dives, live and after", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const dd = Number((await pool.query("SELECT dd FROM dive_directory WHERE id = $1", [dive])).rows[0].dd);
    const x = await recordKit.diver(st.orgId, null, "female", "Carry Xena");
    const y = await recordKit.diver(st.orgId, null, "female", "Carry Yara");
    const w = await recordKit.diver(st.orgId, null, "female", "Carry Wren");
    const z = await recordKit.diver(st.orgId, null, "female", "Carry Zola");
    const h2h = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(h2h, x, 1, dive, 9);
    await recordKit.dive(h2h, y, 1, dive, 5);
    await recordKit.dive(h2h, w, 1, dive, 4);
    await recordKit.dive(h2h, z, 1, dive, 7); // lost her H2H, not in the SF
    const sf = await recordKit.event(st.orgId, { gender: "Female" });
    await pool.query("UPDATE events SET score_carry_from = $1 WHERE id = $2", [h2h.id, sf.id]);
    await recordKit.dive(sf, x, 1, dive, 6);
    await recordKit.dive(sf, y, 1, dive, 7);
    await recordKit.dive(sf, w, 1, dive, 3);
    await pool.query(
      `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number)
       VALUES ($1, $2, $3, 2), ($1, $4, $3, 2)`,
      [sf.id, x, dive, y],
    );
    // Wren pulls out after her first dive.
    await pool.query("UPDATE competitor_dive_lists SET withdrawn_at = now() WHERE event_id = $1 AND competitor_id = $2", [sf.id, w]);

    // Five judges, the middle three count: each dive is 3 × score × DD.
    const pts = (...scores) => (3 * scores.reduce((a, b) => a + b, 0) * dd).toFixed(2);
    const expected = { "Carry Xena": pts(9, 6), "Carry Yara": pts(5, 7), "Carry Wren": pts(4, 3) };
    const table = (rows) => Object.fromEntries(rows.map((r) => [r.full_name, Number(r.total).toFixed(2)]));

    const live = await fetchJson("GET", `/api/scoreboard/${sf.id}?cache=skip`);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.deepEqual(table(live.body.standings), expected);
    assert.deepEqual(live.body.standings.map((r) => r.full_name), ["Carry Xena", "Carry Yara", "Carry Wren"]);

    await pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [sf.id]);
    const recap = await fetchJson("GET", `/api/archive/${sf.id}/results`);
    assert.equal(recap.status, 200, JSON.stringify(recap.body));
    assert.deepEqual(table(recap.body.standings), expected);
    assert.deepEqual(recap.body.standings.map((r) => r.full_name), ["Carry Xena", "Carry Yara", "Carry Wren"]);

    const csv = await (await fetch(`${baseUrl}/api/events/${sf.id}/results.csv`)).text();
    const rows = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
    const byName = Object.fromEntries(rows.map((r) => [r[0], [Number(r[12]).toFixed(2), r[13]]]));
    assert.deepEqual(byName, {
      "Carry Xena": [expected["Carry Xena"], "1"],
      "Carry Yara": [expected["Carry Yara"], "2"],
      "Carry Wren": [expected["Carry Wren"], "3"],
    });

    const pdf = await fetch(`${baseUrl}/api/events/${sf.id}/results.pdf`);
    const text = pdfText(Buffer.from(await pdf.arrayBuffer())).join("\n");
    assert.match(text, new RegExp(`1\\.\\s+Carry Xena[^\\n]*\\n${expected["Carry Xena"]}`));
    assert.ok(!text.includes("Carry Zola"), "the H2H loser isn't in the SF");
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// WA 2026 CR Art 4.1.5: equal totals tie for the place. The analytics
// ranking used to split a tie on the highest single dive, so a diver who
// shared gold on the scoreboard was counted a silver on their dashboard.
test("diver analytics treat a tie on total as a shared place", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const p = await recordKit.diver(st.orgId, null, "female", "Tie Petra");
    const q = await recordKit.diver(st.orgId, null, "female", "Tie Quinn");
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(ev, p, 1, dive, 8);
    await recordKit.dive(ev, p, 2, dive, 6);
    await recordKit.dive(ev, q, 1, dive, 7);
    await recordKit.dive(ev, q, 2, dive, 7);
    for (const id of [p, q]) {
      const a = await fetchJson("GET", `/api/divers/${id}/analytics`);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(Number(a.body.recent_form[0].rank), 1, "both share first");
      assert.equal(a.body.placings.gold, 1);
      assert.equal(a.body.year_over_year[0].wins, 1);
    }
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// A team event ranks teams (teamStandingsCte). Everything that printed a
// "place" for a team member used to rank the members against each other
// instead: the By-Round leaderboard, results.csv, the score sheet, the
// profile trend, the analytics widgets, the public profile and the coach
// dashboard. They all give a member their team's total and place now.
test("team events rank teams everywhere a member's place is shown", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const dd = Number((await pool.query("SELECT dd FROM dive_directory WHERE id = $1", [dive])).rows[0].dd);
    const a1 = await recordKit.diver(st.orgId, null, "female", "Team Alpha One");
    const a2 = await recordKit.diver(st.orgId, null, "female", "Team Alpha Two");
    const b1 = await recordKit.diver(st.orgId, null, "female", "Team Bravo One");
    const b2 = await recordKit.diver(st.orgId, null, "female", "Team Bravo Two");
    const ev = await recordKit.event(st.orgId, { gender: "Female", eventType: "team" });
    const team = async (name, short) => {
      const id = (await pool.query(
        "INSERT INTO teams (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [st.orgId, name, short],
      )).rows[0].id;
      await pool.query("INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)", [ev.id, id]);
      return id;
    };
    const alpha = await team("Alpha", "ALP");
    const bravo = await team("Bravo", "BRV");
    // Bravo One is the best diver in the pool, Alpha the better team.
    await recordKit.dive(ev, a1, 1, dive, 8);
    await recordKit.dive(ev, a2, 2, dive, 8);
    await recordKit.dive(ev, b1, 1, dive, 9);
    await recordKit.dive(ev, b2, 2, dive, 5);
    await pool.query("UPDATE competitor_dive_lists SET team_id = $1 WHERE event_id = $2 AND competitor_id = ANY($3::uuid[])", [alpha, ev.id, [a1, a2]]);
    await pool.query("UPDATE competitor_dive_lists SET team_id = $1 WHERE event_id = $2 AND competitor_id = ANY($3::uuid[])", [bravo, ev.id, [b1, b2]]);
    // Bravo One still has a dive to come, so the coach dashboard has a card.
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, team_id, dive_id, round_number) VALUES ($1, $2, $3, $4, 3)",
      [ev.id, b1, bravo, dive],
    );
    const bravoTotal = (3 * 14 * dd).toFixed(2);

    const lb = await fetchJson("GET", `/api/scoreboard/${ev.id}/leaderboard?cache=skip`);
    assert.equal(lb.status, 200, JSON.stringify(lb.body));
    const round = (n) => lb.body.rounds.find((r) => r.round_number === n).rankings
      .map((r) => [r.full_name, r.rank, r.competitor_id ?? null]);
    assert.deepEqual(round(1), [["Bravo", 1, null], ["Alpha", 2, null]]);
    assert.deepEqual(round(2), [["Alpha", 1, null], ["Bravo", 2, null]]);

    const csv = await (await fetch(`${baseUrl}/api/events/${ev.id}/results.csv`)).text();
    const rows = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
    const place = Object.fromEntries(rows.map((r) => [r[0], [Number(r[12]).toFixed(2), r[13]]]));
    assert.deepEqual(place["Team Bravo One"], [bravoTotal, "2"]);
    assert.deepEqual(place["Team Alpha Two"], [(3 * 16 * dd).toFixed(2), "1"]);

    const sheet = await fetch(`${baseUrl}/api/events/${ev.id}/divers/${b1}/score-sheet.pdf`);
    assert.match(pdfText(Buffer.from(await sheet.arrayBuffer())).join("\n"), /2nd of 2/);

    const profile = await fetchJson("GET", `/api/divers/${b1}/profile`);
    const trend = profile.body.score_trend.find((r) => r.event_id === ev.id);
    assert.equal(trend.final_rank, 2);
    assert.equal(Number(trend.total_score).toFixed(2), bravoTotal);
    assert.equal(trend.team_name, "Bravo");

    const analytics = await fetchJson("GET", `/api/divers/${b1}/analytics`);
    assert.equal(Number(analytics.body.recent_form[0].rank), 2);
    assert.equal(analytics.body.recent_form[0].field_size, 2, "two teams, not four divers");
    assert.equal(analytics.body.placings.silver, 1);

    const slug = crypto.randomBytes(16).toString("hex");
    await pool.query("UPDATE users SET public_slug = $1 WHERE id = $2", [slug, b1]);
    const pub = await fetchJson("GET", `/api/public/divers/${slug}`);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.deepEqual([pub.body.recent_meets[0].rank, pub.body.recent_meets[0].field_size], [2, 2]);

    const coachName = `int-tc-${crypto.randomBytes(3).toString("hex")}`;
    const coach = await insertUser({ orgId: st.orgId, role: "coach", username: coachName, fullName: "Team Coach" });
    await pool.query("INSERT INTO coach_diver_links (coach_id, diver_id, org_id) VALUES ($1, $2, $3)", [coach, b1, st.orgId]);
    const login = await fetchJson("POST", "/api/auth/login", { body: { username: coachName, password: "not-used-here" } });
    const dash = await fetchJson("GET", "/api/coach/dashboard", { token: login.body.token });
    assert.equal(dash.status, 200, JSON.stringify(dash.body));
    const card = dash.body.find((r) => r.diver_id === b1);
    assert.deepEqual([card.current_rank, card.field_size, Number(card.current_total).toFixed(2)], [2, 2, bravoTotal]);
  } finally {
    await pool.query("DELETE FROM coach_diver_links WHERE org_id = $1", [st.orgId]);
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Synchro pairs entered once (Control Room import, manual add) keep their
// scores under the lead, partner_id naming the other diver. The partner's
// profile, analytics, public card and score sheet only ever looked for
// their own competitor_id, so every synchro event they dived was missing.
// Pairs entered both ways round (the consent flow's mirror rows) have
// scores on each side, and mustn't count twice.
test("a synchro partner's profile, analytics, public card and score sheet show the pair's result", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const lead = await recordKit.diver(st.orgId, null, "female", "Sync Lena Lead");
    const partner = await recordKit.diver(st.orgId, null, "female", "Sync Pia Partner");
    const lead2 = await recordKit.diver(st.orgId, null, "female", "Sync Other Lead");
    const partner2 = await recordKit.diver(st.orgId, null, "female", "Sync Other Partner");
    const sync = await recordKit.event(st.orgId, { gender: "Female", eventType: "synchro_pair" });
    await recordKit.dive(sync, lead, 1, dive, 8, { partnerId: partner });
    await recordKit.dive(sync, lead2, 1, dive, 6, { partnerId: partner2 });
    // A mirrored pair where both sides were scored.
    const mirror = await recordKit.event(st.orgId, { gender: "Female", eventType: "synchro_pair" });
    await recordKit.dive(mirror, lead, 1, dive, 7, { partnerId: partner });
    await recordKit.dive(mirror, partner, 1, dive, 7, { partnerId: lead });

    const profile = await fetchJson("GET", `/api/divers/${partner}/profile`);
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    assert.equal(profile.body.stats.total_dives, 2, "one per event, the mirror isn't doubled");
    assert.equal(profile.body.stats.total_meets, 2);
    const trend = profile.body.score_trend.find((r) => r.event_id === sync.id);
    assert.ok(trend, "the pair's event is on the partner's trend");
    assert.equal(trend.final_rank, 1);
    assert.equal(trend.partner_name, "Sync Lena Lead");
    assert.ok(profile.body.personal_bests.length >= 1);

    const a = await fetchJson("GET", `/api/divers/${partner}/analytics`);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const recent = a.body.recent_form.find((r) => r.event_id === sync.id);
    assert.equal(Number(recent.rank), 1);
    assert.equal(recent.field_size, 2);
    assert.equal(recent.dives.length, 1, "the expanded card has the pair's dive");
    assert.equal(a.body.quality_mix.total, 10, "five judges on each of the two dives");
    assert.equal(a.body.round_stamina[0].dive_count, 2);

    const slug = crypto.randomBytes(16).toString("hex");
    await pool.query("UPDATE users SET public_slug = $1 WHERE id = $2", [slug, partner]);
    const pub = await fetchJson("GET", `/api/public/divers/${slug}`);
    assert.equal(pub.body.stats.total_meets, 2);
    assert.ok(pub.body.recent_meets.some((m) => m.event_id === sync.id && m.rank === 1));

    const sheet = await fetch(`${baseUrl}/api/events/${sync.id}/divers/${partner}/score-sheet.pdf`);
    const text = pdfText(Buffer.from(await sheet.arrayBuffer())).join("\n");
    assert.match(text, /1st of 2/);
    assert.ok(!/No dives recorded/.test(text));
    assert.match(text, /Sync Lena Lead/, "the sheet names the pair");
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// PDFKit's Helvetica only prints WinAnsi. A Russian program.pdf printed
// its section headers, and any Cyrillic or Polish name, as mojibake. With
// no Unicode font configured the headers fall back to English and names
// are transliterated (lib/pdf-document).
test("program.pdf in Russian prints readable headers and names", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  if (require("../lib/pdf-fonts").anyFontFile()) return t.skip("PDF fonts found, text isn't folded");
  const st = await setupFixture({ withEvent: false });
  try {
    const meet = (await pool.query(
      "INSERT INTO meets (org_id, name) VALUES ($1, 'Кубок Łodzi') RETURNING id", [st.orgId],
    )).rows[0].id;
    const ev = (await pool.query(
      `INSERT INTO events (org_id, meet_id, name, gender, height, number_of_judges, total_rounds)
       VALUES ($1, $2, 'Вышка 10м', 'Female', '10m', 5, 5) RETURNING id`,
      [st.orgId, meet],
    )).rows[0].id;
    const judge = await insertUser({ orgId: st.orgId, role: "judge", username: `int-ru-${st.slug}`, fullName: "Łukasz Иванов" });
    await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)", [ev, judge]);
    const res = await fetch(`${baseUrl}/api/meets/${meet}/program.pdf?include=judges`, {
      headers: { "accept-language": "ru" },
    });
    assert.equal(res.status, 200);
    const text = pdfText(Buffer.from(await res.arrayBuffer())).join("\n");
    assert.match(text, /EVENT SCHEDULE/);
    assert.match(text, /JUDGE PANEL/);
    assert.match(text, /Lukasz Ivanov/);
    assert.match(text, /Kubok Lodzi/);
    assert.match(text, /Vyshka 10m/);
  } finally {
    await pool.query("DELETE FROM meets WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// The Control Room's "paid" flag looked for payer_user_id = the diver, so
// an entry a guardian paid for (payer = guardian, subject = diver) showed
// as unpaid on the roster.
test("the roster counts an entry a guardian paid for as paid", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture();
  try {
    const kid = await insertUser({ orgId: st.orgId, role: "diver", username: `int-gp-k-${st.slug}`, fullName: "Paid Kid" });
    const parent = await insertUser({ orgId: st.orgId, role: "spectator", username: `int-gp-p-${st.slug}`, fullName: "Paying Parent" });
    const dive = await recordKit.threeMetreDive();
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 1)",
      [st.eventId, kid, dive],
    );
    const paid = async () => {
      const r = await fetchJson("GET", `/api/events/${st.eventId}/roster`, { token: st.adminToken });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rows = Array.isArray(r.body) ? r.body : r.body.roster || r.body.rows;
      return rows.find((row) => row.competitor_id === kid).paid_entry;
    };
    assert.equal(await paid(), false);
    await pool.query(
      `INSERT INTO payments (org_id, payer_user_id, subject_user_id, subject_type, event_id,
                             amount_cents, platform_fee_cents, currency, status, paid_at)
       VALUES ($1, $2, $3, 'event_entry', $4, 2000, 300, 'GBP', 'paid', now())`,
      [st.orgId, parent, kid, st.eventId],
    );
    assert.equal(await paid(), true);
  } finally {
    await pool.query("DELETE FROM payments WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// Migration 096 / club-first §20: a club waiting on its federation stays
// out of public surfaces (PUBLIC_CLUB_JOIN). The judge ranking analysis,
// judge analytics' club breakdown and the diver search joined clubs
// plainly and printed the pending club's name and code.
test("a pending club's name stays off judge ranking, judge analytics and diver search", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const club = await recordKit.club(st.orgId, "Unvetted Pending Club Zed", "UPZ");
    await pool.query("UPDATE clubs SET status = 'pending' WHERE id = $1", [club]);
    const dive = await recordKit.threeMetreDive();
    const d1 = await recordKit.diver(st.orgId, club, "female", "Pending Zara");
    const d2 = await recordKit.diver(st.orgId, null, "female", "Open Zoe");
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [club, ev.judges[0]]);
    for (const r of [1, 2, 3]) {
      await recordKit.dive(ev, d1, r, dive, 6 + (r % 2));
      await recordKit.dive(ev, d2, r, dive, 7);
    }
    await pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [ev.id]);

    const jra = await fetchJson("GET", `/api/events/${ev.id}/judge-ranking-analysis`);
    assert.equal(jra.status, 200, JSON.stringify(jra.body));
    assert.ok(!JSON.stringify(jra.body).includes("Unvetted"), "no pending club name anywhere");
    assert.equal(jra.body.divers.find((d) => d.full_name === "Pending Zara").club_name, null);
    assert.equal(jra.body.judges.find((j) => j.judge_id === ev.judges[0]).club_code, null);

    const ja = await fetchJson("GET", `/api/judges/${ev.judges[1]}/analytics`);
    assert.equal(ja.status, 200, JSON.stringify(ja.body));
    assert.ok(!JSON.stringify(ja.body.club_breakdown).includes("UPZ"));
    assert.ok(!ja.body.club_breakdown.some((c) => c.club_id === club));

    const search = await fetchJson("GET", "/api/divers/search?q=Pending%20Zara", { token: st.adminToken });
    assert.equal(search.status, 200);
    assert.equal(search.body[0].club_name, null);
    const browse = await fetchJson("GET", `/api/divers?q=Pending%20Zara`, { token: st.adminToken });
    assert.equal(browse.body.rows[0].club_code, null);
  } finally {
    await recordKit.cleanup(st.orgId);
    await pool.query("UPDATE users SET club_id = NULL WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// AGENTS.md / migration 090: a diver row in an event context prints the
// meet's representation code. The judge ranking table and the coach's
// per-event views printed the federation's country beside a scoreboard
// showing the club.
test("judge ranking and the coach's event views print the meet's representation code", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const club = await recordKit.club(st.orgId, "Rep Code Divers", "RPC");
    const meet = (await pool.query(
      "INSERT INTO meets (org_id, name, represent_as) VALUES ($1, 'Club Champs', 'club') RETURNING id", [st.orgId],
    )).rows[0].id;
    const dive = await recordKit.threeMetreDive();
    const diver = await recordKit.diver(st.orgId, club, "female", "Rhea Rep");
    const other = await recordKit.diver(st.orgId, null, "female", "Una Unattached");
    const ev = await recordKit.event(st.orgId, { gender: "Female" });
    await pool.query("UPDATE events SET meet_id = $1 WHERE id = $2", [meet, ev.id]);
    await recordKit.dive(ev, diver, 1, dive, 7);
    await recordKit.dive(ev, other, 1, dive, 6);
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 2)",
      [ev.id, diver, dive],
    );

    const sb = await fetchJson("GET", `/api/scoreboard/${ev.id}?cache=skip`);
    assert.equal(sb.body.standings.find((r) => r.full_name === "Rhea Rep").country_code, "RPC");
    const jra = await fetchJson("GET", `/api/events/${ev.id}/judge-ranking-analysis`);
    assert.equal(jra.body.divers.find((d) => d.full_name === "Rhea Rep").country_code, "RPC");

    const coachName = `int-rc-${crypto.randomBytes(3).toString("hex")}`;
    const coach = await insertUser({ orgId: st.orgId, role: "coach", username: coachName, fullName: "Rep Coach" });
    await pool.query("INSERT INTO coach_diver_links (coach_id, diver_id, org_id) VALUES ($1, $2, $3)", [coach, diver, st.orgId]);
    const token = (await fetchJson("POST", "/api/auth/login", { body: { username: coachName, password: "not-used-here" } })).body.token;
    const lists = await fetchJson("GET", `/api/coach/dive-lists/${ev.id}`, { token });
    assert.equal(lists.status, 200, JSON.stringify(lists.body));
    assert.equal(lists.body.divers.find((d) => d.diver_id === diver).country_code, "RPC");
    const dash = await fetchJson("GET", "/api/coach/dashboard", { token });
    assert.equal(dash.body.find((r) => r.diver_id === diver).country_code, "RPC");
  } finally {
    await pool.query("DELETE FROM coach_diver_links WHERE org_id = $1", [st.orgId]);
    await recordKit.cleanup(st.orgId);
    await pool.query("DELETE FROM events WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM meets WHERE org_id = $1", [st.orgId]);
    await pool.query("UPDATE users SET club_id = NULL WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// Program timing: a synchro roster stored one row per pair already counts
// pairs, so halving it made a 20-dive event look like 10. Pairs entered
// both ways round (mirror rows) must still count once, and reserves and
// withdrawn divers don't dive at all.
test("program timing counts synchro pairs once, however the roster stores them", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const meet = (await pool.query("INSERT INTO meets (org_id, name) VALUES ($1, 'Timing Meet') RETURNING id", [st.orgId])).rows[0].id;
    const dive = await recordKit.threeMetreDive();
    const mkEvent = async (name) => (await pool.query(
      `INSERT INTO events (org_id, meet_id, name, gender, height, number_of_judges, total_rounds, event_type)
       VALUES ($1, $2, $3, 'Mixed', '3m', 9, 5, 'synchro_pair') RETURNING id`,
      [st.orgId, meet, name],
    )).rows[0].id;
    const people = [];
    for (let i = 0; i < 10; i++) people.push(await recordKit.diver(st.orgId, null, "female", `Timing Diver ${i}`));
    const row = (ev, a, b, extra = {}) => pool.query(
      `INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, dive_id, round_number, is_reserve, withdrawn_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6)`,
      [ev, a, b, dive, !!extra.reserve, extra.withdrawn ? new Date() : null],
    );
    const single = await mkEvent("Single rows");
    for (let p = 0; p < 4; p++) await row(single, people[2 * p], people[2 * p + 1]);
    await row(single, people[8], people[9], { reserve: true });
    const mirrored = await mkEvent("Mirrored rows");
    for (let p = 0; p < 3; p++) {
      await row(mirrored, people[2 * p], people[2 * p + 1]);
      await row(mirrored, people[2 * p + 1], people[2 * p]);
    }
    await row(mirrored, people[6], people[7], { withdrawn: true });
    await row(mirrored, people[7], people[6], { withdrawn: true });

    const csv = await (await fetch(`${baseUrl}/api/meets/${meet}/program.csv?include=timing&seconds_per_dive=60`)).text();
    const events = Object.fromEntries(csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(","))
      .filter((c) => c[0] === "event").map((c) => [c[1], [c[10], c[12]]]));
    assert.deepEqual(events["Single rows"], ["4", String(4 * 5 * 60)]);
    assert.deepEqual(events["Mirrored rows"], ["3", String(3 * 5 * 60)]);
  } finally {
    await pool.query("DELETE FROM events WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM meets WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// A synchro panel trims within its sub-panels (WA Art 9.1.5.4: execution
// high and low across both athletes' marks, then the sync group), the way
// the scoreboard and calc_event_dive_points do. The score sheet bracketed
// a flat two-high, two-low across all nine judges instead.
test("the score sheet brackets the synchro sub-panel trim the scoreboard shows", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const lead = await recordKit.diver(st.orgId, null, "female", "Sheet Lead");
    const partner = await recordKit.diver(st.orgId, null, "female", "Sheet Partner");
    const ev = (await pool.query(
      `INSERT INTO events (org_id, name, gender, height, number_of_judges, total_rounds, event_type, status)
       VALUES ($1, 'Sync sheet', 'Female', '3m', 9, 5, 'synchro_pair', 'Live') RETURNING id`, [st.orgId],
    )).rows[0].id;
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, dive_id, round_number) VALUES ($1, $2, $3, $4, 1)",
      [ev, lead, partner, dive],
    );
    const scores = [5, 6, 7, 8, 9, 9.5, 9.5, 10, 10];
    for (let i = 0; i < 9; i++) {
      const j = await insertUser({ orgId: st.orgId, role: "judge", fullName: `Sync Judge ${i + 1}`, username: `int-sj-${crypto.randomBytes(4).toString("hex")}` });
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [ev, j, i + 1]);
      await pool.query(
        "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, 1, $5)",
        [ev, lead, j, dive, scores[i]],
      );
    }
    const res = await fetch(`${baseUrl}/api/events/${ev}/divers/${lead}/score-sheet.pdf`);
    assert.equal(res.status, 200);
    const line = pdfText(Buffer.from(await res.arrayBuffer())).find((l) => l.startsWith("Judges:"));
    assert.equal(line, "Judges: [5.0]  6.0  7.0  [8.0]  [9.0]  9.5  9.5  10.0  [10.0]");
  } finally {
    await teardownFixture(st);
  }
});

// A reserve (WA 4.1.12) isn't competing. The start list numbered them as
// the next diver, dives and all, with nothing to say they're a reserve;
// the program PDF already lists them under RESERVES.
test("the start list keeps reserves out of the running order", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture();
  try {
    const dive = await recordKit.threeMetreDive();
    const add = async (name, order, reserve = null) => {
      const id = await recordKit.diver(st.orgId, null, "female", name);
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number, display_order, is_reserve, reserve_position)
         VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [st.eventId, id, dive, order, reserve != null, reserve],
      );
    };
    await add("Start Ada", 1);
    await add("Start Bea", 2);
    await add("Reserve Cleo", null, 1);
    const res = await fetch(`${baseUrl}/api/events/${st.eventId}/start-list.pdf`);
    assert.equal(res.status, 200);
    const lines = pdfText(Buffer.from(await res.arrayBuffer()));
    const at = (re) => lines.findIndex((l) => re.test(l));
    assert.ok(!lines.includes("3"), "the reserve isn't diver #3");
    const header = at(/^RESERVES$/);
    assert.ok(header > at(/^Start Bea/), "a RESERVES block after the running order");
    assert.ok(at(/^Reserve Cleo/) > header);
    assert.equal(lines[at(/^Reserve Cleo/) - 1], "R1");
  } finally {
    await teardownFixture(st);
  }
});

// The scoreboard hides an Upcoming event from outsiders (ensureScoreboard-
// Visible), and records treat scores typed into one as Control Room
// try-outs. The results exports, the score sheet and the judge ranking
// analysis had no such gate, so anyone could download the practice scores
// with a "final_rank". They follow the scoreboard's rule now.
test("results exports, score sheets and judge ranking follow the scoreboard's visibility", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture();
  try {
    const dive = await recordKit.threeMetreDive();
    const diver = await recordKit.diver(st.orgId, null, "female", "Tryout Tess");
    const judges = [];
    for (let i = 1; i <= 5; i++) {
      const j = await insertUser({ orgId: st.orgId, role: "judge", fullName: `Tryout Judge ${i}`, username: `int-vis-${crypto.randomBytes(4).toString("hex")}` });
      await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [st.eventId, j, i]);
      judges.push(j);
    }
    await recordKit.dive({ id: st.eventId, judges }, diver, 1, dive, 7.5);
    const status = (await pool.query("SELECT status FROM events WHERE id = $1", [st.eventId])).rows[0].status;
    assert.equal(status, "Upcoming");

    const paths = [
      `/api/events/${st.eventId}/results.csv`,
      `/api/events/${st.eventId}/results.pdf`,
      `/api/events/${st.eventId}/divers/${diver}/score-sheet.pdf`,
      `/api/events/${st.eventId}/judge-ranking-analysis`,
      `/api/events/${st.eventId}/judge-ranking-analysis.csv`,
      `/api/events/${st.eventId}/judge-ranking-analysis.pdf`,
    ];
    for (const p of paths) {
      assert.equal((await fetch(`${baseUrl}${p}`)).status, 404, `${p}: hidden from the public while Upcoming`);
      const own = await fetch(`${baseUrl}${p}`, { headers: { authorization: `Bearer ${st.adminToken}` } });
      assert.equal(own.status, 200, `${p}: the host org can still pull it`);
    }
    // The start list is meant to be public before the meet.
    assert.equal((await fetch(`${baseUrl}/api/events/${st.eventId}/start-list.pdf`)).status, 200);

    await pool.query("UPDATE events SET status = 'Live' WHERE id = $1", [st.eventId]);
    for (const p of paths) assert.equal((await fetch(`${baseUrl}${p}`)).status, 200, `${p}: public once Live`);
  } finally {
    await teardownFixture(st);
  }
});

// Ids go straight into uuid comparisons, so a malformed one made Postgres
// throw 22P02 and every route here answered 500 (and logged an error per
// crawler hit). Path ids now 404, filter ids 400.
test("malformed ids get a 404 or 400, never a 500", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture();
  try {
    const x = "not-a-uuid";
    for (const path of [
      `/api/scoreboard/${x}`, `/api/scoreboard/${x}/leaderboard`, `/api/archive/${x}/results`,
      `/api/events/${x}/judge-ranking-analysis`, `/api/events/${x}/judge-ranking-analysis.csv`,
      `/api/divers/${x}/profile`, `/api/divers/${x}/analytics`,
      `/api/judges/${x}/profile`, `/api/judges/${x}/analytics`,
      `/api/events/${x}/results.pdf`, `/api/events/${x}/results.csv`, `/api/events/${x}/start-list.pdf`,
      `/api/events/${st.eventId}/divers/${x}/score-sheet.pdf`,
      `/api/meets/${x}/program.pdf`, `/api/meets/${x}/fees`, `/api/events/${x}/fee`,
      `/api/dr-archive/meets/${x}`, `/api/dr-archive/divers/${x}`,
    ]) {
      const r = await fetchJson("GET", path);
      assert.equal(r.status, 404, `${path} → ${r.status}`);
    }
    const coach = await fetchJson("GET", `/api/coach/dive-lists/${x}`, { token: st.adminToken });
    assert.equal(coach.status, 404);
    assert.equal((await fetchJson("GET", `/api/judges/directory?org_id=${x}`)).status, 400);
    assert.equal((await fetchJson("GET", `/api/divers?club_id=${x}`, { token: st.adminToken })).status, 400);
    // A well-formed id that doesn't exist is still a 404, and a real one works.
    assert.equal((await fetchJson("GET", `/api/scoreboard/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await fetchJson("GET", `/api/judges/directory?org_id=${st.orgId}`)).status, 200);
  } finally {
    await teardownFixture(st);
  }
});

// A coach can scratch a diver from a Live event (routes/coach.js), and
// the route promised the operator a banner. Nothing was sent: the Control
// Room loads a Live pool's roster once, so the withdrawn diver stayed in
// the queue until someone reloaded. The route now tells the event's room,
// with no names or reasons on the wire (spectators sit in that room too),
// and drops the cached scoreboard.
test("a coach withdrawing a diver mid-event tells the event room", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { io: ioClient } = require("socket.io-client");
  const st = await setupFixture({ withEvent: false });
  let sock;
  try {
    const dive = await recordKit.threeMetreDive();
    const diver = await recordKit.diver(st.orgId, null, "female", "Scratch Sadie");
    const ev = await recordKit.event(st.orgId, { gender: "Female" }); // Live
    await recordKit.dive(ev, diver, 1, dive, 7);
    await pool.query(
      "INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number) VALUES ($1, $2, $3, 2)",
      [ev.id, diver, dive],
    );
    const coachName = `int-cw-${crypto.randomBytes(3).toString("hex")}`;
    const coach = await insertUser({ orgId: st.orgId, role: "coach", username: coachName, fullName: "Scratch Coach" });
    await pool.query("INSERT INTO coach_diver_links (coach_id, diver_id, org_id) VALUES ($1, $2, $3)", [coach, diver, st.orgId]);
    const token = (await fetchJson("POST", "/api/auth/login", { body: { username: coachName, password: "not-used-here" } })).body.token;

    sock = ioClient(baseUrl, { transports: ["websocket"], forceNew: true });
    await new Promise((resolve, reject) => { sock.on("connect", resolve); sock.on("connect_error", reject); });
    sock.emit("subscribe_event", { event_id: ev.id });
    await new Promise((r) => setTimeout(r, 200));
    const heard = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no roster_changed")), 3000);
      sock.on("roster_changed", (msg) => { clearTimeout(timer); resolve(msg); });
    });
    const res = await fetchJson("POST", `/api/coach/dive-lists/${ev.id}/${diver}/withdraw`, {
      token, body: { reason: "sore shoulder" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const msg = await heard;
    assert.deepEqual(msg, { event_id: ev.id, competitor_id: diver, change: "withdrawn" });
  } finally {
    sock?.close();
    await pool.query("DELETE FROM coach_diver_links WHERE org_id = $1", [st.orgId]);
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// coach_diver_links is unique on (coach, diver). Re-linking a pair whose
// old link belongs to a federation they've both left only updated the
// note, so the new federation got a 201 for a link it couldn't list,
// delete or use.
test("re-linking a coach and diver who changed federation moves the link", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const X = await setupFixture({ withEvent: false });
  const Y = await setupFixture({ withEvent: false });
  try {
    const coach = await insertUser({ orgId: X.orgId, role: "coach", username: `int-cl-c-${X.slug}`, fullName: "Moving Coach" });
    const diver = await insertUser({ orgId: X.orgId, role: "diver", username: `int-cl-d-${X.slug}`, fullName: "Moving Diver" });
    const first = await fetchJson("POST", `/api/orgs/${X.orgId}/coach-links`, { token: X.adminToken, body: { coach_id: coach, diver_id: diver } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    // Both transfer to Y.
    await pool.query("UPDATE users SET org_id = $1 WHERE id = ANY($2::uuid[])", [Y.orgId, [coach, diver]]);
    await pool.query("UPDATE user_org_roles SET org_id = $1 WHERE user_id = ANY($2::uuid[])", [Y.orgId, [coach, diver]]);
    const again = await fetchJson("POST", `/api/orgs/${Y.orgId}/coach-links`, { token: Y.adminToken, body: { coach_id: coach, diver_id: diver, note: "new squad" } });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const list = await fetchJson("GET", `/api/orgs/${Y.orgId}/coach-links`, { token: Y.adminToken });
    assert.deepEqual(list.body.map((l) => [l.coach_id, l.diver_id, l.note]), [[coach, diver, "new squad"]]);
    assert.deepEqual((await fetchJson("GET", `/api/orgs/${X.orgId}/coach-links`, { token: X.adminToken })).body, []);
    const del = await fetchJson("DELETE", `/api/coach-links/${list.body[0].id}`, { token: Y.adminToken });
    assert.equal(del.status, 200);
  } finally {
    await pool.query("DELETE FROM coach_diver_links WHERE org_id = ANY($1::uuid[])", [[X.orgId, Y.orgId]]);
    await teardownFixture(Y);
    await teardownFixture(X);
  }
});

// Migration 035 made score_audit_log.event_id and role_audit_log.org_id
// nullable so audit rows outlive a deleted event or org. The dashboard
// feed (and /api/audit/recent's role rows) still INNER JOINed them, so a
// sysadmin's feed silently dropped exactly those rows.
test("the sysadmin's activity feeds keep audit rows whose event or org is gone", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const jwt = require("jsonwebtoken");
  const st = await setupFixture();
  try {
    const sys = await insertUser({ orgId: st.orgId, role: "org_admin", username: `int-sa-${st.slug}`, fullName: "Feed Sysadmin" });
    await pool.query("UPDATE users SET is_system_admin = true WHERE id = $1", [sys]);
    const token = jwt.sign(
      { id: sys, username: `int-sa-${st.slug}`, full_name: "Feed Sysadmin", org_id: st.orgId, org_roles: ["org_admin"], is_system_admin: true },
      process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "10m" },
    );
    // Newest in the feed (a minute ahead), so other suites' rows can't push them out.
    const scoreRow = (await pool.query(
      `INSERT INTO score_audit_log (event_id, round_number, action, old_score, new_score, reason, created_at)
       VALUES ($1, 1, 'update', 6.0, 6.5, 'orphan check', now() + interval '1 minute') RETURNING id`,
      [st.eventId],
    )).rows[0].id;
    const roleRow = (await pool.query(
      `INSERT INTO role_audit_log (user_id, org_id, role, action, created_at)
       VALUES ($1, NULL, 'judge', 'granted', now() + interval '1 minute') RETURNING id`,
      [sys],
    )).rows[0].id;
    await pool.query("DELETE FROM events WHERE id = $1", [st.eventId]); // event_id → NULL

    const dash = await fetchJson("GET", "/api/dashboard", { token });
    assert.equal(dash.status, 200, JSON.stringify(dash.body));
    const ids = (dash.body.recent_activity || []).map((r) => r.id);
    assert.ok(ids.includes(scoreRow), "the correction on a deleted event is still in the feed");
    assert.ok(ids.includes(roleRow), "so is the role change with no org");
    const recent = await fetchJson("GET", "/api/audit/recent?days=1", { token });
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
    assert.ok(recent.body.some((r) => r.id === roleRow));
    // An org admin's own feed never saw orphans, and still doesn't.
    const own = await fetchJson("GET", "/api/dashboard", { token: st.adminToken });
    assert.ok(!(own.body.recent_activity || []).some((r) => r.id === scoreRow || r.id === roleRow));
  } finally {
    await pool.query("DELETE FROM score_audit_log WHERE reason = 'orphan check'");
    await pool.query("DELETE FROM role_audit_log WHERE user_id IN (SELECT id FROM users WHERE org_id = $1)", [st.orgId]);
    await teardownFixture(st);
  }
});

// Reserves (migration 040) come back in the roster rows, sorted last in
// their round. The Live pool's nextQueueIndex and the randomise preview
// skip rows flagged is_reserve, but the roster never sent the flag, so
// Next Diver after the last real diver of a round put the reserve on the
// stage. The unit tests used a hand-made roster that had the field.
test("the roster flags reserves, so the Live queue steps over them", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const { nextQueueIndex, competingQueue } = await import("../src/composables/useLivePools.js");
  const st = await setupFixture();
  try {
    const dive = await recordKit.threeMetreDive();
    const add = async (name, order, reservePos = null) => {
      const id = await recordKit.diver(st.orgId, null, "female", name);
      // Two rounds each, like a real dive list.
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number, display_order, is_reserve, reserve_position)
         SELECT $1::uuid, $2::uuid, $3::uuid, gs.r, $4::int, $5::boolean, $6::int
           FROM generate_series(1, 2) AS gs(r)`,
        [st.eventId, id, dive, order, reservePos != null, reservePos],
      );
      return id;
    };
    const ada = await add("Queue Ada", 1);
    const bea = await add("Queue Bea", 2);
    const cleo = await add("Queue Cleo", null, 1);
    const r = await fetchJson("GET", `/api/events/${st.eventId}/roster`, { token: st.adminToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = Array.isArray(r.body) ? r.body : r.body.roster || r.body.rows;
    assert.deepEqual(
      rows.map((x) => [x.round_number, x.competitor_id, x.is_reserve]),
      [[1, ada, false], [1, bea, false], [1, cleo, true], [2, ada, false], [2, bea, false], [2, cleo, true]],
    );
    // After Bea in round 1 the next diver is Ada in round 2, not the reserve.
    assert.equal(nextQueueIndex(rows, 1), 3);
    assert.equal(nextQueueIndex(rows, 4), -1, "Bea's last dive ends the event");
    // The pool itself holds only the competing queue, cut from the same rows.
    assert.deepEqual(
      competingQueue(rows).map((x) => [x.round_number, x.competitor_id]),
      [[1, ada], [1, bea], [2, ada], [2, bea]],
    );
  } finally {
    await teardownFixture(st);
  }
});

// Where fix/b4 met the query work already on main. The public profile ranks
// only the diver's five newest events (fullFieldRanking({ latest: 5 })), and
// that cut has to give the same rows as ranking the whole career and keeping
// five, team and synchro-partner events included. And a partner's synchro
// result (b4) is dated by when the event took place (EVENT_DATE, b1), so a
// pair's January meet set up in December lands in January's range.
test("the latest-5 ranking cut matches the full ranking, and a partner's synchro result is dated by its meet", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const { FULL_FIELD_RANKING, fullFieldRanking, EVENT_DATE } = require("../db/queries");
    const dive = await recordKit.threeMetreDive();
    const me = await recordKit.diver(st.orgId, null, "female", "Cut Mara");
    const lead = await recordKit.diver(st.orgId, null, "female", "Cut Lead");
    const rival = await recordKit.diver(st.orgId, null, "female", "Cut Rival");
    const mate = await recordKit.diver(st.orgId, null, "female", "Cut Mate");
    const dated = async (ev, createdAt) => {
      await pool.query("UPDATE events SET status = 'Completed', created_at = $2 WHERE id = $1", [ev.id, createdAt]);
      return ev;
    };
    // Five plain events, two of them created at the same moment.
    for (let i = 0; i < 5; i++) {
      const ev = await dated(await recordKit.event(st.orgId, { gender: "Female" }),
        i < 2 ? "2026-04-01T09:00:00Z" : `2026-0${5 + i}-01T09:00:00Z`);
      await recordKit.dive(ev, me, 1, dive, 6 + i * 0.5);
      await recordKit.dive(ev, rival, 1, dive, 7);
    }
    // A team event, Mara's team second.
    const teamEv = await dated(await recordKit.event(st.orgId, { gender: "Female", eventType: "team" }), "2026-09-10T09:00:00Z");
    const team = async (name) => (await pool.query(
      "INSERT INTO teams (org_id, name, short_code) VALUES ($1, $2, 'CUT') RETURNING id", [st.orgId, name],
    )).rows[0].id;
    const tMe = await team("Cut Team Mara");
    const tRival = await team("Cut Team Rival");
    await recordKit.dive(teamEv, me, 1, dive, 9);
    await recordKit.dive(teamEv, mate, 1, dive, 3);
    await recordKit.dive(teamEv, rival, 1, dive, 8);
    await pool.query("UPDATE competitor_dive_lists SET team_id = $2 WHERE event_id = $1 AND competitor_id = ANY($3::uuid[])", [teamEv.id, tMe, [me, mate]]);
    await pool.query("UPDATE competitor_dive_lists SET team_id = $2 WHERE event_id = $1 AND competitor_id = $3", [teamEv.id, tRival, rival]);
    // A synchro pair stored under the lead, created in December for a
    // meet held in January.
    const meet = (await pool.query(
      "INSERT INTO meets (org_id, name, start_date, end_date) VALUES ($1, 'Cut Synchro Meet', '2026-01-20', '2026-01-20') RETURNING id",
      [st.orgId],
    )).rows[0].id;
    const sync = await dated(await recordKit.event(st.orgId, { gender: "Female", eventType: "synchro_pair" }), "2025-12-15T09:00:00Z");
    await pool.query("UPDATE events SET meet_id = $2 WHERE id = $1", [sync.id, meet]);
    await recordKit.dive(sync, lead, 1, dive, 8, { partnerId: me });
    await recordKit.dive(sync, rival, 1, dive, 6);

    const cols = (rows) => rows.map((r) => [r.event_id, Number(r.total).toFixed(2), Number(r.rank), r.field_size]);
    const order = `JOIN events e ON e.id = ranked.event_id ORDER BY ${EVENT_DATE} DESC, e.id DESC`;
    const full = (await pool.query(`WITH ${FULL_FIELD_RANKING} SELECT ranked.* FROM ranked ${order}`, [me, null, null])).rows;
    const cut = (await pool.query(`WITH ${fullFieldRanking({ latest: 5 })} SELECT ranked.* FROM ranked ${order}`, [me, null, null])).rows;
    assert.equal(full.length, 7);
    assert.deepEqual(cols(cut), cols(full.slice(0, 5)));
    const teamRow = full.find((r) => r.event_id === teamEv.id);
    assert.deepEqual([Number(teamRow.rank), teamRow.field_size], [1, 2], "the team's place, out of the teams");
    assert.throws(() => fullFieldRanking({ latest: "5; DROP TABLE x" }), /positive integer/);

    const slug = crypto.randomBytes(16).toString("hex");
    await pool.query("UPDATE users SET public_slug = $1 WHERE id = $2", [slug, me]);
    const pub = await fetchJson("GET", `/api/public/divers/${slug}`);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.deepEqual(pub.body.recent_meets.map((m) => m.event_id), full.slice(0, 5).map((r) => r.event_id));

    const jan = await fetchJson("GET", `/api/divers/${me}/profile?from_date=2026-01-01&to_date=2026-01-31`);
    assert.equal(jan.status, 200, JSON.stringify(jan.body));
    assert.deepEqual(jan.body.score_trend.map((r) => [r.event_id, r.final_rank, r.partner_name]), [[sync.id, 1, "Cut Lead"]]);
    assert.equal(new Date(jan.body.score_trend[0].created_at).getTime(),
      new Date((await pool.query("SELECT '2026-01-20'::date::timestamptz AS d")).rows[0].d).getTime());
    const dec = await fetchJson("GET", `/api/divers/${me}/profile?from_date=2025-12-01&to_date=2025-12-31`);
    assert.deepEqual(dec.body.score_trend, [], "created in December, held in January");
    const a = await fetchJson("GET", `/api/divers/${me}/analytics`);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.year_over_year.map((y) => [y.year, y.meets]), [[2026, 7]]);
  } finally {
    await pool.query("DELETE FROM meets WHERE org_id = $1", [st.orgId]);
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Who's in a Super Final stage for the carry (lib/scoring-sql stageMembers):
// an active diver, or one who has already dived it. A reserve doesn't count
// even with a scored try-out on their row. That used to be enough to carry
// their whole H2H total onto the SF board, where ownStageScores had already
// kept the try-out itself off, and to add them to the field on every
// diver's score sheet.
test("a Super Final reserve's scored try-out doesn't carry their H2H total onto the SF", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const dd = Number((await pool.query("SELECT dd FROM dive_directory WHERE id = $1", [dive])).rows[0].dd);
    const x = await recordKit.diver(st.orgId, null, "female", "Reserve Xena");
    const y = await recordKit.diver(st.orgId, null, "female", "Reserve Yara");
    const r = await recordKit.diver(st.orgId, null, "female", "Reserve Rhea");
    const h2h = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(h2h, x, 1, dive, 8);
    await recordKit.dive(h2h, y, 1, dive, 6);
    await recordKit.dive(h2h, r, 1, dive, 9.5); // best in the H2H, but only a reserve in the SF
    const sf = await recordKit.event(st.orgId, { gender: "Female" });
    await pool.query("UPDATE events SET score_carry_from = $1, status = 'Completed' WHERE id = $2", [h2h.id, sf.id]);
    await recordKit.dive(sf, x, 1, dive, 7);
    await recordKit.dive(sf, y, 1, dive, 7);
    // Someone tried the reserve's row out on the Control Room.
    await recordKit.dive(sf, r, 1, dive, 10);
    await pool.query(
      "UPDATE competitor_dive_lists SET is_reserve = TRUE, reserve_position = 1 WHERE event_id = $1 AND competitor_id = $2",
      [sf.id, r],
    );

    const pts = (...scores) => (3 * scores.reduce((a, b) => a + b, 0) * dd).toFixed(2);
    const expected = { "Reserve Xena": pts(8, 7), "Reserve Yara": pts(6, 7) };
    const table = (rows) => Object.fromEntries(rows.map((row) => [row.full_name, Number(row.total).toFixed(2)]));
    const live = await fetchJson("GET", `/api/scoreboard/${sf.id}?cache=skip`);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.deepEqual(table(live.body.standings), expected);
    const recap = await fetchJson("GET", `/api/archive/${sf.id}/results`);
    assert.deepEqual(table(recap.body.standings), expected);
    const board = await fetchJson("GET", `/api/scoreboard/${sf.id}/leaderboard?cache=skip`);
    assert.deepEqual(board.body.rounds.flatMap((rd) => rd.rankings.map((row) => row.full_name)).sort(), ["Reserve Xena", "Reserve Yara"]);
    const sheet = await fetch(`${baseUrl}/api/events/${sf.id}/divers/${x}/score-sheet.pdf`);
    assert.match(pdfText(Buffer.from(await sheet.arrayBuffer())).join("\n"), /1st of 2/);
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// The public profile's last five meets are the analytics recent_form's five,
// newest by when each event took place (EVENT_DATE), and dated that way.
// They were ordered and dated by the event row's created_at, so a meet set up
// early but held last could fall out of the public five while it headed the
// dashboard's.
test("the public profile's last five meets are the dashboard's five, dated when they were held", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const me = await recordKit.diver(st.orgId, null, "female", "Held Hana");
    const rival = await recordKit.diver(st.orgId, null, "female", "Held Rival");
    const held = [];
    // Created January to June, held in the opposite order: the one set up
    // first is the most recent meet.
    for (let i = 0; i < 6; i++) {
      const ev = await recordKit.event(st.orgId, { gender: "Female" });
      await pool.query(
        "UPDATE events SET status = 'Completed', created_at = $2, scheduled_at = $3 WHERE id = $1",
        [ev.id, `2026-0${i + 1}-01T09:00:00Z`, `2026-${String(12 - i).padStart(2, "0")}-01T09:00:00Z`],
      );
      await recordKit.dive(ev, me, 1, dive, 6 + i * 0.5);
      await recordKit.dive(ev, rival, 1, dive, 7);
      held.push({ id: ev.id, at: `2026-${String(12 - i).padStart(2, "0")}-01T09:00:00.000Z` });
    }
    const slug = crypto.randomBytes(16).toString("hex");
    await pool.query("UPDATE users SET public_slug = $1 WHERE id = $2", [slug, me]);
    const pub = await fetchJson("GET", `/api/public/divers/${slug}`);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const analytics = await fetchJson("GET", `/api/divers/${me}/analytics`);
    assert.equal(analytics.status, 200, JSON.stringify(analytics.body));
    const newestFive = held.slice(0, 5);
    assert.deepEqual(pub.body.recent_meets.map((m) => m.event_id), newestFive.map((e) => e.id));
    assert.deepEqual(analytics.body.recent_form.map((m) => m.event_id), newestFive.map((e) => e.id));
    assert.deepEqual(pub.body.recent_meets.map((m) => new Date(m.created_at).toISOString()), newestFive.map((e) => e.at));
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// A place on a diver's profile, analytics and public card is the place on
// the event's standings (FULL_FIELD_RANKING reads standingsPerDiveForEventsCte).
// The ranking used to sum every score in the event: a reserve's scored
// try-out counted, even for their team, and put the reserve in the field,
// and a Super Final semi's place left out the H2H carry the scoreboard adds.
test("profile and analytics places match the standings: reserves out, Super Final carry in", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const reserve = async (ev, who) => pool.query(
      "UPDATE competitor_dive_lists SET is_reserve = TRUE, reserve_position = 1 WHERE event_id = $1 AND competitor_id = $2",
      [ev.id, who],
    );
    const place = (body, eventId) => {
      const r = body.recent_form.find((x) => x.event_id === eventId);
      return r && [Number(r.rank), r.field_size, Number(r.total).toFixed(2)];
    };
    const standing = async (eventId, name) => {
      const sb = await fetchJson("GET", `/api/scoreboard/${eventId}?cache=skip`);
      const r = sb.body.standings.find((x) => x.full_name === name);
      return [Number(r.rank), sb.body.standings.length, Number(r.total).toFixed(2)];
    };

    // Team event: Alpha beats Bravo, unless Bravo's reserve's try-out counts.
    const teamEv = await recordKit.event(st.orgId, { gender: "Female", eventType: "team" });
    await pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [teamEv.id]);
    const team = async (name) => (await pool.query(
      "INSERT INTO teams (org_id, name, short_code) VALUES ($1, $2, 'PLC') RETURNING id", [st.orgId, name],
    )).rows[0].id;
    const alpha = await team("Place Alpha");
    const bravo = await team("Place Bravo");
    const a1 = await recordKit.diver(st.orgId, null, "female", "Place A1");
    const b1 = await recordKit.diver(st.orgId, null, "female", "Place B1");
    const br = await recordKit.diver(st.orgId, null, "female", "Place Bravo Reserve");
    await recordKit.dive(teamEv, a1, 1, dive, 8);
    await recordKit.dive(teamEv, b1, 1, dive, 6);
    await recordKit.dive(teamEv, br, 1, dive, 10);
    await pool.query("UPDATE competitor_dive_lists SET team_id = $2 WHERE event_id = $1 AND competitor_id = $3", [teamEv.id, alpha, a1]);
    await pool.query("UPDATE competitor_dive_lists SET team_id = $2 WHERE event_id = $1 AND competitor_id = ANY($3::uuid[])", [teamEv.id, bravo, [b1, br]]);
    await reserve(teamEv, br);

    const aA1 = await fetchJson("GET", `/api/divers/${a1}/analytics`);
    assert.equal(aA1.status, 200, JSON.stringify(aA1.body));
    assert.deepEqual(place(aA1.body, teamEv.id), await standing(teamEv.id, "Place Alpha"));
    assert.equal(place(aA1.body, teamEv.id)[0], 1, "Alpha first, the reserve's 10s don't count for Bravo");
    const pA1 = await fetchJson("GET", `/api/divers/${a1}/profile`);
    assert.deepEqual(pA1.body.score_trend.map((r) => [r.final_rank, r.team_name]), [[1, "Place Alpha"]]);
    const aBr = await fetchJson("GET", `/api/divers/${br}/analytics`);
    assert.equal(place(aBr.body, teamEv.id), undefined, "a reserve has no place to show");

    // Super Final: H2H then an SF carrying it (Appendix 3 §3.1).
    const x = await recordKit.diver(st.orgId, null, "female", "Place Xena");
    const y = await recordKit.diver(st.orgId, null, "female", "Place Yara");
    const r = await recordKit.diver(st.orgId, null, "female", "Place Rhea");
    const h2h = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(h2h, x, 1, dive, 9);
    await recordKit.dive(h2h, y, 1, dive, 5);
    await recordKit.dive(h2h, r, 1, dive, 9.5);
    const sf = await recordKit.event(st.orgId, { gender: "Female" });
    await pool.query("UPDATE events SET score_carry_from = $1, status = 'Completed' WHERE id = $2", [h2h.id, sf.id]);
    // Yara wins the SF round, Xena wins it overall on her H2H carry.
    await recordKit.dive(sf, x, 1, dive, 6);
    await recordKit.dive(sf, y, 1, dive, 7);
    await recordKit.dive(sf, r, 1, dive, 10);
    await reserve(sf, r);

    for (const [who, name] of [[x, "Place Xena"], [y, "Place Yara"]]) {
      const a = await fetchJson("GET", `/api/divers/${who}/analytics`);
      assert.deepEqual(place(a.body, sf.id), await standing(sf.id, name), name);
    }
    const aX = await fetchJson("GET", `/api/divers/${x}/analytics`);
    assert.equal(place(aX.body, sf.id)[0], 1, "the carry puts Xena first");
    const aR = await fetchJson("GET", `/api/divers/${r}/analytics`);
    assert.equal(place(aR.body, sf.id), undefined, "the SF reserve has no SF place");
    assert.ok(place(aR.body, h2h.id), "her H2H is still hers");
    const slug = crypto.randomBytes(16).toString("hex");
    await pool.query("UPDATE users SET public_slug = $1 WHERE id = $2", [slug, x]);
    const pub = await fetchJson("GET", `/api/public/divers/${slug}`);
    const pubSf = pub.body.recent_meets.find((m) => m.event_id === sf.id);
    assert.deepEqual([pubSf.rank, pubSf.field_size, Number(pubSf.total).toFixed(2)], await standing(sf.id, "Place Xena"));
  } finally {
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// The coach dashboard's current place is the scoreboard's: its ranking reads
// the standings' dives (standingsPerDiveForEventsCte), so a live Super Final
// semi counts the H2H carry and a reserve's scored try-out isn't in the field.
test("the coach dashboard's live place matches the scoreboard in a Super Final semi", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const x = await recordKit.diver(st.orgId, null, "female", "Coach Xena");
    const y = await recordKit.diver(st.orgId, null, "female", "Coach Yara");
    const r = await recordKit.diver(st.orgId, null, "female", "Coach Rhea");
    const h2h = await recordKit.event(st.orgId, { gender: "Female" });
    await recordKit.dive(h2h, x, 1, dive, 9);
    await recordKit.dive(h2h, y, 1, dive, 5);
    await recordKit.dive(h2h, r, 1, dive, 9.5);
    await pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [h2h.id]);
    const sf = await recordKit.event(st.orgId, { gender: "Female" }); // Live
    await pool.query("UPDATE events SET score_carry_from = $1 WHERE id = $2", [h2h.id, sf.id]);
    await recordKit.dive(sf, x, 1, dive, 6);
    await recordKit.dive(sf, y, 1, dive, 7);
    await recordKit.dive(sf, r, 1, dive, 10);
    await pool.query(
      "UPDATE competitor_dive_lists SET is_reserve = TRUE, reserve_position = 1 WHERE event_id = $1 AND competitor_id = $2",
      [sf.id, r],
    );
    // Round 2 still to dive, so both have a card on the dashboard.
    await pool.query(
      `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number)
       VALUES ($1, $2, $3, 2), ($1, $4, $3, 2)`,
      [sf.id, x, dive, y],
    );

    const board = await fetchJson("GET", `/api/scoreboard/${sf.id}?cache=skip`);
    const standing = Object.fromEntries(board.body.standings.map((row) =>
      [row.competitor_id, [Number(row.rank), board.body.standings.length, Number(row.total).toFixed(2)]]));
    const coachName = `int-cs-${crypto.randomBytes(3).toString("hex")}`;
    const coach = await insertUser({ orgId: st.orgId, role: "coach", username: coachName, fullName: "Semi Coach" });
    await pool.query(
      "INSERT INTO coach_diver_links (coach_id, diver_id, org_id) VALUES ($1, $2, $4), ($1, $3, $4)",
      [coach, x, y, st.orgId],
    );
    const login = await fetchJson("POST", "/api/auth/login", { body: { username: coachName, password: "not-used-here" } });
    const dash = await fetchJson("GET", "/api/coach/dashboard", { token: login.body.token });
    assert.equal(dash.status, 200, JSON.stringify(dash.body));
    for (const who of [x, y]) {
      const card = dash.body.find((row) => row.diver_id === who && row.event_id === sf.id);
      assert.deepEqual([card.current_rank, card.field_size, Number(card.current_total).toFixed(2)], standing[who]);
      // The last dive is still this stage's round 1, not a carried one.
      assert.equal(card.last_dive_round, 1);
    }
    assert.equal(standing[x][0], 1, "Xena leads on her H2H carry");
    assert.equal(dash.body.filter((row) => row.event_id === sf.id).length, 2, "one card each");
  } finally {
    await pool.query("DELETE FROM coach_diver_links WHERE org_id = $1", [st.orgId]);
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
  }
});

// Events at one meet share its date (EVENT_DATE) unless they're scheduled,
// so date ties are the norm there. The trend, recent_form and the personal
// best pick all break them on the event id, the trend oldest first and
// recent_form its exact reverse, instead of leaving it to the plan.
test("a meet's events tie on date, and the id settles the order everywhere", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const dive = await recordKit.threeMetreDive();
    const me = await recordKit.diver(st.orgId, null, "female", "Tie Tess");
    const meet = (await pool.query(
      "INSERT INTO meets (org_id, name, start_date, end_date) VALUES ($1, 'Tie Meet', '2026-03-14', '2026-03-15') RETURNING id",
      [st.orgId],
    )).rows[0].id;
    const evs = [];
    for (let i = 0; i < 3; i++) {
      const ev = await recordKit.event(st.orgId, { gender: "Female" });
      await recordKit.dive(ev, me, 1, dive, 7); // the same dive and total in each
      evs.push(ev.id);
    }
    // Created in the opposite order to their ids, so created_at can't be
    // what decides it.
    const byId = evs.slice().sort();
    for (const [i, id] of byId.entries()) {
      await pool.query(
        "UPDATE events SET status = 'Completed', meet_id = $2, created_at = $3 WHERE id = $1",
        [id, meet, `2026-01-0${3 - i}T09:00:00Z`],
      );
    }
    const prof = await fetchJson("GET", `/api/divers/${me}/profile`);
    assert.equal(prof.status, 200, JSON.stringify(prof.body));
    assert.deepEqual(prof.body.score_trend.map((r) => r.event_id), byId);
    assert.deepEqual(prof.body.personal_bests.map((r) => r.event_id), [byId[2]]);
    const an = await fetchJson("GET", `/api/divers/${me}/analytics`);
    assert.deepEqual(an.body.recent_form.map((r) => r.event_id), byId.slice().reverse());
  } finally {
    await pool.query("DELETE FROM meets WHERE org_id = $1", [st.orgId]);
    await recordKit.cleanup(st.orgId);
    await teardownFixture(st);
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
      // A DD no other run is using, since the directory is shared. It
      // used to be 5.0 to 9.8; a custom dive now has to sit inside the
      // official 3m range (decision A7-06), so it's 2.0 to 4.7, clear of
      // the core 101B's own 1.5.
      token: coach.token, body: { dive_code: "101", height: "3m", position: "B", dd: 2 + crypto.randomInt(28) / 10 },
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
    // One row per round, on the lead (writeSynchroBothSides keeps no mirror).
    assert.equal(await entries(), 1);
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

// recordAudit swallows its own INSERT error, but handed a transaction
// client the failed statement aborted the caller's transaction, and the
// later COMMIT quietly came back as ROLLBACK: the route said 200 and
// nothing was saved.
test("a failed audit row doesn't roll back the transaction it was written in", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  const { recordAudit } = require("../lib/audit");
  const client = await pool.connect();
  try {
    const bad = { org_id: crypto.randomUUID(), entity_type: "club", action: "club.test" };   // no such org: FK error
    await client.query("BEGIN");
    const club = (await client.query(
      "INSERT INTO clubs (org_id, name, short_code) VALUES ($1, 'Audit Survivors', 'AUS1') RETURNING id", [st.orgId],
    )).rows[0].id;
    await recordAudit(client, bad);
    await client.query("UPDATE clubs SET name = 'Audit Survivors DC' WHERE id = $1", [club]);
    await client.query("COMMIT");
    const row = (await pool.query("SELECT name FROM clubs WHERE id = $1", [club])).rows[0];
    assert.equal(row?.name, "Audit Survivors DC");

    // Outside a transaction (the pool, or a client in autocommit) it's
    // still just a logged miss, and a good row still lands.
    await recordAudit(pool, bad);
    await recordAudit(client, bad);
    await recordAudit(client, { org_id: st.orgId, entity_type: "club", entity_id: club, action: "club.test" });
    const n = (await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'club.test'", [club])).rows[0].n;
    assert.equal(n, 1);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.query("DELETE FROM audit_log WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// A non-UUID in a path went straight into `WHERE id = $1`, pg threw
// 22P02 and the route said 500: a mistyped link or a crawler looked like
// an outage in the 5xx metrics. The shared gates and the busiest public
// routes answer 404 now.
test("a malformed id in the path is a 404, not a 500", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const bad = "not-a-uuid";
    const anon = [
      // /api/events/:id/history answers 400 for a malformed id, pinned by
      // its own visibility test further up.
      `/api/scoreboard/${bad}`, `/api/scoreboard/${bad}/leaderboard`,
      `/api/venue/scoreboard-state/${bad}`, `/api/archive/${bad}/results`,
      `/api/meets/${bad}/program.pdf`, `/api/meets/${bad}/program.csv`, `/api/events/${bad}/start-list.pdf`,
      `/api/events/${bad}/results.csv`, `/api/events/${bad}/results.pdf`,
      `/api/events/${bad}/judge-ranking-analysis`, `/api/events/${bad}/judge-ranking-analysis.csv`,
    ];
    const admin = [
      `/api/events/${bad}/managers`, `/api/events/${bad}/judges`, `/api/events/${bad}/score-audit`,
      `/api/events/${bad}/referees`, `/api/events/${bad}/teams`, `/api/users/${bad}/role-audit`,
      `/api/clubs/${bad}/affiliation`,
    ];
    const got = [];
    for (const p of anon) got.push([p, (await fetchJson("GET", p)).status]);
    for (const p of admin) got.push([p, (await fetchJson("GET", p, { token: st.adminToken })).status]);
    assert.deepEqual(got.filter(([, s]) => s !== 404), []);
  } finally {
    await teardownFixture(st);
  }
});

// A club still waiting on its federation isn't public (migration 096),
// and every public surface joins clubs through PUBLIC_CLUB_JOIN. The
// judge-ranking analysis and the Super Final rankings joined them plain.
test("judge-ranking analysis doesn't print a pending club's name", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const { ev } = await sweepKit.scoredDive(st.orgId, 6);
    const club = await recordKit.club(st.orgId, "Unvetted Founder Club", "UFC");
    await pool.query("UPDATE clubs SET status = 'pending' WHERE id = $1", [club]);
    await pool.query("UPDATE users SET club_id = $2 WHERE id = ANY($1::uuid[])", [ev.judges, club]);
    const json = await fetchJson("GET", `/api/events/${ev.id}/judge-ranking-analysis`);
    assert.equal(json.status, 200, JSON.stringify(json.body).slice(0, 200));
    assert.ok(!JSON.stringify(json.body).includes("Unvetted Founder Club"));
    const csv = await fetchJson("GET", `/api/events/${ev.id}/judge-ranking-analysis.csv`);
    assert.ok(!String(csv.body).includes("Unvetted Founder Club"));
  } finally {
    await pool.query("UPDATE users SET club_id = NULL WHERE org_id = $1", [st.orgId]);
    await recordKit.cleanup(st.orgId);
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// The public fee cards take ?subject_user_id= so a guardian can see
// whether their child's entry is paid. Nothing checked who was asking, so
// anyone could walk competitor ids off a scoreboard and learn who'd paid.
// And the lookup matched the payer, so a child whose parent paid read as
// unpaid on their own card.
test("fee cards: already_paid only for yourself or your dependant", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: true });
  try {
    const parent = await sweepKit.member(st.orgId, "spectator", "Paying Parent");
    const child = await sweepKit.member(st.orgId, "diver", "Entered Child");
    const nosy = await sweepKit.member(st.orgId, "diver", "Nosy Neighbour");
    await pool.query(
      "INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status) VALUES ($1, $2, $3, 'approved')",
      [st.orgId, parent.id, child.id],
    );
    const def = (await pool.query(
      `INSERT INTO fee_definitions (org_id, scope, event_id, name) VALUES ($1, 'event_entry', $2, 'Entry') RETURNING id`,
      [st.orgId, st.eventId],
    )).rows[0].id;
    await pool.query("INSERT INTO fee_prices (fee_definition_id, label, amount_cents) VALUES ($1, 'standard', 1500)", [def]);
    await pool.query(
      `INSERT INTO payments (org_id, fee_definition_id, payer_user_id, subject_user_id, subject_type, event_id,
                             amount_cents, platform_fee_cents, currency, status)
       VALUES ($1, $2, $3, $4, 'event_entry', $5, 1500, 0, 'GBP', 'paid')`,
      [st.orgId, def, parent.id, child.id, st.eventId],
    );
    const fee = (q, token) => fetchJson("GET", `/api/events/${st.eventId}/fee${q}`, { token });
    const about = `?subject_user_id=${child.id}`;

    assert.equal((await fee(about)).status, 403, "anonymous");
    assert.equal((await fee(about, nosy.token)).status, 403, "not their guardian");
    assert.equal((await fee("?subject_user_id=nope", parent.token)).status, 403);
    assert.equal((await fee(about, parent.token)).body.fee.already_paid, true, "the guardian who paid");
    assert.equal((await fee("", child.token)).body.fee.already_paid, true, "the child's own card");
    assert.equal((await fee("", nosy.token)).body.fee.already_paid, false);
  } finally {
    await pool.query("DELETE FROM payments WHERE org_id = $1", [st.orgId]);
    await pool.query("DELETE FROM fee_definitions WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

// users.email is varchar(255). register-org and the email change cap it
// at 254; self-registration didn't, so a long address died as a 500.
test("self-registration refuses an over-long email with a 400", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const r = await fetchJson("POST", "/api/auth/register", {
      body: {
        username: `int-sw-long-${st.slug}`, password: TEST_PASSWORD, full_name: "Long Address",
        email: `${"a".repeat(250)}@example.test`, org_id: st.orgId,
      },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  } finally {
    await teardownFixture(st);
  }
});

// The sysadmin can add a coach link in any org (POST /api/orgs/:id/
// coach-links) but the delete matched the caller's own org only, so a
// wrong link in a federation with no admin of its own couldn't go.
test("the sysadmin can remove a coach link in another org", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const coach = await insertUser({ orgId: st.orgId, role: "coach", username: `int-sw-co-${st.slug}`, fullName: "Link Coach" });
    const diver = await insertUser({ orgId: st.orgId, role: "diver", username: `int-sw-di-${st.slug}`, fullName: "Link Diver" });
    const link = (await pool.query(
      "INSERT INTO coach_diver_links (coach_id, diver_id, org_id) VALUES ($1, $2, $3) RETURNING id",
      [coach, diver, st.orgId],
    )).rows[0].id;
    const sys = await claimKit.login("admin", "admin");
    const del = await fetchJson("DELETE", `/api/coach-links/${link}`, { token: sys.token });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await pool.query("SELECT 1 FROM coach_diver_links WHERE id = $1", [link])).rows.length, 0);
  } finally {
    await teardownFixture(st);
  }
});

// =====================================================================
// Migration 103: the one-off data cleanup (synchro mirror rows, roles
// left behind by org transfers, referees club or region admins handed
// out). It works on the whole database, and other suites run beside this
// one against the same DB, so the fixtures and both runs of the file all
// happen on one client inside a transaction that's rolled back at the
// end. Nothing seeded or removed here ever lands in the shared test DB.
// =====================================================================
test("migration 103 removes mirror rows, transfer leftovers and club-granted referees, and a re-run changes nothing", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const fs = require("node:fs");
  const path = require("node:path");
  const file = fs.readFileSync(path.join(__dirname, "..", "migrations", "103_data_cleanup.sql"), "utf8");
  // It carries its own BEGIN/COMMIT, which would commit ours halfway.
  assert.match(file, /^BEGIN;$/m);
  assert.match(file, /^COMMIT;$/m);
  const body = file.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
  const sys = await claimSysadmin();
  if (!sys) return t.skip("no sysadmin in this DB");

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const q = async (sql, params) => (await c.query(sql, params)).rows;
    const tag = crypto.randomBytes(3).toString("hex");
    const org = async (name, claimState) => (await q(
      `INSERT INTO organisations (name, country_code, slug, status, claim_state)
       VALUES ($1, 'MNG', $1, 'active', $2) RETURNING id`, [`m103-${name}-${tag}`, claimState],
    ))[0].id;
    const user = async (orgId, name, roles = [], grantedBy = null) => {
      const id = (await q(
        "INSERT INTO users (username, full_name, org_id, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id",
        [`m103-${name}-${tag}`, name, orgId],
      ))[0].id;
      for (const role of roles) {
        await q("INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1, $2, $3, $4)", [id, orgId, role, grantedBy]);
      }
      return id;
    };
    const grant = (userId, orgId, role, grantedBy = null) =>
      q("INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1, $2, $3, $4)", [userId, orgId, role, grantedBy]);

    const home = await org("home", "claimed");
    const away = await org("away", "claimed");
    const clubsOnly = await org("clubs", "unclaimed");

    // ---- synchro pairs, entered the way the old portal code did ----
    const ev = (await q(
      `INSERT INTO events (org_id, name, gender, height, number_of_judges, total_rounds, event_type, status)
       VALUES ($1, 'Mirror Synchro', 'Mixed', '3m', 9, 2, 'synchro_pair', 'Completed') RETURNING id`, [home],
    ))[0].id;
    const dives = (await q("SELECT id FROM dive_directory WHERE height = 3 ORDER BY dive_code, id LIMIT 2")).map((r) => r.id);
    const row = (competitor, partner, round, withdrawn = false) => q(
      `INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, round_number, dive_id, withdrawn_at)
       VALUES ($1, $2, $3, $4, $5, $6)`, [ev, competitor, partner, round, dives[round - 1], withdrawn ? new Date() : null],
    );
    const pairing = (requester, partner, status, respondedAgo = 0) => q(
      `INSERT INTO pending_partner_pairings (event_id, requester_id, partner_id, status, responded_at)
       VALUES ($1, $2, $3, $4, now() - make_interval(days => $5))`, [ev, requester, partner, status, respondedAgo],
    );
    const D = {};
    for (const n of "abcdefghij") D[n] = await user(home, `Diver ${n.toUpperCase()}`, ["diver"]);
    // A plain pair: B's rows mirror A's.
    await pairing(D.a, D.b, "accepted");
    for (const r of [1, 2]) { await row(D.a, D.b, r); await row(D.b, D.a, r); }
    // D's round 1 mirror got scored. Round 1 stays, round 2 goes.
    await pairing(D.c, D.d, "accepted");
    for (const r of [1, 2]) { await row(D.c, D.d, r); await row(D.d, D.c, r); }
    const judge = await user(home, "Mirror Judge", ["judge"]);
    await q("INSERT INTO scores (event_id, competitor_id, judge_id, round_number, score) VALUES ($1, $2, $3, 1, 6.5)", [ev, D.d, judge]);
    // Somebody withdrew E's round 1 by hand and kept F's: that's F's to keep.
    await pairing(D.e, D.f, "accepted");
    await row(D.e, D.f, 1, true); await row(D.f, D.e, 1);
    await row(D.e, D.f, 2); await row(D.f, D.e, 2);
    // Accepted both ways round: the newer pairing (H asked) names the lead.
    await pairing(D.g, D.h, "accepted", 2);
    await pairing(D.h, D.g, "accepted", 0);
    await row(D.g, D.h, 1); await row(D.h, D.g, 1);
    // Still pending: nothing to go by, both rows stay.
    await pairing(D.i, D.j, "pending");
    await row(D.i, D.j, 1); await row(D.j, D.i, 1);

    // ---- roles ----
    const clubAdmin = await user(clubsOnly, "Club Admin", ["diver"]);
    // Moved home -> away long ago; the old org_admin and meet_manager stayed.
    const mover = await user(away, "Moved Admin", ["diver"]);
    await grant(mover, home, "org_admin");
    await grant(mover, home, "meet_manager");
    const legit = await user(home, "Own Org Admin", ["org_admin", "judge"]);
    // Referees in the country with no federation.
    const refOnly = await user(clubsOnly, "Club Referee", [], null);
    await grant(refOnly, clubsOnly, "referee", clubAdmin);
    const refDiver = await user(clubsOnly, "Diving Referee", ["diver"]);
    await grant(refDiver, clubsOnly, "referee", clubAdmin);
    const refSys = await user(clubsOnly, "DivingHQ Referee", ["referee"], sys.id);
    const refNull = await user(clubsOnly, "Seeded Referee", ["referee"], null);
    // Granted by the same club admin, but in a claimed org: not ours to judge.
    const refClaimed = await user(home, "Federation Referee", ["referee"], clubAdmin);
    // Both at once: a club admin's referee grant in an org they've left.
    const refMoved = await user(home, "Moved Referee", ["diver"]);
    await grant(refMoved, clubsOnly, "referee", clubAdmin);

    const everyone = [...Object.values(D), judge, clubAdmin, mover, legit, refOnly, refDiver, refSys, refNull, refClaimed, refMoved];
    const versions = async () => Object.fromEntries((await q(
      "SELECT id, token_version FROM users WHERE id = ANY($1::uuid[])", [everyone],
    )).map((r) => [r.id, r.token_version]));
    const rolesOf = async (id) => (await q(
      "SELECT org_id, role::text AS role FROM user_org_roles WHERE user_id = $1 ORDER BY org_id, role", [id],
    )).map((r) => `${r.org_id === home ? "home" : r.org_id === away ? "away" : "clubs"}:${r.role}`);
    const audit = async (id) => (await q(
      "SELECT role::text AS role, action::text AS action, actor_id, note FROM role_audit_log WHERE user_id = $1 ORDER BY role, action", [id],
    ));
    const entries = async () => (await q(
      "SELECT competitor_id, round_number FROM competitor_dive_lists WHERE event_id = $1", [ev],
    )).map((r) => `${Object.keys(D).find((k) => D[k] === r.competitor_id)}${r.round_number}`).sort();
    const before = await versions();

    await c.query(body);

    assert.deepEqual(await entries(), [
      "a1", "a2",        // B's mirrors gone
      "c1", "c2", "d1",  // D's scored round 1 stays
      "e1", "e2", "f1",  // F's round 1 was the one kept by hand
      "h1",              // the newer pairing's lead
      "i1", "j1",        // pending, untouched
    ]);
    assert.equal((await q("SELECT count(*)::int AS n FROM scores WHERE event_id = $1", [ev]))[0].n, 1, "the score stays");

    assert.deepEqual(await rolesOf(mover), ["away:diver"]);
    assert.deepEqual((await audit(mover)).map((r) => `${r.role}:${r.action}`), ["meet_manager:revoked", "org_admin:revoked"]);
    for (const r of await audit(mover)) {
      assert.equal(r.actor_id, null);
      assert.match(r.note, /migration 103/);
    }
    assert.deepEqual(await rolesOf(legit), ["home:judge", "home:org_admin"]);

    assert.deepEqual(await rolesOf(refOnly), ["clubs:spectator"], "not left with nothing");
    assert.deepEqual((await audit(refOnly)).map((r) => `${r.role}:${r.action}`), ["referee:revoked", "spectator:granted"]);
    assert.deepEqual(await rolesOf(refDiver), ["clubs:diver"]);
    assert.deepEqual((await audit(refDiver)).map((r) => `${r.role}:${r.action}`), ["referee:revoked"]);
    assert.deepEqual(await rolesOf(refSys), ["clubs:referee"]);
    assert.deepEqual(await rolesOf(refNull), ["clubs:referee"]);
    assert.deepEqual(await rolesOf(refClaimed), ["home:referee"]);
    assert.deepEqual(await rolesOf(refMoved), ["home:diver"]);
    const movedAudit = await audit(refMoved);
    assert.equal(movedAudit.length, 1, "audited once, as a transfer leftover");
    assert.match(movedAudit[0].note, /another organisation/);

    const after = await versions();
    const bumped = everyone.filter((id) => after[id] !== before[id]).sort();
    assert.deepEqual(bumped, [mover, refOnly, refDiver, refMoved].sort(), "only the people who lost a role sign in again");
    for (const id of bumped) assert.equal(after[id], before[id] + 1);
    assert.equal((await q("SELECT version FROM schema_meta WHERE id = 1"))[0].version, 103);

    // Again: nothing left to do, so nothing moves.
    const snapshot = async () => JSON.stringify({
      entries: await entries(),
      roles: await (async () => { const out = []; for (const id of everyone) out.push(await rolesOf(id)); return out; })(),
      audit: (await q("SELECT count(*)::int AS n FROM role_audit_log WHERE user_id = ANY($1::uuid[])", [everyone]))[0].n,
      versions: await versions(),
    });
    const once = await snapshot();
    await c.query(body);
    assert.equal(await snapshot(), once);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
});

// ---------------------------------------------------------------------
// A federation keeps one live org admin (lib/admin-rows.js orgAdminHold).
// Only an org admin can appoint another, so the last one leaving (deleting
// their account, dropping the role, being suspended or moved out) left the
// federation with nobody but DivingHQ. Orgs made here, in a country no
// other test uses, since nothing below needs register-org.
// ---------------------------------------------------------------------
const lastAdminKit = {
  async org(name, tag) {
    return (await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status, claim_state)
       VALUES ($1, 'KHM', $1, 'active', 'claimed') RETURNING id`, [`lastadm-${name}-${tag}`],
    )).rows[0].id;
  },
  del: (token) => fetchJson("POST", "/api/users/me/delete", { token, body: { password: "not-used-here" } }),
  setRoles: (token, id, roles) => fetchJson("PUT", `/api/users/${id}/roles`, { token, body: { roles } }),
  suspend: (token, id) => fetchJson("POST", `/api/users/${id}/suspend`, { token }),
  async admins(orgId) {
    return (await pool.query(
      `SELECT r.user_id FROM user_org_roles r JOIN users u ON u.id = r.user_id AND u.org_id = r.org_id
        WHERE r.org_id = $1 AND r.role = 'org_admin' AND u.deleted_at IS NULL AND u.suspended_at IS NULL
        ORDER BY r.user_id`, [orgId],
    )).rows.map((r) => r.user_id);
  },
};

test("the last live org admin can't delete their account or drop the role, and two can't both go at once", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const tag = crypto.randomBytes(3).toString("hex");
  const fed = await lastAdminKit.org("fed", tag);
  const { del, setRoles, suspend, admins } = lastAdminKit;
  try {
    const uname = (n) => `int-la-${n}-${tag}`;
    const a = await insertUser({ orgId: fed, role: "org_admin", username: uname("a"), fullName: "Admin A" });
    let aTok = await b3Login(uname("a"));

    // On their own: no deleting the account, no dropping the role.
    let r = await del(aTok);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "last_org_admin");
    assert.match(r.body.error, /Appoint another administrator/);
    assert.match(r.body.error, /support@/);
    assert.equal((await pool.query("SELECT deleted_at FROM users WHERE id = $1", [a])).rows[0].deleted_at, null);
    r = await setRoles(aTok, a, ["diver"]);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "last_org_admin");
    assert.deepEqual(await admins(fed), [a]);
    // Changing the rest while keeping org_admin is fine.
    assert.equal((await setRoles(aTok, a, ["org_admin", "judge"])).status, 200);
    aTok = await b3Login(uname("a"));

    // A suspended second admin doesn't count.
    const b = await insertUser({ orgId: fed, role: "org_admin", username: uname("b"), fullName: "Admin B" });
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [b]);
    assert.equal((await del(aTok)).status, 409);
    assert.equal((await setRoles(aTok, a, ["judge"])).status, 409);
    await pool.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [b]);
    let bTok = await b3Login(uname("b"));

    // Demoting the other admin is fine while one is left...
    assert.equal((await setRoles(bTok, a, ["judge"])).status, 200);
    // ...and then B is the last one.
    r = await setRoles(bTok, b, ["judge"]);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /^You're the last administrator/);
    assert.equal((await setRoles(bTok, a, ["org_admin", "judge"])).status, 200);
    aTok = await b3Login(uname("a"));

    // Both step down at the same moment: one gets through.
    const down = await Promise.all([setRoles(aTok, a, ["judge"]), setRoles(bTok, b, ["judge"])]);
    assert.deepEqual(down.map((x) => x.status).sort(), [200, 409], JSON.stringify(down.map((x) => x.body)));
    let left = await admins(fed);
    assert.equal(left.length, 1);
    const [stay] = left;
    const [went, wentName] = stay === a ? [b, uname("b")] : [a, uname("a")];
    const stayTok = await b3Login(stay === a ? uname("a") : uname("b"));
    assert.equal((await setRoles(stayTok, went, ["org_admin", "judge"])).status, 200);
    const wentTok = await b3Login(wentName);

    // Both delete their accounts at the same moment: one gets through.
    const gone = await Promise.all([del(stayTok), del(wentTok)]);
    assert.deepEqual(gone.map((x) => x.status).sort(), [200, 409], JSON.stringify(gone.map((x) => x.body)));
    left = await admins(fed);
    assert.equal(left.length, 1, "one admin still runs it");

    // Two admins suspending each other at once: never both.
    const lastName = left[0] === a ? uname("a") : uname("b");
    const lastTok = await b3Login(lastName);
    const c = await insertUser({ orgId: fed, role: "org_admin", username: uname("c"), fullName: "Admin C" });
    const cTok = await b3Login(uname("c"));
    const sus = await Promise.all([suspend(lastTok, c), suspend(cTok, left[0])]);
    assert.equal(sus.filter((x) => x.status === 200).length, 1, JSON.stringify(sus.map((x) => [x.status, x.body])));
    assert.equal((await admins(fed)).length, 1);

    // The sysadmin isn't held to it.
    const sys = await claimKit.login("admin", "admin");
    if (sys?.token) {
      const [only] = await admins(fed);
      assert.equal((await setRoles(sys.token, only, ["judge"])).status, 200);
      assert.deepEqual(await admins(fed), []);
    }
  } finally {
    await compKit.cleanup(fed);
  }
});

test("an org transfer can't take a federation's last live org admin, unless the sysadmin moves them", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const tag = crypto.randomBytes(3).toString("hex");
  const from = await lastAdminKit.org("from", tag);
  const to = await lastAdminKit.org("to", tag);
  try {
    const mover = await insertUser({ orgId: from, role: "org_admin", username: `int-la-mv-${tag}`, fullName: "Moving Admin" });
    await insertUser({ orgId: to, role: "org_admin", username: `int-la-to-${tag}`, fullName: "Receiving Admin" });
    const moverTok = await b3Login(`int-la-mv-${tag}`);
    const toTok = await b3Login(`int-la-to-${tag}`);

    const made = await fetchJson("POST", "/api/club-change-requests", { token: moverTok, body: { to_org_id: to } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const review = (token) => fetchJson("POST", `/api/club-change-requests/${made.body.id}/review`, { token, body: { decision: "approved" } });
    // Their own federation's side, which they can sign as its admin.
    assert.equal((await review(moverTok)).body.status, "pending");
    // The receiving side is the last one in, and that's refused.
    const r = await review(toTok);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "last_org_admin");
    assert.equal((await pool.query("SELECT status::text FROM club_change_requests WHERE id = $1", [made.body.id])).rows[0].status, "pending");
    assert.equal((await pool.query("SELECT org_id FROM users WHERE id = $1", [mover])).rows[0].org_id, from);
    assert.deepEqual(await lastAdminKit.admins(from), [mover]);

    const sys = await claimKit.login("admin", "admin");
    if (!sys?.token) return t.skip("no sysadmin login in this DB");
    const ok = await review(sys.token);
    assert.equal(ok.body.status, "approved", JSON.stringify(ok.body));
    assert.equal((await pool.query("SELECT org_id FROM users WHERE id = $1", [mover])).rows[0].org_id, to);
  } finally {
    await pool.query("DELETE FROM club_change_requests WHERE from_org_id = ANY($1::uuid[]) OR to_org_id = ANY($1::uuid[])", [[from, to]]);
    await compKit.cleanup(from, to);
  }
});

// The lock in orgAdminHold, with no HTTP timing in the way. Two requests
// racing through the server only sometimes overlap (the concurrent role
// edits above got through with the lock taken out), so this drives two
// connections by hand the way two admins' transactions would go: the
// first checks, takes itself out and hasn't committed yet. The second
// has to wait for it, and once it commits, see nobody else is left. Both
// ways out an admin can take without touching the other's rows: the role
// row going (needs the lock on the role rows) and the account being
// suspended (needs the one on the users rows).
test("orgAdminHold makes a second admin wait for the first one's transaction, then counts them out", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  const { orgAdminHold } = require("../lib/admin-rows");
  const tag = crypto.randomBytes(3).toString("hex");
  const fed = await lastAdminKit.org("lock", tag);
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    const a = await insertUser({ orgId: fed, role: "org_admin", username: `int-lk-a-${tag}`, fullName: "Lock A" });
    const b = await insertUser({ orgId: fed, role: "org_admin", username: `int-lk-b-${tag}`, fullName: "Lock B" });
    const ways = {
      "drops the role": (c) => c.query(
        "DELETE FROM user_org_roles WHERE user_id = $1 AND org_id = $2 AND role = 'org_admin'", [a, fed]),
      "is suspended": (c) => c.query("UPDATE users SET suspended_at = now() WHERE id = $1", [a]),
    };
    for (const [how, leave] of Object.entries(ways)) {
      await c1.query("BEGIN");
      assert.equal(await orgAdminHold(c1, fed, a), null, `${how}: B is still there for A`);
      await leave(c1);
      await c2.query("BEGIN");
      let settled = false;
      const second = orgAdminHold(c2, fed, b).then((v) => { settled = true; return v; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, `${how}: B's check waits on A's open transaction`);
      await c1.query("COMMIT");
      const hold = await second;
      assert.equal(hold?.org_id, fed, `${how}: and then sees B is the last one`);
      await c2.query("ROLLBACK");
      // A back as a live admin for the next round.
      await pool.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [a]);
      await pool.query(
        "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'org_admin') ON CONFLICT DO NOTHING", [a, fed]);
    }
  } finally {
    // c1 first: if an assertion failed while c2 was still waiting on it.
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    c1.release();
    c2.release();
    await compKit.cleanup(fed);
  }
});

// ---------------------------------------------------------------------
// Event templates by owner (migration 104). A template belongs to the
// org, club or region that saved it and only that owner's admins use it.
// Deliberately not hierarchical: the federation doesn't see its clubs'
// templates, a region doesn't see its clubs', and a club sees neither of
// theirs. Everything here lives in Vatican City, which no other test uses.
// ---------------------------------------------------------------------
const tplKit = {
  CODE: "VAT",
  // One org with two regions, club A (in region R) and club B, an admin
  // for each, plus the fixture's own org admin.
  async world() {
    const st = await setupFixture({ withEvent: false });
    await pool.query("UPDATE organisations SET country_code = $2 WHERE id = $1", [st.orgId, tplKit.CODE]);
    const one = async (sql, params) => (await pool.query(sql, params)).rows[0].id;
    const regionR = await one("INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Borgo', 'BRG') RETURNING id", [st.orgId]);
    const regionR2 = await one("INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Giardini', 'GIA') RETURNING id", [st.orgId]);
    const clubA = await one("INSERT INTO clubs (org_id, name, region_id) VALUES ($1, 'Borgo Divers', $2) RETURNING id", [st.orgId, regionR]);
    const clubB = await one("INSERT INTO clubs (org_id, name) VALUES ($1, 'Giardini Divers') RETURNING id", [st.orgId]);
    const seat = async (table, col, ownerId) => {
      const m = await sweepKit.member(st.orgId, "spectator", `Template ${table}`);
      await pool.query(`INSERT INTO ${table} (${col}, user_id, org_id) VALUES ($1, $2, $3)`, [ownerId, m.id, st.orgId]);
      return m.token;
    };
    return {
      st, clubA, clubB, regionR, regionR2,
      org: st.adminToken,
      a: await seat("club_admins", "club_id", clubA),
      b: await seat("club_admins", "club_id", clubB),
      r: await seat("region_admins", "region_id", regionR),
      r2: await seat("region_admins", "region_id", regionR2),
    };
  },
  async teardown(w) {
    if (!w) return;
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [w.st.orgId]);
    await pool.query("DELETE FROM regions WHERE org_id = $1", [w.st.orgId]);
    await teardownFixture(w.st);
  },
  config: { gender: "Mixed", height: "1m", number_of_judges: 3, total_rounds: 4, event_type: "individual" },
  list: (token, q = "") => fetchJson("GET", `/api/event-templates${q}`, { token }),
  save: (token, q, name, config = tplKit.config) =>
    fetchJson("POST", `/api/event-templates${q}`, { token, body: { name, config } }),
  del: (token, id, q = "") => fetchJson("DELETE", `/api/event-templates/${id}${q}`, { token }),
  names: (res) => res.body.map((row) => row.name),
};

test("event templates by owner: a club's are for its own admins, not the federation's or another club's", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await tplKit.world();
    const { list, save, del } = tplKit;
    const qA = `?club_id=${w.clubA}`;
    const qB = `?club_id=${w.clubB}`;

    // Club A's admin saves one into the club.
    assert.deepEqual((await list(w.a, qA)).body, []);
    const mine = await save(w.a, qA, "Club Night 1m");
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal(mine.body.club_id, w.clubA);
    assert.equal(mine.body.region_id, null);
    const row = (await pool.query("SELECT org_id, club_id, created_by FROM event_templates WHERE id = $1", [mine.body.id])).rows[0];
    assert.equal(row.org_id, null, "the club owns it, not the club's org");
    assert.equal(row.club_id, w.clubA);
    // Saving the same name again inside the club is the same template.
    const again = await save(w.a, qA, "Club Night 1m", { ...tplKit.config, total_rounds: 6 });
    assert.equal(again.status, 201);
    assert.equal(again.body.id, mine.body.id);
    assert.equal((await list(w.a, qA)).body[0].config.total_rounds, 6);

    // Club B's admin can't reach club A's scope at all.
    assert.equal((await list(w.b, qA)).status, 403);
    assert.equal((await save(w.b, qA, "Sneaky")).status, 403);
    assert.equal((await del(w.b, mine.body.id, qA)).status, 403);
    // Nor delete A's template from inside their own club.
    assert.equal((await del(w.b, mine.body.id, qB)).status, 404);
    // Their own club can use the same name: a name is once per owner.
    const theirs = await save(w.b, qB, "Club Night 1m");
    assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
    assert.notEqual(theirs.body.id, mine.body.id);
    assert.deepEqual((await list(w.b, qB)).body.map((x) => x.id), [theirs.body.id]);
    assert.equal((await del(w.a, theirs.body.id, qA)).status, 404);

    // The federation's org admin sees neither club's and can't get in.
    assert.deepEqual((await list(w.org)).body, [], "org scope has no club templates in it");
    assert.equal((await list(w.org, qA)).status, 403);
    assert.equal((await save(w.org, qA, "From above")).status, 403);
    assert.equal((await del(w.org, mine.body.id)).status, 404);
    const orgs = await save(w.org, "", "Club Night 1m");
    assert.equal(orgs.status, 201, "the org can use the name too");
    assert.equal(orgs.body.club_id, null);
    assert.deepEqual((await list(w.org)).body.map((x) => x.id), [orgs.body.id]);

    // And the other way: a club admin has no org role, so no org scope.
    assert.equal((await list(w.a)).status, 403);
    assert.equal((await save(w.a, "", "Up a level")).status, 403);
    assert.equal((await del(w.a, orgs.body.id)).status, 403);
    assert.equal((await del(w.a, orgs.body.id, qA)).status, 404);

    // Every template is where it was.
    const left = await pool.query(
      "SELECT count(*)::int AS n FROM event_templates WHERE id = ANY($1::uuid[])",
      [[mine.body.id, theirs.body.id, orgs.body.id]],
    );
    assert.equal(left.rows[0].n, 3);

    // The owner deletes their own.
    assert.equal((await del(w.a, mine.body.id, qA)).status, 200);
    assert.deepEqual((await list(w.a, qA)).body, []);
  } finally {
    await tplKit.teardown(w);
  }
});

test("event templates by owner: a region's are for its admins, apart from its clubs' and the next region's", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await tplKit.world();
    const { list, save, del, names } = tplKit;
    const qR = `?region_id=${w.regionR}`;
    const qR2 = `?region_id=${w.regionR2}`;
    const qA = `?club_id=${w.clubA}`;

    const regional = await save(w.r, qR, "Borgo Champs 3m");
    assert.equal(regional.status, 201, JSON.stringify(regional.body));
    assert.equal(regional.body.region_id, w.regionR);
    assert.equal(regional.body.club_id, null);
    assert.deepEqual(names(await list(w.r, qR)), ["Borgo Champs 3m"]);
    const clubs = await save(w.a, qA, "Borgo Champs 3m");
    assert.equal(clubs.status, 201, "a club in the region can use the same name");

    // Club A sits in region R, and still neither sees the other's.
    assert.equal((await list(w.r, qA)).status, 403, "a region admin doesn't get its clubs' templates");
    assert.equal((await del(w.r, clubs.body.id, qR)).status, 404);
    assert.equal((await list(w.a, qR)).status, 403, "a club admin doesn't get its region's");
    assert.equal((await del(w.a, regional.body.id, qA)).status, 404);

    // The next region over, and the federation, stay out too.
    assert.equal((await list(w.r2, qR)).status, 403);
    assert.equal((await save(w.r2, qR, "Sideways")).status, 403);
    assert.equal((await del(w.r2, regional.body.id, qR2)).status, 404);
    assert.deepEqual((await list(w.r2, qR2)).body, []);
    assert.equal((await list(w.org, qR)).status, 403);
    assert.equal((await del(w.org, regional.body.id)).status, 404);
    // A region admin with no org role has no org scope either.
    assert.equal((await list(w.r)).status, 403);

    assert.equal((await del(w.r, regional.body.id, qR)).status, 200);
    assert.deepEqual((await list(w.r, qR)).body, []);
    assert.deepEqual(names(await list(w.a, qA)), ["Borgo Champs 3m"], "the club's copy is its own");
  } finally {
    await tplKit.teardown(w);
  }
});

test("event templates: the sysadmin works in any scope, and bad or pending scopes are refused", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await tplKit.world();
    const { list, save, del, names } = tplKit;
    const qA = `?club_id=${w.clubA}`;
    const qB = `?club_id=${w.clubB}`;
    const qR = `?region_id=${w.regionR}`;
    const sys = (await claimKit.login("admin", "admin")).token;

    const clubs = await save(w.a, qA, "Twilight 1m");
    const regional = await save(sys, qR, "Put there by DivingHQ");
    assert.equal(regional.status, 201, JSON.stringify(regional.body));
    assert.equal(regional.body.region_id, w.regionR);
    assert.deepEqual(names(await list(w.r, qR)), ["Put there by DivingHQ"], "the region's admins get it");
    assert.deepEqual(names(await list(sys, qA)), ["Twilight 1m"]);
    const bs = await save(w.b, qB, "Giardini Open");
    // The bypass: a sysadmin deletes by id from whatever scope they're in.
    assert.equal((await del(sys, bs.body.id)).status, 200);
    assert.deepEqual((await list(w.b, qB)).body, []);
    const unknown = crypto.randomUUID();
    assert.equal((await list(sys, `?club_id=${unknown}`)).status, 404);
    assert.equal((await list(sys, `?region_id=${unknown}`)).status, 404);

    // Malformed or mixed scopes are a 400; a club that isn't yours looks
    // the same whether or not it exists.
    assert.equal((await list(w.a, "?club_id=nope")).status, 400);
    assert.equal((await list(w.r, "?region_id=nope")).status, 400);
    assert.equal((await list(w.a, `${qA}&region_id=${w.regionR}`)).status, 400);
    assert.equal((await list(w.a, `?club_id=${unknown}`)).status, 403);
    assert.equal((await del(w.a, "not-a-uuid", qA)).status, 404);
    // Anonymous: no.
    assert.equal((await list(null, qA)).status, 403);

    // A club still waiting for its federation has no templates to run.
    await pool.query("UPDATE clubs SET status = 'pending' WHERE id = $1", [w.clubB]);
    const pending = await list(w.b, qB);
    assert.equal(pending.status, 409);
    assert.equal(pending.body.code, "club_pending");
    assert.equal((await save(w.b, qB, "Too early")).status, 409);

    // One owner per row, whatever writes it.
    await assert.rejects(
      pool.query(
        "INSERT INTO event_templates (org_id, club_id, name, config) VALUES ($1, $2, 'Both', '{}'::jsonb)",
        [w.st.orgId, w.clubA],
      ),
      /event_templates_one_owner/,
    );
    await assert.rejects(
      pool.query("INSERT INTO event_templates (name, config) VALUES ('Nobody', '{}'::jsonb)"),
      /event_templates_one_owner/,
    );

    // A club's templates go with the club.
    await pool.query("DELETE FROM clubs WHERE id = $1", [w.clubA]);
    const gone = await pool.query("SELECT 1 FROM event_templates WHERE id = $1", [clubs.body.id]);
    assert.equal(gone.rows.length, 0);
  } finally {
    await tplKit.teardown(w);
  }
});

// A seat only counts while its holder is still in the club's (or region's)
// org, same rule as the delegate helpers. Before routes/club-changes.js
// started dropping them, a transfer left the old club_admins row behind,
// and a template scope that just looked the row up would have kept
// handing the old club's templates to somebody who'd left for another
// federation. This pins that the route goes through the org-pinned seat
// SQL rather than a bare lookup.
test("event templates: a seat left behind by a transfer doesn't open the old club's or region's templates", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w, elsewhere;
  try {
    w = await tplKit.world();
    elsewhere = await setupFixture({ withEvent: false });
    const { list, save } = tplKit;
    const qA = `?club_id=${w.clubA}`;
    const qR = `?region_id=${w.regionR}`;

    const mover = await sweepKit.member(w.st.orgId, "spectator", "Template mover");
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [w.clubA, mover.id, w.st.orgId]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [w.regionR, mover.id, w.st.orgId]);
    assert.equal((await save(mover.token, qA, "Before the move")).status, 201);
    assert.equal((await list(mover.token, qR)).status, 200);

    // Off to another federation, with both rows stranded behind them.
    await pool.query("UPDATE users SET org_id = $2 WHERE id = $1", [mover.id, elsewhere.orgId]);
    const again = await fetchJson("POST", "/api/auth/login", { body: { username: mover.username, password: "not-used-here" } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const token = again.body.token;
    assert.equal((await list(token, qA)).status, 403);
    assert.equal((await save(token, qA, "After the move")).status, 403);
    assert.equal((await list(token, qR)).status, 403);
    assert.equal((await save(token, qR, "After the move")).status, 403);

    // The club's template is still the club's, for whoever admins it now.
    assert.deepEqual(tplKit.names(await list(w.a, qA)), ["Before the move"]);
  } finally {
    await tplKit.teardown(w);
    await teardownFixture(elsewhere);
  }
});

// ---------------------------------------------------------------------
// Guardian links where there's no federation (lib/guardian-requests.js).
// The child's club decides: its admins, the region above it, then the
// sysadmin. Each test owns country codes nobody else in test/ uses and
// wipes them before and after.
// ---------------------------------------------------------------------

const guardianKit = {
  async minor(id, years = 10) {
    await pool.query(
      "UPDATE users SET date_of_birth = (CURRENT_DATE - make_interval(years => $2))::date WHERE id = $1", [id, years],
    );
  },
  async ask(parentToken, kidId) {
    const r = await fetchJson("POST", "/api/guardians/request", { token: parentToken, body: { dependent_user_id: kidId } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (await pool.query(
      `SELECT * FROM guardians WHERE dependent_user_id = $1 AND status = 'pending'
        ORDER BY requested_at DESC LIMIT 1`, [kidId],
    )).rows[0];
  },
  async queue(token) {
    const r = await fetchJson("GET", "/api/guardian-requests", { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  },
  review(token, id, decision = "approved") {
    return fetchJson("POST", `/api/guardian-requests/${id}/review`, { token, body: { decision } });
  },
  async status(id) {
    return (await pool.query("SELECT status FROM guardians WHERE id = $1", [id])).rows[0]?.status;
  },
  async region(orgId, name, code, clubIds) {
    const id = (await pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, name, code],
    )).rows[0].id;
    await pool.query("UPDATE clubs SET region_id = $1 WHERE id = ANY($2::uuid[])", [id, clubIds]);
    return id;
  },
};

test("guardian links in an unclaimed country: the child's club decides, and the parent hears", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "NPL";
  await claimKit.wipe(CODE);
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Kathmandu Divers" });
    const B = await delegateSignUp({ country_code: CODE, new_club_name: "Pokhara Divers" });
    const kid = await delegateSignUp({ country_code: CODE, club_id: A.clubId, full_name: "Saraa Bold" });
    const parent = await delegateSignUp({ country_code: CODE, full_name: "Bold Bat" });
    assert.equal((await pool.query("SELECT club_id FROM users WHERE id = $1", [kid.id])).rows[0].club_id, A.clubId);
    await guardianKit.minor(kid.id, 10);

    const link = await guardianKit.ask(parent.token, kid.id);
    assert.equal(link.org_id, A.orgId);

    // Only the child's club heard, and the notice points at My club.
    const told = await approvalKit.notices(A.id, "guardian_request");
    assert.equal(told.length, 1);
    assert.equal(told[0].action_url, "/club");
    assert.match(told[0].title, /Bold Bat/);
    assert.equal(told[0].data.guardian_link_id, link.id);
    assert.deepEqual(await approvalKit.notices(B.id, "guardian_request"), [], "not the club next door");
    assert.equal((await require("../lib/guardian-requests").reviewersFor(pool, link)).via, "club");

    // The parent sees it waiting on /guardians; the payments picker doesn't.
    assert.deepEqual((await fetchJson("GET", "/api/guardians/my-dependents", { token: parent.token })).body, []);
    const mine = (await fetchJson("GET", "/api/guardians/my-dependents?include=pending", { token: parent.token })).body;
    assert.deepEqual(mine.map((d) => [d.id, d.status]), [[kid.id, "pending"]]);

    // Another club's admin in the same country: not theirs to see or decide.
    assert.ok(!(await guardianKit.queue(B.token)).some((g) => g.id === link.id));
    assert.equal((await guardianKit.review(B.token, link.id)).status, 403);
    // Neither the parent nor the child reviews anything.
    assert.equal((await fetchJson("GET", "/api/guardian-requests", { token: parent.token })).status, 403);
    assert.equal((await guardianKit.review(kid.token, link.id)).status, 403);

    // The club admin sees who's asking, the child's age and club, not the birthday.
    const row = (await guardianKit.queue(A.token)).find((g) => g.id === link.id);
    assert.ok(row, "the child's club admin sees it");
    assert.equal(row.guardian_name, "Bold Bat");
    assert.equal(row.dependent_name, "Saraa Bold");
    assert.equal(row.dependent_age, 10);
    assert.equal(row.club_name, "Kathmandu Divers");
    assert.ok(!("dependent_dob" in row), "a club admin gets the age, not the date of birth");

    assert.equal((await guardianKit.review(A.token, link.id, "maybe")).status, 400);
    const ok = await guardianKit.review(A.token, link.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await guardianKit.status(link.id), "approved");
    assert.equal((await guardianKit.review(A.token, link.id, "rejected")).status, 409, "decided once");
    assert.deepEqual((await fetchJson("GET", "/api/guardians/my-dependents", { token: parent.token })).body.map((d) => d.id), [kid.id]);
    const heard = await approvalKit.notices(parent.id, "guardian_decision");
    assert.equal(heard.length, 1);
    assert.equal(heard[0].action_url, "/guardians");
    assert.match(heard[0].title, /now linked to Saraa Bold/);

    // A no reaches the parent too.
    const kid2 = await delegateSignUp({ country_code: CODE, club_id: A.clubId, full_name: "Temuulen Bold" });
    await guardianKit.minor(kid2.id, 12);
    const link2 = await guardianKit.ask(parent.token, kid2.id);
    assert.equal((await guardianKit.review(A.token, link2.id, "rejected")).status, 200);
    assert.equal(await guardianKit.status(link2.id), "rejected");
    assert.match((await approvalKit.notices(parent.id, "guardian_decision"))[1].title, /turned down/);

    // Turned down means a day's wait before asking again, as with roles.
    const again = await fetchJson("POST", "/api/guardians/request", { token: parent.token, body: { dependent_user_id: kid2.id } });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.code, "recently_declined");

    // Withdrawing and asking again is fine, but the club hears once a day.
    const kid3 = await delegateSignUp({ country_code: CODE, club_id: A.clubId, full_name: "Enkh Bold" });
    await guardianKit.minor(kid3.id, 8);
    const first = await guardianKit.ask(parent.token, kid3.id);
    assert.equal((await fetchJson("POST", `/api/guardians/${first.id}/revoke`, { token: parent.token })).status, 200);
    const second = await guardianKit.ask(parent.token, kid3.id);
    assert.notEqual(second.id, first.id);
    const aboutKid3 = (await approvalKit.notices(A.id, "guardian_request")).filter((n) => n.data.dependent_user_id === kid3.id);
    assert.equal(aboutKid3.length, 1, "one notice, not one per re-ask");
    assert.ok((await guardianKit.queue(A.token)).some((g) => g.id === second.id), "the new request is still in the queue");
  } finally {
    await claimKit.wipe(CODE);
  }
});

test("guardian links in an unclaimed country: the region steps in, nobody decides their own, and it follows the child", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const CODE = "KGZ";
  const FAR = "TJK";
  await claimKit.wipe(CODE);
  await claimKit.wipe(FAR);
  const { reviewersFor } = require("../lib/guardian-requests");
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Bishkek Divers" });
    const B = await delegateSignUp({ country_code: CODE, new_club_name: "Osh Divers" });
    const north = await guardianKit.region(A.orgId, "Chuy", "CHU", [A.clubId]);
    const south = await guardianKit.region(A.orgId, "Osh Region", "OSH", [B.clubId]);
    const RA = await delegateSignUp({ country_code: CODE, full_name: "Chuy Admin" });
    const RB = await delegateSignUp({ country_code: CODE, full_name: "Osh Admin" });
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3), ($4, $5, $3)",
      [north, RA.id, A.orgId, south, RB.id]);

    // The club's founder asks to pay for their own child in their own club.
    const kid = await delegateSignUp({ country_code: CODE, club_id: A.clubId, full_name: "Aibek Founder" });
    await guardianKit.minor(kid.id, 9);
    const own = await guardianKit.ask(A.token, kid.id);
    // Nobody else runs the club, so it goes up to the region.
    assert.deepEqual(await approvalKit.notices(A.id, "guardian_request"), [], "not asked to approve themselves");
    const up = await approvalKit.notices(RA.id, "guardian_request");
    assert.equal(up.length, 1);
    assert.equal(up[0].action_url, "/region");
    assert.deepEqual(await approvalKit.notices(RB.id, "guardian_request"), [], "not the other region");
    assert.ok(!(await guardianKit.queue(A.token)).some((g) => g.id === own.id), "not in their own queue");
    assert.equal((await guardianKit.review(A.token, own.id)).status, 403);

    // A co-admin is a nearer pair of eyes than the region, once there is one.
    const A2 = await delegateSignUp({ country_code: CODE, club_id: A.clubId, full_name: "Bishkek Co-admin" });
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [A.clubId, A2.id, A.orgId]);
    const next = await reviewersFor(pool, own);
    assert.equal(next.via, "club");
    assert.deepEqual(next.recipients.map((r) => r.id), [A2.id]);
    assert.ok((await guardianKit.queue(A2.token)).some((g) => g.id === own.id));

    // Nobody live at the club or the region: DivingHQ.
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = ANY($1::uuid[])", [[A2.id, RA.id]]);
    assert.equal((await reviewersFor(pool, own)).via, "sysadmin");
    await pool.query("UPDATE users SET suspended_at = NULL WHERE id = ANY($1::uuid[])", [[A2.id, RA.id]]);

    // One level up can always act; the other region can't.
    assert.ok((await guardianKit.queue(RA.token)).some((g) => g.id === own.id));
    assert.ok(!(await guardianKit.queue(RB.token)).some((g) => g.id === own.id));
    assert.equal((await guardianKit.review(RB.token, own.id)).status, 403);
    assert.equal((await guardianKit.review(RA.token, own.id)).status, 200);
    assert.equal(await guardianKit.status(own.id), "approved");

    // It follows the child: moved to Osh, the old club and region lose it.
    const parent = await delegateSignUp({ country_code: CODE, full_name: "Moving Parent" });
    const mover = await delegateSignUp({ country_code: CODE, club_id: A.clubId, full_name: "Moving Kid" });
    await guardianKit.minor(mover.id, 13);
    const moving = await guardianKit.ask(parent.token, mover.id);
    assert.ok((await guardianKit.queue(A2.token)).some((g) => g.id === moving.id));
    await pool.query("UPDATE users SET club_id = $2 WHERE id = $1", [mover.id, B.clubId]);
    assert.ok(!(await guardianKit.queue(A2.token)).some((g) => g.id === moving.id));
    assert.equal((await guardianKit.review(A2.token, moving.id)).status, 403);
    assert.equal((await guardianKit.review(RA.token, moving.id)).status, 403);
    assert.ok((await guardianKit.queue(B.token)).some((g) => g.id === moving.id));

    // And never across a border: another country's club admin.
    const far = await delegateSignUp({ country_code: FAR, new_club_name: "Dushanbe Divers" });
    assert.ok(!(await guardianKit.queue(far.token)).some((g) => g.id === moving.id));
    const cross = await guardianKit.review(far.token, moving.id);
    assert.equal(cross.status, 403, JSON.stringify(cross.body));
    assert.equal(await guardianKit.status(moving.id), "pending");

    // The sysadmin can always decide, wherever it is.
    const sys = await claimKit.login("admin", "admin");
    assert.ok((await guardianKit.queue(sys.token)).some((g) => g.id === moving.id));
    assert.equal((await guardianKit.review(sys.token, moving.id, "rejected")).status, 200);
  } finally {
    await claimKit.wipe(CODE);
    await claimKit.wipe(FAR);
  }
});

test("guardian links under a federation stay with its org admins, not the clubs", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const st = await setupFixture({ withEvent: false });
  try {
    const club = (await pool.query(
      "INSERT INTO clubs (org_id, name) VALUES ($1, 'Federation Divers') RETURNING id", [st.orgId],
    )).rows[0].id;
    const clubAdmin = await approvalKit.member(st.orgId, "coach", club);
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [club, clubAdmin.id, st.orgId]);
    const kid = await approvalKit.member(st.orgId, "diver", club);
    await guardianKit.minor(kid.id, 11);
    const parent = await approvalKit.member(st.orgId, "spectator");

    const link = await guardianKit.ask(parent.token, kid.id);
    const told = await approvalKit.notices(st.adminId, "guardian_request");
    assert.equal(told.length, 1, "the org admin hears");
    assert.equal(told[0].action_url, "/users");
    assert.deepEqual(await approvalKit.notices(clubAdmin.id, "guardian_request"), [], "the club doesn't");

    // A club admin under a federation has an empty queue and no say.
    assert.deepEqual(await guardianKit.queue(clubAdmin.token), []);
    assert.equal((await guardianKit.review(clubAdmin.token, link.id)).status, 403);

    const row = (await guardianKit.queue(st.adminToken)).find((g) => g.id === link.id);
    assert.ok(row);
    assert.equal(row.dependent_age, 11);
    assert.ok(row.dependent_dob, "User Manager still gets the date of birth");
    assert.equal((await guardianKit.review(st.adminToken, link.id)).status, 200);
    assert.equal(await guardianKit.status(link.id), "approved");

    // With no live org admin, new ones go to DivingHQ.
    await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [st.adminId]);
    assert.equal((await require("../lib/guardian-requests").reviewersFor(pool, link)).via, "sysadmin");
  } finally {
    await pool.query("DELETE FROM clubs WHERE org_id = $1", [st.orgId]);
    await teardownFixture(st);
  }
});

test("guardian links in an unclaimed country: a club waiting for approval decides nothing", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  // Nobody runs a pending club (migration 096), whatever club_admins says,
  // and its region doesn't get to act through it either. So a child there
  // goes to DivingHQ until the club is live.
  const CODE = "UZB";
  await claimKit.wipe(CODE);
  const { reviewersFor } = require("../lib/guardian-requests");
  try {
    const A = await delegateSignUp({ country_code: CODE, new_club_name: "Tashkent Divers" });
    const RA = await delegateSignUp({ country_code: CODE, full_name: "Tashkent Region Admin" });
    const region = await guardianKit.region(A.orgId, "Tashkent", "TAS", [A.clubId]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)", [region, RA.id, A.orgId]);
    const kid = await delegateSignUp({ country_code: CODE, club_id: A.clubId, full_name: "Dilnoza Karimova" });
    await guardianKit.minor(kid.id, 10);
    const parent = await delegateSignUp({ country_code: CODE, full_name: "Rustam Karimov" });
    await pool.query("UPDATE clubs SET status = 'pending' WHERE id = $1", [A.clubId]);

    const link = await guardianKit.ask(parent.token, kid.id);
    assert.equal((await reviewersFor(pool, link)).via, "sysadmin");
    assert.deepEqual(await approvalKit.notices(A.id, "guardian_request"), [], "not the pending club's admin");
    assert.deepEqual(await approvalKit.notices(RA.id, "guardian_request"), [], "nor its region");

    for (const who of [A, RA]) {
      assert.ok(!(await guardianKit.queue(who.token)).some((g) => g.id === link.id));
      assert.equal((await guardianKit.review(who.token, link.id)).status, 403);
    }
    assert.equal(await guardianKit.status(link.id), "pending");

    // Approved, the club has its say again.
    await pool.query("UPDATE clubs SET status = 'active' WHERE id = $1", [A.clubId]);
    assert.ok((await guardianKit.queue(A.token)).some((g) => g.id === link.id));
    assert.equal((await guardianKit.review(A.token, link.id)).status, 200);
    assert.equal(await guardianKit.status(link.id), "approved");
  } finally {
    await claimKit.wipe(CODE);
  }
});

// =====================================================================
// Who changes a score by hand: the host's meet managers, never another
// level's (product decision, 2026-09). scoreAuthority in lib/middleware.js
// decides for manual entry, corrections, conflict resolution and dive-off
// results. One country (South Georgia, a code nothing else in the suite
// touches) with a region, two clubs in it, one outside it and a pending
// one, and a meet hosted at each level.
// =====================================================================
const hostKit = {
  async org(tag) {
    const slug = `sgs-${tag}-${crypto.randomBytes(3).toString("hex")}`;
    return (await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status, claim_state)
       VALUES ($1, 'SGS', $2, 'active', 'claimed') RETURNING id`,
      [`South Georgia ${slug}`, slug],
    )).rows[0].id;
  },
  async world() {
    const orgId = await hostKit.org("host");
    const otherOrgId = await hostKit.org("away");
    const q = async (sql, params) => (await pool.query(sql, params)).rows[0]?.id;
    const region = await q(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Cumberland Bay', 'CBY') RETURNING id", [orgId]);
    const club = (name, code, regionId, status = "active") => q(
      "INSERT INTO clubs (org_id, name, short_code, region_id, status) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [orgId, name, code, regionId, status]);
    const c1 = await club("Grytviken Divers", "GRY", region);
    const c2 = await club("King Edward Point", "KEP", region);
    const c3 = await club("Stromness Swim", "STR", null);
    const pending = await club("Leith Harbour", "LEH", region, "pending");
    const meet = (name, hostClub, hostRegion) => q(
      "INSERT INTO meets (org_id, name, host_club_id, host_region_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [orgId, name, hostClub, hostRegion]);
    const meets = {
      club: await meet("Club night", c1, null),
      region: await meet("Region champs", null, region),
      org: await meet("Nationals", null, null),
    };

    const u = (name, roles, clubId = null, extra = {}) =>
      compKit.user(orgId, name, roles, { clubId, ...extra });
    const users = {
      sysadmin: await u("SGS Sysadmin", [], null, { sysadmin: true }),
      orgAdmin: await u("SGS Org Admin", ["org_admin"]),
      fedMM: await u("SGS Fed MM", ["meet_manager"]),
      fedMMC3: await u("SGS Stromness MM", ["meet_manager"], c3),
      c1Admin: await u("SGS Grytviken Admin", ["diver"], c1),
      c1MM: await u("SGS Grytviken MM", ["meet_manager"], c1),
      c1Ref: await u("SGS Grytviken Ref", ["referee"], c1),
      c2MM: await u("SGS KEP MM", ["meet_manager"], c2),
      c3Ref: await u("SGS Stromness Ref", ["referee"], c3),
      pendingMM: await u("SGS Leith MM", ["meet_manager"], pending),
      regionAdmin: await u("SGS Region Admin", ["diver"]),
      orgRef: await u("SGS Org Ref", ["referee"]),
      referee: await u("SGS Referee", ["referee"], c1),
      away: await compKit.user(otherOrgId, "SGS Away Admin", ["org_admin"]),
    };
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)",
      [c1, users.c1Admin.id, orgId]);
    await pool.query("INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)",
      [region, users.regionAdmin.id, orgId]);

    // One Live event per meet (plus one with no meet), each with one
    // judge seated and a scored dive to correct.
    const judge = await u("SGS Judge", ["judge"]);
    const diver = await u("SGS Diver", ["diver"], c1);
    const dives = await compKit.dives(3);
    const events = {};
    for (const [kind, meetId] of [["club", meets.club], ["region", meets.region], ["org", meets.org], ["nomeet", null]]) {
      const id = await compKit.event(orgId, { name: `SGS ${kind}`, status: "Live", number_of_judges: 3, meet_id: meetId });
      await compKit.enter(id, diver.id, dives, { display_order: 1 });
      await compKit.panel(id, [judge]);
      await compKit.score(id, diver.id, 1, judge, 6);
      const scoreId = (await pool.query("SELECT id FROM scores WHERE event_id = $1", [id])).rows[0].id;
      events[kind] = { id, scoreId };
    }
    // Event managers: two on the club's event (one from the club, one
    // from outside it) and one on the federation's.
    const addManager = (eventId, userId) => pool.query(
      "INSERT INTO event_managers (event_id, user_id) VALUES ($1, $2)", [eventId, userId]);
    await addManager(events.club.id, users.c1Ref.id);
    await addManager(events.club.id, users.c3Ref.id);
    await addManager(events.region.id, users.c3Ref.id);
    await addManager(events.org.id, users.orgRef.id);
    return { orgId, otherOrgId, region, clubs: { c1, c2, c3, pending }, meets, users, events, judge, diver };
  },
  async cleanup(w) {
    if (!w) return;
    await compKit.cleanup(w.orgId, w.otherOrgId);
  },
};

test("score authority: the host's meet managers can correct a score, nobody from another level", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await hostKit.world();
    const U = w.users;
    // [event, who, allowed]. Every row is a PUT /api/scores/:id.
    const matrix = [
      // A club's meet: its admins, its members who manage meets, its
      // members added to the event. Nobody above or beside it.
      ["club", "c1Admin", true],
      ["club", "c1MM", true],
      ["club", "c1Ref", true],
      ["club", "sysadmin", true],
      ["club", "orgAdmin", false],
      ["club", "fedMM", false],
      ["club", "regionAdmin", false],
      ["club", "c2MM", false],
      ["club", "c3Ref", false],
      ["club", "referee", false],
      ["club", "away", false],
      // A region's meet: its admins and meet managers from its clubs.
      // Not the clubs' own admins, not the federation, not a club
      // that's still waiting on approval, not a club outside it.
      ["region", "regionAdmin", true],
      ["region", "c1MM", true],
      ["region", "c2MM", true],
      ["region", "c1Admin", false],
      ["region", "pendingMM", false],
      ["region", "fedMMC3", false],
      ["region", "c3Ref", false],
      ["region", "orgAdmin", false],
      ["region", "fedMM", false],
      // The federation's own meet, and an event with no meet at all:
      // the org's admins and meet managers and the event's managers.
      // A club or region admin gets nowhere.
      ["org", "orgAdmin", true],
      ["org", "fedMM", true],
      ["org", "fedMMC3", true],
      ["org", "orgRef", true],
      ["org", "c1Admin", false],
      ["org", "regionAdmin", false],
      ["org", "referee", false],
      ["org", "away", false],
      ["nomeet", "orgAdmin", true],
      ["nomeet", "c1MM", true],
      ["nomeet", "c1Admin", false],
      ["nomeet", "orgRef", false],
    ];
    let next = 6;
    for (const [kind, who, allowed] of matrix) {
      next = next === 9 ? 6.5 : next + 0.5;
      const r = await fetchJson("PUT", `/api/scores/${w.events[kind].scoreId}`, {
        token: U[who].token, body: { score: next, reason: `${who} on ${kind}` },
      });
      if (allowed) {
        assert.equal(r.status, 200, `${who} on the ${kind} event: ${JSON.stringify(r.body)}`);
      } else {
        assert.equal(r.status, 403, `${who} on the ${kind} event: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, "score_authority");
        assert.equal(r.body.host, kind === "nomeet" ? "org" : kind);
      }
    }
    // The refusal names who can.
    const club = await fetchJson("PUT", `/api/scores/${w.events.club.scoreId}`, {
      token: U.orgAdmin.token, body: { score: 5 },
    });
    assert.match(club.body.error, /host club's admins and meet managers/);
    const region = await fetchJson("PUT", `/api/scores/${w.events.region.scoreId}`, {
      token: U.c1Admin.token, body: { score: 5 },
    });
    assert.match(region.body.error, /host region's admins and meet managers/);
  } finally {
    await hostKit.cleanup(w);
  }
});

test("score authority: manual entry and conflict resolution follow the host too", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await hostKit.world();
    const U = w.users;
    const manual = (kind, who, score, round = 2) => fetchJson("POST", "/api/scores/manual-entry", {
      token: U[who].token,
      body: { event_id: w.events[kind].id, competitor_id: w.diver.id, round_number: round, judge_id: w.judge.id, score },
    });
    const stored = async (kind, round = 2) => (await pool.query(
      "SELECT score::float AS s, score_source FROM scores WHERE event_id = $1 AND round_number = $2",
      [w.events[kind].id, round])).rows[0];

    // Club night: the federation can't type a score in, the club can.
    let r = await manual("club", "orgAdmin", 7);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.host, "club");
    assert.equal(await stored("club"), undefined, "nothing written");
    r = await manual("club", "c1MM", 7);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await stored("club"), { s: 7, score_source: "manual_entry" });

    // Region champs: the region yes, a club admin in the region no.
    assert.equal((await manual("region", "c1Admin", 7)).status, 403);
    assert.equal((await manual("region", "regionAdmin", 7)).status, 200);

    // The federation's meet: a club admin no, a federation meet manager yes.
    assert.equal((await manual("org", "c1Admin", 7)).status, 403);
    assert.equal((await manual("org", "fedMM", 7)).status, 200);

    // An event that doesn't exist is a 404, not a refusal.
    const ghost = await fetchJson("POST", "/api/scores/manual-entry", {
      token: U.orgAdmin.token,
      body: { event_id: crypto.randomUUID(), competitor_id: w.diver.id, round_number: 1, judge_id: w.judge.id, score: 7 },
    });
    assert.equal(ghost.status, 404);

    // A judge's late sync disagreed with the club's manual entry. Settling
    // it picks the score that stands, so the same rule applies.
    const { insertScoreAudit } = require("../lib/score-audit");
    const row = (await pool.query(
      "SELECT id FROM scores WHERE event_id = $1 AND round_number = 2", [w.events.club.id])).rows[0];
    await insertScoreAudit(pool, {
      scoreId: row.id, eventId: w.events.club.id, competitorId: w.diver.id, judgeId: w.judge.id,
      round: 2, action: "rejected_duplicate", oldScore: 7, newScore: 7.5,
    });
    const resolve = (who) => fetchJson("POST", `/api/conflicts/${row.id}/resolve`, {
      token: U[who].token, body: { decision: "accept_proposed", proposed_score: 7.5 },
    });
    for (const who of ["orgAdmin", "fedMM", "regionAdmin", "c3Ref"]) {
      const no = await resolve(who);
      assert.equal(no.status, 403, `${who}: ${JSON.stringify(no.body)}`);
      assert.equal(no.body.code, "score_authority");
    }
    assert.deepEqual(await stored("club"), { s: 7, score_source: "manual_entry" }, "still the operator's value");
    const yes = await resolve("c1Admin");
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.deepEqual(await stored("club"), { s: 7.5, score_source: "manual_then_reconciled" });
  } finally {
    await hostKit.cleanup(w);
  }
});

test("score authority: the events list says who can change scores, per event", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await hostKit.world();
    const flags = async (who) => {
      const r = await fetchJson("GET", "/api/events", { token: w.users[who].token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const out = {};
      for (const [kind, ev] of Object.entries(w.events)) {
        out[kind] = r.body.find((e) => e.id === ev.id)?.can_change_scores;
      }
      return out;
    };
    assert.deepEqual(await flags("c1Admin"), { club: true, region: false, org: false, nomeet: false });
    assert.deepEqual(await flags("c1MM"), { club: true, region: true, org: true, nomeet: true });
    assert.deepEqual(await flags("regionAdmin"), { club: false, region: true, org: false, nomeet: false });
    assert.deepEqual(await flags("orgAdmin"), { club: false, region: false, org: true, nomeet: true });
    assert.deepEqual(await flags("sysadmin"), { club: true, region: true, org: true, nomeet: true });
    // Spectators see Live events, never with the flag up.
    const anon = await fetchJson("GET", "/api/events");
    const mine = anon.body.filter((e) => Object.values(w.events).some((ev) => ev.id === e.id));
    assert.equal(mine.length, 4);
    assert.ok(mine.every((e) => e.can_change_scores === false));
  } finally {
    await hostKit.cleanup(w);
  }
});

test("score authority: a dive-off's scores and winner are the host's to record", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await hostKit.world();
    const U = w.users;
    // A club-hosted Super Final head-to-head with one tied pair (nobody
    // has scored, so both are on 0).
    const h2h = await compKit.event(w.orgId, {
      name: "SGS H2H", status: "Live", number_of_judges: 3, meet_id: w.meets.club, event_format: "super_final_h2h",
    });
    const a = await compKit.user(w.orgId, "SGS Pair A", ["diver"], { clubId: w.clubs.c1 });
    const b = await compKit.user(w.orgId, "SGS Pair B", ["diver"], { clubId: w.clubs.c1 });
    const dive = (await compKit.dives(1))[0];
    for (const [who, order] of [[a, 1], [b, 2]]) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id, display_order, group_number)
         VALUES ($1, $2, 1, $3, $4, 1)`,
        [h2h, who.id, dive, order]);
    }
    // The federation's org admin can still set one up (that's running the
    // event, not scoring it), but not with a result in it.
    const create = (who, extra = {}) => fetchJson("POST", `/api/events/${h2h}/dive-offs`, {
      token: U[who].token, body: { competitor_a_id: a.id, competitor_b_id: b.id, ...extra },
    });
    const withScores = await create("orgAdmin", { score_a: 8, score_b: 7, winner_id: a.id });
    assert.equal(withScores.status, 403, JSON.stringify(withScores.body));
    assert.equal(withScores.body.code, "score_authority");
    const made = await create("orgAdmin", { score_a: null, score_b: null, winner_id: null, notes: "set up" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.dive_off.id;

    const patch = (who, body) => fetchJson("PATCH", `/api/events/${h2h}/dive-offs/${id}`, { token: U[who].token, body });
    const refused = await patch("orgAdmin", { score_a: 8.5, score_b: 8, winner_id: a.id });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    // Re-sending the same (empty) result with new notes isn't a change.
    assert.equal((await patch("orgAdmin", { score_a: null, score_b: null, winner_id: null, notes: "dives picked" })).status, 200);

    const ok = await patch("c1Admin", { score_a: 8.5, score_b: 8, winner_id: a.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.dive_off.winner_id, a.id);
    // Now there's a result, the federation can still touch the notes as
    // long as it sends the stored result back unchanged, but it can't
    // flip the winner.
    assert.equal((await patch("orgAdmin", { score_a: "8.50", score_b: 8, winner_id: a.id, notes: "checked" })).status, 200);
    assert.equal((await patch("orgAdmin", { winner_id: b.id })).status, 403);
    const stored = (await pool.query("SELECT winner_id, notes FROM tiebreak_dive_offs WHERE id = $1", [id])).rows[0];
    assert.deepEqual(stored, { winner_id: a.id, notes: "checked" });
  } finally {
    await hostKit.cleanup(w);
  }
});

// =====================================================================
// Custom dives keep to the official DD range (decision A7-06). A custom
// row's DD has to fall between the lowest and highest DD the official
// dives at its height use, read from the directory (lib/custom-dive-dd.js),
// when it's made or edited and whenever a dive list takes it.
// =====================================================================
const ddKit = {
  async range(height) {
    const r = (await pool.query(
      "SELECT MIN(dd)::float AS lo, MAX(dd)::float AS hi FROM dive_directory WHERE NOT is_custom AND height = $1",
      [height])).rows[0];
    return r.lo == null ? null : r;
  },
  async allRange() {
    return (await pool.query(
      "SELECT MIN(dd)::float AS lo, MAX(dd)::float AS hi FROM dive_directory WHERE NOT is_custom")).rows[0];
  },
  // A dive code nothing in the catalogue or another run uses.
  code() {
    return `9${crypto.randomInt(10000, 99999)}`;
  },
  fmt: (n) => Number(n).toFixed(1),
  // n + d on the 0.1 grid, without the float tail (4.3 + 0.1 isn't 4.4).
  step: (n, d) => Math.round((n + d) * 10) / 10,
};

test("custom dives: a DD outside the official range for the height is refused on create and edit", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await hostKit.org("dd");
  try {
    const coach = await compKit.user(orgId, "SGS DD Coach", ["coach"]);
    const three = await ddKit.range(3);
    const one = await ddKit.range(1);
    const all = await ddKit.allRange();
    assert.ok(three && one && all.lo != null, "the catalogue is loaded");
    assert.equal(await ddKit.range(0), null, "no official dives at 0m, which the fallback is for");
    const post = (body) => fetchJson("POST", "/api/dive-directory", {
      token: coach.token, body: { dive_code: ddKit.code(), position: "B", ...body },
    });

    // Above and below the 3m range: refused, and the message gives it.
    const high = await post({ height: "3m", dd: ddKit.step(three.hi, 0.1) });
    assert.equal(high.status, 400, JSON.stringify(high.body));
    assert.equal(high.body.code, "dd_out_of_range");
    assert.match(high.body.error, new RegExp(`between ${ddKit.fmt(three.lo)} to ${ddKit.fmt(three.hi)}`));
    assert.match(high.body.error, /official World Aquatics dives at 3m/);
    assert.equal((await post({ height: "3m", dd: ddKit.step(three.lo, -0.1) })).status, 400);
    // The ends of the range are in it.
    assert.equal((await post({ height: "3m", dd: three.lo })).status, 201);
    assert.equal((await post({ height: "3m", dd: three.hi })).status, 201);

    // 0m has no official dives, so the range across every height applies.
    const drill = await post({ height: "0m", dd: ddKit.step(all.hi, 0.1) });
    assert.equal(drill.status, 400);
    assert.match(drill.body.error, /no official World Aquatics dives at 0m/);
    assert.equal((await post({ height: "0m", dd: ddKit.step(all.lo, -0.1) })).status, 400, "the old 0.5 sit-dive goes too");
    const okDrill = await post({ height: "0m", dd: all.lo });
    assert.equal(okDrill.status, 201, JSON.stringify(okDrill.body));

    // Edits are checked on the row as it would end up: a new DD, and a
    // move to a height whose range doesn't cover the DD it already has.
    const put = (id, body) => fetchJson("PUT", `/api/dive-directory/${id}`, { token: coach.token, body });
    const badDd = await put(okDrill.body.id, { dd: ddKit.step(all.hi, 1) });
    assert.equal(badDd.status, 400, JSON.stringify(badDd.body));
    assert.equal(badDd.body.code, "dd_out_of_range");
    const tall = ddKit.step(one.hi, 0.1);
    assert.ok(tall <= three.hi, "a DD that fits 3m but not 1m");
    const mover = await post({ height: "3m", dd: tall });
    assert.equal(mover.status, 201, JSON.stringify(mover.body));
    const moved = await put(mover.body.id, { height: "1m" });
    assert.equal(moved.status, 400, JSON.stringify(moved.body));
    assert.match(moved.body.error, /at 1m/);
    assert.equal((await put(mover.body.id, { description: "still fine at 3m" })).status, 200);
    const stored = (await pool.query("SELECT height::float AS h, dd::float AS dd FROM dive_directory WHERE id = $1",
      [mover.body.id])).rows[0];
    assert.deepEqual(stored, { h: 3, dd: tall });
  } finally {
    await compKit.cleanup(orgId);
  }
});

test("custom dives: a dive list won't take one whose DD is outside the official range", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await hostKit.org("ddlist");
  try {
    const admin = await compKit.user(orgId, "SGS DD Admin", ["org_admin"]);
    const diver = await compKit.user(orgId, "SGS DD Diver", ["diver"]);
    const three = await ddKit.range(3);
    // Rows made before the rule, which the API won't make any more, so
    // straight into the table: one too hard for 3m, one inside it.
    const custom = async (dd) => (await pool.query(
      `INSERT INTO dive_directory (dive_code, height, position, dd, is_custom, created_org_id)
       VALUES ($1, 3, 'B', $2, TRUE, $3) RETURNING id`,
      [ddKit.code(), dd, orgId])).rows[0].id;
    const legacy = await custom(9.5);
    const fine = await custom(three.lo);
    const eventId = await compKit.event(orgId, { name: "SGS DD event", total_rounds: 1 });

    // The diver's own submit (lib/dive-list-submit.js).
    const submit = (diveId) => fetchJson("POST", "/api/competitor/submit-list", {
      token: diver.token, body: { event_id: eventId, dives: [{ round_number: 1, dive_id: diveId }] },
    });
    const refused = await submit(legacy);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.body.error, /DD 9\.5 for custom dive 9\d+B at 3m has to be between/);
    assert.equal((await submit(fine)).status, 200);

    // The operator's late-entry add.
    const late = (diveId) => fetchJson("POST", `/api/events/${eventId}/roster`, {
      token: admin.token, body: { competitor_id: diver.id, dive_id: diveId, round_number: 1 },
    });
    const lateNo = await late(legacy);
    assert.equal(lateNo.status, 400, JSON.stringify(lateNo.body));
    assert.equal(lateNo.body.code, "dd_out_of_range");
    const kept = (await pool.query(
      "SELECT dive_id FROM competitor_dive_lists WHERE event_id = $1 AND competitor_id = $2", [eventId, diver.id])).rows;
    assert.deepEqual(kept.map((r) => r.dive_id), [fine], "the list still holds the in-range dive");

    // The roster CSV import finds dives by code, so the legacy row is what
    // its code resolves to; the row comes back as an error, not a write.
    const code = (await pool.query("SELECT dive_code FROM dive_directory WHERE id = $1", [legacy])).rows[0].dive_code;
    const username = (await pool.query("SELECT username FROM users WHERE id = $1", [diver.id])).rows[0].username;
    const csv = await fetchJson("POST", `/api/events/${eventId}/roster/import`, {
      token: admin.token, body: { csv: `username,round_1_code,round_1_pos\n${username},${code},B\n` },
    });
    assert.equal(csv.status, 200, JSON.stringify(csv.body));
    assert.equal(csv.body.rounds_written, 0);
    assert.match(csv.body.errors[0]?.error || "", /^Round 1: DD 9\.5 for custom dive/);

    // An event's prescribed round dives, on create and on edit.
    const create = await fetchJson("POST", "/api/events", {
      token: admin.token,
      body: {
        name: "SGS prescribed", gender: "Mixed", height: "3m", number_of_judges: 5, event_type: "individual",
        round_dives: [{ round_number: 1, dive_id: fine }, { round_number: 2, dive_id: legacy }],
      },
    });
    assert.equal(create.status, 400, JSON.stringify(create.body));
    assert.match(create.body.error, /round_dives round 2: DD 9\.5/);
    const edit = await fetchJson("PUT", `/api/events/${eventId}`, {
      token: admin.token, body: { round_dives: [{ round_number: 1, dive_id: legacy }] },
    });
    assert.equal(edit.status, 400, JSON.stringify(edit.body));
    assert.equal((await pool.query("SELECT 1 FROM event_round_dives WHERE event_id = $1", [eventId])).rows.length, 0);
  } finally {
    await compKit.cleanup(orgId);
  }
});

// Review follow-ups on the score rule. The matrix above never had an
// event manager from one of the region's clubs at the region's meet, or a
// meet hosted by a club that's still waiting on approval, so dropping
// either branch of the rule went unnoticed.
test("score authority: a region club's event manager counts at the region's meet; a pending host club's meet is only the sysadmin's", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await hostKit.world();
    const U = w.users;
    const correct = (scoreId, who, score) => fetchJson("PUT", `/api/scores/${scoreId}`, {
      token: U[who].token, body: { score, reason: `${who} review` },
    });

    // A referee from King Edward Point (in the region) added to run the
    // region's event: in. Without the event_managers row: out.
    U.c2Ref = await compKit.user(w.orgId, "SGS KEP Ref", ["referee"], { clubId: w.clubs.c2 });
    let r = await correct(w.events.region.scoreId, "c2Ref", 6.5);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    await pool.query("INSERT INTO event_managers (event_id, user_id) VALUES ($1, $2)", [w.events.region.id, U.c2Ref.id]);
    r = await correct(w.events.region.scoreId, "c2Ref", 7);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // Leith Harbour hasn't been approved, so its meet is nobody's to
    // rescore: not its own admin or meet manager, not the federation.
    const pendingMeet = (await pool.query(
      "INSERT INTO meets (org_id, name, host_club_id) VALUES ($1, 'Leith night', $2) RETURNING id",
      [w.orgId, w.clubs.pending])).rows[0].id;
    const ev = await compKit.event(w.orgId, { name: "SGS pending", status: "Live", number_of_judges: 3, meet_id: pendingMeet });
    await compKit.enter(ev, w.diver.id, await compKit.dives(3), { display_order: 1 });
    await compKit.panel(ev, [w.judge]);
    await compKit.score(ev, w.diver.id, 1, w.judge, 6);
    const scoreId = (await pool.query("SELECT id FROM scores WHERE event_id = $1", [ev])).rows[0].id;
    U.pendingAdmin = await compKit.user(w.orgId, "SGS Leith Admin", ["diver"], { clubId: w.clubs.pending });
    await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)",
      [w.clubs.pending, U.pendingAdmin.id, w.orgId]);
    for (const who of ["pendingAdmin", "pendingMM", "orgAdmin", "fedMM"]) {
      const no = await correct(scoreId, who, 7);
      assert.equal(no.status, 403, `${who}: ${JSON.stringify(no.body)}`);
      assert.equal(no.body.code, "score_authority");
    }
    assert.equal((await correct(scoreId, "sysadmin", 7.5)).status, 200);
  } finally {
    await hostKit.cleanup(w);
  }
});

// A dive-off's resolved_at is part of its result: when a pair dives off
// more than once, the latest resolved run is the one that counts
// (loadResolvedDiveOffs). So someone who runs the event but can't change
// its scores mustn't be able to move it, directly or by re-sending a
// winner that's already stored (which used to re-stamp it).
test("score authority: a dive-off's resolved_at is the host's too, and re-sending the stored winner doesn't move it", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  let w;
  try {
    w = await hostKit.world();
    const U = w.users;
    const h2h = await compKit.event(w.orgId, {
      name: "SGS H2H rerun", status: "Live", number_of_judges: 3, meet_id: w.meets.club, event_format: "super_final_h2h",
    });
    const a = await compKit.user(w.orgId, "SGS Rerun A", ["diver"], { clubId: w.clubs.c1 });
    const b = await compKit.user(w.orgId, "SGS Rerun B", ["diver"], { clubId: w.clubs.c1 });
    const dive = (await compKit.dives(1))[0];
    for (const [who, order] of [[a, 1], [b, 2]]) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id, display_order, group_number)
         VALUES ($1, $2, 1, $3, $4, 1)`,
        [h2h, who.id, dive, order]);
    }
    // The club records two runs of the same pair: A won the first, B the
    // re-run, which is the one that stands.
    const create = async (winner, sa, sb) => {
      const r = await fetchJson("POST", `/api/events/${h2h}/dive-offs`, {
        token: U.c1Admin.token,
        body: { competitor_a_id: a.id, competitor_b_id: b.id, score_a: sa, score_b: sb, winner_id: winner.id },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.dive_off;
    };
    const first = await create(a, 8, 7);
    await pool.query("UPDATE tiebreak_dive_offs SET resolved_at = now() - interval '1 hour' WHERE id = $1", [first.id]);
    await create(b, 7, 8.5);
    const { loadResolvedDiveOffs, diveOffPairKey } = require("../lib/super-final-helpers");
    const standing = async () => (await loadResolvedDiveOffs(pool, h2h)).get(diveOffPairKey(a.id, b.id));
    assert.equal(await standing(), b.id);
    const firstStamp = async () => (await pool.query(
      "SELECT resolved_at FROM tiebreak_dive_offs WHERE id = $1", [first.id])).rows[0].resolved_at.getTime();
    const before = await firstStamp();

    const patch = (who, body) => fetchJson("PATCH", `/api/events/${h2h}/dive-offs/${first.id}`, { token: U[who].token, body });
    // The federation runs the event (org admin), but it's the club's meet.
    const moved = await patch("orgAdmin", { resolved_at: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(moved.status, 403, JSON.stringify(moved.body));
    assert.equal(moved.body.code, "score_authority");
    // Notes plus the winner the form already had: fine, and nothing moves.
    const resent = await patch("orgAdmin", { winner_id: a.id, score_a: 8, score_b: 7, notes: "checked" });
    assert.equal(resent.status, 200, JSON.stringify(resent.body));
    assert.equal(await firstStamp(), before, "resolved_at left alone");
    assert.equal(await standing(), b.id, "the re-run still counts");
    // Sending back exactly what's stored and nothing else is a no-op.
    assert.equal((await patch("orgAdmin", { winner_id: a.id })).status, 200);
    assert.equal(await firstStamp(), before);

    // The club can reorder the runs if it has to.
    const club = await patch("c1Admin", { resolved_at: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(club.status, 200, JSON.stringify(club.body));
    assert.equal(await standing(), a.id);
  } finally {
    await hostKit.cleanup(w);
  }
});

// The team bulk submit is one of the dive-list paths the DD range check
// went into, and nothing covered it.
test("custom dives: a team's dive list won't take one whose DD is outside the official range", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await hostKit.org("ddteam");
  try {
    const manager = await compKit.user(orgId, "SGS DD Team Manager", ["meet_manager"]);
    const m1 = await compKit.user(orgId, "SGS DD Team One", ["diver"]);
    const m2 = await compKit.user(orgId, "SGS DD Team Two", ["diver"]);
    const three = await ddKit.range(3);
    const custom = async (dd) => (await pool.query(
      `INSERT INTO dive_directory (dive_code, height, position, dd, is_custom, created_org_id)
       VALUES ($1, 3, 'B', $2, TRUE, $3) RETURNING id`,
      [ddKit.code(), dd, orgId])).rows[0].id;
    const legacy = await custom(9.5);
    const fine = await custom(three.lo);
    const [core] = await compKit.dives(1);
    const eventId = await compKit.event(orgId, { name: "SGS DD team event", event_type: "team", total_rounds: 2 });
    const team = (await pool.query("INSERT INTO teams (org_id, name) VALUES ($1, 'SGS DD Team') RETURNING id", [orgId])).rows[0].id;
    await pool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($1, $3)", [team, m1.id, m2.id]);
    const post = (m1Dives) => fetchJson("POST", `/api/teams/${team}/dive-lists`, {
      token: manager.token,
      body: {
        event_id: eventId,
        dives: [
          ...m1Dives.map((dive_id, i) => ({ competitor_id: m1.id, dive_id, round_number: i + 1 })),
          ...[core, fine].map((dive_id, i) => ({ competitor_id: m2.id, dive_id, round_number: i + 1 })),
        ],
      },
    });
    const no = await post([core, legacy]);
    assert.equal(no.status, 400, JSON.stringify(no.body));
    assert.match(no.body.error, /DD 9\.5 for custom dive 9\d+B at 3m has to be between/);
    assert.equal((await pool.query("SELECT 1 FROM competitor_dive_lists WHERE event_id = $1", [eventId])).rows.length, 0);
    const ok = await post([core, fine]);
    assert.ok(ok.status < 300, JSON.stringify(ok.body));
  } finally {
    await pool.query("DELETE FROM events WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM teams WHERE org_id = $1", [orgId]).catch(() => {});
    await compKit.cleanup(orgId);
  }
});

// PDFs through the real route with a name in every script the per-script
// font fallback knows about. This suite runs with PDF_FONT_DIR=none (top
// of the file), which is a box without fonts-noto-core or fonts-noto-cjk:
// every row still prints, Cyrillic and Latin-extended names are spelled
// out and the scripts with no Latin form come out as "?", never mojibake
// or a 500. With the fonts installed the same rows print in their own
// scripts; that path is tested without a database in
// test/pdf-document.test.js.
test("start-list.pdf prints a row for every script, folded when there's no font", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  if (require("../lib/pdf-fonts").anyFontFile()) return t.skip("PDF fonts found, text isn't folded");
  const st = await setupFixture({ withEvent: true });
  try {
    const dive = await recordKit.threeMetreDive();
    const names = {
      "Иван Петров": "Ivan Petrov",
      "Łukasz Świątek": "Lukasz Swiatek",
      "Γιώργος Παπαδόπουλος": "Giorgos Papadopoulos",
      "李娜": "??",
      "山田はなこ": "?????",
      "김연아": "???",
      "محمد علي": "???? ???",
      "רחל כהן": "??? ???",
    };
    let order = 0;
    for (const fullName of Object.keys(names)) {
      const id = await insertUser({
        orgId: st.orgId, role: "diver", fullName,
        username: `int-scr-${order}-${st.slug}`,
      });
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number, display_order)
         VALUES ($1, $2, $3, 1, $4)`,
        [st.eventId, id, dive, ++order],
      );
    }
    const res = await fetch(`${baseUrl}/api/events/${st.eventId}/start-list.pdf`);
    assert.equal(res.status, 200);
    const text = pdfText(Buffer.from(await res.arrayBuffer())).join("\n");
    for (const [name, folded] of Object.entries(names)) {
      assert.ok(text.includes(`${folded}  TST`), `${name} prints as ${folded}\n${text}`);
    }
  } finally {
    await teardownFixture(st);
  }
});

// GET /api/ops/status is mounted on the real server, ahead of the SPA
// fallback and the maintenance gate, and the request window sees the
// traffic this suite has already sent. routes/ops-status.js has its own
// suite (ops-status.integration.test.js) for the details.
test("ops status answers on the real server", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const health = await fetchJson("GET", "/api/health");
  const res = await fetch(`${baseUrl}/api/ops/status`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.schema_version, health.body.schema_version);
  assert.equal(body.errors.window_minutes, 15);
  assert.ok(body.errors.requests >= 1, "the /api/health call above was counted");
  for (const block of ["backup", "restore_check", "deploy"]) assert.equal(typeof body[block], "object");
});

// /metrics on the real server: a direct scrape (Prometheus on the box)
// still works, a request that came through the Cloudflare tunnel is a
// 404. The suite runs outside production with no METRICS_TOKEN, so the
// direct path is open here. test/metrics-access.test.js covers the live
// box's production settings and the token.
test("/metrics answers a direct scrape and hides from the tunnel", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  if (process.env.METRICS_TOKEN || process.env.NODE_ENV === "production") {
    return t.skip("needs the default dev metrics settings");
  }
  const direct = await fetch(`${baseUrl}/metrics`);
  assert.equal(direct.status, 200);
  assert.match(await direct.text(), /dive_recorder_http_requests_total/);
  for (const headers of [{ "cf-ray": "8c1f0d2e3a4b5c6d-SYD" }, { "cf-connecting-ip": "203.0.113.9" }]) {
    const viaTunnel = await fetch(`${baseUrl}/metrics`, { headers });
    assert.equal(viaTunnel.status, 404, JSON.stringify(headers));
    assert.equal(await viaTunnel.text(), "Not found");
  }
});

// The judge screen reads a dive's scores back after a reload or a
// reconnect (GET /api/events/:eventId/dive-scores), so a judge who had
// scored sees their mark and a shut keypad instead of an open one. Only
// a judge with a seat on the panel gets an answer, and a score a re-dive
// set aside isn't in it.
test("dive-scores: a panel judge reads back the dive's scores, nobody else does", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("dives");
  const otherOrg = await compKit.org("divesx");
  try {
    const j1 = await compKit.user(orgId, "DS Judge One", ["judge"]);
    const j2 = await compKit.user(orgId, "DS Judge Two", ["judge"]);
    const offPanel = await compKit.user(orgId, "DS Off Panel", ["judge"]);
    const diverRole = await compKit.user(orgId, "DS Diver Role", ["diver"]);
    const outsider = await compKit.user(otherOrg, "DS Outsider", ["judge"]);
    const sys = await compKit.user(otherOrg, "DS Sysadmin", [], { sysadmin: true });
    const competitor = await compKit.user(orgId, "DS Competitor", ["diver"]);
    const eventId = await compKit.event(orgId, { status: "Live" });
    await compKit.enter(eventId, competitor.id, await compKit.dives(2));
    await compKit.panel(eventId, [j1, j2]);
    await compKit.score(eventId, competitor.id, 1, j1, 8.5);
    await compKit.score(eventId, competitor.id, 1, j2, 7);
    await compKit.score(eventId, competitor.id, 2, j1, 6);
    const url = (q) => `/api/events/${eventId}/dive-scores?${q}`;
    const round1 = `competitor_id=${competitor.id}&round_number=1`;

    const both = await fetchJson("GET", url(round1), { token: j2.token });
    assert.equal(both.status, 200);
    assert.deepEqual(both.body, {
      judge_number: 2,
      scores: [{ judge_number: 1, score: 8.5 }, { judge_number: 2, score: 7 }],
    });
    const round2 = await fetchJson("GET", url(`competitor_id=${competitor.id}&round_number=2`), { token: j1.token });
    assert.deepEqual(round2.body, { judge_number: 1, scores: [{ judge_number: 1, score: 6 }] });

    // A re-dive marks the old rows until each judge scores again.
    await pool.query(
      "UPDATE scores SET status = 'redive' WHERE event_id = $1 AND round_number = 1 AND judge_id = $2",
      [eventId, j2.id],
    );
    const afterRedive = await fetchJson("GET", url(round1), { token: j1.token });
    assert.deepEqual(afterRedive.body.scores, [{ judge_number: 1, score: 8.5 }]);

    // No seat, no scores: another judge in the org, one from elsewhere,
    // a sysadmin who isn't on the panel.
    for (const u of [offPanel, outsider, sys]) {
      assert.equal((await fetchJson("GET", url(round1), { token: u.token })).status, 404, u.full_name);
    }
    // Not a judge at all, or not signed in (verifyToken answers a missing
    // token with a 403).
    assert.equal((await fetchJson("GET", url(round1), { token: diverRole.token })).status, 403);
    assert.equal((await fetchJson("GET", url(round1))).status, 403);
    // Junk in the query is a 400, and a junk event id a 404, never a
    // Postgres 500.
    for (const q of ["competitor_id=nope&round_number=1", `competitor_id=${competitor.id}&round_number=0`,
      `competitor_id=${competitor.id}&round_number=1.5`, `competitor_id=${competitor.id}`, ""]) {
      assert.equal((await fetchJson("GET", url(q), { token: j1.token })).status, 400, q);
    }
    assert.equal((await fetchJson("GET", `/api/events/not-a-uuid/dive-scores?${round1}`, { token: j1.token })).status, 404);
  } finally {
    await compKit.cleanup(orgId, otherOrg);
  }
});

// The Control Room reads the live dive's stored scores back after a
// reload, a reconnect or an undone finalise (GET /api/events/:id/dive-panel),
// so its tiles and Next / Finalise come back instead of sitting on
// "Waiting for 5 more judge scores" with every score stored. Same people
// as the roster: the event's org admins, meet managers and referees (and
// a sysadmin). judge_id comes with each score so the pool can key them
// like a live score_received; a re-dive's set-aside panel isn't in it; the
// referee's call on the dive is.
test("dive-panel: the Control Room reads back a dive's stored scores", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("panel");
  const otherOrg = await compKit.org("panelx");
  try {
    const j1 = await compKit.user(orgId, "DP Judge One", ["judge"]);
    const j2 = await compKit.user(orgId, "DP Judge Two", ["judge"]);
    const manager = await compKit.user(orgId, "DP Manager", ["meet_manager"]);
    const referee = await compKit.user(orgId, "DP Referee", ["referee"]);
    const admin = await compKit.user(orgId, "DP Admin", ["org_admin"]);
    const diverRole = await compKit.user(orgId, "DP Diver Role", ["diver"]);
    const outsider = await compKit.user(otherOrg, "DP Outsider", ["meet_manager"]);
    const sys = await compKit.user(otherOrg, "DP Sysadmin", [], { sysadmin: true });
    const competitor = await compKit.user(orgId, "DP Competitor", ["diver"]);
    const eventId = await compKit.event(orgId, { status: "Live" });
    await compKit.enter(eventId, competitor.id, await compKit.dives(2));
    await compKit.panel(eventId, [j1, j2]);
    await compKit.score(eventId, competitor.id, 1, j2, 7);
    await compKit.score(eventId, competitor.id, 1, j1, 8.5);
    await compKit.score(eventId, competitor.id, 2, j1, 6);
    const url = (q) => `/api/events/${eventId}/dive-panel?${q}`;
    const round1 = `competitor_id=${competitor.id}&round_number=1`;

    for (const u of [manager, referee, admin, sys]) {
      const res = await fetchJson("GET", url(round1), { token: u.token });
      assert.equal(res.status, 200, u.full_name);
      assert.deepEqual(res.body, {
        event_id: eventId,
        competitor_id: competitor.id,
        round_number: 1,
        referee_call: null,
        referee_cap: null,
        scores: [
          { judge_id: j1.id, judge_number: 1, score: 8.5 },
          { judge_id: j2.id, judge_number: 2, score: 7 },
        ],
      }, u.full_name);
    }

    // A dive nobody's scored yet is just empty.
    await pool.query(
      "UPDATE competitor_dive_lists SET referee_call = 'cap', referee_cap = 2 WHERE event_id = $1 AND round_number = 2",
      [eventId],
    );
    const round2 = await fetchJson("GET", url(`competitor_id=${competitor.id}&round_number=2`), { token: manager.token });
    assert.equal(round2.body.referee_call, "cap");
    assert.equal(round2.body.referee_cap, 2);
    assert.deepEqual(round2.body.scores, [{ judge_id: j1.id, judge_number: 1, score: 6 }]);

    // A re-dive marks the old rows until each judge scores again.
    await pool.query(
      "UPDATE scores SET status = 'redive' WHERE event_id = $1 AND round_number = 1 AND judge_id = $2",
      [eventId, j2.id],
    );
    const afterRedive = await fetchJson("GET", url(round1), { token: manager.token });
    assert.deepEqual(afterRedive.body.scores, [{ judge_id: j1.id, judge_number: 1, score: 8.5 }]);

    // A meet manager from another org, a judge, a diver, nobody signed in.
    assert.equal((await fetchJson("GET", url(round1), { token: outsider.token })).status, 403);
    assert.equal((await fetchJson("GET", url(round1), { token: j1.token })).status, 403);
    assert.equal((await fetchJson("GET", url(round1), { token: diverRole.token })).status, 403);
    assert.equal((await fetchJson("GET", url(round1))).status, 403);
    // Junk in the query is a 400, and a junk event id a 404, never a
    // Postgres 500.
    for (const q of ["competitor_id=nope&round_number=1", `competitor_id=${competitor.id}&round_number=0`,
      `competitor_id=${competitor.id}&round_number=1.5`, `competitor_id=${competitor.id}`, ""]) {
      assert.equal((await fetchJson("GET", url(q), { token: manager.token })).status, 400, q);
    }
    assert.equal((await fetchJson("GET", `/api/events/not-a-uuid/dive-panel?${round1}`, { token: manager.token })).status, 404);
  } finally {
    await compKit.cleanup(orgId, otherOrg);
  }
});

// The Control Room's Setup stage reads the readiness checklist, and the
// Control Room is open to meet managers and referees as well as org
// admins. Readiness was org admins and event delegates only, so a referee
// following a sign-off request into the Control Room (and a meet manager
// running it) got "You don't have permission" where the checklist and the
// start order belong. Same people as the roster now, own org only.
test("readiness: the Control Room's people read the checklist, nobody else", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");
  const orgId = await compKit.org("ready");
  const otherOrg = await compKit.org("readyx");
  try {
    const referee = await compKit.user(orgId, "RD Referee", ["referee"]);
    const manager = await compKit.user(orgId, "RD Manager", ["meet_manager"]);
    const admin = await compKit.user(orgId, "RD Admin", ["org_admin"]);
    const judge = await compKit.user(orgId, "RD Judge", ["judge"]);
    const diver = await compKit.user(orgId, "RD Diver", ["diver"]);
    const outsider = await compKit.user(otherOrg, "RD Outsider", ["referee"]);
    const sys = await compKit.user(otherOrg, "RD Sysadmin", [], { sysadmin: true });
    const eventId = await compKit.event(orgId);
    const url = `/api/events/${eventId}/readiness`;
    for (const u of [referee, manager, admin, sys]) {
      const res = await fetchJson("GET", url, { token: u.token });
      assert.equal(res.status, 200, u.full_name);
      assert.equal(res.body.event_id, eventId);
      assert.ok(res.body.steps.some((s) => s.key === "sign_off"));
    }
    assert.equal((await fetchJson("GET", url, { token: outsider.token })).status, 404);
    for (const u of [judge, diver]) {
      assert.equal((await fetchJson("GET", url, { token: u.token })).status, 403, u.full_name);
    }
    assert.equal((await fetchJson("GET", url)).status, 403);
    assert.equal((await fetchJson("GET", "/api/events/not-a-uuid/readiness", { token: manager.token })).status, 404);
  } finally {
    await compKit.cleanup(orgId, otherOrg);
  }
});
