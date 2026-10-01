// A referee sign-off request that ran out isn't a pending one.
//
// Nothing flips referee_signoff_requests.status to 'expired' when a
// request's five minutes pass, the row stays 'pending' until something
// else touches it. The event readiness checklist (lib/workflow.js, the
// Control Room's setup stage), the operator's dashboard and the meet
// readiness report all read any pending row as "Waiting for <referee>",
// so an event said that for good once a request lapsed, and the operator
// had no hint they should just send another. They share one definition
// now (lib/signoff-sql.js). This checks every one of them, plus the
// referee's own desk, against an event whose only request lapsed and one
// whose request is still live.
//
// Skips when Postgres isn't reachable.

process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const { getEventReadiness } = require("../lib/workflow");

let pool;
let dbReachable = true;
let server;
let port;
let caller = null;
const ids = { orgs: [], users: [], events: [], meets: [] };
let org, operator, lapsedRef, liveRef, meetId;
let lapsedEvent, liveEvent, mixedEvent;
const LAPSED_NAME = "Lapsed Referee";
const LIVE_NAME = "Live Referee";

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
  org = await one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'SGA', $1, 'active') RETURNING id`, [`signoff-pending-${sfx}`]);
  ids.orgs.push(org);
  const mkUser = (username, name) => one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', $2, $3, now()) RETURNING id`, [username, name, org]);
  operator = await mkUser(`sp-op-${sfx}`, "Operator");
  lapsedRef = await mkUser(`sp-lapsed-${sfx}`, LAPSED_NAME);
  liveRef = await mkUser(`sp-live-${sfx}`, LIVE_NAME);
  ids.users.push(operator, lapsedRef, liveRef);
  for (const ref of [lapsedRef, liveRef]) {
    await pool.query(
      "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'referee')", [ref, org]);
  }

  meetId = await one(
    "INSERT INTO meets (org_id, name) VALUES ($1, $2) RETURNING id", [org, `Signoff pending ${sfx}`]);
  ids.meets.push(meetId);

  // Checked in and drawn, so the referee's sign-off is the step in play.
  const mkEvent = (name) => one(
    `INSERT INTO events (org_id, meet_id, name, gender, status, height, event_type, total_rounds,
                         number_of_judges, scheduled_at, check_in_done_at, dive_order_randomised_at)
     VALUES ($1, $2, $3, 'Mixed', 'Upcoming', '3m', 'individual', 3, 5, now() + interval '1 day',
             now(), now()) RETURNING id`,
    [org, meetId, name]);
  lapsedEvent = await mkEvent(`Lapsed ${sfx}`);
  liveEvent = await mkEvent(`Live ${sfx}`);
  mixedEvent = await mkEvent(`Mixed ${sfx}`);
  ids.events.push(lapsedEvent, liveEvent, mixedEvent);

  // Rows written straight in, the way they sit in the table after nobody
  // touched them: still 'pending', expires_at wherever the clock left it.
  const ask = (eventId, ref, expires, createdAgo) => pool.query(
    `INSERT INTO referee_signoff_requests (event_id, requested_by, target_referee_id, expires_at, created_at)
     VALUES ($1, $2, $3, now() + $4::interval, now() - $5::interval)`,
    [eventId, operator, ref, expires, createdAgo]);
  await ask(lapsedEvent, lapsedRef, "-1 minute", "6 minutes");
  await ask(liveEvent, liveRef, "4 minutes", "1 minute");
  // An old request that lapsed and a newer live one to someone else. The
  // newer one is who we're waiting on.
  await ask(mixedEvent, lapsedRef, "-10 minutes", "15 minutes");
  await ask(mixedEvent, liveRef, "4 minutes", "1 minute");

  const pass = (_req, _res, next) => next();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = caller === "lapsedRef" || caller === "liveRef"
      ? { id: caller === "liveRef" ? liveRef : lapsedRef, org_id: org, is_system_admin: false, org_roles: ["referee"] }
      : { id: operator, org_id: org, is_system_admin: false, org_roles: ["meet_manager"] };
    next();
  });
  app.use(require("../routes/dashboard")({ pool, verifyToken: pass }));
  app.use(require("../routes/meets")({
    pool,
    requireMeetEditor: pass,
    requireEventManager: () => pass,
  }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool && dbReachable) {
    try {
      await pool.query("DELETE FROM referee_signoff_requests WHERE event_id = ANY($1::uuid[])", [ids.events]);
      await pool.query("DELETE FROM events WHERE id = ANY($1::uuid[])", [ids.events]);
      await pool.query("DELETE FROM meets WHERE id = ANY($1::uuid[])", [ids.meets]);
      await pool.query("DELETE FROM user_org_roles WHERE user_id = ANY($1::uuid[])", [ids.users]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids.users]);
      await pool.query("DELETE FROM organisations WHERE id = ANY($1::uuid[])", [ids.orgs]);
    } catch (err) {
      console.warn(`[cleanup] ${err.message}`);
    }
  }
  if (pool) await pool.end();
});

