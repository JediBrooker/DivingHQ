// Integration coverage for lib/schedule-conflicts.js: SQL overlap
// math against a real Postgres test DB. Complements
// test/schedule-conflicts.test.js, which pins the JS contract with a
// fake pool stub and a synthetic detector row shape.
//
// SCOPE
// -----
// The detector itself is one (large) SQL query with four UNION ALL
// arms (judge / board / diver / referee), a hoisted event_divers CTE,
// and a soft-vs-hard severity CASE. Unit-stubbing the pool can't prove
// the SQL actually computes overlaps the way the docs say it does;
// this file inserts real schedule_blocks / events / dive lists and
// asserts the rows detectConflicts() returns.
//
// What every test does, in shape:
//   1. Build an org + meet + pool + a couple of events as fixtures
//      (helpers `makeOrg`, `makeMeet`, `makeEvent`, …) all using
//      direct pool.query() inserts. The HTTP layer isnt in play, so
//      these are SQL-level integration tests.
//   2. Insert exactly the two schedule_blocks the scenario needs and
//      whatever resource membership (event_judges row, dive-list row,
//      team_member row, …) the arm under test reads from.
//   3. Call detectConflicts(meetId, pool) and assert on the returned
//      Conflict array, usually count, resource_kind, severity, and
//      that the right user_ids are referenced.
//
// REGRESSION GUARD
// ----------------
// One of these scenarios specifically guards the hoisted event_divers
// CTE from commit 02f52e7. The "diver double-booked across events"
// test would fail if the JOIN between (pairs) and (event_divers) was
// dropped or its filters changed, exactly the kind of regression
// that could re-introduce the O(pairs × dive_list_rows) hot path.
//
// SKIPPING
// --------
// If Postgres isn't reachable, the suite self-skips with a console
// warning (same convention as test/integration.test.js). That keeps
// `npm test` green for a dev with no local DB while still running in
// CI where the Postgres service container is up.
//
// WHAT THIS FILE DELIBERATELY DOES NOT COVER
// ------------------------------------------
//   * Concurrent-writer locking. lib/schedule-conflicts.js is
//     read-only and acquires no row locks; the FOR UPDATE block-row
//     lock the API depends on lives in routes/sessions.js
//     (POST /api/blocks/reflow). Locking is therefore a route-level
//     concern, not a detector-level one, and belongs to a seperate
//     route-integration test.
//   * Dismissed-conflict flag flow. Pinned by the JS-stub tests in
//     test/schedule-conflicts.test.js; re-asserting against a real
//     dismissed_conflicts row here wouldn't exercise different SQL.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

require("dotenv").config();
const { Pool } = require("pg");

const { detectConflicts } = require("../lib/schedule-conflicts");

// ---------------------------------------------------------------
// Pool setup: mirrors test/integration.test.js so a single
// .env / CI config feeds both suites. Skips with a warning when
// the DB is unreachable instead of failing.
// ---------------------------------------------------------------
let dbReachable = true;
let pool;

// Track fixtures so the after() cleanup can drop them. Even though
// each test() builds its own org and the org cascades to most of
// the world, we still hold onto the org ids so cleanup can be
// best-effort, just in case a test crashes mid-fixture.
const createdOrgIds = [];

before(async () => {
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user:     process.env.DB_USER     || process.env.PGUSER,
        host:     process.env.DB_HOST     || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port:     process.env.DB_PORT     || process.env.PGPORT,
      });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    dbReachable = false;
    console.warn(`[skip] schedule-conflicts.integration — Postgres not reachable: ${err.message}`);
  }
});

after(async () => {
  if (!pool) return;
  if (dbReachable) {
    // organisations cascades to clubs, meets, events, teams, and
    // boards, but users.org_id is ON DELETE RESTRICT (so an admin
    // can't accidentally drop an org and orphan its accounts). So
    // we delete users first, then org cascades the rest.
    // meets → sessions → schedule_blocks all cascade. event_judges
    // and competitor_dive_lists hang off events → cascade.
    for (const orgId of createdOrgIds) {
      try {
        await pool.query("DELETE FROM users          WHERE org_id = $1", [orgId]);
        await pool.query("DELETE FROM organisations  WHERE id     = $1", [orgId]);
      } catch (err) {
        console.warn(`[cleanup] org ${orgId}: ${err.message}`);
      }
    }
  }
  await pool.end();
});

