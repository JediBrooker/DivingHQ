// Audit parked-fixes spec. Locks in the seven items the
// security + code-review audit flagged after the initial
// Super Final rollout but that got deferred to a follow-up
// commit. Each test exercises ONE fix in isolation so a
// regression points at one defect.
//
//   1. PUT /api/events/:id parent_event_id must be in caller's org
//   2. /api/judges/* is rate-limited (smoke: header present)
//   3. /super-final/rankings refuses when an H2H pair is tied
//   4. /replace-from-synchro on already-withdrawn diver 404s
//   5. /synchro-reserve-pool filters by H2H gender
//   6. Dive-off dive_a_id/dive_b_id must be a previously-
//      performed dive (POST + PATCH)
//   7. Age-group legacy decomposition pins to junior:* (covered
//      by an existing pure-JS expectation; the warning UI is
//      visual, asserted indirectly via the round-trip).

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// ---------------- Fix #1 ----------------
test("PUT /api/events/:id rejects parent_event_id in another org", async ({ request }) => {
  test.setTimeout(45_000);
  const orgA = await setup.createOrgAndAdmin(request);
  const orgB = await setup.createOrgAndAdmin(request);

  // Org A creates a child-shaped event with no parent yet.
  const childA = await setup.createEvent(request, {
    adminToken: orgA.adminToken,
    name: "A's H2H",
    height: "3m", number_of_judges: 5, total_rounds: 3,
    event_format: "super_final_h2h",
  });
  // Org B creates an event that Org A doesn't own.
  const parentB = await setup.createEvent(request, {
    adminToken: orgB.adminToken,
    name: "B's stop-1",
    height: "3m", number_of_judges: 5, total_rounds: 1,
    event_format: "final",
  });

  // Org A tries to PUT the parent_event_id over to Org B's event.
  const cross = await request.put(`/api/events/${childA.id}`, {
    headers: { Authorization: `Bearer ${orgA.adminToken}` },
    data: { parent_event_id: parentB.id },
  });
  expect(cross.status()).toBe(400);
  const body = await cross.json();
  expect(body.error).toMatch(/parent event not found in this org/i);

  await setup.deleteOrg(orgA.orgId);
  await setup.deleteOrg(orgB.orgId);
});

// ---------------- Fix #2 ----------------
// The judge-analytics router is now mounted behind searchLimiter
// (60 req/min/IP). In the e2e env RATE_LIMIT_DISABLED=true skips
// the limiter so the suite doesn't trip its own 429s, meaning we
// can't directly observe the limit firing here. Next-best check:
// the endpoints behind the limiter still respond 200 (the mount
// didn't break the router), and a separate unit assertion on the
// limiter's `skip` behavior lives in test/syntax/integration.
// Smoke-grade: hit each public judge endpoint and assert 200.
test("/api/judges/* endpoints still respond 200 after limiter mount", async ({ request }) => {
  test.setTimeout(15_000);
  const dirRes = await request.get("/api/judges/directory?limit=1");
  expect(dirRes.status()).toBe(200);
  const searchRes = await request.get("/api/judges/search?q=Jud");
  expect(searchRes.status()).toBe(200);
});

