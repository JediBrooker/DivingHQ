// GET /api/events/:id/me-meet-day against a real database: the standing,
// the medal targets and the "divers until you're up" count a diver sees on
// /me/meet/<event>. Two things the rehearsal found:
//
//   * Before anyone had scored, the page said the diver was in the lead
//     and every medal was "Already achieved". A place nobody holds yet
//     came back as reached, and so did one for a diver with no score.
//   * "N divers until you're up" went wrong across a round change. With
//     the active diver in the round before, it returned the diver's own
//     place in the order and stopped there, so a diver who dives 4th read
//     "4 divers" when 3 were ahead, and the count ignored everyone still
//     to dive in the round before.
//
// The route is mounted on its own with the signed-in diver taken from a
// header, the way manual-scores.integration.test.js does it. The *.integration
// name keeps it out of test:safe. Skips when Postgres isn't reachable.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config({ quiet: true });

let pool;
let dbReachable = false;
let server;
let port;
let orgId;
const divers = [];          // display order 1..4 every round
const judges = [];
let eventId;
let diveIds;

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
    await pool.query("SELECT 1");
  } catch (err) {
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }
  dbReachable = true;

  const sfx = crypto.randomBytes(4).toString("hex");
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0].id;
  orgId = await one(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, 'XX', $1, 'active') RETURNING id`, [`meetday-${sfx}`]);
  const user = (name) => one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', $2, $3, now()) RETURNING id`, [`${name}-${sfx}`.toLowerCase(), name, orgId]);
  for (const name of ["Ada", "Bea", "Cat", "Zoe"]) divers.push({ name, id: await user(name) });
  for (let j = 1; j <= 5; j++) judges.push(await user(`Judge${j}`));

  eventId = await one(
    `INSERT INTO events (org_id, name, gender, status, height, event_type, total_rounds, number_of_judges)
     VALUES ($1, 'Meet day queue', 'Mixed', 'Live', '3m', 'individual', 3, 5) RETURNING id`, [orgId]);
  for (let j = 0; j < judges.length; j++) {
    await pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)",
      [eventId, judges[j], j + 1]);
  }
  diveIds = (await pool.query(
    "SELECT id FROM dive_directory WHERE height = 3 AND NOT is_custom ORDER BY dive_code, id LIMIT 3")).rows.map((r) => r.id);
  for (let i = 0; i < divers.length; i++) {
    for (let round = 1; round <= 3; round++) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id, display_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [eventId, divers[i].id, round, diveIds[round - 1], i + 1]);
    }
  }

  const app = express();
  app.use(express.json());
  const verifyToken = (req, res, next) => {
    const id = req.headers["x-test-user"];
    if (!id) return res.status(401).json({ error: "no user" });
    req.user = { id, org_id: orgId, org_roles: ["diver"], is_system_admin: false, full_name: "Diver" };
    next();
  };
  const pass = (_req, _res, next) => next();
  app.use(require("../routes/competitor")({
    pool, verifyToken, requireOrgRole: () => pass, bulkWriteLimiter: pass, loadEventForEntries: pass,
  }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (dbReachable && orgId) {
    await pool.query("DELETE FROM events WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]);
    await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]);
  }
  if (pool) await pool.end();
});

async function meetDay(diver) {
  const res = await fetch(`http://127.0.0.1:${port}/api/events/${eventId}/me-meet-day`, {
    headers: { "X-Test-User": diver.id },
  });
  assert.equal(res.status, 200);
  return res.json();
}

// Every judge gives the dive the same mark.
async function scoreDive(diver, round, score) {
  for (const judgeId of judges) {
    await pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventId, diver.id, judgeId, diveIds[round - 1], round, score]);
  }
}

// What the Control Room leaves in event_live_state when it puts a dive up.
async function putUp(diver, round) {
  const payload = { event_id: eventId, competitor_id: diver.id, full_name: diver.name, round_number: round };
  await pool.query(
    `INSERT INTO event_live_state (event_id, active_diver_payload) VALUES ($1, $2::jsonb)
     ON CONFLICT (event_id) DO UPDATE SET active_diver_payload = EXCLUDED.active_diver_payload`,
    [eventId, JSON.stringify(payload)]);
}

async function reset() {
  await pool.query("DELETE FROM scores WHERE event_id = $1", [eventId]);
  await pool.query("DELETE FROM event_live_state WHERE event_id = $1", [eventId]);
}