// ---------------------------------------------------------------
// Fixture helpers: direct SQL. We bypass the HTTP layer because
// this file is about exercising the detector SQL, not the API.
// Every helper returns the inserted row's id so callers can wire
// up referential graphs without re-SELECTing.
// ---------------------------------------------------------------

// Random tag for unique names, since slugs and usernames have UNIQUE
// indexes, and parallel test runs (or a previous failed run that
// didn't clean up) would otherwise collide.
function tag() {
  return crypto.randomBytes(4).toString("hex");
}

async function makeOrg(suffix = "") {
  const t = tag();
  const r = await pool.query(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id`,
    [`Test Org ${t}${suffix}`, "TST", `test-${t}${suffix}`],
  );
  const id = r.rows[0].id;
  createdOrgIds.push(id);
  return id;
}

async function makeUser(orgId, fullName) {
  const t = tag();
  const r = await pool.query(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [`u-${t}`, "x", fullName, orgId],
  );
  return r.rows[0].id;
}

async function makeMeet(orgId) {
  const t = tag();
  const r = await pool.query(
    `INSERT INTO meets (org_id, name, start_date, end_date)
     VALUES ($1, $2, '2026-05-18', '2026-05-19') RETURNING id`,
    [orgId, `Test Meet ${t}`],
  );
  return r.rows[0].id;
}

async function makeEvent(orgId, meetId, { height = "3m", name = "Test Event" } = {}) {
  const r = await pool.query(
    `INSERT INTO events
       (org_id, meet_id, name, gender, height, number_of_judges, event_type)
     VALUES ($1, $2, $3, 'Mixed', $4, 5, 'individual')
     RETURNING id`,
    [orgId, meetId, `${name} ${tag()}`, height],
  );
  return r.rows[0].id;
}

async function makeSession(meetId, { refereeUserId = null, pool: poolName = "Main pool" } = {}) {
  const r = await pool.query(
    `INSERT INTO sessions (meet_id, name, session_date, pool, referee_user_id)
     VALUES ($1, $2, '2026-05-18', $3, $4) RETURNING id`,
    [meetId, `Sess ${tag()}`, poolName, refereeUserId],
  );
  return r.rows[0].id;
}

async function makeBlock(
  sessionId,
  { startsAt, endsAt, eventId = null, label = "Block", boardIds = [], blockType = "event_start" } = {},
) {
  const r = await pool.query(
    `INSERT INTO schedule_blocks
       (session_id, block_type, label, starts_at, ends_at, board_ids, event_id)
     VALUES ($1, $2::schedule_block_type, $3, $4, $5, $6::uuid[], $7)
     RETURNING id`,
    [sessionId, blockType, label, startsAt, endsAt, boardIds, eventId],
  );
  return r.rows[0].id;
}

async function assignJudge(eventId, judgeId, judgeNumber = 1) {
  await pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)`,
    [eventId, judgeId, judgeNumber],
  );
}

async function pickDive() {
  // dive_directory is seeded by init.sql; any row is fine for
  // wiring up competitor_dive_lists.
  const r = await pool.query(`SELECT id FROM dive_directory LIMIT 1`);
  assert.ok(r.rows.length, "dive_directory must have at least one row");
  return r.rows[0].id;
}

async function enterDiver(eventId, competitorId, { partnerId = null, teamId = null, withdrawnAt = null, round = 1 } = {}) {
  const diveId = await pickDive();
  const r = await pool.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, partner_id, team_id, dive_id, round_number, withdrawn_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [eventId, competitorId, partnerId, teamId, diveId, round, withdrawnAt],
  );
  return r.rows[0].id;
}

