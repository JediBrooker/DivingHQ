// A sign-off request that stops being open takes its Approve / Deny banner
// with it (routes/control-room-signoff.js, lib/push.js).
//
// The rehearsal had the referee's phone keep a request's banner after the
// operator pressed Cancel and tried another way, and after a newer request
// or a code replaced it, reload or no reload: the request went to
// 'expired' but its notification stayed 'sent'. Approve on it answered
// "Request already expired". And Cancel never told the server anything,
// so a referee who tapped Approve on that request signed the order off
// while the Control Room had moved on and never noticed.
//
// Cancel withdraws the request now. Whatever closes a request (Cancel, a
// newer request or code, an answer by banner, notification, code or the
// referee signing at the laptop, running out) retires its notification and
// tells the referee's devices, so a late Approve has nothing to press.
//
// Uses the real push engine over a fake io that records what it's asked to
// send. Skips when Postgres isn't reachable.

process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

require("dotenv").config();

let pool;
let push;
let dbReachable = true;
let server;
let port;
const ids = { orgs: [], users: [], events: [] };
let operator, referee, refereeUsername, eventId, otherEventId;
let refereeB, refereeBUsername;
let caller = null;
const sent = [];
const REF_PASSWORD = "referee-pw-1234";

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
     VALUES ($1, 'SGA', $1, 'active') RETURNING id`, [`signoff-withdraw-${sfx}`]);
  ids.orgs.push(org);
  operator = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Operator', $2, now()) RETURNING id`, [`sw-op-${sfx}`, org]);
  refereeUsername = `sw-ref-${sfx}`;
  referee = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, $2, 'Referee', $3, now()) RETURNING id`,
    [refereeUsername, await bcrypt.hash(REF_PASSWORD, 4), org]);
  refereeBUsername = `sw-refb-${sfx}`;
  refereeB = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, $2, 'Second Referee', $3, now()) RETURNING id`,
    [refereeBUsername, await bcrypt.hash(REF_PASSWORD, 4), org]);
  ids.users.push(operator, referee, refereeB);
  await pool.query(
    "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $3, 'referee'), ($2, $3, 'referee')",
    [referee, refereeB, org]);

  const mkEvent = (name) => one(
    `INSERT INTO events (org_id, name, gender, status, height, event_type, total_rounds, number_of_judges,
                         check_in_done_at, dive_order_randomised_at)
     VALUES ($1, $2, 'Mixed', 'Upcoming', '3m', 'individual', 3, 5, now(), now()) RETURNING id`,
    [org, name]);
  eventId = await mkEvent(`Signoff withdraw ${sfx}`);
  otherEventId = await mkEvent(`Signoff withdraw other ${sfx}`);
  ids.events.push(eventId, otherEventId);

  push = require("../lib/push")({ pool, io: fakeIo });
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
    push,
    bcrypt,
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
      await pool.query("DELETE FROM user_org_roles WHERE user_id = ANY($1::uuid[])", [ids.users]);
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

async function fresh() {
  await pool.query(
    "UPDATE events SET status = 'Upcoming', dive_order_signed_off_at = NULL, dive_order_signed_off_by = NULL WHERE id = $1",
    [eventId],
  );
  await pool.query(
    "UPDATE referee_signoff_requests SET status = 'expired' WHERE event_id = $1 AND status = 'pending'",
    [eventId],
  );
  sent.length = 0;
}

