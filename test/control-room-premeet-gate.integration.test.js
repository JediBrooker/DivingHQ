// The Control Room's pre-meet gate (routes/control-room.js
// loadUpcomingEvent + requireReferee). Seven routes share it: the four
// workflow steps and the three referee sign-off paths. It has to keep
// answering exactly as each route did on its own, so this pins the
// 404 for another org's event, each route's 409 wording on a Live
// event, and the 400 for a sign-off aimed at someone who isn't a
// referee.
//
// Skips when Postgres isn't reachable.

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
let liveEvent, upcomingEvent, foreignEvent, diverId;
let liveName;

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
     VALUES ($1, 'PMA', $1, 'active') RETURNING id`, [`premeet-a-${sfx}`]);
  const otherOrg = await one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'PMB', $1, 'active') RETURNING id`, [`premeet-b-${sfx}`]);
  ids.orgs.push(org, otherOrg);

  const operator = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Operator', $2, now()) RETURNING id`, [`pm-op-${sfx}`, org]);
  diverId = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Not A Referee', $2, now()) RETURNING id`, [`pm-diver-${sfx}`, org]);
  ids.users.push(operator, diverId);

  const mkEvent = (orgId, name, status) => one(
    `INSERT INTO events (org_id, name, gender, status, height, event_type, total_rounds, number_of_judges)
     VALUES ($1, $2, 'Mixed', $3, '3m', 'individual', 5, 5) RETURNING id`,
    [orgId, name, status]);
  liveName = `Live gate ${sfx}`;
  liveEvent     = await mkEvent(org, liveName, "Live");
  upcomingEvent = await mkEvent(org, `Upcoming gate ${sfx}`, "Upcoming");
  foreignEvent  = await mkEvent(otherOrg, `Foreign gate ${sfx}`, "Upcoming");
  ids.events.push(liveEvent, upcomingEvent, foreignEvent);

  const pass = (_req, _res, next) => next();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: operator, org_id: org, is_system_admin: false, org_roles: ["meet_manager"] };
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
    // The request and credential paths 503 without these; neither is
    // reached on the refusals below.
    push: { sendNotification: async () => { throw new Error("should not be reached"); } },
    bcrypt: { compare: async () => { throw new Error("should not be reached"); } },
  }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool && dbReachable) {
    try {
      await pool.query("DELETE FROM events WHERE id = ANY($1::uuid[])", [ids.events]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids.users]);
      await pool.query("DELETE FROM organisations WHERE id = ANY($1::uuid[])", [ids.orgs]);
    } catch (err) {
      console.warn(`[cleanup] ${err.message}`);
    }
  }
  if (pool) await pool.end();
});

async function post(path, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// route suffix, request body, the verb its 409 has always used
const ROUTES = [
  ["dive-order/sign-off",            {},                                   "Cannot sign off"],
  ["check-in/confirm",               {},                                   "Cannot confirm check-in"],
  ["dive-order/reset",               {},                                   "Cannot reset workflow"],
  ["dive-order/confirm",             {},                                   "Cannot advance workflow"],
  ["dive-order/sign-off/request",    { referee_id: "x" },                  "Cannot request sign-off"],
  ["dive-order/sign-off/code",       { referee_id: "x" },                  "Cannot generate code"],
  ["dive-order/sign-off/credential", { username: "ref", password: "pw" }, null],
];

test("another org's event is a 404 on every gated route", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  for (const [route, body] of ROUTES) {
    const r = await post(`/api/events/${foreignEvent}/${route}`, body);
    assert.equal(r.status, 404, route);
    assert.deepEqual(r.body, { error: "Event not found" }, route);
  }
});

test("a Live event is a 409 in each route's own words", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  for (const [route, body, verb] of ROUTES) {
    const r = await post(`/api/events/${liveEvent}/${route}`, body);
    assert.equal(r.status, 409, route);
    const expected = verb
      ? `${verb} — event "${liveName}" is Live.`
      : `Event "${liveName}" is Live.`;
    assert.deepEqual(r.body, { error: expected }, route);
  }
});

test("a sign-off aimed at someone who isn't a referee is a 400", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  for (const route of ["dive-order/sign-off/request", "dive-order/sign-off/code"]) {
    const r = await post(`/api/events/${upcomingEvent}/${route}`, { referee_id: diverId });
    assert.equal(r.status, 400, route);
    assert.deepEqual(r.body, { error: "Selected user is not a referee in this org" }, route);
  }
});

test("an Upcoming event in the caller's org gets through", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const r = await post(`/api/events/${upcomingEvent}/check-in/confirm`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.check_in_done_at);
});