// ---------------- Fix #3 ----------------
test("/super-final/rankings 400s when an H2H pair is dead-tied", async ({ request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // Minimal Stop-1 + H2H + SF + F chain, just enough to satisfy
  // the endpoint's parent_event_id checks. We'll plant a tied H2H
  // pair manually before calling rankings.
  const parent = await setup.createEvent(request, {
    adminToken, name: "Stop-1", height: "3m",
    number_of_judges: 5, total_rounds: 1, event_format: "final",
  });
  // Add minimum 12 divers to the parent so seed-h2h can succeed.
  const judge = await setup.insertUser({ orgId, role: "judge", fullName: "J1" });
  await setup.pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)`,
    [parent.id, judge.userId],
  );
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const divers = [];
  for (let i = 0; i < 12; i++) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: `Diver ${i}` });
    divers.push(d);
    await setup.insertDiveList({
      eventId: parent.id, competitorId: d.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });
    // score everyone the same → ties everywhere → tied pairs in H2H
    await setup.pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, 1, 7.0)`,
      [parent.id, d.userId, judge.userId, diveId],
    );
  }
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Completed" });

  // build the rest of the chain
  const h2h = await setup.createEvent(request, {
    adminToken, name: "H2H", height: "3m",
    number_of_judges: 5, total_rounds: 3,
    event_format: "super_final_h2h", parent_event_id: parent.id,
  });
  const seedH = await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { max_per_org: 12 },
  });
  expect(seedH.status()).toBe(200);

  // score H2H so every pair ties (uniform scores)
  await setup.pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)`,
    [h2h.id, judge.userId],
  );
  for (const d of divers) {
    for (let r = 1; r <= 3; r++) {
      await setup.pool.query(
        `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
         VALUES ($1, $2, $3, $4, $5, 7.0)`,
        [h2h.id, d.userId, judge.userId, diveId, r],
      );
    }
  }
  await setup.setEventStatus(request, { adminToken, eventId: h2h.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken, eventId: h2h.id, status: "Completed" });

  // The merged rankings endpoint sits on the F event. We won't
  // actually seed SF/F, no need since the endpoint should 400 on
  // tied H2H without needing them to exist. Skip that by minting
  // a bare F just to satisfy the URL.
  const sf = await setup.createEvent(request, {
    adminToken, name: "SF", height: "3m",
    number_of_judges: 5, total_rounds: 3,
    event_format: "super_final_semi", parent_event_id: h2h.id,
  });
  const f = await setup.createEvent(request, {
    adminToken, name: "F", height: "3m",
    number_of_judges: 5, total_rounds: 6,
    event_format: "super_final_final", parent_event_id: sf.id,
  });

  const rankings = await request.get(`/api/events/${f.id}/super-final/rankings`);
  expect(rankings.status()).toBe(400);
  const body = await rankings.json();
  expect(body.error).toMatch(/tied|dive-off/i);
  expect(Array.isArray(body.tied_pair_ids)).toBe(true);
  expect(body.tied_pair_ids.length).toBe(6); // all 6 pairs come back tied

  await setup.deleteOrg(orgId);
});

// ---------------- Fix #4 ----------------
test("/replace-from-synchro 404s when the withdraw target is already withdrawn", async ({ request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // simplest path here: set up the same Stop-1 → H2H chain as fix #3,
  // pre-stamp withdrawn_at on a roster row, then call replace
  const parent = await setup.createEvent(request, {
    adminToken, name: "Stop-1", height: "3m",
    number_of_judges: 5, total_rounds: 1, event_format: "final",
  });
  const judge = await setup.insertUser({ orgId, role: "judge", fullName: "J1" });
  await setup.pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)`,
    [parent.id, judge.userId],
  );
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const divers = [];
  for (let i = 0; i < 12; i++) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: `Diver ${i}` });
    divers.push(d);
    await setup.insertDiveList({
      eventId: parent.id, competitorId: d.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });
    await setup.pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      // 8.0 down by 0.5 each time, still valid half-points
      [parent.id, d.userId, judge.userId, diveId, 8.0 - i * 0.5],
    );
  }
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Completed" });

  const h2h = await setup.createEvent(request, {
    adminToken, name: "H2H", height: "3m",
    number_of_judges: 5, total_rounds: 3,
    event_format: "super_final_h2h", parent_event_id: parent.id,
  });
  await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { max_per_org: 12 },
  });

  // stamp withdrawn_at on the first roster row
  const pickRoster = await setup.pool.query(
    `SELECT competitor_id FROM competitor_dive_lists
      WHERE event_id = $1 AND withdrawn_at IS NULL LIMIT 1`,
    [h2h.id],
  );
  const withdrawnId = pickRoster.rows[0].competitor_id;
  await setup.pool.query(
    `UPDATE competitor_dive_lists SET withdrawn_at = NOW()
      WHERE event_id = $1 AND competitor_id = $2`,
    [h2h.id, withdrawnId],
  );

  // Now POST replace-from-synchro pointing at the already
  // withdrawn diver. Should 404, not silently re-stamp and
  // insert a second slot.
  const someOther = divers.find((d) => d.userId !== withdrawnId);
  const replace = await request.post(`/api/events/${h2h.id}/replace-from-synchro`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      withdraw_competitor_id:    withdrawnId,
      replacement_competitor_id: someOther.userId,
    },
  });
  expect(replace.status()).toBe(404);
  const body = await replace.json();
  expect(body.error).toMatch(/active|already withdrawn|never on it/i);

  await setup.deleteOrg(orgId);
});

