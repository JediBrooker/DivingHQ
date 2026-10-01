// Where a referee's sign-off answer goes, and the status check the
// manager's dialog leans on while it waits (routes/control-room-signoff.js).
//
// Sign-off happens while the event is still Upcoming, and the Control Room
// only joins an event's room once it's Live. The answer used to go to the
// event room alone, so the laptop that asked never heard it and the dialog
// sat on "Waiting for ..." until a reload. It goes to the asker's own room
// now as well, and GET .../request/:requestId says where a request stands.
//
// Uses the real push engine over a fake io that records what it's asked to
// send. Skips when Postgres isn't reachable.

// No real web push from a test, whatever .env says. dotenv leaves keys
// that are already set alone.
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

let pool;
let dbReachable = true;
let server;
let port;
const ids = { orgs: [], users: [], events: [] };
let operator, referee, eventId, otherEventId;
let caller = null;
const sent = [];

// Just enough of socket.io for lib/push: to(rooms).emit(name, payload).
const fakeIo = {
  to(rooms) {
    return { emit: (name, payload) => sent.push({ rooms: [].concat(rooms), name, payload }) };
  },
};

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
     VALUES ($1, 'SGA', $1, 'active') RETURNING id`, [`signoff-answer-${sfx}`]);
  ids.orgs.push(org);
  operator = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Operator', $2, now()) RETURNING id`, [`sa-op-${sfx}`, org]);
  referee = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Referee', $2, now()) RETURNING id`, [`sa-ref-${sfx}`, org]);
  ids.users.push(operator, referee);
  await pool.query(
    "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'referee')", [referee, org]);

  const mkEvent = (name) => one(
    `INSERT INTO events (org_id, name, gender, status, height, event_type, total_rounds, number_of_judges,
                         check_in_done_at, dive_order_randomised_at)
     VALUES ($1, $2, 'Mixed', 'Upcoming', '3m', 'individual', 3, 5, now(), now()) RETURNING id`,
    [org, name]);
  eventId = await mkEvent(`Signoff answer ${sfx}`);
  otherEventId = await mkEvent(`Signoff other ${sfx}`);
  ids.events.push(eventId, otherEventId);

  const pass = (_req, _res, next) => next();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = caller === "referee"
      ? { id: referee, org_id: org, is_system_admin: false, org_roles: ["referee"] }
      : { id: operator, org_id: org, is_system_admin: false, org_roles: ["meet_manager"] };
    next();
  });
  app.use(require("../routes/control-room")({
    pool,
    requireOrgRole: () => pass,
    requireMeetEditor: pass,
    bulkWriteLimiter: pass,
    ensureEventOrgGate: async () => true,
    ensureEventPreMeet: async () => true,
    requireRoleOrEventDelegate: () => pass,
    push: require("../lib/push")({ pool, io: fakeIo }),
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
      await pool.query("DELETE FROM notifications WHERE user_id = ANY($1::uuid[])", [ids.users]);
      await pool.query("DELETE FROM events WHERE id = ANY($1::uuid[])", [ids.events]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids.users]);
      await pool.query("DELETE FROM organisations WHERE id = ANY($1::uuid[])", [ids.orgs]);
    } catch (err) {
      console.warn(`[cleanup] ${err.message}`);
    }
  }
  if (pool) await pool.end();
});

