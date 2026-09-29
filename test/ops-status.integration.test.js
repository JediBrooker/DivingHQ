// GET /api/ops/status over HTTP (routes/ops-status.js): the shape the
// monitor relies on, the no-store header, what happens with the state
// files present, missing or garbled, a database that's down or hung
// (still a 200, ok false), and the 5xx tally from lib/request-window.js.
//
// The "database up" case talks to the real test database and skips when
// Postgres isn't reachable. The rest use a stand-in pool, so they run
// anywhere.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config({ quiet: true });

const createOpsStatusRouter = require("../routes/ops-status");
const { createRequestWindow } = require("../lib/request-window");

let pool;
let dbReachable = true;
let liveVersion = null;
const servers = [];
const dirs = [];

before(async () => {
  require("./support/test-db").assertTestDatabase();
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
    liveVersion = (await pool.query("SELECT version FROM public.schema_meta WHERE id = 1")).rows[0].version;
  } catch (err) {
    dbReachable = false;
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
  }
});

after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (pool) await pool.end();
});

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dhq-opsstatus-"));
  dirs.push(d);
  return d;
}

// The same order server.js uses: the window goes on first, then the
// router, and a couple of extra routes to have something to fail.
async function serve({ pool: p, stateDir, requestWindow = createRequestWindow({ minutes: 15 }), dbTimeoutMs }) {
  const app = express();
  app.use(requestWindow.middleware);
  app.use(createOpsStatusRouter({ pool: p, requestWindow, stateDir, dbTimeoutMs }));
  app.get("/boom", (_req, res) => res.status(500).json({ error: "boom" }));
  app.get("/unavailable", (_req, res) => res.status(503).end());
  app.get("/fine", (_req, res) => res.json({ ok: true }));
  app.get("/throws", () => { throw new Error("handler blew up"); });
  // Stands in for server.js's last-stop handler, which turns that throw
  // into a 500 too (Express's default one would print the stack here).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: "server error" }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async (p2) => {
      const r = await fetch(base + p2);
      await r.text();
      return r.status;
    },
    status: async () => {
      const r = await fetch(base + "/api/ops/status");
      return { status: r.status, headers: r.headers, body: await r.json() };
    },
  };
}

const deadPool = { query: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:5432 for role diving_app"); } };
const hungPool = { query: () => new Promise(() => {}) };

function assertShape(body) {
  assert.deepEqual(Object.keys(body).sort(),
    ["backup", "deploy", "errors", "ok", "restore_check", "schema_version", "time"]);
  assert.deepEqual(Object.keys(body.backup).sort(),
    ["last_attempt_at", "last_ok", "last_success_at", "offsite", "size_bytes"]);
  assert.deepEqual(Object.keys(body.restore_check).sort(), ["last_run_at", "ok"]);
  assert.deepEqual(Object.keys(body.deploy).sort(), ["last_at", "ok", "sha"]);
  assert.deepEqual(Object.keys(body.errors).sort(), ["requests", "server_errors", "window_minutes"]);
  assert.equal(body.errors.window_minutes, 15);
  assert.ok(!Number.isNaN(Date.parse(body.time)));
}

test("database up: ok, the live schema version, no-store, nulls with no state files", async (t) => {
  if (!dbReachable) { t.skip("Postgres not reachable"); return; }
  const app = await serve({ pool, stateDir: tmpDir() });
  const r = await app.status();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-type"), /application\/json/);
  assertShape(r.body);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.schema_version, liveVersion);
  assert.deepEqual(r.body.backup, { last_attempt_at: null, last_success_at: null, last_ok: null, offsite: null, size_bytes: null });
  assert.deepEqual(r.body.restore_check, { last_run_at: null, ok: null });
  assert.deepEqual(r.body.deploy, { last_at: null, ok: null, sha: null });
});

test("database down: still a 200, ok false, and none of the error text", async () => {
  const app = await serve({ pool: deadPool, stateDir: tmpDir() });
  const r = await app.status();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assertShape(r.body);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.schema_version, null);
  const text = JSON.stringify(r.body);
  for (const leak of ["ECONNREFUSED", "10.1.2.3", "diving_app"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

test("a hung database times out into ok false instead of hanging the monitor", async () => {
  const app = await serve({ pool: hungPool, stateDir: tmpDir(), dbTimeoutMs: 150 });
  const started = Date.now();
  const r = await app.status();
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.ok(Date.now() - started < 2000, "answered promptly");
});

test("state files present are reported, garbage and missing ones read as null", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "backup.json"), JSON.stringify({
    last_attempt_at: "2026-09-29T16:30:00Z",
    last_success_at: "2026-09-28T16:30:00Z",
    last_ok: false,
    offsite: "failed",
    size_bytes: 69738696,
    note: "/var/backups/divinghq is 98% full",
  }));
  fs.writeFileSync(path.join(dir, "deploy.json"),
    JSON.stringify({ last_at: "2026-09-29T02:00:00Z", ok: true, sha: "532356670d1b5a61a27100e0905e3e5c10f2ae44" }));
  fs.writeFileSync(path.join(dir, "restore-check.json"), "\u0000\u0001 definitely not json");

  const app = await serve({ pool: deadPool, stateDir: dir });
  const r = await app.status();
  assert.equal(r.status, 200);
  assertShape(r.body);
  assert.deepEqual(r.body.backup, {
    last_attempt_at: "2026-09-29T16:30:00.000Z",
    last_success_at: "2026-09-28T16:30:00.000Z",
    last_ok: false,
    offsite: "failed",
    size_bytes: 69738696,
  });
  assert.deepEqual(r.body.deploy, { last_at: "2026-09-29T02:00:00.000Z", ok: true, sha: "5323566" });
  assert.deepEqual(r.body.restore_check, { last_run_at: null, ok: null });
  assert.ok(!JSON.stringify(r.body).includes("/var/backups"), "extra fields never pass through");

  // The files are read on each call, a new run shows up straight away.
  fs.writeFileSync(path.join(dir, "restore-check.json"), JSON.stringify({ last_run_at: "2026-09-27T17:30:00Z", ok: true }));
  fs.rmSync(path.join(dir, "deploy.json"));
  const again = (await app.status()).body;
  assert.deepEqual(again.restore_check, { last_run_at: "2026-09-27T17:30:00.000Z", ok: true });
  assert.deepEqual(again.deploy, { last_at: null, ok: null, sha: null });
});

test("the error window counts 5xx and total responses", async () => {
  const app = await serve({ pool: deadPool, stateDir: tmpDir() });
  const first = (await app.status()).body.errors;
  assert.deepEqual(first, { window_minutes: 15, server_errors: 0, requests: 0 });

  await app.get("/fine");
  await app.get("/fine");
  await app.get("/boom");
  await app.get("/unavailable");
  await app.get("/throws");
  await app.get("/no-such-route"); // 404, counted but not an error

  // The first status call counts as a response too: 1 + 6.
  const second = (await app.status()).body.errors;
  assert.deepEqual(second, { window_minutes: 15, server_errors: 3, requests: 7 });
});