async function ask() {
  const r = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/request`, { referee_id: referee });
  assert.equal(r.status, 201);
  return r.body.request_id;
}

// The referee's banner feed: what a reload (or the inbox) would draw.
async function bannersFor(requestId) {
  const rows = await push.listForUser(referee, { limit: 50 });
  return rows.filter((n) => n.category === "referee_signoff" && n.data?.request_id === requestId);
}

function retractions(requestId) {
  return sent.filter((s) => s.name === "referee_signoff_response" && s.payload.request_id === requestId);
}

async function signedOff() {
  const r = await pool.query("SELECT dive_order_signed_off_at FROM events WHERE id = $1", [eventId]);
  return r.rows[0].dive_order_signed_off_at;
}

async function signedOffBy() {
  const r = await pool.query("SELECT dive_order_signed_off_by FROM events WHERE id = $1", [eventId]);
  return r.rows[0].dive_order_signed_off_by;
}

async function requestStatus(requestId) {
  const r = await pool.query("SELECT status FROM referee_signoff_requests WHERE id = $1", [requestId]);
  return r.rows[0].status;
}

test("Cancel withdraws the request: the banner leaves the feed and a late Approve doesn't sign off", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  const banners = await bannersFor(requestId);
  assert.equal(banners.length, 1, "the referee has the banner");
  // Tapping it opens the Control Room on this event, not "No event selected".
  assert.equal(banners[0].action_url, `/control?event=${eventId}&signoff_request=${requestId}`);

  const cancel = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/request/${requestId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.deepEqual(cancel.body, { ok: true, status: "expired" });
  assert.deepEqual(await bannersFor(requestId), [], "a reload doesn't bring it back");

  // The referee's open devices are told straight away.
  const told = retractions(requestId);
  assert.equal(told.length, 1);
  assert.ok(told[0].rooms.includes(`user:${referee}`));
  assert.ok(told[0].rooms.includes(`user:${operator}`));
  assert.deepEqual(told[0].payload, { event_id: eventId, request_id: requestId, decision: "expired", by_user_id: operator });

  const late = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: requestId, decision: "approve" });
  assert.equal(late.status, 409);
  assert.equal(await signedOff(), null, "Cancel means cancelled, on the laptop and the phone");
});

test("a newer request replaces the old one's banner", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const first = await ask();
  const second = await ask();
  assert.deepEqual(await bannersFor(first), []);
  assert.equal((await bannersFor(second)).length, 1);
  assert.equal(retractions(first).length, 1);
  assert.equal(retractions(first)[0].payload.decision, "expired");
  assert.equal(retractions(second).length, 0);
});

test("a handoff code replaces a pushed request's banner", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const prevBase = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "http://127.0.0.1";
  t.after(() => {
    if (prevBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = prevBase;
  });
  const pushed = await ask();
  const gen = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/code`, { referee_id: referee });
  assert.equal(gen.status, 201);
  assert.deepEqual(await bannersFor(pushed), []);
  assert.equal(retractions(pushed).length, 1);
});

test("an answered request's banner doesn't come back, even once it's been read", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  const [banner] = await bannersFor(requestId);
  const res = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: requestId, decision: "approve" });
  assert.equal(res.status, 200);
  assert.deepEqual(await bannersFor(requestId), []);
  // The phone acks it after answering. That mustn't put it back in the
  // feed for a /control?signoff_request= link to find.
  assert.equal(await push.acknowledgeNotification(banner.id, referee), true);
  assert.deepEqual(await bannersFor(requestId), []);
  const answer = retractions(requestId);
  assert.equal(answer.length, 1);
  assert.deepEqual(answer[0].payload, { event_id: eventId, request_id: requestId, decision: "approved", by_user_id: referee });
});

test("the referee signing at the laptop takes the pushed request's banner down", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  const res = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/credential`,
    { username: refereeUsername, password: REF_PASSWORD });
  assert.equal(res.status, 200);
  assert.ok(await signedOff());
  assert.deepEqual(await bannersFor(requestId), []);
  assert.equal(retractions(requestId).length, 1);
  assert.equal(retractions(requestId)[0].payload.decision, "approved");
});

test("Cancel after the referee already approved says so, it doesn't undo it", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: requestId, decision: "approve" });
  const cancel = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/request/${requestId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.deepEqual(cancel.body, { ok: true, status: "approved" });
  assert.ok(await signedOff());
});

test("Cancel only answers for a request on that event", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  const wrongEvent = await call("operator", "POST", `/api/events/${otherEventId}/dive-order/sign-off/request/${requestId}/cancel`);
  assert.equal(wrongEvent.status, 404);
  const junk = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/request/not-a-uuid/cancel`);
  assert.equal(junk.status, 404);
  const unknown = await call("operator", "POST",
    `/api/events/${eventId}/dive-order/sign-off/request/${crypto.randomUUID()}/cancel`);
  assert.equal(unknown.status, 404);
  assert.equal((await bannersFor(requestId)).length, 1, "the real one is still open");
});

