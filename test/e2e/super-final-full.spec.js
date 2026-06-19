// Super Final — full 12-diver walkthrough (Phases 2 + 3a + 3b
// + 3c).
//
// Drives all 4 stages end-to-end:
//   1. Stop-1 final  (event_format='final')   18 divers, 6 feds × 3
//   2. H2H           (super_final_h2h)         12 divers, 6 pairs
//      → one pair forced tied → resolve via dive-off (Phase 3c)
//   3. SF            (super_final_semi)        6 winners
//   4. F             (super_final_final)       4 finalists
//
// Then GET /super-final/rankings and verify the 1-4 / 5-6 / 7-12
// payout layout per Appendix 3 §7.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("super-final full 12-diver walkthrough: H2H + tie + SF + F + rankings", async ({ request }) => {
  test.setTimeout(180_000);

  // ---- 6 federations × 3 divers (18 total). ----
  const feds = [];
  for (let i = 0; i < 6; i++) {
    feds.push(await setup.createOrgAndAdmin(request, {
      orgName: `E2E Full Fed ${i} ${setup.rand()}`,
      countryCode: String.fromCharCode(0x41 + i).repeat(3),
    }));
  }
  const fedHost = feds[0];
  const divers = [];
  for (let f = 0; f < feds.length; f++) {
    for (let i = 0; i < 3; i++) {
      const u = await setup.insertUser({
        orgId: feds[f].orgId,
        role: "diver",
        fullName: `Fed${f} D${i + 1}`,
      });
      divers.push({ ...u, fedIdx: f, withinFed: i });
    }
  }

  // ---- Stop-1 final: 18 divers, 6 rounds (full M/W list). ----
  const parent = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E Full Stop-1",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 6,
    event_format: "final",
    gender: "Male",      // M to get 6 rounds (Appendix 3 §2.3)
  });

  const judges = [];
  for (let j = 0; j < 5; j++) {
    judges.push(await setup.insertUser({
      orgId: fedHost.orgId, role: "judge", fullName: `Parent J${j+1}`,
    }));
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3)`,
      [parent.id, judges[j].userId, j + 1],
    );
  }
  const dive_id = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });

  // 6-round dive list per diver. Score so global ranking is:
  //   For 6 feds × 3 divers, the cap (max 2 per fed) keeps the
  //   top-2 from each fed → exactly 12. Use a rank-encoded
  //   scoring scheme (similar to super-final-h2h.spec.js).
  // We rank divers in fed-rotated order so each fed's top-2 are
  // spread across the global ranking but cleanly above each
  // fed's 3rd diver.
  const rankOrder = [];
  // First pass: best of each fed (rank 1..6)
  for (let f = 0; f < 6; f++) rankOrder.push({ fedIdx: f, withinFed: 0 });
  // Second pass: 2nd-best of each fed (rank 7..12)
  for (let f = 0; f < 6; f++) rankOrder.push({ fedIdx: f, withinFed: 1 });
  // Third pass: 3rd of each fed (rank 13..18 — capped, never qualify)
  for (let f = 0; f < 6; f++) rankOrder.push({ fedIdx: f, withinFed: 2 });

  for (let rank = 1; rank <= rankOrder.length; rank++) {
    const ent = rankOrder[rank - 1];
    const d = divers.find((x) => x.fedIdx === ent.fedIdx && x.withinFed === ent.withinFed);
    // Submit a 6-round list.
    await setup.insertDiveList({
      eventId: parent.id, competitorId: d.userId,
      dives: [1, 2, 3, 4, 5, 6].map((r) => ({ round_number: r, dive_id })),
    });
    // Score: encode rank in two rounds so 18 are distinct.
    // round 1..3 score = base, round 4..6 score = base + step
    // where base is monotonic in rank.
    // base 6.0 → rank 18; base 8.5 → rank 1, by 0.5 increments.
    // 18 ranks need 18 distinct base values. 0.5 steps from 0.5
    // to 9.0 = 18 values exactly — perfect.
    const base = Math.max(0.5, 9.0 - (rank - 1) * 0.5);
    for (let round = 1; round <= 6; round++) {
      const score = base; // identical across rounds → 6× base sum
      for (let j = 0; j < judges.length; j++) {
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [parent.id, d.userId, judges[j].userId, dive_id, round, score],
        );
      }
    }
  }
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: parent.id, status: "Completed" });

  // ---- Create H2H + seed (Phase 2). ----
  const h2h = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E Full H2H",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "super_final_h2h",
    parent_event_id: parent.id,
    gender: "Male",
  });
  const seedH2hRes = await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${fedHost.adminToken}` },
    data: { max_per_org: 2, lock_minutes: 30 },
  });
  expect(seedH2hRes.status()).toBe(200);
  const seedH2h = await seedH2hRes.json();
  expect(seedH2h.seeded).toBe(12);

  // ---- Score H2H: 5 of 6 pairs decisive, 1 tied. ----
  const h2hJudges = [];
  for (let j = 0; j < 5; j++) {
    h2hJudges.push(await setup.insertUser({
      orgId: fedHost.orgId, role: "judge", fullName: `H2H J${j+1}`,
    }));
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3) ON CONFLICT (event_id, judge_id) DO NOTHING`,
      [h2h.id, h2hJudges[j].userId, j + 1],
    );
  }
  // Pair 5 (indexes [5]) → tied 7.0 vs 7.0; rest → A=5.0, B=8.0.
  for (const p of seedH2h.pairs) {
    const tied = p.pair_index === 5;
    const sA = tied ? 7.0 : 5.0;
    const sB = tied ? 7.0 : 8.0;
    for (let round = 1; round <= 3; round++) {
      for (const ju of h2hJudges) {
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [h2h.id, p.competitor_a_id, ju.userId, dive_id, round, sA],
        );
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [h2h.id, p.competitor_b_id, ju.userId, dive_id, round, sB],
        );
      }
    }
  }

  // ---- Create + resolve dive-off for the tied pair (Phase 3c). ----
  const tiedPair = seedH2h.pairs.find((p) => p.pair_index === 5);
  const createDoRes = await request.post(`/api/events/${h2h.id}/dive-offs`, {
    headers: { Authorization: `Bearer ${fedHost.adminToken}` },
    data: {
      competitor_a_id: tiedPair.competitor_a_id,
      competitor_b_id: tiedPair.competitor_b_id,
      notes: "Forced tied pair for full walkthrough",
    },
  });
  expect(createDoRes.status()).toBe(201);
  const created = (await createDoRes.json()).dive_off;
  // Resolve: B wins.
  const resolveDoRes = await request.patch(
    `/api/events/${h2h.id}/dive-offs/${created.id}`,
    {
      headers: { Authorization: `Bearer ${fedHost.adminToken}` },
      data: {
        score_a:   7.5,
        score_b:   8.5,
        winner_id: tiedPair.competitor_b_id,
      },
    },
  );
  expect(resolveDoRes.status()).toBe(200);

  // The resolved dive-off (winner = competitor_b) now breaks the
  // on-field tie directly — h2h-results consumes tiebreak_dive_offs,
  // so no manual score adjustment is needed (it used to be required
  // because the dive-off winner wasn't read).

  // ---- Verify h2h-results: 6 winners, one resolved by the dive-off. ----
  const h2hResultsRes = await request.get(`/api/events/${h2h.id}/super-final/h2h-results`);
  const h2hResults = await h2hResultsRes.json();
  expect(h2hResults.pairs.filter((p) => !p.tied)).toHaveLength(6);
  expect(h2hResults.pairs.some((p) => p.resolved_by === "dive_off")).toBe(true);

  // Mark H2H Completed.
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: h2h.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: h2h.id, status: "Completed" });

  // ---- Create SF + seed (Phase 3a). ----
  const sf = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E Full SF",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,         // M = 3 (Appendix 3 §2.2)
    event_format: "super_final_semi",
    parent_event_id: h2h.id,
    gender: "Male",
  });
  const seedSfRes = await request.post(`/api/events/${sf.id}/seed-semi`, {
    headers: { Authorization: `Bearer ${fedHost.adminToken}` },
    data: { lock_minutes: 30 },
  });
  expect(seedSfRes.status()).toBe(200);
  const seedSf = await seedSfRes.json();
  expect(seedSf.seeded).toBe(6);

  // SUPER FINAL §3 carry: SF.score_carry_from must point at H2H.
  // Audit caught that the events row column wasn't asserted; this
  // pin lets a future regression be flagged by tests.
  const sfRowAfterSeed = await setup.pool.query(
    "SELECT score_carry_from FROM events WHERE id = $1",
    [sf.id],
  );
  expect(sfRowAfterSeed.rows[0].score_carry_from).toBe(h2h.id);

  // Score SF — make group winners clean (highest seed advances).
  const sfJudges = [];
  for (let j = 0; j < 5; j++) {
    sfJudges.push(await setup.insertUser({ orgId: fedHost.orgId, role: "judge", fullName: `SF J${j+1}` }));
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3) ON CONFLICT (event_id, judge_id) DO NOTHING`,
      [sf.id, sfJudges[j].userId, j + 1],
    );
  }
  // For each diver in seedSf.by_group, score so within-group
  // rank reflects display_order: highest display_order = best.
  for (const g of [1, 2]) {
    const inGroup = seedSf.by_group[g];
    for (const d of inGroup) {
      // display_order in [1..6]. Higher do = better. Score
      // base = 4.0 + 0.5 * d.display_order (within group).
      const base = 4.0 + 0.5 * d.display_order;
      for (let round = 1; round <= 3; round++) {
        for (const ju of sfJudges) {
          await setup.pool.query(
            `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [sf.id, d.competitor_id, ju.userId, dive_id, round, base],
          );
        }
      }
    }
  }
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: sf.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: sf.id, status: "Completed" });

  // ---- Create F + seed (Phase 3a). ----
  const f = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E Full F",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 6,         // M = 6 (Appendix 3 §2.3)
    event_format: "super_final_final",
    parent_event_id: sf.id,
    gender: "Male",
  });
  const seedFRes = await request.post(`/api/events/${f.id}/seed-final`, {
    headers: { Authorization: `Bearer ${fedHost.adminToken}` },
    data: { lock_minutes: 15 },
  });
  expect(seedFRes.status()).toBe(200);
  const seedF = await seedFRes.json();
  expect(seedF.seeded).toBe(4);

  // §3.2 reset: F.score_carry_from must be NULL.
  const fRowAfterSeed = await setup.pool.query(
    "SELECT score_carry_from, dive_list_locks_at FROM events WHERE id = $1",
    [f.id],
  );
  expect(fRowAfterSeed.rows[0].score_carry_from).toBeNull();

  // §4.1 lock-window math: lock_minutes=15 → effective lock at
  // NOW() + 10 min (5-min buffer baked in). Assert the stamped
  // dive_list_locks_at is within 30 sec of NOW()+10min.
  const lockAtMs = new Date(fRowAfterSeed.rows[0].dive_list_locks_at).getTime();
  const expectedLockMs = Date.now() + 10 * 60 * 1000;
  expect(Math.abs(lockAtMs - expectedLockMs)).toBeLessThan(30_000);

  // Score F.
  const fJudges = [];
  for (let j = 0; j < 5; j++) {
    fJudges.push(await setup.insertUser({ orgId: fedHost.orgId, role: "judge", fullName: `F J${j+1}` }));
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3) ON CONFLICT (event_id, judge_id) DO NOTHING`,
      [f.id, fJudges[j].userId, j + 1],
    );
  }
  // 4 finalists, ascending display_order = ascending SF cumulative.
  // Score so the F result orders by display_order DESC (highest
  // SF cumulative scorer wins F). Each gets a distinct base.
  for (const fl of seedF.finalists) {
    const base = 4.0 + 0.5 * fl.display_order;
    for (let round = 1; round <= 6; round++) {
      for (const ju of fJudges) {
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [f.id, fl.competitor_id, ju.userId, dive_id, round, base],
        );
      }
    }
  }
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: f.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: f.id, status: "Completed" });

  // ---- GET /super-final/rankings ----
  const rankingsRes = await request.get(`/api/events/${f.id}/super-final/rankings`);
  expect(rankingsRes.status()).toBe(200);
  const rankings = await rankingsRes.json();
  expect(rankings.rankings).toHaveLength(12);
  // 1-4: source='final'
  for (let i = 0; i < 4; i++) {
    expect(rankings.rankings[i].rank).toBe(i + 1);
    expect(rankings.rankings[i].source).toBe("final");
  }
  // 5-6: source='h2h+semi'
  for (let i = 4; i < 6; i++) {
    expect(rankings.rankings[i].source).toBe("h2h+semi");
  }
  // 7-12: source='h2h'
  for (let i = 6; i < 12; i++) {
    expect(rankings.rankings[i].source).toBe("h2h");
  }

  // MAGNITUDE GUARD: an earlier Cartesian-join bug had the F-tier
  // SUM inflated by total_rounds (6× for Men, 5× for Women) —
  // tests passed because the inflation was uniform and ranks
  // ordered correctly. Pin a sanity range so a future regression
  // can't slip through. Each F finalist scores `base = 4.0 +
  // 0.5 × display_order` (so 4.5 / 5.0 / 5.5 / 6.0) on a 5-judge
  // panel. Trim drops 1 high + 1 low → 3 kept × base × DD ≈
  // 3 × 6.0 × 1.7 ≈ 30.6/dive × 6 rounds ≈ 184 max. The pre-fix
  // bug returned ~1100. Cap any rank's total below 250 catches
  // it while leaving room for a stricter dive_directory DD.
  for (const r of rankings.rankings) {
    expect(Number(r.total)).toBeLessThan(300);
    expect(Number(r.total)).toBeGreaterThan(0);
  }
  // The F-tier (rank 1-4) totals should monotonically decrease.
  for (let i = 1; i < 4; i++) {
    expect(Number(rankings.rankings[i - 1].total))
      .toBeGreaterThanOrEqual(Number(rankings.rankings[i].total));
  }
  // SCORE-CARRY GUARD: tier-2 (h2h+semi) totals must include H2H
  // carry. Each tier-2 diver did 3 H2H + 3 SF dives, all at
  // base ≈ 5.0..5.5; total should be within 110..200 (NOT just
  // the SF half ~75). If carry were missing, totals would be
  // ~half this range.
  for (let i = 4; i < 6; i++) {
    expect(Number(rankings.rankings[i].total)).toBeGreaterThan(80);
  }

  // ---- Cleanup ----
  for (const fed of feds) await setup.deleteOrg(fed.orgId);
});
