// routes/teams.js loadOwnTeam: the one check every route on an existing
// team runs before touching it. requireMeetEditor only proves the caller
// holds the role somewhere, so this is what stops another org's team
// UUID from working. Pins the 404 for an unknown team and each route's
// own 403 wording for a team in another org.
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
const ids = { orgs: [], users: [], teams: [] };
let ownTeam, foreignTeam, ownMember;

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
     VALUES ($1, 'TGA', $1, 'active') RETURNING id`, [`teamgate-a-${sfx}`]);
  const otherOrg = await one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'TGB', $1, 'active') RETURNING id`, [`teamgate-b-${sfx}`]);
  ids.orgs.push(org, otherOrg);
  const manager = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Manager', $2, now()) RETURNING id`, [`tg-mgr-${sfx}`, org]);
  ownMember = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Member', $2, now()) RETURNING id`, [`tg-mem-${sfx}`, org]);
  ids.users.push(manager, ownMember);
  ownTeam = await one(
    "INSERT INTO teams (org_id, name, short_code) VALUES ($1, 'Own Team', 'OWN') RETURNING id", [org]);
  foreignTeam = await one(
    "INSERT INTO teams (org_id, name, short_code) VALUES ($1, 'Their Team', 'THR') RETURNING id", [otherOrg]);
  ids.teams.push(ownTeam, foreignTeam);

  const pass = (_req, _res, next) => next();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: manager, org_id: org, is_system_admin: false, org_roles: ["meet_manager"] };
    next();
  });
  app.use(require("../routes/teams")({
    pool,
    requireMeetEditor: pass,
    requireEventManager: () => pass,
    bulkWriteLimiter: pass,
    loadEventForEntries: async () => ({ status: 409, error: "should not be reached" }),
  }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool && dbReachable) {
    try {
      await pool.query("DELETE FROM teams WHERE id = ANY($1::uuid[])", [ids.teams]);
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

// method, path for team T, body, the verb its 403 uses
const ROUTES = [
  ["PUT",    (t) => `/api/teams/${t}`,                                { name: "Renamed" },                 "edit"],
  ["DELETE", (t) => `/api/teams/${t}`,                                null,                                "delete"],
  ["GET",    (t) => `/api/teams/${t}/events`,                         null,                                "read"],
  ["POST",   (t) => `/api/teams/${t}/dive-lists`,                     { event_id: "e", dives: [{}] },      "manage"],
  ["GET",    (t) => `/api/teams/${t}/events/${crypto.randomUUID()}/dive-list`, null,                     "read"],
  ["GET",    (t) => `/api/teams/${t}/members`,                        null,                                "view"],
  ["POST",   (t) => `/api/teams/${t}/members`,                        { user_id: crypto.randomUUID() },    "modify"],
  ["DELETE", (t) => `/api/teams/${t}/members/${crypto.randomUUID()}`, null,                                "modify"],
];

test("an unknown team is a 404 on every team route", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  for (const [method, path, body] of ROUTES) {
    const r = await call(method, path(crypto.randomUUID()), body);
    assert.equal(r.status, 404, `${method} ${path("T")}`);
    assert.deepEqual(r.body, { error: "Team not found" });
  }
});

test("another org's team is a 403 in each route's own words", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  for (const [method, path, body, verb] of ROUTES) {
    const r = await call(method, path(foreignTeam), body);
    assert.equal(r.status, 403, `${method} ${path("T")}`);
    assert.deepEqual(r.body, { error: `Cannot ${verb} teams in other organisations` });
  }
});

test("your own team gets through", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const add = await call("POST", `/api/teams/${ownTeam}/members`, { user_id: ownMember });
  assert.deepEqual(add, { status: 200, body: { message: "Member added" } });
  const list = await call("GET", `/api/teams/${ownTeam}/members`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((m) => m.id), [ownMember]);
  const del = await call("DELETE", `/api/teams/${ownTeam}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.members, 1);
  ids.teams = ids.teams.filter((id) => id !== ownTeam);
});