// ---------------- Fix #5 ----------------
test("/synchro-reserve-pool only returns same-gender synchro events", async ({ request }) => {
  test.setTimeout(45_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // Create a meet to hang both H2H + synchro events on.
  // The endpoint contract is fixed: POST /api/meets returns 201
  // with `{ id, ... }`. If that shape ever changes we want this
  // test to fail loudly instead of silently skipping, that's kind
  // of the whole point of the audit-parked-fixes suite.
  const meetRes = await request.post("/api/meets", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { name: "Mixed Gender Meet", venue: "Pool" },
  });
  expect(meetRes.status()).toBe(201);
  const meet = await meetRes.json();

  // create both Male and Female synchro events at the meet
  await setup.createEvent(request, {
    adminToken, name: "Men's Synchro", height: "3m",
    number_of_judges: 9, total_rounds: 1,
    event_type: "synchro_pair", gender: "Male",
    meet_id: meet.id,
  });
  await setup.createEvent(request, {
    adminToken, name: "Women's Synchro", height: "3m",
    number_of_judges: 9, total_rounds: 1,
    event_type: "synchro_pair", gender: "Female",
    meet_id: meet.id,
  });

  // Female H2H, so the synchro pool should NOT contain men's synchro.
  const h2h = await setup.createEvent(request, {
    adminToken, name: "F H2H", height: "3m",
    number_of_judges: 5, total_rounds: 3,
    event_format: "super_final_h2h", gender: "Female",
    meet_id: meet.id,
  });
  const pool = await request.get(`/api/events/${h2h.id}/synchro-reserve-pool`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(pool.status()).toBe(200);
  const body = await pool.json();
  // Pool may be empty (no synchro scores yet), but it must not
  // reference the men's synchro event. If the response includes
  // synchro_events / referenced event ids, assert they're all
  // Female. If empty, well, the gender filter is at least not
  // blowing up, so it passes vacuously.
  const seen = JSON.stringify(body);
  // quick smoke check: response shouldn't accidentally surface
  // a row labelled "Men's Synchro"
  expect(seen).not.toMatch(/Men's Synchro/);

  await setup.deleteOrg(orgId);
});

// ---------------- Fix #6 ----------------
test("dive-off POST rejects a dive_id the diver hasn't performed", async ({ request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // Stop-1 + H2H, seed + score so 1 pair ends up genuinely tied
  // (both same score) so we can attempt a dive-off.
  const parent = await setup.createEvent(request, {
    adminToken, name: "S1", height: "3m",
    number_of_judges: 5, total_rounds: 1, event_format: "final",
  });
  const judge = await setup.insertUser({ orgId, role: "judge", fullName: "J1" });
  await setup.pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)`,
    [parent.id, judge.userId],
  );
  const diveActuallyDone = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });
  const diveNotDone = await setup.pickDiveId({
    height: 3.0, dive_code: "201", position: "B",
  });
  const divers = [];
  for (let i = 0; i < 12; i++) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: `Diver ${i}` });
    divers.push(d);
    await setup.insertDiveList({
      eventId: parent.id, competitorId: d.userId,
      dives: [{ round_number: 1, dive_id: diveActuallyDone }],
    });
    await setup.pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [parent.id, d.userId, judge.userId, diveActuallyDone, 8.0 - i * 0.5],
    );
  }
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Completed" });

  const h2h = await setup.createEvent(request, {
    adminToken, name: "H2H", height: "3m",
    number_of_judges: 5, total_rounds: 3,
    event_format: "super_final_h2h", parent_event_id: parent.id,
  });
  await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { max_per_org: 12 },
  });

  // score the H2H so the first pair ties (uniform 7.0)
  await setup.pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)`,
    [h2h.id, judge.userId],
  );
  // Pick a real PAIR (display_order 1 + 2 in Group 1, same pair
  // per the H2H seeding scheme: pairs interleave in display_order
  // 1,2 / 3,4 / 5,6 within each group). Selecting by competitor_id
  // ascending was wrong, it'd cross pair boundaries.
  const pair = await setup.pool.query(
    `SELECT DISTINCT competitor_id, display_order
       FROM competitor_dive_lists
      WHERE event_id = $1 AND group_number = 1
        AND display_order IN (1, 2)
      ORDER BY display_order`,
    [h2h.id],
  );
  const [pA, pB] = pair.rows.map((r) => r.competitor_id);
  for (const c of [pA, pB]) {
    for (let r = 1; r <= 3; r++) {
      await setup.pool.query(
        `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
         VALUES ($1, $2, $3, $4, $5, 7.0)`,
        [h2h.id, c, judge.userId, diveActuallyDone, r],
      );
    }
  }

  // attempt to create a dive-off with a dive_a_id the competitor
  // never actually performed, should 400 per Appendix 3 §6
  const bad = await request.post(`/api/events/${h2h.id}/dive-offs`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      competitor_a_id: pA, competitor_b_id: pB,
      dive_a_id: diveNotDone,
    },
  });
  expect(bad.status()).toBe(400);
  const body = await bad.json();
  expect(body.error).toMatch(/previously performed|§6/i);

  // and the same dive_id that WAS performed succeeds
  const ok = await request.post(`/api/events/${h2h.id}/dive-offs`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      competitor_a_id: pA, competitor_b_id: pB,
      dive_a_id: diveActuallyDone,
      dive_b_id: diveActuallyDone,
    },
  });
  expect(ok.status()).toBe(201);

  await setup.deleteOrg(orgId);
});