async function get(as, path) {
  caller = as;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

function signoffHint(readiness) {
  return readiness.steps.find((s) => s.key === "sign_off").hint;
}

// What every readiness-shaped surface should say about the three events.
function assertSignoffState(byEvent, surface) {
  const lapsed = byEvent(lapsedEvent);
  const live = byEvent(liveEvent);
  const mixed = byEvent(mixedEvent);
  assert.ok(lapsed && live && mixed, `${surface}: all three events listed`);

  assert.equal(lapsed.pending_signoff_referee_name, null,
    `${surface}: a lapsed request isn't one anyone's waiting on`);
  assert.equal(signoffHint(lapsed), "Send request or sign off",
    `${surface}: the operator is told to send one again`);

  assert.equal(live.pending_signoff_referee_name, LIVE_NAME, `${surface}: a live request still shows`);
  assert.equal(signoffHint(live), `Waiting for ${LIVE_NAME}`);

  assert.equal(mixed.pending_signoff_referee_name, LIVE_NAME,
    `${surface}: the live request wins over an older lapsed one`);

  for (const ev of [lapsed, live, mixed]) {
    const step = ev.steps.find((s) => s.key === "sign_off");
    assert.equal(step.done, false, `${surface}: nobody has signed off yet`);
  }
}

test("event readiness (the Control Room checklist) drops a lapsed request", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const cache = new Map();
  for (const eventId of [lapsedEvent, liveEvent, mixedEvent]) {
    cache.set(eventId, await getEventReadiness(pool, { eventId, isSystemAdmin: false, orgId: org }));
  }
  assertSignoffState((id) => cache.get(id), "readiness");
  // Still a blocker, just without the stale name on it.
  const blocker = cache.get(lapsedEvent).blockers.find((b) => b.key === "sign_off");
  assert.equal(blocker?.hint, "Send request or sign off");
});

test("the operator's dashboard drops a lapsed request", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const res = await get("operator", "/api/dashboard");
  assert.equal(res.status, 200);
  // The slice swallows a query error into [], so an empty list here would
  // pass the lapsed check for the wrong reason. assertSignoffState also
  // insists the live one comes through.
  const rows = res.body.workflow_actions;
  assert.ok(Array.isArray(rows) && rows.length >= 3, "workflow_actions came back");
  assertSignoffState((id) => rows.find((r) => r.event_id === id), "dashboard");
});

test("the meet readiness report drops a lapsed request", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const res = await get("operator", `/api/meets/${meetId}/readiness-report`);
  assert.equal(res.status, 200);
  const rows = res.body.events;
  assertSignoffState((id) => rows.find((r) => r.event_id === id), "meet report");
});

test("the referee desk only lists requests that are still live", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const lapsed = await get("lapsedRef", "/api/dashboard");
  assert.equal(lapsed.status, 200);
  assert.deepEqual(lapsed.body.referee_desk.pending_signoffs, [],
    "both of this referee's requests ran out");

  const live = await get("liveRef", "/api/dashboard");
  const events = live.body.referee_desk.pending_signoffs.map((r) => r.event_id).sort();
  assert.deepEqual(events, [liveEvent, mixedEvent].sort());
  // Pushed requests, each with a banner to answer. A handoff code's card
  // goes to /sign-off-codes instead (by_code, see src/lib/signoffLink.js).
  assert.ok(live.body.referee_desk.pending_signoffs.every((r) => r.by_code === false));
});

test("a fresh request on the lapsed event shows up again", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  // What the operator does once the checklist stops naming the old
  // referee: send another. Same shape the request endpoint writes.
  await pool.query(
    `UPDATE referee_signoff_requests SET status = 'expired', responded_at = now()
      WHERE event_id = $1 AND status = 'pending'`, [lapsedEvent]);
  await pool.query(
    `INSERT INTO referee_signoff_requests (event_id, requested_by, target_referee_id)
     VALUES ($1, $2, $3)`, [lapsedEvent, operator, lapsedRef]);
  const readiness = await getEventReadiness(pool, { eventId: lapsedEvent, isSystemAdmin: false, orgId: org });
  assert.equal(readiness.pending_signoff_referee_name, LAPSED_NAME);
  assert.equal(signoffHint(readiness), `Waiting for ${LAPSED_NAME}`);
});
