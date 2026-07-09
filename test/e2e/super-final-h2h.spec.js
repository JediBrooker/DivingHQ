// Super Final: Head-to-Head seeding + results
// (Diving World Cup 2026, Appendix 3 §1-2 + §6, see
// docs/2026.03.05-…-Super-Final…pdf).
//
// Covers the Phase-2 endpoints:
//
//   POST /api/events/:id/seed-h2h           commit pairs
//   GET  /api/events/:id/seed-h2h/preview   read-only preview
//   GET  /api/events/:id/super-final/h2h-results  pair winners
//
// Setup: 6 federations × 4 divers (24 divers total) entered in
// a parent-stage "final" event, each with a 3-round dive list.
// Scores are spread so:
//
//   - 4 of Federation A's divers would qualify in the global
//     top-9 with no cap; max_per_org=2 (Appendix 3 §1.1 /
//     WC Rule 1.4) drops 2 of them in favour of divers from
//     B/C/D/E/F so the top-12 ends up with at most 2 per
//     federation.
//
// 6 feds × max-2 = 12 max, so we need at least that many feds for
// the cap to leave 12 qualifiers. With 6 feds and 4 divers each,
// every fed contributes exactly 2 and the bracket fills.
//
// We then verify pair structure (12v1, 11v2, …, 7v6 by rank
// within the cap-applied top 12), group assignment per
// Appendix 3 §2.1.1, and that h2h-results returns 6 winners
// with totals once the H2H stage is scored.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// Helper: registers a fresh org via the public API and returns
// adminToken/orgId. Mirrors createOrgAndAdmin, just returns enough
// detail to spawn N divers under that org.
async function makeFederation(request, label) {
  return await setup.createOrgAndAdmin(request, {
    orgName: `E2E Fed ${label} ${setup.rand()}`,
    countryCode: label.padStart(3, "X"),
  });
}

// Insert a synthetic 5-judge panel + per-diver scores for a
// list of (competitor_id, score) tuples. Assumes total_rounds=3.
//
// Scoring tweak: every rank gets a unique TRIMMED total by
// varying the score across rounds 1, 2, 3 (each round picks up
// the rank delta). Specifically:
//
//   round 1 → all five judges score `roundA`
//   round 2 → all five judges score `roundB`
//   round 3 → all five judges score `roundC`
//
// where roundA/B/C are 0.5 increments derived from rank so the
// 3-round sum (with calc_event_dive_points trim, since every judge
// agreed, kept sum = 3 × score) is monotonic across ranks. Avoids
// the "more divers than 0.5 increments" problem.
async function scoreParentEvent({ eventId, divers, dive_id, judgeUserIds }) {
  for (let i = 0; i < judgeUserIds.length; i++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, judge_id) DO NOTHING`,
      [eventId, judgeUserIds[i], i + 1],
    );
  }
  for (const { competitorId, rank } of divers) {
    // Total dive-points (trimmed sum × DD) is monotonic in rank.
    // Use 3 rounds of evenly-decreasing scores so sum-over-rounds
    // gives 24 distinct totals.
    //
    // Score per round in 0.5 increments. We want rank N to score
    // strictly more than rank N+1 across the round triple.
    // Encode rank in base 17 across 3 rounds, each digit is in
    // [0..16] which maps to a 0.5-increment score in [2.0..10.0].
    // 17^3 = 4913 distinct codes, way more than enough for 24.
    //
    // For deterministic ordering, higher rank = higher score, so:
    //   code = (24 - rank)  → larger for better divers
    //   round1 = base-17 high digit
    //   round2 = mid digit
    //   round3 = low digit
    const code = 24 - rank; // rank 1 → 23, rank 24 → 0
    const r1 = Math.floor(code / 100) % 17; // (always 0 for code < 100)
    const r2 = Math.floor(code / 10) % 17;
    const r3 = code % 10;
    // Convert digit (0..16) → score (2.0..10.0 in 0.5 steps) with bias.
    // We use scaled = 2.0 + 0.5*digit (so 0 → 2.0, 16 → 10.0).
    const scoreOf = (digit) => Math.min(10, 2.0 + 0.5 * digit);
    const roundScores = [scoreOf(r1), scoreOf(r2), scoreOf(r3)];
    for (let round = 1; round <= 3; round++) {
      const s = roundScores[round - 1];
      // All 5 judges score the same value, so trim drops one high
      // + one low, keeps three identical → kept sum = 3 × s.
      for (const judgeUserId of judgeUserIds) {
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (event_id, competitor_id, round_number, judge_id)
           DO UPDATE SET score = EXCLUDED.score`,
          [eventId, competitorId, judgeUserId, dive_id, round, s],
        );
      }
    }
  }
}