test("a banner whose time ran out isn't listed, even before the sweep gets to it", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  await pool.query(
    `UPDATE notifications SET expires_at = now() - interval '1 second'
      WHERE user_id = $1 AND data->>'request_id' = $2`,
    [referee, requestId],
  );
  assert.deepEqual(await bannersFor(requestId), []);
});

// Signed off another way while a push was still out: the operator pressed
// Esc on the dialog (which leaves the request open on purpose), opened it
// again and attested as meet manager, or a different referee signed in at
// the laptop. The earlier request stayed pending with its banner, so the
// referee's phone kept Approve and Deny for an order already signed off.
// Deny answered 200 'declined' as if it counted, and Approve rewrote who
// signed off. Whatever signs the order off now closes every request still
// out for it.
test("the manager attesting closes a request still out to the referee's phone", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  const attest = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off`);
  assert.equal(attest.status, 200);
  assert.equal(await signedOffBy(), operator);

  assert.equal(await requestStatus(requestId), "expired");
  assert.deepEqual(await bannersFor(requestId), [], "a reload doesn't bring the banner back");
  const told = retractions(requestId);
  assert.equal(told.length, 1);
  assert.ok(told[0].rooms.includes(`user:${referee}`));
  assert.deepEqual(told[0].payload, { event_id: eventId, request_id: requestId, decision: "expired", by_user_id: operator });

  for (const decision of ["deny", "approve"]) {
    const late = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
      { request_id: requestId, decision });
    assert.equal(late.status, 409, `a late ${decision} isn't taken`);
  }
  assert.equal(await signedOffBy(), operator, "nobody rewrites who signed off");
});

test("another referee signing at the laptop closes the first referee's request too", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  const res = await call("operator", "POST", `/api/events/${eventId}/dive-order/sign-off/credential`,
    { username: refereeBUsername, password: REF_PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(await signedOffBy(), refereeB);

  assert.equal(await requestStatus(requestId), "expired", "the first referee never answered it");
  assert.deepEqual(await bannersFor(requestId), []);
  assert.equal(retractions(requestId).length, 1);
  assert.equal(retractions(requestId)[0].payload.decision, "expired");

  const late = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: requestId, decision: "approve" });
  assert.equal(late.status, 409);
  assert.equal(await signedOffBy(), refereeB);
});

// Backstop for a request that's somehow still pending (one written before
// this change, say): an order that's already signed off, or an event
// that's gone Live, has nothing left for it to decide.
test("a request still pending after the order was signed off can't relabel the sign-off", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  await pool.query(
    "UPDATE events SET dive_order_signed_off_at = now(), dive_order_signed_off_by = $2 WHERE id = $1",
    [eventId, operator],
  );
  const late = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: requestId, decision: "approve" });
  assert.equal(late.status, 409);
  assert.equal(late.body.status, "expired");
  assert.equal(await signedOffBy(), operator);
  assert.equal(await requestStatus(requestId), "expired");
  assert.deepEqual(await bannersFor(requestId), []);
  assert.equal(retractions(requestId).length, 1, "the referee's other devices hear it closed");
});

test("a request still pending once the event is Live can't be answered", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const requestId = await ask();
  await pool.query("UPDATE events SET status = 'Live' WHERE id = $1", [eventId]);
  const late = await call("referee", "POST", `/api/events/${eventId}/dive-order/sign-off/respond`,
    { request_id: requestId, decision: "deny" });
  assert.equal(late.status, 409);
  assert.equal(await requestStatus(requestId), "expired");
  assert.equal(await signedOff(), null);
});

test("a handoff code still pending after the order was signed off is refused", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  await fresh();
  const code = String(100000 + crypto.randomInt(900000));
  const ins = await pool.query(
    `INSERT INTO referee_signoff_requests (event_id, requested_by, target_referee_id, handoff_code)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [eventId, operator, referee, code],
  );
  await pool.query(
    "UPDATE events SET dive_order_signed_off_at = now(), dive_order_signed_off_by = $2 WHERE id = $1",
    [eventId, operator],
  );
  const late = await call("referee", "POST", "/api/sign-off/code/verify", { code });
  assert.equal(late.status, 409);
  assert.equal(await signedOffBy(), operator);
  assert.equal(await requestStatus(ins.rows[0].id), "expired");
});
