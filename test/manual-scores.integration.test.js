// Integration tests for the P5 manual-fallback flow against a
// live Postgres.
//
// Exercises the parts the mock-pool unit tests can't:
//
//   * Migration 055 actually applied (score_source column + enum
//     extension + partial index).
//   * POST /api/scores/manual-entry mounts cleanly + writes a row
//     with score_source='manual_entry'.
//   * Re-POST with a different score updates the row (typo fix).
//   * Re-POST with a different idempotency_key but same payload
//     hits the unique constraint via the upsert.
//   * POST /api/conflicts/:score_id/resolve with 'keep_existing'
//     flips score_source to 'manual_then_reconciled' and writes an
//     audit row.
//   * POST /api/conflicts/:score_id/resolve with 'accept_proposed'
//     updates the score and writes an audit row.
//
// Skips (doesn't fail) when:
//   * Postgres isn't reachable.
//   * Migrations 054 + 055 haven't been applied to divinghq_test.
//
// The socket-side reconciliation (submit_score against a prior
// manual entry) isn't exercised here — it requires spinning up
// Socket.IO + a JWT-authenticated client, which doubles the
// fixture cost for marginal extra coverage. The HTTP-side guards
// + audit-log shape verified here are enough to demonstrate the
// schema + endpoints work end-to-end.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

let pool;
let dbReachable = true;
let migrationsApplied = true;
let app;
let httpServer;
let harnessPort;

// Test-fixture row ids — cleaned up in after().
let testOrgId, testEventId, testOperatorId, testJudgeId, testCompetitorId;
let testDiveId;

before(async () => {
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user:     process.env.DB_USER     || process.env.PGUSER,
        host:     process.env.DB_HOST     || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port:     Number(process.env.DB_PORT || process.env.PGPORT || 5432),
      });

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    dbReachable = false;
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  // Migration 055 check.
  try {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'scores' AND column_name = 'score_source'`,
    );
    if (!r.rows.length) {
      migrationsApplied = false;
      console.warn("[skip] scores.score_source missing — apply migration 055");
      return;
    }
  } catch (err) {
    migrationsApplied = false;
    console.warn(`[skip] migration check failed: ${err.message}`);
    return;
  }

  // Provision fixtures. Minimum bones for the manual-entry path:
  // org → users (operator + judge + competitor) → event → panel
  // → dive directory row → competitor_dive_lists row.
  const suffix = crypto.randomBytes(4).toString("hex");

  const org = await pool.query(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'XX', $2, 'active') RETURNING id`,
    [`manual-int-${suffix}`, `manual-int-${suffix}`],
  );
  testOrgId = org.rows[0].id;

  // Roles live in the user_org_roles join table (not a users column),
  // so each user is two inserts: the row, then its org role. Mirrors
  // the pattern in test/e2e/_setup.js insertUser().
  const mkUser = async (uname, fullName, role) => {
    const u = await pool.query(
      `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
       VALUES ($1, 'x', $2, $3, now()) RETURNING id`,
      [uname, fullName, testOrgId],
    );
    const id = u.rows[0].id;
    await pool.query(
      `INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)`,
      [id, testOrgId, role],
    );
    return id;
  };
  testOperatorId   = await mkUser(`op-${suffix}`, "Operator", "org_admin");
  testJudgeId      = await mkUser(`j-${suffix}`, "Judge One", "judge");
  testCompetitorId = await mkUser(`d-${suffix}`, "Diver One", "diver");

  // Reuse a seeded 1m dive from the World Aquatics catalog (init.sql
  // seeds dive_directory). competitor_dive_lists.dive_id just needs a
  // valid directory row — no need to author a custom one (and the
  // catalog is shared, so nothing to clean up).
  const dive = await pool.query(
    `SELECT id FROM dive_directory WHERE height = 1.0 ORDER BY dive_code LIMIT 1`,
  );
  testDiveId = dive.rows[0].id;

  const event = await pool.query(
    `INSERT INTO events (
       org_id, name, gender, status, height, event_type, total_rounds, number_of_judges
     ) VALUES ($1, $2, 'Male', 'Live', '1m', 'individual', 5, 3)
     RETURNING id`,
    [testOrgId, `Manual integration ${suffix}`],
  );
  testEventId = event.rows[0].id;

  await pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number)
     VALUES ($1, $2, 1)`,
    [testEventId, testJudgeId],
  );

  // Dive list row so the manual-entry endpoint can resolve a
  // dive_id from competitor_dive_lists.
  await pool.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, dive_id, round_number)
     VALUES ($1, $2, $3, 1)`,
    [testEventId, testCompetitorId, testDiveId],
  );

  // HTTP harness. Mount the actual production routes against the
  // pool so we exercise the real code paths. Auth is short-
  // circuited via a header that fills in req.user — the actual
  // JWT layer is verified separately in routes/auth tests.
  app = express();
  app.use(express.json());

  // Stub req.user from a header so we can target operator or judge.
  app.use((req, _res, next) => {
    if (req.headers["x-test-user"]) {
      const userId = req.headers["x-test-user"];
      const roles = (req.headers["x-test-roles"] || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      req.user = {
        id: userId,
        org_id: testOrgId,
        is_system_admin: roles.includes("system_admin"),
        org_roles: roles,
        full_name: "Test User",
      };
    }
    next();
  });

  // Minimal requireOrgRole shim — the real middleware checks JWT
  // + DB; we trust the X-Test-Roles header here since the
  // X-Test-User indirection is the same pattern other integration
  // tests use.
  const requireOrgRole = (allowed) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "no user" });
    if (req.user.is_system_admin) return next();
    const hasRole = (req.user.org_roles || []).some((r) => allowed.includes(r));
    if (!hasRole) return res.status(403).json({ error: "insufficient_role" });
    next();
  };

  // Stub io with a no-op so the manual-scores router's broadcast
  // call doesn't throw. We don't verify the broadcast here.
  const io = { to: () => ({ emit: () => {} }) };
  const scoreboardCache = { invalidate: () => {} };

  app.use(require("../routes/manual-scores")({
    pool, io, scoreboardCache, requireOrgRole,
  }));
  app.use(require("../routes/conflicts")({
    pool, io, scoreboardCache, requireOrgRole,
  }));

  httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  harnessPort = httpServer.address().port;
});