async function makeTeam(orgId, memberIds) {
  const r = await pool.query(
    `INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id`,
    [orgId, `Team ${tag()}`],
  );
  const teamId = r.rows[0].id;
  for (const uid of memberIds) {
    await pool.query(
      `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`,
      [teamId, uid],
    );
  }
  return teamId;
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------
// Each test() builds its own org so the per-test fixture graph is
// independent and the cleanup pass can drop one org at a time. We
// run them sequentially (node:test's default for sibling test() at
// the top level) since they share the connection pool.

test("overlap by 1 minute → board_conflict on overlapping blocks", async (t) => {
  if (!dbReachable) return t.skip("no test DB");

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const boardR = await pool.query(
    `INSERT INTO boards (org_id, pool_name, height) VALUES ($1, 'Main pool', '3m') RETURNING id`,
    [orgId],
  );
  const boardId = boardR.rows[0].id;
  const sessionA = await makeSession(meetId);
  const sessionB = await makeSession(meetId);
  // Block A ends 10:00, block B starts 09:59, an overlap of one minute.
  // Both claim the same board, which is the resource collision.
  const blockA = await makeBlock(sessionA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    boardIds: [boardId],
  });
  const blockB = await makeBlock(sessionB, {
    startsAt: "2026-05-18T09:59:00Z",
    endsAt:   "2026-05-18T11:00:00Z",
    boardIds: [boardId],
  });

  const conflicts = await detectConflicts(meetId, pool);
  const board = conflicts.filter((c) => c.resource_kind === "board");
  assert.equal(board.length, 1, "exactly one board conflict expected");
  assert.deepEqual(board[0].resource_ids, [boardId]);
  // both blocks are referenced but order depends on the SQL's b.id >
  // a.id pair ordering, so check membership rather than position
  const ids = [board[0].block_a.id, board[0].block_b.id].sort();
  assert.deepEqual(ids, [blockA, blockB].sort());
  assert.equal(board[0].severity, "hard");
});

test("back-to-back at the same pool → no conflict (exclusive end)", async (t) => {
  if (!dbReachable) return t.skip("no test DB");

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const boardR = await pool.query(
    `INSERT INTO boards (org_id, pool_name, height) VALUES ($1, 'Main pool', '3m') RETURNING id`,
    [orgId],
  );
  const boardId = boardR.rows[0].id;
  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  // A ends 10:00, B starts 10:00. The overlap predicate is
  // a.starts < b.ends AND b.starts < a.ends, strict <, so touching
  // boundaries don't overlap
  await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    boardIds: [boardId],
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T10:00:00Z",
    endsAt:   "2026-05-18T11:00:00Z",
    boardIds: [boardId],
  });

  const conflicts = await detectConflicts(meetId, pool);
  const board = conflicts.filter((c) => c.resource_kind === "board");
  assert.equal(board.length, 0, "back-to-back blocks must not produce a board conflict");
});

test("judge double-booked across overlapping events → judge_conflict", async (t) => {
  if (!dbReachable) return t.skip("no test DB");

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const judgeId = await makeUser(orgId, "Judge X");
  const eventA = await makeEvent(orgId, meetId, { name: "Event A" });
  const eventB = await makeEvent(orgId, meetId, { name: "Event B" });
  await assignJudge(eventA, judgeId);
  await assignJudge(eventB, judgeId);

  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  // overlap 09:30-10:00, judge is on both panels
  await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    eventId: eventA,
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T09:30:00Z",
    endsAt:   "2026-05-18T10:30:00Z",
    eventId: eventB,
  });

  const conflicts = await detectConflicts(meetId, pool);
  const judge = conflicts.filter((c) => c.resource_kind === "judge");
  assert.equal(judge.length, 1, "exactly one judge conflict expected");
  assert.deepEqual(judge[0].resource_ids, [judgeId]);
  assert.equal(judge[0].severity, "hard");
  const eventIds = [judge[0].block_a.event_id, judge[0].block_b.event_id].sort();
  assert.deepEqual(eventIds, [eventA, eventB].sort());
});

