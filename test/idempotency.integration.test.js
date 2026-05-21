// Integration tests for lib/idempotency.js against a live Postgres.
//
// Verifies the bits the mock-pool unit tests can't:
//
//   * Migration 054 actually applied (idempotency_keys table
//     exists with the expected columns + indexes).
//   * pg's bytea ↔ Buffer round-trip works for request_hash.
//   * Owner + payload guards function against real rows.
//   * Sweeper's `created_at < now() - interval` clause matches the
//     row we expect.
//   * httpMiddleware behaves correctly when bolted onto a real
//     Express app talking to the real pool.
//
// Skips (doesn't fail) when:
//   * Postgres isn't reachable (mirrors test/integration.test.js).
//   * Migration 054 hasn't been applied to divinghq_test — the
//     CREATE TABLE check at boot time catches this with a clear
//     console warning. CI applies all migrations via init.sql +
//     scripts/migrate.js before running tests, so this should
//     only skip on stale dev databases.
//
// CI sets PG* env vars in .github/workflows/ci.yml. Local devs
// either set them or accept that this test skips.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const createIdempotency = require("../lib/idempotency");
const { hashPayload } = createIdempotency;
const sweeper = require("../lib/idempotency-sweeper");

let pool;
let dbReachable = true;
let migrationApplied = true;
let idem;
let testUserId;

// HTTP harness for the middleware test.
let httpServer;
let harnessPort;

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

  // Migration 054 check. If the table is missing we skip every
  // test rather than reporting confusing column-not-found errors.
  try {
    const r = await pool.query(
      `SELECT to_regclass('public.idempotency_keys') AS exists`,
    );
    if (!r.rows[0]?.exists) {
      migrationApplied = false;
      console.warn("[skip] idempotency_keys table missing — apply migration 054");
      return;
    }
  } catch (err) {
    migrationApplied = false;
    console.warn(`[skip] migration check failed: ${err.message}`);
    return;
  }

  idem = createIdempotency({ pool });

  // Provision a throwaway user row so foreign-key references are
  // valid. Cheapest path: insert a row with the bare minimum NOT
  // NULL columns. Cleaned up in after().
  const u = await pool.query(
    `INSERT INTO users (id, username, password, full_name, org_id)
     VALUES (gen_random_uuid(), $1, 'x', 'Idempotency Integration', NULL)
     RETURNING id`,
    [`idem-int-${crypto.randomBytes(4).toString("hex")}`],
  );
  testUserId = u.rows[0].id;

  // HTTP harness for the middleware test. A bare Express app with
  // one route guarded by httpMiddleware. We simulate auth by
  // setting req.user manually in a pre-middleware.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-test-user"]) {
      req.user = { id: req.headers["x-test-user"] };
    }
    next();
  });
  app.post("/test/echo",
    idem.httpMiddleware("test_echo"),
    (req, res) => {
      res.json({ ok: true, echoed: req.body, randomId: crypto.randomUUID() });
    },
  );
  httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  harnessPort = httpServer.address().port;
});

after(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  sweeper.stop();
  if (pool && dbReachable && migrationApplied) {
    // Clean up our test rows. The user row goes last because the
    // idempotency_keys rows reference it via FK ON DELETE SET NULL,
    // so order doesn't strictly matter — but explicit is cheap.
    try {
      await pool.query(`DELETE FROM idempotency_keys WHERE user_id = $1`, [testUserId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    } catch { /* ignore cleanup failures */ }
  }
  if (pool) await pool.end();
});

// ---- Migration shape ------------------------------------------

test("migration 054: idempotency_keys table has the expected columns", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const r = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'idempotency_keys'
     ORDER BY ordinal_position`,
  );
  const cols = Object.fromEntries(r.rows.map((row) => [row.column_name, row]));
  for (const expected of [
    "idempotency_key", "user_id", "action_type", "request_hash",
    "response_status", "response_body", "created_at",
  ]) {
    assert.ok(cols[expected], `column ${expected} missing`);
  }
  assert.equal(cols.request_hash.data_type, "bytea");
  assert.equal(cols.response_body.data_type, "jsonb");
});

test("migration 054: score_audit_log gained actor_local_time + server_committed_at", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'score_audit_log'
       AND column_name IN ('actor_local_time', 'server_committed_at')`,
  );
  const names = r.rows.map((row) => row.column_name).sort();
  assert.deepEqual(names, ["actor_local_time", "server_committed_at"]);
});

test("migration 054: event_status enum includes pending_signoff", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const r = await pool.query(
    `SELECT unnest(enum_range(NULL::event_status))::text AS v`,
  );
  const values = r.rows.map((row) => row.v);
  assert.ok(values.includes("pending_signoff"),
    `event_status should include 'pending_signoff', got ${JSON.stringify(values)}`);
});

// ---- socketStore + socketCheck round-trip ---------------------