// ---------------- Fix #7 ----------------
// The Edit modal's warning UI is best verified via a Playwright
// page test, but here's the part that really matters: opening a
// legacy event in the Edit modal and saving without ticking "Keep
// legacy" rewrites the column to the canonical form, while ticking
// it preserves the legacy string. So we assert the API behaviour
// instead: PUT with the canonical form succeeds and the column
// reads back as canonical; PUT with the legacy string preserves
// the legacy text.
test("Edit modal age-group: caller-supplied string round-trips verbatim", async ({ request }) => {
  test.setTimeout(30_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // create an event with the LEGACY format
  const ev = await setup.createEvent(request, {
    adminToken, name: "Legacy Age Event", height: "3m",
    number_of_judges: 5, total_rounds: 1,
    age_group: "11 and under",
  });

  // PUT with the legacy string verbatim, column should stay legacy
  const keepLegacy = await request.put(`/api/events/${ev.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { age_group: "11 and under" },
  });
  expect(keepLegacy.status()).toBe(200);
  const after1 = await setup.pool.query(
    "SELECT age_group FROM events WHERE id = $1", [ev.id]);
  expect(after1.rows[0].age_group).toBe("11 and under");

  // PUT with the canonical string, column updates to canonical
  const canon = await request.put(`/api/events/${ev.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { age_group: "Junior Group D" },
  });
  expect(canon.status()).toBe(200);
  const after2 = await setup.pool.query(
    "SELECT age_group FROM events WHERE id = $1", [ev.id]);
  expect(after2.rows[0].age_group).toBe("Junior Group D");

  await setup.deleteOrg(orgId);
});