test("judge soft-warning when gap < 15 min and no overlap → severity 'soft'", async (t) => {
  if (!dbReachable) return t.skip("no test DB");

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const judgeId = await makeUser(orgId, "Judge Y");
  const eventA = await makeEvent(orgId, meetId, { name: "Event A" });
  const eventB = await makeEvent(orgId, meetId, { name: "Event B" });
  await assignJudge(eventA, judgeId);
  await assignJudge(eventB, judgeId);

  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  // A ends 09:30, B starts 09:40, a 10-minute transit gap, inside
  // the SOFT_JUDGE_GAP_MINUTES window but with no actual overlap.
  await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T09:30:00Z",
    eventId: eventA,
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T09:40:00Z",
    endsAt:   "2026-05-18T10:10:00Z",
    eventId: eventB,
  });

  const conflicts = await detectConflicts(meetId, pool);
  const judge = conflicts.filter((c) => c.resource_kind === "judge");
  assert.equal(judge.length, 1);
  assert.equal(judge[0].severity, "soft");
  assert.deepEqual(judge[0].resource_ids, [judgeId]);
});

test("diver double-booked across overlapping events → diver_conflict (event_divers CTE)", async (t) => {
  if (!dbReachable) return t.skip("no test DB");
  // this is the regression guard for commit 02f52e7. The detector
  // SQL hoists an event_divers CTE that's hash-joined against the
  // overlapping-pair set. If that hoist is broken (wrong filter,
  // wrong join key, lost UNION arm) this test fails because the
  // diver_conflicts CTE no longer yields rows

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const diverY = await makeUser(orgId, "Diver Y");
  const eventA = await makeEvent(orgId, meetId, { name: "Event A" });
  const eventB = await makeEvent(orgId, meetId, { name: "Event B" });
  // Diver Y entered in both events as the lead competitor.
  await enterDiver(eventA, diverY);
  await enterDiver(eventB, diverY);

  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    eventId: eventA,
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T09:30:00Z",
    endsAt:   "2026-05-18T10:30:00Z",
    eventId: eventB,
  });

  const conflicts = await detectConflicts(meetId, pool);
  const diver = conflicts.filter((c) => c.resource_kind === "diver");
  assert.equal(diver.length, 1, "diver double-booking must surface exactly one diver_conflict");
  assert.deepEqual(diver[0].resource_ids, [diverY]);
  const eventIds = [diver[0].block_a.event_id, diver[0].block_b.event_id].sort();
  assert.deepEqual(eventIds, [eventA, eventB].sort());
});

test("synchro partner double-booked across events → diver_conflict (partner-side)", async (t) => {
  if (!dbReachable) return t.skip("no test DB");
  // Diver Y is the lead competitor in event B but the partner in
  // event A. The event_divers UNION must pick Y up from BOTH the
  // competitor_id and partner_id arms. If the partner arm gets
  // dropped, this test fails.

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const someoneElse = await makeUser(orgId, "Partner Lead");
  const diverY = await makeUser(orgId, "Diver Y");
  const eventA = await makeEvent(orgId, meetId, { name: "Synchro A" });
  const eventB = await makeEvent(orgId, meetId, { name: "Solo B" });
  // Event A: someoneElse is the competitor, Y is the partner.
  await enterDiver(eventA, someoneElse, { partnerId: diverY });
  // Event B: Y enters as the competitor.
  await enterDiver(eventB, diverY);

  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    eventId: eventA,
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T09:30:00Z",
    endsAt:   "2026-05-18T10:30:00Z",
    eventId: eventB,
  });

  const conflicts = await detectConflicts(meetId, pool);
  // Filter to conflicts involving Y. Other entries (e.g. a
  // diver_conflict for someoneElse) shouldn't fire because
  // someoneElse only appears in event A.
  const diver = conflicts.filter(
    (c) => c.resource_kind === "diver" && c.resource_ids.includes(diverY),
  );
  assert.equal(diver.length, 1, "partner-side membership must surface a diver conflict");
  assert.ok(diver[0].resource_ids.includes(diverY));
});