test("super-final H2H: per-fed cap, pair structure, group assignment", async ({ request }) => {
  test.setTimeout(120_000);

  // ---- 6 federations with 4 divers each (24 total) ----------
  // Federation A's divers all rank in the global top 8 before
  // the cap kicks in; B/C/D/E/F each have 1-2 strong divers.
  const fedA = await makeFederation(request, "AAA");
  const fedB = await makeFederation(request, "BBB");
  const fedC = await makeFederation(request, "CCC");
  const fedD = await makeFederation(request, "DDD");
  const fedE = await makeFederation(request, "EEE");
  const fedF = await makeFederation(request, "FFF");

  const allFeds = [fedA, fedB, fedC, fedD, fedE, fedF];
  const FED_LABELS = ["A","B","C","D","E","F"];

  // 4 divers per federation, named so we can assert by name.
  const divers = []; // { userId, full_name, fedIdx, withinFed, scoreFloor }
  for (let f = 0; f < allFeds.length; f++) {
    for (let i = 0; i < 4; i++) {
      const fed = allFeds[f];
      const u = await setup.insertUser({
        orgId:    fed.orgId,
        role:     "diver",
        fullName: `Fed${FED_LABELS[f]} Diver ${i + 1}`,
      });
      divers.push({
        userId:    u.userId,
        full_name: `Fed${FED_LABELS[f]} Diver ${i + 1}`,
        fedIdx:    f,
        username:  u.username,
        withinFed: i,
      });
    }
  }

  // ---- Parent stage: create as a "final" in fedA's org ------
  // (the H2H later will be in fedA's org too, single host)
  const parent = await setup.createEvent(request, {
    adminToken: fedA.adminToken,
    name: "E2E Parent Stop1 Final",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "final",
  });

  // 5-judge panel for the parent.
  const judgeUserIds = [];
  for (let j = 0; j < 5; j++) {
    const ju = await setup.insertUser({ orgId: fedA.orgId, role: "judge", fullName: `Parent Judge ${j+1}` });
    judgeUserIds.push(ju.userId);
  }

  // Pick a 3m forward 1.5 (101B), just needs to exist in the seed.
  const dive_id = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });

  // Insert dive-list rows for every diver (3 rounds of the same
  // dive, since the H2H seed copies these forward).
  for (const d of divers) {
    await setup.insertDiveList({
      eventId:      parent.id,
      competitorId: d.userId,
      dives: [
        { round_number: 1, dive_id },
        { round_number: 2, dive_id },
        { round_number: 3, dive_id },
      ],
    });
  }

  // ---- Score assignment so the cap actually bites ----------
  // Strategy: assign scoreFloor by global rank (lower = better).
  // Worked out by hand:
  //   Rank  1: FedA Diver 1
  //   Rank  2: FedA Diver 2
  //   Rank  3: FedA Diver 3   (3rd A, DROPPED by cap)
  //   Rank  4: FedA Diver 4   (4th A, DROPPED by cap)
  //   Rank  5: FedB Diver 1
  //   Rank  6: FedB Diver 2
  //   Rank  7: FedC Diver 1
  //   Rank  8: FedC Diver 2
  //   Rank  9: FedD Diver 1
  //   Rank 10: FedE Diver 1
  //   Rank 11: FedF Diver 1
  //   Rank 12: FedD Diver 2
  //   Rank 13: FedE Diver 2
  //   Rank 14: FedF Diver 2
  //   Rank 15+: rest, all capped or below the line.
  //
  // After cap with max_per_org=2, the kept top-12 in rank order:
  //   FedA1, FedA2, FedB1, FedB2, FedC1, FedC2,
  //   FedD1, FedE1, FedF1, FedD2, FedE2, FedF2
  // i.e. each of the 6 federations contributes exactly 2.
  const RANK_ORDER = [
    { fedIdx: 0, withinFed: 0 }, // 1: FedA Diver 1
    { fedIdx: 0, withinFed: 1 }, // 2: FedA Diver 2
    { fedIdx: 0, withinFed: 2 }, // 3: FedA Diver 3 (capped)
    { fedIdx: 0, withinFed: 3 }, // 4: FedA Diver 4 (capped)
    { fedIdx: 1, withinFed: 0 }, // 5: FedB Diver 1
    { fedIdx: 1, withinFed: 1 }, // 6: FedB Diver 2
    { fedIdx: 2, withinFed: 0 }, // 7: FedC Diver 1
    { fedIdx: 2, withinFed: 1 }, // 8: FedC Diver 2
    { fedIdx: 3, withinFed: 0 }, // 9: FedD Diver 1
    { fedIdx: 4, withinFed: 0 }, //10: FedE Diver 1
    { fedIdx: 5, withinFed: 0 }, //11: FedF Diver 1
    { fedIdx: 3, withinFed: 1 }, //12: FedD Diver 2
    { fedIdx: 4, withinFed: 1 }, //13: FedE Diver 2
    { fedIdx: 5, withinFed: 1 }, //14: FedF Diver 2
    { fedIdx: 1, withinFed: 2 }, //15: FedB Diver 3 (capped)
    { fedIdx: 1, withinFed: 3 }, //16: FedB Diver 4 (capped)
    { fedIdx: 2, withinFed: 2 }, //17: FedC Diver 3 (capped)
    { fedIdx: 2, withinFed: 3 }, //18: FedC Diver 4 (capped)
    { fedIdx: 3, withinFed: 2 }, //19: FedD Diver 3 (capped)
    { fedIdx: 3, withinFed: 3 }, //20: FedD Diver 4 (capped)
    { fedIdx: 4, withinFed: 2 }, //21: FedE Diver 3 (capped)
    { fedIdx: 4, withinFed: 3 }, //22: FedE Diver 4 (capped)
    { fedIdx: 5, withinFed: 2 }, //23: FedF Diver 3 (capped)
    { fedIdx: 5, withinFed: 3 }, //24: FedF Diver 4 (capped)
  ];
  // Map RANK_ORDER → [{ competitorId, rank }] tuples; the score
  // helper encodes the rank into 3 distinct round scores.
  const scoreScored = [];
  for (let rank = 1; rank <= RANK_ORDER.length; rank++) {
    const ent = RANK_ORDER[rank - 1];
    const diver = divers.find(d => d.fedIdx === ent.fedIdx && d.withinFed === ent.withinFed);
    scoreScored.push({ competitorId: diver.userId, rank });
  }

  await scoreParentEvent({
    eventId: parent.id,
    divers:  scoreScored,
    dive_id,
    judgeUserIds,
  });

  // Mark parent event Completed.
  await setup.setEventStatus(request, { adminToken: fedA.adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken: fedA.adminToken, eventId: parent.id, status: "Completed" });

  // ---- Create the H2H child event --------------------------
  // (in fedA's org with parent_event_id pointing at parent)
  const h2h = await setup.createEvent(request, {
    adminToken: fedA.adminToken,
    name: "E2E Super Final H2H",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "super_final_h2h",
    parent_event_id: parent.id,
  });

  // ---- Preview seed-h2h ------------------------------------
  const previewRes = await request.get(
    `/api/events/${h2h.id}/seed-h2h/preview?max_per_org=2`,
    { headers: { Authorization: `Bearer ${fedA.adminToken}` } },
  );
  expect(previewRes.status()).toBe(200);
  const preview = await previewRes.json();
  expect(preview.shortfall).toBeNull();
  expect(preview.pairs).toHaveLength(6);
  // A's two top divers (Diver 1 + Diver 2) should be seeds 1 and 2.
  // FedA Diver 3 + 4 should NOT be in the top 12.
  const inTop12Ids = new Set(preview.pairs.flatMap(p => [p.competitor_a_id, p.competitor_b_id]));
  const fedADiver3 = divers.find(d => d.fedIdx === 0 && d.withinFed === 2);
  const fedADiver4 = divers.find(d => d.fedIdx === 0 && d.withinFed === 3);
  expect(inTop12Ids.has(fedADiver3.userId)).toBe(false);
  expect(inTop12Ids.has(fedADiver4.userId)).toBe(false);

  // ---- Commit seed-h2h -------------------------------------
  const seedRes = await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${fedA.adminToken}` },
    data:    { max_per_org: 2, lock_minutes: 30 },
  });
  expect(seedRes.status()).toBe(200);
  const seed = await seedRes.json();
  expect(seed.seeded).toBe(12);
  expect(seed.pairs).toHaveLength(6);
  expect(seed.dive_list_locks_at).toBeTruthy();

  // Verify pair structure: pair_index 0 = seed12 vs seed1, etc.
  for (let i = 0; i < 6; i++) {
    const p = seed.pairs.find(pp => pp.pair_index === i);
    expect(p).toBeTruthy();
    expect(p.seed_a).toBe(12 - i);  // 12, 11, 10, 9, 8, 7
    expect(p.seed_b).toBe(i + 1);   //  1,  2,  3, 4, 5, 6
  }

  // Group assignment per Appendix 3 §2.1.1:
  //   G1: pairs (12,1), (9,4), (8,5)  → indexes 0, 3, 4
  //   G2: pairs (11,2), (10,3), (7,6) → indexes 1, 2, 5
  const g1Indexes = seed.pairs.filter(p => p.group_number === 1).map(p => p.pair_index).sort();
  const g2Indexes = seed.pairs.filter(p => p.group_number === 2).map(p => p.pair_index).sort();
  expect(g1Indexes).toEqual([0, 3, 4]);
  expect(g2Indexes).toEqual([1, 2, 5]);

  // ---- Verify roster ---------------------------------------
  const roster = await setup.pool.query(
    `SELECT competitor_id, round_number, dive_id, group_number, display_order
       FROM competitor_dive_lists
      WHERE event_id = $1
      ORDER BY display_order, round_number`,
    [h2h.id],
  );
  // 12 divers × 3 rounds = 36 rows.
  expect(roster.rows).toHaveLength(36);
  // Every row has group_number ∈ {1, 2}.
  for (const r of roster.rows) {
    expect([1, 2]).toContain(r.group_number);
    expect(r.dive_id).toBe(dive_id);
  }
  // Federation A has at most 2 divers in the H2H roster.
  const aDiverIds = divers.filter(d => d.fedIdx === 0).map(d => d.userId);
  const aCount = new Set(roster.rows
    .filter(r => aDiverIds.includes(r.competitor_id))
    .map(r => r.competitor_id)).size;
  expect(aCount).toBeLessThanOrEqual(2);

  // ---- Score H2H so seed_b (higher seed = better diver) wins
  //      every pair ----------------------------------------
  // Add a 5-judge panel to the H2H event itself.
  const h2hJudges = [];
  for (let j = 0; j < 5; j++) {
    const ju = await setup.insertUser({ orgId: fedA.orgId, role: "judge", fullName: `H2H Judge ${j+1}` });
    h2hJudges.push(ju.userId);
  }
  // For each pair: competitor_b (the higher-seeded, presumably
  // better diver) gets 8.0s, competitor_a gets 5.0s. Both finish
  // all 3 rounds.
  for (const p of seed.pairs) {
    for (let round = 1; round <= 3; round++) {
      for (let j = 0; j < h2hJudges.length; j++) {
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [h2h.id, p.competitor_a_id, h2hJudges[j], dive_id, round, 5.0],
        );
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [h2h.id, p.competitor_b_id, h2hJudges[j], dive_id, round, 8.0],
        );
      }
    }
  }
  // Also need a 5-judge panel mapped to the H2H event so
  // calc_event_dive_points can resolve judge_numbers.
  for (let j = 0; j < h2hJudges.length; j++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3) ON CONFLICT (event_id, judge_id) DO NOTHING`,
      [h2h.id, h2hJudges[j], j + 1],
    );
  }

  // ---- Fetch h2h-results -----------------------------------
  const resultsRes = await request.get(`/api/events/${h2h.id}/super-final/h2h-results`);
  expect(resultsRes.status()).toBe(200);
  const results = await resultsRes.json();
  expect(results.pairs).toHaveLength(6);
  for (const p of results.pairs) {
    // Higher seed (b) was scored higher, so they should win.
    expect(p.tied).toBe(false);
    expect(p.winner_id).toBe(p.competitor_b_id);
    expect(Number(p.total_b)).toBeGreaterThan(Number(p.total_a));
  }

  // ---- Cleanup ---------------------------------------------
  for (const fed of allFeds) {
    await setup.deleteOrg(fed.orgId);
  }
});
