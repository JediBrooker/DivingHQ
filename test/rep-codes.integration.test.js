// Representation codes on the per-round lists: the Control Room roster
// and history, the scoreboard's up-next queue and leaderboard, and the
// archive recap's dives.
//
// All five used to call event_rep_code() once per output row (twice
// with the partner). They now look each person up once in the
// eventRepCodesCte (lib/scoring-sql.js), which is a lot cheaper, but
// only worth it if every row still carries the exact code the per-row
// call gave. This pins that: each row's country_code / partner_country
// is checked against a direct event_rep_code(event, person, their org's
// country) call, on
//
//   * a synchro event in a club-represented meet, with a pending club
//     (falls back to the home country), an active club, no club, and a
//     partner from another federation,
//   * an individual event in a region-represented meet,
//   * an individual event with no meet at all (country codes).
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
const ids = { orgs: [], users: [], events: [], meets: [], clubs: [], regions: [] };
let synchroEvent, regionEvent, plainEvent;

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
    await pool.query("SELECT event_rep_code(NULL::uuid, NULL::uuid, NULL::text)");
  } catch (err) {
    dbReachable = false;
    console.warn(`[skip] Postgres not reachable or pre-090 schema: ${err.message}`);
    return;
  }

  const sfx = crypto.randomBytes(4).toString("hex");
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0].id;

  const org = await one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'RCA', $1, 'active') RETURNING id`, [`repcodes-a-${sfx}`]);
  const otherOrg = await one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'RCB', $1, 'active') RETURNING id`, [`repcodes-b-${sfx}`]);
  ids.orgs.push(org, otherOrg);

  const region = await one(
    `INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Rep Region', 'RRG') RETURNING id`, [org]);
  ids.regions.push(region);
  const activeClub = await one(
    `INSERT INTO clubs (org_id, name, short_code, region_id) VALUES ($1, 'Active Club', 'ACT', $2) RETURNING id`,
    [org, region]);
  const pendingClub = await one(
    `INSERT INTO clubs (org_id, name, short_code, status) VALUES ($1, 'Pending Club', 'PND', 'pending') RETURNING id`,
    [org]);
  ids.clubs.push(activeClub, pendingClub);

  const mkUser = (name, orgId, clubId) => one(
    `INSERT INTO users (username, password, full_name, org_id, club_id, email_verified_at)
     VALUES ($1, 'x', $2, $3, $4, now()) RETURNING id`,
    [`${name}-${sfx}`, name, orgId, clubId]);
  const dActive  = await mkUser("Avery Active", org, activeClub);
  const dPending = await mkUser("Parker Pending", org, pendingClub);
  const dNoClub  = await mkUser("Noel Noclub", org, null);
  const dForeign = await mkUser("Fran Foreign", otherOrg, null);
  const judge    = await mkUser("Jude Judge", org, null);
  ids.users.push(dActive, dPending, dNoClub, dForeign, judge);

  const clubMeet = await one(
    `INSERT INTO meets (org_id, name, represent_as) VALUES ($1, $2, 'club') RETURNING id`,
    [org, `Club meet ${sfx}`]);
  const regionMeet = await one(
    `INSERT INTO meets (org_id, name, represent_as) VALUES ($1, $2, 'region') RETURNING id`,
    [org, `Region meet ${sfx}`]);
  ids.meets.push(clubMeet, regionMeet);

  const mkEvent = (name, meetId, type) => one(
    `INSERT INTO events (org_id, meet_id, name, gender, status, height, event_type, total_rounds, number_of_judges)
     VALUES ($1, $2, $3, 'Mixed', 'Live', '3m', $4, 2, 3) RETURNING id`,
    [org, meetId, `${name} ${sfx}`, type]);
  synchroEvent = await mkEvent("Synchro", clubMeet, "synchro_pair");
  regionEvent  = await mkEvent("Region individual", regionMeet, "individual");
  plainEvent   = await mkEvent("No meet individual", null, "individual");
  ids.events.push(synchroEvent, regionEvent, plainEvent);

  const dive = (await pool.query(
    "SELECT id FROM dive_directory WHERE height = 3.0 ORDER BY dive_code LIMIT 1")).rows[0].id;

  const entries = [
    [synchroEvent, dActive, dPending],
    [synchroEvent, dNoClub, dForeign],
    [regionEvent, dActive, null],
    [regionEvent, dPending, null],
    [regionEvent, dNoClub, null],
    [plainEvent, dActive, null],
    [plainEvent, dForeign, null],
  ];
  for (const ev of ids.events) {
    await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)", [ev, judge]);
  }
  for (const [ev, comp, partner] of entries) {
    for (const round of [1, 2]) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, dive_id, round_number, display_order)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [ev, comp, partner, dive, round]);
      // Round 1 scored, round 2 not, so history is a strict subset.
      if (round === 1) {
        await pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, 1, 7.5)`,
          [ev, comp, judge, dive]);
      }
    }
  }

  const pass = (_req, _res, next) => next();
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: judge, org_id: org, is_system_admin: true, org_roles: ["org_admin"] };
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
  }));
  // No scoreboard cache, so every request builds from the database.
  app.use(require("../routes/scoreboard")({ pool, scoreboardCache: null, optionalAuth: pass }));
  app.use(require("../routes/archive")({ pool }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool && dbReachable) {
    try {
      await pool.query("DELETE FROM events WHERE id = ANY($1::uuid[])", [ids.events]);
      await pool.query("DELETE FROM meets WHERE id = ANY($1::uuid[])", [ids.meets]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids.users]);
      await pool.query("DELETE FROM clubs WHERE id = ANY($1::uuid[])", [ids.clubs]);
      await pool.query("DELETE FROM regions WHERE id = ANY($1::uuid[])", [ids.regions]);
      await pool.query("DELETE FROM organisations WHERE id = ANY($1::uuid[])", [ids.orgs]);
    } catch (err) {
      console.warn(`[cleanup] ${err.message}`);
    }
  }
  if (pool) await pool.end();
});

// What the old per-row call gave: the person's code in this event, with
// their own org's country as the fallback. NULL person, NULL code.
async function expectedCode(eventId, userId) {
  if (!userId) return null;
  const r = await pool.query(
    `SELECT event_rep_code($1, u.id, o.country_code) AS code
       FROM users u LEFT JOIN organisations o ON o.id = u.org_id
      WHERE u.id = $2`,
    [eventId, userId]);
  return r.rows[0]?.code ?? null;
}

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(res.status, 200, path);
  return res.json();
}

async function checkEvent(eventId) {
  const seen = new Set();
  const roster = await getJson(`/api/events/${eventId}/roster`);
  assert.ok(roster.length > 0);
  for (const row of roster) {
    assert.equal(row.country_code, await expectedCode(eventId, row.competitor_id), "roster country_code");
    assert.equal(row.partner_country, await expectedCode(eventId, row.partner_id), "roster partner_country");
    seen.add(row.country_code).add(row.partner_country);
  }
  const history = await getJson(`/api/events/${eventId}/history`);
  assert.ok(history.length > 0);
  const partnerOf = new Map(roster.map((r) => [r.competitor_id, r.partner_id]));
  for (const row of history) {
    assert.equal(row.country_code, await expectedCode(eventId, row.competitor_id), "history country_code");
    assert.equal(row.partner_country, await expectedCode(eventId, partnerOf.get(row.competitor_id)),
      "history partner_country");
  }

  // Scoreboard: round 2 is unscored, so it's all in the up-next queue,
  // and round 1 is the leaderboard.
  const board = await getJson(`/api/scoreboard/${eventId}`);
  assert.ok(board.upcoming.length > 0);
  for (const row of board.upcoming) {
    assert.equal(row.country_code, await expectedCode(eventId, row.competitor_id), "up-next country_code");
    assert.equal(row.partner_country, await expectedCode(eventId, row.partner_id), "up-next partner_country");
  }
  const leaderboard = await getJson(`/api/scoreboard/${eventId}/leaderboard`);
  const ranked = leaderboard.rounds.flatMap((r) => r.rankings);
  assert.ok(ranked.length > 0);
  for (const row of ranked) {
    assert.equal(row.country_code, await expectedCode(eventId, row.competitor_id), "leaderboard country_code");
  }

  // Archive recap, dive by dive.
  const recap = await getJson(`/api/archive/${eventId}/results`);
  assert.ok(recap.dives.length > 0);
  for (const row of recap.dives) {
    assert.equal(row.country_code, await expectedCode(eventId, row.competitor_id), "recap country_code");
    assert.equal(row.partner_country, await expectedCode(eventId, row.partner_id), "recap partner_country");
  }
  return seen;
}

test("synchro in a club meet: club, pending-club fallback, no club and a foreign partner", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const seen = await checkEvent(synchroEvent);
  // Make sure the fixture actually exercises the interesting branches,
  // otherwise the equality checks above prove very little.
  assert.ok(seen.has("ACT"), "active club code");
  assert.ok(seen.has("RCA"), "pending club falls back to the home country");
  assert.ok(seen.has("RCB"), "partner from another org keeps their own country");
});

test("individual in a region meet", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const seen = await checkEvent(regionEvent);
  assert.ok(seen.has("RRG"), "region short code");
  assert.ok(seen.has(null), "no partner, no partner code");
});

test("individual with no meet uses country codes", async (t) => {
  if (!dbReachable) { t.skip(); return; }
  const seen = await checkEvent(plainEvent);
  assert.ok(seen.has("RCA") && seen.has("RCB"));
});