test("team member double-booked across events → diver_conflict", async (t) => {
  if (!dbReachable) return t.skip("no test DB");
  // Y is in a team that's entered in event A, and entered as a solo
  // competitor in event B. The team_members UNION arm in
  // event_divers is the only path that picks Y up for event A. If
  // it's dropped, this test fails.

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const teamLead = await makeUser(orgId, "Team Lead");
  const diverY = await makeUser(orgId, "Team Member Y");
  const teamId = await makeTeam(orgId, [diverY, teamLead]);
  const eventA = await makeEvent(orgId, meetId, { name: "Team A" });
  const eventB = await makeEvent(orgId, meetId, { name: "Solo B" });
  // Event A's dive list row references the team (competitor_id is
  // the team's lead, team_id pulls in every team_member).
  await enterDiver(eventA, teamLead, { teamId });
  // Event B: Y as solo competitor.
  await enterDiver(eventB, diverY);

  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    eventId: eventA,
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T09:30:00Z",
    endsAt:   "2026-05-18T10:30:00Z",
    eventId: eventB,
  });

  const conflicts = await detectConflicts(meetId, pool);
  const diver = conflicts.filter(
    (c) => c.resource_kind === "diver" && c.resource_ids.includes(diverY),
  );
  assert.equal(diver.length, 1, "team-member membership must surface a diver conflict");
});

test("withdrawn diver in one event → no diver_conflict", async (t) => {
  if (!dbReachable) return t.skip("no test DB");
  // The event_divers CTE filters on dl.withdrawn_at IS NULL. Y is
  // entered in both events but withdrawn from event B, so the
  // intersection comes up empty.

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const diverY = await makeUser(orgId, "Withdrawn Y");
  const eventA = await makeEvent(orgId, meetId, { name: "Event A" });
  const eventB = await makeEvent(orgId, meetId, { name: "Event B" });
  await enterDiver(eventA, diverY);
  await enterDiver(eventB, diverY, { withdrawnAt: "2026-05-17T00:00:00Z" });

  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    eventId: eventA,
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T09:30:00Z",
    endsAt:   "2026-05-18T10:30:00Z",
    eventId: eventB,
  });

  const conflicts = await detectConflicts(meetId, pool);
  const diver = conflicts.filter((c) => c.resource_kind === "diver");
  assert.equal(diver.length, 0, "withdrawn dive-list row must not produce a diver conflict");
});

test("cross-meet isolation — detector scope is the meet id", async (t) => {
  if (!dbReachable) return t.skip("no test DB");
  // Two separate meets in the same org. M1 has one block, M2 has
  // an overlapping block at the same pool, with the same judge on
  // both events. detectConflicts(M1) must NOT surface anything
  // from M2.

  const orgId = await makeOrg();
  const meetM1 = await makeMeet(orgId);
  const meetM2 = await makeMeet(orgId);
  const sharedJudge = await makeUser(orgId, "Shared Judge");
  const eventM1 = await makeEvent(orgId, meetM1, { name: "M1 Event" });
  const eventM2 = await makeEvent(orgId, meetM2, { name: "M2 Event" });
  await assignJudge(eventM1, sharedJudge);
  await assignJudge(eventM2, sharedJudge);

  const sessM1 = await makeSession(meetM1);
  const sessM2 = await makeSession(meetM2);
  await makeBlock(sessM1, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    eventId: eventM1,
  });
  await makeBlock(sessM2, {
    startsAt: "2026-05-18T09:30:00Z",
    endsAt:   "2026-05-18T10:30:00Z",
    eventId: eventM2,
  });

  const m1Conflicts = await detectConflicts(meetM1, pool);
  assert.equal(m1Conflicts.length, 0, "M1 has only one block; cross-meet pairs must not appear");
  const m2Conflicts = await detectConflicts(meetM2, pool);
  assert.equal(m2Conflicts.length, 0, "M2 has only one block; cross-meet pairs must not appear");
});