async function call(as, method, path, body) {
  caller = as;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function answers() {
  return sent.filter((s) => s.name === "referee_signoff_response");
}

async function resetSignoff() {
  await pool.query(
    "UPDATE events SET dive_order_signed_off_at = NULL, dive_order_signed_off_by = NULL WHERE id = $1",
    [eventId],
  );
  sent.length = 0;
}

test("an approval from the referee's device reaches the operator's own room", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await resetSignoff();
  const req = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/request`, { referee_id: referee });
  assert.equal(req.status, 201);
  const requestId = req.body.request_id;

  let status = await call("operator", "GET", `/api/events/${eventId}/dive-order/sign-off/request/${requestId}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "pending");
  assert.equal(status.body.dive_order_signed_off_at, null);

  const res = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: requestId, decision: "approve" });
  assert.equal(res.status, 200);

  const got = answers();
  assert.equal(got.length, 1, "one emit, over every room at once");
  // The referee's own room too, for a dashboard they have open elsewhere.
  assert.deepEqual(new Set(got[0].rooms), new Set([`event:${eventId}`, `user:${operator}`, `user:${referee}`]));
  assert.deepEqual(got[0].payload, { event_id: eventId, request_id: requestId, decision: "approved", by_user_id: referee });

  status = await call("operator", "GET", `/api/events/${eventId}/dive-order/sign-off/request/${requestId}`);
  assert.equal(status.body.status, "approved");
  assert.equal(status.body.decision_method, "push");
  assert.ok(status.body.dive_order_signed_off_at);
  assert.equal(status.body.dive_order_signed_off_by, referee);
});

test("a refusal goes the same way and reads as declined", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await resetSignoff();
  const req = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/request`, { referee_id: referee });
  const requestId = req.body.request_id;
  const res = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: requestId, decision: "deny" });
  assert.equal(res.status, 200);
  const got = answers();
  assert.equal(got.length, 1);
  assert.ok(got[0].rooms.includes(`user:${operator}`));
  assert.equal(got[0].payload.decision, "declined");

  const status = await call("operator", "GET", `/api/events/${eventId}/dive-order/sign-off/request/${requestId}`);
  assert.equal(status.body.status, "declined");
  assert.equal(status.body.dive_order_signed_off_at, null);
});

test("a handoff code typed on the referee's phone reaches the operator's own room", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await resetSignoff();
  const prevBase = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "http://127.0.0.1";
  t.after(() => {
    if (prevBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = prevBase;
  });
  const gen = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/code`, { referee_id: referee });
  assert.equal(gen.status, 201);

  const res = await call("referee", "POST", "/api/sign-off/code/verify", { code: gen.body.code });
  assert.equal(res.status, 200);
  const got = answers();
  assert.equal(got.length, 1);
  assert.deepEqual(new Set(got[0].rooms), new Set([`event:${eventId}`, `user:${operator}`, `user:${referee}`]));
  assert.deepEqual(got[0].payload, { event_id: eventId, request_id: gen.body.request_id, decision: "approved", by_user_id: referee });

  const status = await call("operator", "GET", `/api/events/${eventId}/dive-order/sign-off/request/${gen.body.request_id}`);
  assert.equal(status.body.status, "approved");
  assert.equal(status.body.decision_method, "code");
});

test("a request past its expiry reads as expired even before anything touches the row", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const r = await pool.query(
    `INSERT INTO referee_signoff_requests (event_id, requested_by, target_referee_id, expires_at)
     VALUES ($1, $2, $3, now() - interval '1 minute') RETURNING id`,
    [eventId, operator, referee],
  );
  const status = await call("operator", "GET", `/api/events/${eventId}/dive-order/sign-off/request/${r.rows[0].id}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "expired");
  const row = await pool.query("SELECT status FROM referee_signoff_requests WHERE id = $1", [r.rows[0].id]);
  assert.equal(row.rows[0].status, "pending", "a read doesn't write");
});

test("the status check only answers for a request on that event", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const r = await pool.query(
    `INSERT INTO referee_signoff_requests (event_id, requested_by, target_referee_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [eventId, operator, referee],
  );
  const wrongEvent = await call("operator", "GET", `/api/events/${otherEventId}/dive-order/sign-off/request/${r.rows[0].id}`);
  assert.equal(wrongEvent.status, 404);
  const junk = await call("operator", "GET", `/api/events/${eventId}/dive-order/sign-off/request/not-a-uuid`);
  assert.equal(junk.status, 404);
  const badRespond = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: "not-a-uuid", decision: "approve" });
  assert.equal(badRespond.status, 400);
});