test("no lead and no medals claimed for a diver with no score", async (t) => {
  if (!dbReachable) return t.skip("Postgres not reachable");
  await reset();
  const [ada, bea, , zoe] = divers;

  // Nobody has scored: no place, nothing to chase yet, but the field is
  // the four divers entered, not the nobody who has a total.
  let day = await meetDay(zoe);
  assert.equal(day.standing.rank, null);
  assert.equal(day.standing.total_competitors, 4);
  assert.deepEqual(day.targets, { gold: null, silver: null, bronze: null });

  // Ada is in. Zoë hasn't dived: gold is Ada's total to chase, and the
  // places nobody holds yet aren't Zoë's either.
  await scoreDive(ada, 1, 7);
  day = await meetDay(zoe);
  assert.equal(day.standing.rank, null);
  assert.equal(day.targets.gold.achieved, false);
  assert.ok(day.targets.gold.gap > 0);
  assert.ok(day.targets.gold.needs_avg > 0);
  assert.equal(day.targets.silver, null);
  assert.equal(day.targets.bronze, null);

  // Zoë scores below Ada, with only two totals so far: she holds second,
  // so silver and bronze are hers for now, gold isn't.
  await scoreDive(zoe, 1, 6);
  day = await meetDay(zoe);
  assert.equal(day.standing.rank, 2);
  assert.equal(day.targets.gold.achieved, false);
  assert.equal(day.targets.silver.achieved, true);
  assert.equal(day.targets.bronze.achieved, true);

  // Bea goes between them: Zoë is third.
  await scoreDive(bea, 1, 6.5);
  day = await meetDay(zoe);
  assert.equal(day.standing.rank, 3);
  assert.equal(day.targets.silver.achieved, false);
  assert.equal(day.targets.bronze.achieved, true);
  // The leader's own view is unchanged by any of this.
  day = await meetDay(ada);
  assert.equal(day.standing.rank, 1);
  assert.equal(day.targets.gold.achieved, true);
});

test("divers until you're up counts across a round change", async (t) => {
  if (!dbReachable) return t.skip("Postgres not reachable");
  await reset();
  const [ada, bea, cat, zoe] = divers;
  const until = async (diver) => (await meetDay(diver)).queue.divers_until_me;

  assert.equal(await until(zoe), null, "nothing is up yet");

  // Round 1 in order. The active diver counts until their dive is in.
  await putUp(ada, 1);
  assert.equal(await until(zoe), 3);
  assert.equal(await until(bea), 1);
  await scoreDive(ada, 1, 7);
  await putUp(bea, 1);
  assert.equal(await until(zoe), 2);
  assert.equal(await until(bea), 0, "Bea is up");
  await scoreDive(bea, 1, 7);
  // Bea's dive is in and still on the board: her next one is round 2,
  // with Cat and Zoë still to go in round 1 and Ada ahead of her in 2.
  assert.equal(await until(bea), 3);
  await putUp(cat, 1);
  assert.equal(await until(bea), 3);
  assert.equal(await until(zoe), 1);
  await scoreDive(cat, 1, 7);
  await putUp(zoe, 1);
  assert.equal(await until(zoe), 0, "Zoë is up");
  assert.equal(await until(bea), 2);

  // Zoë's round 1 is in, still on the board. Three dive before her in
  // round 2, not four.
  await scoreDive(zoe, 1, 7);
  assert.equal(await until(zoe), 3);
  assert.equal(await until(ada), 0, "Ada opens round 2, nobody is left before her");

  await putUp(ada, 2);
  assert.equal(await until(zoe), 3);
  await scoreDive(ada, 2, 7);
  assert.equal(await until(zoe), 2, "Ada's round 2 is in");
  await putUp(bea, 2);
  await scoreDive(bea, 2, 7);
  await putUp(cat, 2);
  await scoreDive(cat, 2, 7);
  await putUp(zoe, 2);
  await scoreDive(zoe, 2, 7);
  assert.equal(await until(zoe), 3, "end of round 2, same again");

  // The referee calls a redive on Zoë's round 2: her next dive is that
  // one again, and she's the one up.
  await pool.query(
    "UPDATE scores SET status = 'redive' WHERE event_id = $1 AND competitor_id = $2 AND round_number = 2",
    [eventId, zoe.id]);
  let day = await meetDay(zoe);
  assert.equal(day.next_dive.round_number, 2);
  assert.equal(day.queue.divers_until_me, 0);
  await pool.query(
    "UPDATE scores SET status = 'active' WHERE event_id = $1 AND competitor_id = $2 AND round_number = 2",
    [eventId, zoe.id]);
  day = await meetDay(zoe);
  assert.equal(day.next_dive.round_number, 3);

  // A diver who's withdrawn isn't in anyone's count.
  await pool.query(
    "UPDATE competitor_dive_lists SET withdrawn_at = now() WHERE event_id = $1 AND competitor_id = $2",
    [eventId, bea.id]);
  try {
    assert.equal(await until(zoe), 2);
  } finally {
    await pool.query(
      "UPDATE competitor_dive_lists SET withdrawn_at = NULL WHERE event_id = $1 AND competitor_id = $2",
      [eventId, bea.id]);
  }
});