test("fingerprint stability — same fixture, two runs, identical hashes", async (t) => {
  if (!dbReachable) return t.skip("no test DB");

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const judgeId = await makeUser(orgId, "Stable Judge");
  const eventA = await makeEvent(orgId, meetId, { name: "Event A" });
  const eventB = await makeEvent(orgId, meetId, { name: "Event B" });
  await assignJudge(eventA, judgeId);
  await assignJudge(eventB, judgeId);
  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    eventId: eventA,
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T09:30:00Z",
    endsAt:   "2026-05-18T10:30:00Z",
    eventId: eventB,
  });

  const run1 = await detectConflicts(meetId, pool);
  const run2 = await detectConflicts(meetId, pool);
  assert.equal(run1.length, run2.length, "two detector runs must return the same number of conflicts");
  for (let i = 0; i < run1.length; i++) {
    assert.equal(
      run1[i].fingerprint,
      run2[i].fingerprint,
      `fingerprint at index ${i} must be stable across runs`,
    );
  }
});

test("fingerprint changes when block time shifts (membership stays the same shape)", async (t) => {
  if (!dbReachable) return t.skip("no test DB");
  // Shifting a block by 1 minute keeps the same overlapping pair,
  // and the same resource set, so the *fingerprint of the resource
  // membership* should be identical. But mutating block_a's start
  // makes the pair re-emerge with a different overlap window. We
  // assert the row count stays positive and the fingerprint of the
  // pair-with-time changes only if membership changes. To do that,
  // we change the SET of overlapping judges: add a
  // second judge to both panels and re-run. The fingerprint then
  // covers two ids and must differ from the one-judge run.

  const orgId = await makeOrg();
  const meetId = await makeMeet(orgId);
  const j1 = await makeUser(orgId, "Judge 1");
  const j2 = await makeUser(orgId, "Judge 2");
  const eventA = await makeEvent(orgId, meetId, { name: "Event A" });
  const eventB = await makeEvent(orgId, meetId, { name: "Event B" });
  await assignJudge(eventA, j1, 1);
  await assignJudge(eventB, j1, 1);
  const sessA = await makeSession(meetId);
  const sessB = await makeSession(meetId);
  const blockA = await makeBlock(sessA, {
    startsAt: "2026-05-18T09:00:00Z",
    endsAt:   "2026-05-18T10:00:00Z",
    eventId: eventA,
  });
  await makeBlock(sessB, {
    startsAt: "2026-05-18T09:30:00Z",
    endsAt:   "2026-05-18T10:30:00Z",
    eventId: eventB,
  });

  const before = await detectConflicts(meetId, pool);
  const beforeJudge = before.find((c) => c.resource_kind === "judge");
  assert.ok(beforeJudge, "baseline run must yield a judge conflict");

  // shift blockA's start by one minute. Does NOT change membership;
  // fingerprint must remain stable for the same resource set
  await pool.query(
    `UPDATE schedule_blocks SET starts_at = $1 WHERE id = $2`,
    ["2026-05-18T09:01:00Z", blockA],
  );
  const afterShift = await detectConflicts(meetId, pool);
  const afterShiftJudge = afterShift.find((c) => c.resource_kind === "judge");
  assert.ok(afterShiftJudge);
  assert.equal(
    afterShiftJudge.fingerprint,
    beforeJudge.fingerprint,
    "time shift without membership change must keep fingerprint stable",
  );

  // now add a second judge to both panels: membership changes,
  // fingerprint must change
  await assignJudge(eventA, j2, 2);
  await assignJudge(eventB, j2, 2);
  const afterAdd = await detectConflicts(meetId, pool);
  const afterAddJudge = afterAdd.find((c) => c.resource_kind === "judge");
  assert.ok(afterAddJudge);
  assert.notEqual(
    afterAddJudge.fingerprint,
    beforeJudge.fingerprint,
    "adding a judge to the panel must change the resource fingerprint",
  );
});
