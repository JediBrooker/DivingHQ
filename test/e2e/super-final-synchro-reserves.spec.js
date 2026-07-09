// Super Final, synchro reserve replacement (Appendix 3 §5.1).
//
// Phase 3d e2e: build a 12-diver Super Final + a synchro_pair
// event at the SAME meet, withdraw a Top-12 individual, replace
// from the synchro pool, and verify the replacement ends up in
// the H2H roster occupying the withdrawn diver's slot.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("super-final synchro reserve replacement: pool listing + swap", async ({ request }) => {
  test.setTimeout(120_000);

  // ---- 6 federations × 2 individuals + 2 synchro pair divers
  // each (24 individuals + 12 synchro divers across the 6 feds)
  const feds = [];
  for (let i = 0; i < 6; i++) {
    feds.push(await setup.createOrgAndAdmin(request, {
      orgName: `E2E SR Fed ${i} ${setup.rand()}`,
      countryCode: String.fromCharCode(0x41 + i).repeat(3),
    }));
  }
  const fedHost = feds[0];

  // 2 individuals per fed = 12
  const individuals = [];
  for (let f = 0; f < feds.length; f++) {
    for (let i = 0; i < 2; i++) {
      const u = await setup.insertUser({
        orgId: feds[f].orgId, role: "diver",
        fullName: `Fed${f} Individual ${i + 1}`,
      });
      individuals.push({ ...u, fedIdx: f });
    }
  }
  // 2 synchro divers per fed = 12
  const synchroDivers = [];
  for (let f = 0; f < feds.length; f++) {
    for (let i = 0; i < 2; i++) {
      const u = await setup.insertUser({
        orgId: feds[f].orgId, role: "diver",
        fullName: `Fed${f} Synchro ${i + 1}`,
      });
      synchroDivers.push({ ...u, fedIdx: f });
    }
  }

  // ---- Create a meet via SQL, simpler than the API for a
  // fixture since it requires the meet_manager role and we just
  // need an id. meets table has org_id NOT NULL, name NOT NULL.
  const meetRes = await setup.pool.query(
    `INSERT INTO meets (org_id, name) VALUES ($1, $2) RETURNING id`,
    [fedHost.orgId, `E2E SR Meet ${setup.rand()}`],
  );
  const meetId = meetRes.rows[0].id;

  // ---- Stop-1 final (parent of the Super Final H2H) at this meet ----
  const parent = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E SR Parent",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "final",
    meet_id: meetId,
  });

  // 5-judge panel
  const judgeUserIds = [];
  for (let j = 0; j < 5; j++) {
    const ju = await setup.insertUser({ orgId: fedHost.orgId, role: "judge", fullName: `Parent Judge ${j+1}` });
    judgeUserIds.push(ju.userId);
  }
  for (let i = 0; i < judgeUserIds.length; i++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)`,
      [parent.id, judgeUserIds[i], i + 1],
    );
  }
  const dive_id = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });

  // score every individual + insert a 3-round dive list, floor
  // by global rank: rank 1 → 8.0, decreasing by 0.5 each step
  for (let rank = 1; rank <= individuals.length; rank++) {
    const d = individuals[rank - 1];
    await setup.insertDiveList({
      eventId: parent.id, competitorId: d.userId,
      dives: [
        { round_number: 1, dive_id },
        { round_number: 2, dive_id },
        { round_number: 3, dive_id },
      ],
    });
    const floor = Math.max(0.5, 8.0 - (rank - 1) * 0.25);
    const quantized = Math.round(floor * 2) / 2;
    for (let round = 1; round <= 3; round++) {
      for (let j = 0; j < judgeUserIds.length; j++) {
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [parent.id, d.userId, judgeUserIds[j], dive_id, round, Math.min(10, quantized + 0.5 * (j - 2))],
        );
      }
    }
  }
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: parent.id, status: "Completed" });

  // ---- Synchro_pair event at the same meet ----
  const synchroEvent = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E SR Synchro 3m",
    height: "3m",
    number_of_judges: 9,           // synchro allows 7, 9 or 11 judges
    total_rounds: 3,
    event_format: "final",
    event_type: "synchro_pair",
    meet_id: meetId,
  });
  // add a 9-judge panel
  const synchroJudges = [];
  for (let j = 0; j < 9; j++) {
    const ju = await setup.insertUser({ orgId: fedHost.orgId, role: "judge", fullName: `Synchro Judge ${j+1}` });
    synchroJudges.push(ju.userId);
  }
  for (let j = 0; j < synchroJudges.length; j++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)`,
      [synchroEvent.id, synchroJudges[j], j + 1],
    );
  }
  // Insert synchro pair entries, partner_id links the two
  // divers. 6 pairs (one per fed). Score them so fed 0 ranks
  // best. We'll withdraw a fed-1 diver, expect fed-0 synchro
  // to be the top of the reserve pool, but fed-0 already has
  // 2 individuals so it's INELIGIBLE, meaning fed-1's synchro
  // is next.
  for (let f = 0; f < feds.length; f++) {
    const lead = synchroDivers[f * 2];
    const partner = synchroDivers[f * 2 + 1];
    // two roster rows per round (one for each diver), with
    // partner_id linking them
    for (let round = 1; round <= 3; round++) {
      await setup.pool.query(
        `INSERT INTO competitor_dive_lists
           (event_id, competitor_id, partner_id, dive_id, round_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [synchroEvent.id, lead.userId, partner.userId, dive_id, round],
      );
      await setup.pool.query(
        `INSERT INTO competitor_dive_lists
           (event_id, competitor_id, partner_id, dive_id, round_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [synchroEvent.id, partner.userId, lead.userId, dive_id, round],
      );
    }
    // score: fed 0 → 8s, fed 1 → 7.5s, ..., fed 5 → 5.5s, both
    // pair members get the same scores
    const score = Math.max(0.5, 8.0 - 0.5 * f);
    for (const cid of [lead.userId, partner.userId]) {
      for (let round = 1; round <= 3; round++) {
        for (const judgeId of synchroJudges) {
          await setup.pool.query(
            `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [synchroEvent.id, cid, judgeId, dive_id, round, score],
          );
        }
      }
    }
  }
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: synchroEvent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken: fedHost.adminToken, eventId: synchroEvent.id, status: "Completed" });

  // ---- H2H event at the same meet ----
  const h2h = await setup.createEvent(request, {
    adminToken: fedHost.adminToken,
    name: "E2E SR H2H",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "super_final_h2h",
    parent_event_id: parent.id,
    meet_id: meetId,
  });
  const seedRes = await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${fedHost.adminToken}` },
    data: { max_per_org: 2, lock_minutes: 30 },
  });
  expect(seedRes.status()).toBe(200);
  const seed = await seedRes.json();
  expect(seed.seeded).toBe(12);

  // ---- pool listing ----
  const poolRes = await request.get(
    `/api/events/${h2h.id}/synchro-reserve-pool`,
    { headers: { Authorization: `Bearer ${fedHost.adminToken}` } },
  );
  expect(poolRes.status()).toBe(200);
  const pool = await poolRes.json();
  // every fed has 2 individuals → all are at the cap → reserve
  // pool should be empty
  expect(pool.reserve_pool).toEqual([]);

  // Withdraw a fed-3 individual to free up the slot, picking the
  // first individual from fed 3 in the H2H bracket.
  const fed3IndIds = individuals.filter(d => d.fedIdx === 3).map(d => d.userId);
  // find the one currently in the H2H roster
  const rosterRes = await setup.pool.query(
    `SELECT competitor_id FROM competitor_dive_lists
      WHERE event_id = $1 AND competitor_id = ANY($2::uuid[])
      LIMIT 1`,
    [h2h.id, fed3IndIds],
  );
  expect(rosterRes.rows.length).toBe(1);
  const withdrawId = rosterRes.rows[0].competitor_id;
  // pre-mark withdrawn so the reserve pool sees fed 3 with only
  // 1 individual remaining
  await setup.pool.query(
    `UPDATE competitor_dive_lists SET withdrawn_at = NOW()
      WHERE event_id = $1 AND competitor_id = $2`,
    [h2h.id, withdrawId],
  );

  // ---- pool re-listing, fed 3 should now appear ----
  const poolRes2 = await request.get(
    `/api/events/${h2h.id}/synchro-reserve-pool`,
    { headers: { Authorization: `Bearer ${fedHost.adminToken}` } },
  );
  const pool2 = await poolRes2.json();
  // fed 3 has 1 individual + 2 synchro divers → eligible.
  // Synchro rank 4 here (fed 0 is best, fed 1 second, etc).
  // (more precisely: fed 0 = rank 1, fed 1 = rank 2, fed 2 = rank 3,
  //  fed 3 = rank 4, fed 4 = rank 5, fed 5 = rank 6)
  const fed3Entry = pool2.reserve_pool.find(p => p.org_id === feds[3].orgId);
  expect(fed3Entry).toBeTruthy();
  expect(fed3Entry.eligible_divers.length).toBeGreaterThanOrEqual(1);

  // ---- pre-restore the withdrawn flag (the actual replace
  //      endpoint will re-stamp it anyway). Easier than rebuilding
  //      the whole bracket. ----
  await setup.pool.query(
    `UPDATE competitor_dive_lists SET withdrawn_at = NULL
      WHERE event_id = $1 AND competitor_id = $2`,
    [h2h.id, withdrawId],
  );

  // ---- replace from synchro pool ----
  const replacementId = fed3Entry.eligible_divers[0].competitor_id;
  const replaceRes = await request.post(
    `/api/events/${h2h.id}/replace-from-synchro`,
    {
      headers: { Authorization: `Bearer ${fedHost.adminToken}` },
      data: {
        withdraw_competitor_id: withdrawId,
        replacement_competitor_id: replacementId,
      },
    },
  );
  expect(replaceRes.status()).toBe(200);
  const replaceBody = await replaceRes.json();
  expect(replaceBody.replaced).toBe(true);

  // ---- verify roster: replacement has 3 rows in same slot,
  //      withdrawn diver has withdrawn_at stamped on all 3 ----
  const verifyReplRes = await setup.pool.query(
    `SELECT COUNT(*) AS c, MIN(group_number) AS gn, MIN(display_order) AS d_order
       FROM competitor_dive_lists
      WHERE event_id = $1 AND competitor_id = $2 AND is_reserve = FALSE
      GROUP BY competitor_id`,
    [h2h.id, replacementId],
  );
  expect(Number(verifyReplRes.rows[0].c)).toBe(3);
  expect(Number(verifyReplRes.rows[0].gn)).toBe(replaceBody.slot.group_number);
  expect(Number(verifyReplRes.rows[0].d_order)).toBe(replaceBody.slot.display_order);

  const verifyWdRes = await setup.pool.query(
    `SELECT withdrawn_at FROM competitor_dive_lists
      WHERE event_id = $1 AND competitor_id = $2`,
    [h2h.id, withdrawId],
  );
  for (const r of verifyWdRes.rows) {
    expect(r.withdrawn_at).not.toBeNull();
  }

  // ---- cleanup ----
  for (const fed of feds) await setup.deleteOrg(fed.orgId);
});