test("socketStore persists and socketCheck retrieves", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const key = crypto.randomUUID();
  const payload = { score: 8.5, dive: "107B" };
  const hash = hashPayload(payload);

  idem.socketStore(key, testUserId, "test_action", hash, 200, { ok: true, score_id: "abc" });
  // Fire-and-forget; wait for the insert to land.
  await new Promise((r) => setTimeout(r, 100));

  const cached = await idem.socketCheck(key, testUserId, hash);
  assert.ok(cached, "cache hit expected");
  assert.equal(cached.response_status, 200);
  assert.deepEqual(cached.response_body, { ok: true, score_id: "abc" });
});

test("socketCheck returns 403 error for different user", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const key = crypto.randomUUID();
  const hash = hashPayload({ x: 1 });
  idem.socketStore(key, testUserId, "test_action", hash, 200, { ok: true });
  await new Promise((r) => setTimeout(r, 100));

  const otherUser = crypto.randomUUID();
  const result = await idem.socketCheck(key, otherUser, hash);
  assert.equal(result.error, "key_belongs_to_different_user");
  assert.equal(result.status, 403);
});

test("socketCheck returns 422 error for same key, different payload", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const key = crypto.randomUUID();
  const hashA = hashPayload({ score: 8.0 });
  const hashB = hashPayload({ score: 8.5 });
  idem.socketStore(key, testUserId, "test_action", hashA, 200, { ok: true });
  await new Promise((r) => setTimeout(r, 100));

  const result = await idem.socketCheck(key, testUserId, hashB);
  assert.equal(result.error, "key_reused_with_different_payload");
  assert.equal(result.status, 422);
});

// ---- HTTP middleware round-trip --------------------------------

function harnessRequest({ method = "POST", path = "/test/echo", body = {}, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      method, hostname: "127.0.0.1", port: harnessPort, path,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

test("httpMiddleware: replay returns identical body + X-Idempotent header", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const key = crypto.randomUUID();
  const body = { something: "echo me" };
  const headers = {
    "X-Idempotency-Key": key,
    "X-Test-User": testUserId,
  };

  const first = await harnessRequest({ body, headers });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.echoed.something, "echo me");

  // Wait for the fire-and-forget cache write to land.
  await new Promise((r) => setTimeout(r, 150));

  const second = await harnessRequest({ body, headers });
  assert.equal(second.status, 200);
  assert.equal(second.headers["x-idempotent"], "replay");
  // randomId is generated per-request, so an identical-bodied
  // replay proves the response came from the cache, not a fresh
  // handler invocation.
  assert.equal(second.body.randomId, first.body.randomId);
});

test("httpMiddleware: reusing key with different body returns 422", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const key = crypto.randomUUID();
  const headers = {
    "X-Idempotency-Key": key,
    "X-Test-User": testUserId,
  };

  const first = await harnessRequest({ body: { x: 1 }, headers });
  assert.equal(first.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  const second = await harnessRequest({ body: { x: 2 }, headers });
  assert.equal(second.status, 422);
  assert.ok(second.body.error.includes("different payload"));
});

test("httpMiddleware: invalid UUID v4 returns 400 without a DB write", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const before = await pool.query(`SELECT count(*)::int AS n FROM idempotency_keys`);
  const r = await harnessRequest({
    body: {},
    headers: {
      "X-Idempotency-Key": "not-a-uuid",
      "X-Test-User": testUserId,
    },
  });
  assert.equal(r.status, 400);
  const after = await pool.query(`SELECT count(*)::int AS n FROM idempotency_keys`);
  assert.equal(after.rows[0].n, before.rows[0].n,
    "no cache row should land for an invalid key");
});

// ---- Sweeper --------------------------------------------------

test("sweeper.sweep deletes rows older than 72 hours", async (t) => {
  if (!dbReachable || !migrationApplied) { t.skip(); return; }
  const oldKey = crypto.randomUUID();
  const newKey = crypto.randomUUID();
  await pool.query(
    `INSERT INTO idempotency_keys
       (idempotency_key, user_id, action_type, request_hash, response_status, response_body, created_at)
     VALUES
       ($1, $2, 'sweep_old', $3, 200, '{}'::jsonb, now() - interval '73 hours'),
       ($4, $5, 'sweep_new', $6, 200, '{}'::jsonb, now())`,
    [oldKey, testUserId, hashPayload({}), newKey, testUserId, hashPayload({ new: true })],
  );

  sweeper.start({ pool, intervalMs: 999999999 });
  // The initial sweep fires from start(); wait for it.
  await new Promise((r) => setTimeout(r, 200));
  sweeper.stop();

  const r = await pool.query(
    `SELECT idempotency_key FROM idempotency_keys WHERE idempotency_key IN ($1, $2)`,
    [oldKey, newKey],
  );
  const remaining = r.rows.map((row) => row.idempotency_key);
  assert.ok(!remaining.includes(oldKey), "old row should have been swept");
  assert.ok(remaining.includes(newKey), "new row should remain");
});
