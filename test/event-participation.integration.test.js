// International participation (routes/events/participation.js): the two ways a
// host brings another federation in, an invite it has to accept and a
// straight add, share one set of refusals (loadInviteContext), and all
// three notifications go to the other side's org admins through
// notifyOrgAdmins. This pins the refusals for both routes, and who gets
// told what for an invite, an add, a re-add (nobody) and a
// self-withdrawal.
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
const sent = [];
let host, guest, dormant, hostAdmin, guestAdmin, event, completedEvent;
let hostName, guestName;
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
  const mkOrg = (name, cc, status) => one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, $2, $1, $3) RETURNING id`, [name, cc, status]);
  hostName = `particip-host-${sfx}`;
  guestName = `particip-guest-${sfx}`;
  host    = await mkOrg(hostName, "PHA", "active");
  guest   = await mkOrg(guestName, "PGA", "active");
  dormant = await mkOrg(`particip-dormant-${sfx}`, "PDA", "suspended");
  ids.orgs.push(host, guest, dormant);

  const mkAdmin = async (name, orgId) => {
    const id = await one(
      `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
       VALUES ($1, 'x', $1, $2, now()) RETURNING id`, [`${name}-${sfx}`, orgId]);
    await pool.query(
      "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, 'org_admin')", [id, orgId]);
    ids.users.push(id);
    return id;
  };
  hostAdmin  = await mkAdmin("host-admin", host);
  guestAdmin = await mkAdmin("guest-admin", guest);

  const mkEvent = (name, status) => one(
    `INSERT INTO events (org_id, name, gender, status, height, event_type, total_rounds, number_of_judges)
     VALUES ($1, $2, 'Mixed', $3, '3m', 'individual', 5, 5) RETURNING id`,
    [host, `${name} ${sfx}`, status]);
  event          = await mkEvent("Open", "Upcoming");
  completedEvent = await mkEvent("Done", "Completed");
  ids.events.push(event, completedEvent);

  // req.user comes from whoever the test is acting as.
  const setUser = (req, _res, next) => {
    req.user = { ...actAs, org_roles: ["org_admin"], is_system_admin: false };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(require("../routes/events")({
    pool,
    optionalAuth: setUser,
    io: { to: () => ({ emit() {} }) },
    verifyToken: setUser,
    requireOrgAdmin: setUser,
    requireEventManager: () => setUser,
    sendEventStartedEmails: () => {},
    sendEventResultsEmails: () => {},
    activeDivers: {},
    meetHolds: {},
    push: { sendNotification: async (userIds, payload) => { sent.push({ userIds, payload }); } },
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
      await pool.query("DELETE FROM user_org_roles WHERE user_id = ANY($1::uuid[])", [ids.users]);
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

const asHost  = () => { actAs = { id: hostAdmin, org_id: host }; };
const asGuest = () => { actAs = { id: guestAdmin, org_id: guest }; };

for (const route of ["participation-requests", "participating-orgs"]) {
  test(`${route}: the shared refusals`, async (t) => {
    if (!dbReachable) { t.skip(); return; }
    asHost();
    const post = (ev, body) => call("POST", `/api/events/${ev}/${route}`, body);
    assert.deepEqual(await post(crypto.randomUUID(), { org_id: guest }),
      { status: 404, body: { error: "Event not found" } });
    assert.deepEqual(await post(completedEvent, { org_id: guest }), {
      status: 409,
      body: { error: "Event is already Completed — re-open it before inviting more federations" },
    });
    assert.deepEqual(await post(event, { org_id: host }), {
      status: 400,
      body: { error: "Host org is implicit — don't list it as a participating org" },
    });
    assert.deepEqual(await post(event, { org_id: crypto.randomUUID() }),
      { status: 404, body: { error: "Target org not found" } });
    const dormantName = (await pool.query("SELECT name FROM organisations WHERE id = $1", [dormant])).rows[0].name;
    assert.deepEqual(await post(event, { org_id: dormant }), {
      status: 409,
      body: { error: `${dormantName} is suspended; only active orgs can participate` },
    });
    asGuest();
    assert.deepEqual(await post(event, { org_id: dormant }),
      { status: 403, body: { error: "You don't host this event" } });
    assert.equal(sent.length, 0, "no refusal notifies anyone");
  });
}

test("invite, add, re-add and self-withdrawal notify the right admins", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  sent.length = 0;

  asHost();
  const invite = await call("POST", `/api/events/${event}/participation-requests`, { org_id: guest });
  assert.equal(invite.status, 201);
  assert.deepEqual(sent.at(-1).userIds, [guestAdmin]);
  assert.equal(sent.at(-1).payload.title, `${hostName} invited you to "Open ${hostName.slice(-8)}"`);
  assert.equal(sent.at(-1).payload.body, "Open Meet Manager to accept or decline participation.");
  assert.deepEqual(sent.at(-1).payload.data,
    { request_id: invite.body.id, event_id: event, host_org_id: host });

  const add = await call("POST", `/api/events/${event}/participating-orgs`, { org_id: guest });
  assert.deepEqual(add, { status: 201, body: { ok: true } });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.at(-1).userIds, [guestAdmin]);
  assert.equal(sent.at(-1).payload.title, `${hostName} invited you to "Open ${hostName.slice(-8)}"`);
  assert.deepEqual(sent.at(-1).payload.data, { event_id: event, host_org_id: host });

  // Already on the list: no second invite notification.
  const again = await call("POST", `/api/events/${event}/participating-orgs`, { org_id: guest });
  assert.deepEqual(again, { status: 201, body: { ok: true } });
  assert.equal(sent.length, 2);

  asGuest();
  const leave = await call("DELETE", `/api/events/${event}/participating-orgs/${guest}`);
  assert.deepEqual(leave, { status: 200, body: { ok: true } });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.at(-1).userIds, [hostAdmin]);
  assert.equal(sent.at(-1).payload.title, `${guestName} withdrew from "Open ${hostName.slice(-8)}"`);
  assert.deepEqual(sent.at(-1).payload.data, { event_id: event, withdrawing_org_id: guest });
});
