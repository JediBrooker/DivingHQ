// Super Final: dive-off API surface (Phase 3c).
//
// Covers POST + PATCH /api/events/:id/dive-offs and GET listing.
// Builds a small H2H fixture with 12 divers and forces a tie in
// one pair via identical scores; the operator records a dive-off,
// then resolves it, and we verify both endpoints respond
// correctly.
//
// Validation cases tested:
//   - cross-pair dive-off rejected with 400 (must be same pair)
//   - non-tied competitors rejected unless confirm_tied:true
//   - winner_id must be one of the two competitors
//   - PATCH auto-stamps resolved_at when winner_id flips non-null

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// Score the H2H bracket so 5 of 6 pairs have a clear winner +
// 1 pair (the last one, pair_index=5) is tied.
async function scoreH2hBracket({ eventId, pairs, dive_id, judges }) {
  for (let j = 0; j < judges.length; j++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3) ON CONFLICT (event_id, judge_id) DO NOTHING`,
      [eventId, judges[j], j + 1],
    );
  }
  for (const p of pairs) {
    const isTiedPair = p.pair_index === 5;
    // For all 5 pairs not the tied one: A scores 5.0, B scores 8.0
    // For the tied pair: both score 7.0
    const scoreA = isTiedPair ? 7.0 : 5.0;
    const scoreB = isTiedPair ? 7.0 : 8.0;
    for (let round = 1; round <= 3; round++) {
      for (const judgeId of judges) {
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [eventId, p.competitor_a_id, judgeId, dive_id, round, scoreA],
        );
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [eventId, p.competitor_b_id, judgeId, dive_id, round, scoreB],
        );
      }
    }
  }
}

// Build an H2H bracket end-to-end. Returns
// { adminToken, parentEventId, h2hEvent, pairs, dive_id, judgeUserIds }.
async function buildH2hWithTie(request) {
  // Six "federations", easiest with one orgAdmin per fed. Reuses
  // the same approach the H2H spec uses.
  const feds = [];
  for (let i = 0; i < 6; i++) {
    feds.push(await setup.createOrgAndAdmin(request, {
      orgName:     `E2E DO Fed ${i} ${setup.rand()}`,
      countryCode: String.fromCharCode(0x41 + i).repeat(3),
    }));
  }
  const fedHost = feds[0];

  // 2 divers per fed = 12 divers (exactly fills the cap).
  const divers = [];
  for (let f = 0; f < feds.length; f++) {
    for (let i = 0; i < 2; i++) {
      const u = await setup.insertUser({
        orgId:    feds[f].orgId,
        role:     "diver",
        fullName: `Fed${f} Diver ${i + 1}`,
      });
      divers.push({ ...u, fedIdx: f });
    }
  }

  // Parent event in fedHost org.
  const parent = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E DO Parent",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "final",
  });

  // 5-judge panel.
  const judgeUserIds = [];
  for (let j = 0; j < 5; j++) {
    const ju = await setup.insertUser({ orgId: fedHost.orgId, role: "judge", fullName: `Parent Judge ${j+1}` });
    judgeUserIds.push(ju.userId);
  }
  for (let i = 0; i < judgeUserIds.length; i++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3)`,
      [parent.id, judgeUserIds[i], i + 1],
    );
  }
  const dive_id = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });

  // Submit a 3-dive list for every diver and score them so the
  // ordering is well-defined. Diver i (0..11) scores
  // 5.0 + 0.25*(11 - i) per round → distinct totals → distinct ranks.
  for (let i = 0; i < divers.length; i++) {
    const d = divers[i];
    await setup.insertDiveList({
      eventId: parent.id,
      competitorId: d.userId,
      dives: [
        { round_number: 1, dive_id },
        { round_number: 2, dive_id },
        { round_number: 3, dive_id },
      ],
    });
    // Score floor in 0.5 increments, quantize.
    const raw = 5.0 + 0.25 * (11 - i);
    const floor = Math.round(raw * 2) / 2;
    for (let round = 1; round <= 3; round++) {
      for (let j = 0; j < judgeUserIds.length; j++) {
        const s = Math.min(10, floor + 0.5 * (j - 2));
        // Ensure 0.5 step + valid range.
        const clamped = Math.max(0, Math.min(10, Math.round(s * 2) / 2));
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [parent.id, d.userId, judgeUserIds[j], dive_id, round, clamped],
        );
      }
    }
  }

  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: parent.id, status: "Completed" });

  // Create H2H event + seed.
  const h2h = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E DO H2H",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "super_final_h2h",
    parent_event_id: parent.id,
  });
  const seedRes = await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${fedHost.adminToken}` },
    data:    { max_per_org: 2, lock_minutes: 30 },
  });
  expect(seedRes.status()).toBe(200);
  const seed = await seedRes.json();

  // Score the H2H: pair 5 (last) is tied.
  const h2hJudges = [];
  for (let j = 0; j < 5; j++) {
    const ju = await setup.insertUser({ orgId: fedHost.orgId, role: "judge", fullName: `H2H Judge ${j+1}` });
    h2hJudges.push(ju.userId);
  }
  await scoreH2hBracket({
    eventId: h2h.id,
    pairs:   seed.pairs,
    dive_id,
    judges:  h2hJudges,
  });

  return {
    adminToken: fedHost.adminToken,
    parentEventId: parent.id,
    h2hEvent: h2h,
    pairs: seed.pairs,
    dive_id,
    feds,
  };
}

test("super-final dive-offs: create / validate / resolve", async ({ request }) => {
  test.setTimeout(120_000);
  const { adminToken, h2hEvent, pairs, feds } = await buildH2hWithTie(request);

  // ---- h2h-results should flag pair 5 as tied -----
  const resultsRes = await request.get(`/api/events/${h2hEvent.id}/super-final/h2h-results`);
  expect(resultsRes.status()).toBe(200);
  const results = await resultsRes.json();
  const tiedPair = results.pairs.find(p => p.tied);
  expect(tiedPair).toBeTruthy();
  const cleanPair = results.pairs.find(p => !p.tied && p.winner_id);
  expect(cleanPair).toBeTruthy();

  // ---- POST dive-off: cross-pair rejected ----
  const crossRes = await request.post(`/api/events/${h2hEvent.id}/dive-offs`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data:    {
      competitor_a_id: tiedPair.competitor_a_id,
      // Pair 5 is in G2; pair 0 is in G1, cross-group.
      competitor_b_id: cleanPair.competitor_a_id,
      confirm_tied:    true,
    },
  });
  expect(crossRes.status()).toBe(400);

  // ---- POST dive-off: non-tied without confirm rejected ----
  const noConfirmRes = await request.post(`/api/events/${h2hEvent.id}/dive-offs`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data:    {
      competitor_a_id: cleanPair.competitor_a_id,
      competitor_b_id: cleanPair.competitor_b_id,
      // Same pair but they're not tied → server should reject
      // unless confirm_tied is set.
    },
  });
  expect(noConfirmRes.status()).toBe(400);

  // ---- POST dive-off: tied pair (clean path) ----
  const createRes = await request.post(`/api/events/${h2hEvent.id}/dive-offs`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data:    {
      competitor_a_id: tiedPair.competitor_a_id,
      competitor_b_id: tiedPair.competitor_b_id,
      notes:           "Tied at 7.0 across all 3 dives — running dive-off.",
    },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()).dive_off;
  expect(created.id).toBeTruthy();
  expect(created.resolved_at).toBeFalsy();
  expect(created.winner_id).toBeFalsy();

  // ---- GET dive-offs lists the row ----
  const listRes = await request.get(`/api/events/${h2hEvent.id}/dive-offs`);
  expect(listRes.status()).toBe(200);
  const list = await listRes.json();
  expect(list.dive_offs).toHaveLength(1);
  expect(list.dive_offs[0].competitor_a_name).toBeTruthy();

  // ---- PATCH winner not in pair → 400 ----
  const otherCompetitor = cleanPair.competitor_a_id;
  const badWinnerRes = await request.patch(
    `/api/events/${h2hEvent.id}/dive-offs/${created.id}`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data:    { winner_id: otherCompetitor },
    },
  );
  expect(badWinnerRes.status()).toBe(400);

  // ---- PATCH resolves cleanly + auto-stamps resolved_at ----
  const resolveRes = await request.patch(
    `/api/events/${h2hEvent.id}/dive-offs/${created.id}`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data:    {
        score_a:   8.5,
        score_b:   8.0,
        winner_id: tiedPair.competitor_a_id,
      },
    },
  );
  expect(resolveRes.status()).toBe(200);
  const resolved = (await resolveRes.json()).dive_off;
  expect(resolved.winner_id).toBe(tiedPair.competitor_a_id);
  expect(resolved.resolved_at).toBeTruthy();
  expect(Number(resolved.score_a)).toBe(8.5);
  expect(Number(resolved.score_b)).toBe(8.0);

  // ---- Integration: the resolved dive-off now drives h2h-results ----
  // Previously the winner was recorded but never consumed, so the pair
  // stayed tied=true with winner_id null. Now the formerly-tied pair
  // reports the dive-off winner and is no longer flagged unresolved.
  const afterRes = await request.get(`/api/events/${h2hEvent.id}/super-final/h2h-results`);
  expect(afterRes.status()).toBe(200);
  const after = await afterRes.json();
  const resolvedPair = after.pairs.find((p) => p.pair_index === tiedPair.pair_index);
  expect(resolvedPair.tied).toBe(false);
  expect(resolvedPair.winner_id).toBe(tiedPair.competitor_a_id);
  expect(resolvedPair.tied_on_total).toBe(true);
  expect(resolvedPair.resolved_by).toBe("dive_off");
  expect(after.pairs.filter((p) => p.tied)).toHaveLength(0);

  // ---- Cleanup ----
  for (const fed of feds) await setup.deleteOrg(fed.orgId);
});