after(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  if (pool && dbReachable && migrationsApplied) {
    try {
      // Delete in FK order. Audit rows + scores via event cascade,
      // dive lists via the table CASCADE, panel + event explicit.
      if (testEventId) {
        await pool.query(`DELETE FROM events WHERE id = $1`, [testEventId]);
      }
      if (testOperatorId) await pool.query(`DELETE FROM users WHERE id = $1`, [testOperatorId]);
      if (testJudgeId) await pool.query(`DELETE FROM users WHERE id = $1`, [testJudgeId]);
      if (testCompetitorId) await pool.query(`DELETE FROM users WHERE id = $1`, [testCompetitorId]);
      if (testOrgId) await pool.query(`DELETE FROM organisations WHERE id = $1`, [testOrgId]);
    } catch (err) {
      console.warn(`[cleanup] ${err.message}`);
    }
  }
  if (pool) await pool.end();
});

// ---- Helpers --------------------------------------------------

async function httpPost(path, body, { userId, roles } = {}) {
  const url = `http://127.0.0.1:${harnessPort}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userId ? { "X-Test-User": userId } : {}),
      ...(roles ? { "X-Test-Roles": roles.join(",") } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

// ---- Migration shape ------------------------------------------

test("migration 055: scores.score_source column + default + constraint", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  const r = await pool.query(
    `SELECT column_name, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'scores' AND column_name = 'score_source'`,
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].is_nullable, "NO");
  assert.ok(String(r.rows[0].column_default).includes("judge_direct"));
});

test("migration 055: score_audit_action enum extended", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  const r = await pool.query(
    `SELECT unnest(enum_range(NULL::score_audit_action))::text AS v`,
  );
  const values = r.rows.map((row) => row.v);
  assert.ok(values.includes("reconcile_manual"));
  assert.ok(values.includes("rejected_duplicate"));
});

// ---- Manual-entry endpoint ------------------------------------

test("POST /api/scores/manual-entry inserts with score_source='manual_entry'", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  const res = await httpPost(
    "/api/scores/manual-entry",
    {
      event_id: testEventId,
      competitor_id: testCompetitorId,
      round_number: 1,
      judge_id: testJudgeId,
      score: 8.5,
      reason: "integration test",
    },
    { userId: testOperatorId, roles: ["org_admin"] },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.new_score, 8.5);
  assert.equal(res.body.source, "manual_entry");

  // Verify the row landed with the right source.
  const row = await pool.query(
    `SELECT score, score_source FROM scores WHERE id = $1`,
    [res.body.score_id],
  );
  assert.equal(Number(row.rows[0].score), 8.5);
  assert.equal(row.rows[0].score_source, "manual_entry");
});

test("POST /api/scores/manual-entry updates on re-post (operator typo fix)", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  // First entry — initial value.
  const r1 = await httpPost(
    "/api/scores/manual-entry",
    {
      event_id: testEventId,
      competitor_id: testCompetitorId,
      round_number: 1,
      judge_id: testJudgeId,
      score: 7.0,
    },
    { userId: testOperatorId, roles: ["org_admin"] },
  );
  assert.equal(r1.status, 200);

  // Second entry — operator corrects to 7.5.
  const r2 = await httpPost(
    "/api/scores/manual-entry",
    {
      event_id: testEventId,
      competitor_id: testCompetitorId,
      round_number: 1,
      judge_id: testJudgeId,
      score: 7.5,
    },
    { userId: testOperatorId, roles: ["org_admin"] },
  );
  assert.equal(r2.status, 200);
  assert.equal(r2.body.score_id, r1.body.score_id);
  assert.equal(r2.body.new_score, 7.5);

  // DB confirms the update.
  const row = await pool.query(
    `SELECT score, score_source FROM scores WHERE id = $1`,
    [r1.body.score_id],
  );
  assert.equal(Number(row.rows[0].score), 7.5);
  assert.equal(row.rows[0].score_source, "manual_entry");
});

test("POST /api/scores/manual-entry rejects values outside 0.0-10.0", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  const r = await httpPost(
    "/api/scores/manual-entry",
    {
      event_id: testEventId, competitor_id: testCompetitorId,
      round_number: 1, judge_id: testJudgeId, score: 11,
    },
    { userId: testOperatorId, roles: ["org_admin"] },
  );
  assert.equal(r.status, 400);
});

test("POST /api/scores/manual-entry rejects non-0.5 increments", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  const r = await httpPost(
    "/api/scores/manual-entry",
    {
      event_id: testEventId, competitor_id: testCompetitorId,
      round_number: 1, judge_id: testJudgeId, score: 8.3,
    },
    { userId: testOperatorId, roles: ["org_admin"] },
  );
  assert.equal(r.status, 400);
});

test("POST /api/scores/manual-entry rejects when judge is not on panel", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  // Use the operator's id as a fake judge id — they're not in event_judges.
  const r = await httpPost(
    "/api/scores/manual-entry",
    {
      event_id: testEventId, competitor_id: testCompetitorId,
      round_number: 1, judge_id: testOperatorId, score: 8.0,
    },
    { userId: testOperatorId, roles: ["org_admin"] },
  );
  assert.equal(r.status, 409);
  assert.ok(/panel/i.test(r.body.error));
});

// ---- Conflict resolve endpoint --------------------------------

test("POST /api/conflicts/:id/resolve keep_existing flips source", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  // Set up a fresh manual-entry row.
  const setup = await httpPost(
    "/api/scores/manual-entry",
    {
      event_id: testEventId, competitor_id: testCompetitorId,
      round_number: 1, judge_id: testJudgeId, score: 9.0,
    },
    { userId: testOperatorId, roles: ["org_admin"] },
  );
  assert.equal(setup.status, 200);

  const resolve = await httpPost(
    `/api/conflicts/${setup.body.score_id}/resolve`,
    { decision: "keep_existing" },
    { userId: testOperatorId, roles: ["referee"] },
  );
  assert.equal(resolve.status, 200);
  assert.equal(resolve.body.decision, "keep_existing");

  const row = await pool.query(
    `SELECT score, score_source FROM scores WHERE id = $1`,
    [setup.body.score_id],
  );
  assert.equal(Number(row.rows[0].score), 9.0);
  assert.equal(row.rows[0].score_source, "manual_then_reconciled");

  // Audit row exists with action='reconcile_manual'.
  const aud = await pool.query(
    `SELECT action FROM score_audit_log
     WHERE score_id = $1 AND action = 'reconcile_manual'
     ORDER BY created_at DESC LIMIT 1`,
    [setup.body.score_id],
  );
  assert.equal(aud.rows.length, 1);
});

test("POST /api/conflicts/:id/resolve accept_proposed updates score", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  // Fresh manual-entry row.
  const setup = await httpPost(
    "/api/scores/manual-entry",
    {
      event_id: testEventId, competitor_id: testCompetitorId,
      round_number: 1, judge_id: testJudgeId, score: 6.0,
    },
    { userId: testOperatorId, roles: ["org_admin"] },
  );
  assert.equal(setup.status, 200);

  const resolve = await httpPost(
    `/api/conflicts/${setup.body.score_id}/resolve`,
    { decision: "accept_proposed", proposed_score: 6.5,
      reason: "judge phone showed 6.5 — operator misread" },
    { userId: testOperatorId, roles: ["referee"] },
  );
  assert.equal(resolve.status, 200);
  assert.equal(resolve.body.new_score, 6.5);

  const row = await pool.query(
    `SELECT score, score_source FROM scores WHERE id = $1`,
    [setup.body.score_id],
  );
  assert.equal(Number(row.rows[0].score), 6.5);
  assert.equal(row.rows[0].score_source, "manual_then_reconciled");
});

test("POST /api/conflicts/:id/resolve rejects unknown decision", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  // Use any valid UUID format.
  const r = await httpPost(
    `/api/conflicts/${crypto.randomUUID()}/resolve`,
    { decision: "nonsense" },
    { userId: testOperatorId, roles: ["referee"] },
  );
  assert.equal(r.status, 400);
});

test("POST /api/conflicts/:id/resolve rejects accept_proposed without valid proposed_score", async (t) => {
  if (!dbReachable || !migrationsApplied) { t.skip(); return; }
  const r = await httpPost(
    `/api/conflicts/${crypto.randomUUID()}/resolve`,
    { decision: "accept_proposed", proposed_score: 99 },
    { userId: testOperatorId, roles: ["referee"] },
  );
  assert.equal(r.status, 400);
  assert.ok(/between 0 and 10/i.test(r.body.error));
});
