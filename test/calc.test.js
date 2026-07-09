// World Aquatics scoring tests, exercises the SQL functions
// calc_dive_points and calc_synchro_dive_points against a live
// Postgres connection. The functions are pure and deterministic,
// so we use known World Aquatics-rule examples and assert exact outputs.
//
// Connection: prefers the app's own DB_* env vars (the ones
// .env.example documents) and falls back to libpq's PG* names so
// CI's Postgres service container keeps working unchanged. Empty
// new Pool() would only see PG* though, that's a gotcha on a dev
// box where .env has DB_* and the password looks "set" but the
// Pool gets undefined and pg throws a confusing SASL error.
// dotenv loaded so the local .env actually reaches us.

require("dotenv").config();
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      user:     process.env.DB_USER     || process.env.PGUSER,
      host:     process.env.DB_HOST     || process.env.PGHOST,
      database: process.env.DB_DATABASE || process.env.PGDATABASE,
      password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
      port:     process.env.DB_PORT     || process.env.PGPORT,
    });
let dbReachable = true;

before(async () => {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    dbReachable = false;
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
  }
});

after(async () => {
  await pool.end();
});

// Helper: run a calc query and return the numeric result.
async function diveValue(scores, numJudges, dd) {
  const r = await pool.query("SELECT calc_dive_points($1, $2, $3) AS v", [
    scores,
    numJudges,
    dd,
  ]);
  return Number(r.rows[0].v);
}

async function synchroValue(judgeNumbers, scores, numJudges, dd) {
  const r = await pool.query(
    "SELECT calc_synchro_dive_points($1, $2, $3, $4) AS v",
    [judgeNumbers, scores, numJudges, dd],
  );
  return Number(r.rows[0].v);
}

// ─────────────────────────────────────────────────────────────
// calc_dive_points: individual events
// ─────────────────────────────────────────────────────────────

test("calc_dive_points: 5 judges, drop high+low", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  // Scores [5, 6, 7, 8, 9], drop 5 + 9, keep [6,7,8] = 21, × DD 2.0 = 42
  const v = await diveValue([5, 6, 7, 8, 9], 5, 2.0);
  assert.equal(v, 42);
});

test("calc_dive_points: 7 judges, drop 2 high + 2 low", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  // Scores [4,5,6,7,8,9,10], drop 4,5,9,10, keep [6,7,8] = 21, × DD 3.0 = 63
  const v = await diveValue([4, 5, 6, 7, 8, 9, 10], 7, 3.0);
  assert.equal(v, 63);
});

test("calc_dive_points: 9 judges, drop 2+2, × 0.6 normalisation", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  // Scores 1..9, drop 1,2,8,9, keep [3,4,5,6,7] = 25, × DD 2.0 = 50, × 0.6 = 30
  const v = await diveValue([1, 2, 3, 4, 5, 6, 7, 8, 9], 9, 2.0);
  assert.equal(v, 30);
});

test("calc_dive_points: 11 judges, drop 3+3, × 0.6", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  // All 7s, drop 3 highest + 3 lowest (still 7s), keep middle 5 = 35, × DD 2.0 × 0.6 = 42
  const v = await diveValue([7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7], 11, 2.0);
  assert.equal(v, 42);
});

test("calc_dive_points: 3 judges, no drops", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  // Scores [6, 7, 8], keep all = 21, × DD 1.5 = 31.5
  const v = await diveValue([6, 7, 8], 3, 1.5);
  assert.equal(v, 31.5);
});

test("calc_dive_points: empty scores returns 0", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  const v = await diveValue([], 5, 2.0);
  assert.equal(v, 0);
});

// ─────────────────────────────────────────────────────────────
// calc_synchro_dive_points: synchronised pairs
// ─────────────────────────────────────────────────────────────

test("synchro: 9-judge panel, cancel hi+lo exec across both divers, drop hi+lo sync", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  // WA Article 9.1.5.4: judges 1-2 score Diver A exec, 3-4 Diver B,
  // 5-9 sync. Execution is cancelled BETWEEN BOTH Athletes, so pool
  // the four exec marks, drop one high + one low, keep the middle two.
  // Exec pool: [7,8,7,8] → sorted [7,7,8,8] → drop 7 + 8 → keep 7+8 = 15
  // Sync: [5,6,7,8,9] → drop 5+9 → 6+7+8 = 21
  // Sum = 36, × DD 2.0 × 0.6 = 43.2
  const v = await synchroValue(
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    [7, 8, 7, 8, 5, 6, 7, 8, 9],
    9,
    2.0,
  );
  assert.equal(v, 43.2);
});

test("synchro: 7-judge panel, cancel hi+lo exec across both divers, keep all 3 sync", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  // Judges 1-2 score Diver A exec, 3-4 score Diver B, 5-7 sync.
  // The 7-judge panel mirrors the 9-judge execution rule (it has the
  // same 2+2 layout): pool the four exec marks, drop 1 high + 1 low,
  // keep the middle 2. The 3 sync marks are all kept. Five counted
  // marks keep the panel on the same × 0.6 scale as the 9/11-judge.
  // Exec pool: [7,8,6,7] → sorted [6,7,7,8] → drop 6 + 8 → keep 7+7 = 14
  // Sync: 5+7+9 = 21
  // Sum = 35, × DD 2.0 × 0.6 = 42.0
  const v = await synchroValue(
    [1, 2, 3, 4, 5, 6, 7],
    [7, 8, 6, 7, 5, 7, 9],
    7,
    2.0,
  );
  assert.equal(v, 42.0);
});

test("synchro: 11-judge panel, middle 1 of 3 exec, middle 3 of 5 sync", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  // Judges 1-3 exec A, 4-6 exec B, 7-11 sync.
  // Exec A: [6,7,8] → middle = 7
  // Exec B: [5,6,7] → middle = 6
  // Sync: [4,5,6,7,8] → drop 4+8 → 5+6+7 = 18
  // Sum = 31, × DD 3.0 × 0.6 = 55.8
  const v = await synchroValue(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    [6, 7, 8, 5, 6, 7, 4, 5, 6, 7, 8],
    11,
    3.0,
  );
  assert.equal(v, 55.8);
});

test("synchro: empty scores returns 0", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  const v = await synchroValue([], [], 9, 2.0);
  assert.equal(v, 0);
});

// ─────────────────────────────────────────────────────────────
// schema_meta + purge_audit_logs: operational sanity
// ─────────────────────────────────────────────────────────────

test("schema_meta is populated", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  const r = await pool.query("SELECT version FROM schema_meta WHERE id = 1");
  assert.ok(r.rows[0]?.version >= 15, `expected schema version ≥ 15, got ${r.rows[0]?.version}`);
});

test("purge_audit_logs returns per-table counts", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  const r = await pool.query("SELECT * FROM purge_audit_logs(99999)");
  // 99999-day window means nothing should be deleted on a typical
  // test database. We just assert the function returns the
  // documented shape (three rows, after migration 032 added
  // audit_log alongside the existing two).
  const tables = r.rows.map((row) => row.table_name).sort();
  assert.deepEqual(tables, ["audit_log", "role_audit_log", "score_audit_log"]);
  for (const row of r.rows) {
    assert.equal(typeof row.deleted_rows, "string", "row counts come back as bigint strings");
  }
});
