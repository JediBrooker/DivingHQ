// routes/sessions.js write paths that share the block wire shape and
// the meet-edit gates: PUT /api/blocks/:id (via requireBlockEdit),
// POST /api/sessions/:id/duplicate (via requireSessionEdit), and the
// dismiss / undismiss pair (both broadcast through safeEmit). Pins the
// refusals, the block shape each returns, and the socket events.
//
// Skips when Postgres isn't reachable.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const BLOCK_KEYS = [
  "id", "session_id", "block_type", "label", "starts_at", "ends_at", "board_ids", "event_id",
  "actual_start_at", "actual_end_at", "notes", "created_at", "updated_at",
  "event_name", "event_height",
].sort();

let pool;
let dbReachable = true;
let server;
let port;
const ids = { orgs: [], users: [], meets: [] };
const emitted = [];
let editor, outsider, sessionId, blockA, blockB;
let actAs;

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

  const sfx = crypto.randomBytes(4).toString("hex");
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0].id;
  const org = await one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'SRA', $1, 'active') RETURNING id`, [`schedroutes-a-${sfx}`]);
  const otherOrg = await one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'SRB', $1, 'active') RETURNING id`, [`schedroutes-b-${sfx}`]);
  ids.orgs.push(org, otherOrg);
  const mkUser = (name, orgId) => one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', $1, $2, now()) RETURNING id`, [`${name}-${sfx}`, orgId]);
  const editorId = await mkUser("sched-editor", org);
  const outsiderId = await mkUser("sched-outsider", otherOrg);
  ids.users.push(editorId, outsiderId);
  editor   = { id: editorId, org_id: org, org_roles: ["meet_manager"], is_system_admin: false };
  outsider = { id: outsiderId, org_id: otherOrg, org_roles: ["meet_manager"], is_system_admin: false };

  const meet = await one(
    "INSERT INTO meets (org_id, name) VALUES ($1, $2) RETURNING id", [org, `Sched meet ${sfx}`]);
  ids.meets.push(meet);
  sessionId = await one(
    `INSERT INTO sessions (meet_id, name, session_date, pool)
     VALUES ($1, 'Day 1', '2026-10-01', 'Main') RETURNING id`, [meet]);
  const mkBlock = (label, from, to) => one(
    `INSERT INTO schedule_blocks (session_id, block_type, label, starts_at, ends_at, notes)
     VALUES ($1, 'custom', $2, $3, $4, 'n') RETURNING id`, [sessionId, label, from, to]);
  blockA = await mkBlock("Warm up", "2026-10-01T08:00:00Z", "2026-10-01T09:00:00Z");
  blockB = await mkBlock("Ceremony", "2026-10-01T09:00:00Z", "2026-10-01T09:30:00Z");

  const pass = (_req, _res, next) => next();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actAs; next(); });
  app.use(require("../routes/sessions")({
    pool,
    optionalAuth: pass,
    requireMeetEditor: pass,
    io: { emit: (name, payload) => emitted.push({ name, payload }) },
  }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool && dbReachable) {
    try {
      await pool.query("DELETE FROM meets WHERE id = ANY($1::uuid[])", [ids.meets]);
      await pool.query("DELETE FROM audit_log WHERE org_id = ANY($1::uuid[])", [ids.orgs]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids.users]);
      await pool.query("DELETE FROM organisations WHERE id = ANY($1::uuid[])", [ids.orgs]);
    } catch (err) {
      console.warn(`[cleanup] ${err.message}`);
    }
  }
  if (pool) await pool.end();
});

async function call(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test("PUT /api/blocks/:id: 404, 403 for another org, then the block shape", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  actAs = editor;
  assert.deepEqual(await call("PUT", `/api/blocks/${crypto.randomUUID()}`, { label: "x" }),
    { status: 404, body: { error: "Block not found" } });
  actAs = outsider;
  assert.deepEqual(await call("PUT", `/api/blocks/${blockA}`, { label: "x" }),
    { status: 403, body: { error: "You cannot edit this meet schedule" } });
  actAs = editor;
  const r = await call("PUT", `/api/blocks/${blockA}`, { label: "Warm up (moved)" });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.block).sort(), BLOCK_KEYS);
  assert.equal(r.body.block.label, "Warm up (moved)");
  assert.ok(Array.isArray(r.body.conflicts));
  assert.deepEqual(emitted.at(-1).name, "schedule:block_updated");
});

test("POST /api/sessions/:id/duplicate: refusals, then a shifted copy", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  actAs = editor;
  assert.deepEqual(await call("POST", `/api/sessions/${crypto.randomUUID()}/duplicate`, { target_date: "2026-10-02" }),
    { status: 404, body: { error: "Session not found" } });
  actAs = outsider;
  assert.deepEqual(await call("POST", `/api/sessions/${sessionId}/duplicate`, { target_date: "2026-10-02" }),
    { status: 403, body: { error: "You cannot edit this meet schedule" } });
  actAs = editor;
  // The day delta is worked out from session_date as node-postgres hands
  // it back, a local-midnight Date, so the exact shift depends on the
  // server's TZ (reported separately). Only TZ-independent facts here:
  // both blocks move by the same whole number of days.
  const r = await call("POST", `/api/sessions/${sessionId}/duplicate`, { target_date: "2026-10-05" });
  assert.equal(r.status, 201);
  const { session } = r.body;
  assert.equal(session.name, "Day 1");
  assert.equal(session.pool, "Main");
  assert.equal(session.blocks.length, 2);
  for (const b of session.blocks) assert.deepEqual(Object.keys(b).sort(), BLOCK_KEYS);
  const shift = session.blocks.map((b, i) =>
    Date.parse(b.starts_at) - Date.parse(["2026-10-01T08:00:00Z", "2026-10-01T09:00:00Z"][i]));
  assert.equal(shift[0], shift[1]);
  assert.ok(shift[0] > 0 && shift[0] % 86_400_000 === 0, `whole days, got ${shift[0]}`);
  assert.deepEqual(session.blocks.map((b) => b.label), ["Warm up (moved)", "Ceremony"]);
  assert.equal(emitted.at(-1).name, "schedule:session_duplicated");
  assert.equal(emitted.at(-1).payload.source_session_id, sessionId);
});

test("dismiss then undismiss both broadcast schedule:conflict_dismissed", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  actAs = editor;
  const d = await call("POST", "/api/conflicts/dismiss",
    { block_a_id: blockA, block_b_id: blockB, resource_kind: "board", reason: "fine" });
  assert.equal(d.status, 200);
  assert.deepEqual(emitted.at(-1), {
    name: "schedule:conflict_dismissed",
    payload: { meet_id: ids.meets[0], action: "dismiss" },
  });
  const u = await call("DELETE", `/api/conflicts/dismiss/${d.body.dismissal.id}`);
  assert.equal(u.status, 200);
  assert.equal(u.body.message, "Dismissal removed");
  assert.deepEqual(emitted.at(-1), {
    name: "schedule:conflict_dismissed",
    payload: { meet_id: ids.meets[0], action: "undismiss" },
  });
});
