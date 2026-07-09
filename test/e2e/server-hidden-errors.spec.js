// Hidden backend error guards.
//
// These are intentionally API/socket-first tests. The browser UI can
// look perfectly healthy while a caught backend error just logs and
// returns an empty slice, so these assertions pin the side effects
// that have to exist.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

function headers(token) {
  return { Authorization: `Bearer ${token}` };
}

async function createPanel(request, { orgId, eventIds, adminToken, count = 5 }) {
  const judges = [];
  for (let i = 1; i <= count; i++) {
    const judge = await setup.insertUser({
      orgId,
      role: "judge",
      fullName: `Hidden Error Judge ${i}`,
    });
    judges.push(judge);
  }
  for (const eventId of eventIds) {
    await setup.assignJudges(request, {
      adminToken,
      eventId,
      judgeIds: judges.map((judge) => judge.userId),
    });
  }
  return judges;
}

async function insertPanelScores({ eventId, competitorId, judgeIds, diveId, roundNumber, scores }) {
  for (let i = 0; i < judgeIds.length; i++) {
    await setup.pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id, competitor_id, round_number, judge_id)
       DO UPDATE SET score = EXCLUDED.score, dive_id = EXCLUDED.dive_id`,
      [eventId, competitorId, judgeIds[i], diveId, roundNumber, scores[i % scores.length]],
    );
  }
}

test("coach up-next fan-out writes notification rows", async ({ request, baseURL }) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "NZL",
  });
  try {
    const event = await setup.createEvent(request, {
      adminToken,
      name: "E2E Coach Alert Hidden Error",
      total_rounds: 1,
      number_of_judges: 5,
      height: "3m",
    });
    const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    const divers = [];
    for (const name of ["Active Diver", "Buffer Diver", "On Deck Diver"]) {
      const diver = await setup.insertUser({ orgId, role: "diver", fullName: name });
      divers.push(diver);
      await setup.insertDiveList({
        eventId: event.id,
        competitorId: diver.userId,
        dives: [{ round_number: 1, dive_id: diveId }],
      });
    }
    for (let i = 0; i < divers.length; i++) {
      await setup.pool.query(
        `UPDATE competitor_dive_lists
            SET display_order = $1
          WHERE event_id = $2 AND competitor_id = $3`,
        [i + 1, event.id, divers[i].userId],
      );
    }

    const coach = await setup.insertUser({
      orgId,
      role: "coach",
      fullName: "Alert Coach",
    });
    await setup.pool.query(
      `INSERT INTO coach_diver_links (coach_id, diver_id, org_id)
       VALUES ($1, $2, $3)`,
      [coach.userId, divers[2].userId, orgId],
    );
    await setup.pool.query(
      `INSERT INTO coach_alert_preferences (coach_id, enabled, dives_ahead)
       VALUES ($1, TRUE, 2)
       ON CONFLICT (coach_id)
       DO UPDATE SET enabled = TRUE, dives_ahead = 2, updated_at = now()`,
      [coach.userId],
    );

    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

    const sock = await setup.openSocket(baseURL, adminToken);
    try {
      sock.emit("set_active_diver", {
        event_id: event.id,
        competitor_id: divers[0].userId,
        round_number: 1,
      });

      await expect.poll(async () => {
        const r = await setup.pool.query(
          `SELECT COUNT(*)::int AS n
             FROM notifications
            WHERE user_id = $1
              AND category = 'coach.diver_up_next'
              AND data->>'event_id' = $2`,
          [coach.userId, event.id],
        );
        return r.rows[0].n;
      }, { timeout: 5000, intervals: [100, 250, 500] }).toBe(1);
    } finally {
      sock.disconnect();
    }

    const row = await setup.pool.query(
      `SELECT title, body, data
         FROM notifications
        WHERE user_id = $1
          AND category = 'coach.diver_up_next'
          AND data->>'event_id' = $2
        LIMIT 1`,
      [coach.userId, event.id],
    );
    expect(row.rows[0].title).toBe("On Deck Diver is up in 2");
    expect(row.rows[0].body).toContain("Round 1");
    expect(row.rows[0].data.diver_id).toBe(divers[2].userId);
  } finally {
    await setup.deleteOrg(orgId);
  }
});

test("leaderboard returns non-empty rankings for normal and carry-forward events", async ({
  request,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  try {
    const parent = await setup.createEvent(request, {
      adminToken,
      name: "E2E Leaderboard Parent",
      total_rounds: 1,
      number_of_judges: 5,
      height: "3m",
    });
    const child = await setup.createEvent(request, {
      adminToken,
      name: "E2E Leaderboard Carry",
      total_rounds: 1,
      number_of_judges: 5,
      height: "3m",
    });
    await setup.pool.query(
      "UPDATE events SET score_carry_from = $2 WHERE id = $1",
      [child.id, parent.id],
    );

    const diver = await setup.insertUser({
      orgId,
      role: "diver",
      fullName: "Leaderboard Diver",
    });
    const parentDive = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    const childDive = await setup.pickDiveId({ height: 3.0, dive_code: "201", position: "B" });
    await setup.insertDiveList({
      eventId: parent.id,
      competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: parentDive }],
    });
    await setup.insertDiveList({
      eventId: child.id,
      competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: childDive }],
    });

    const judges = await createPanel(request, {
      orgId,
      eventIds: [parent.id, child.id],
      adminToken,
      count: 5,
    });
    const judgeIds = judges.map((judge) => judge.userId);
    await insertPanelScores({
      eventId: parent.id,
      competitorId: diver.userId,
      judgeIds,
      diveId: parentDive,
      roundNumber: 1,
      scores: [7.0, 7.5, 8.0, 8.5, 9.0],
    });
    await insertPanelScores({
      eventId: child.id,
      competitorId: diver.userId,
      judgeIds,
      diveId: childDive,
      roundNumber: 1,
      scores: [8.0, 8.0, 8.5, 8.5, 9.0],
    });
    await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Completed" });
    await setup.setEventStatus(request, { adminToken, eventId: child.id, status: "Completed" });

    const normal = await request.get(`/api/scoreboard/${parent.id}/leaderboard`);
    expect(normal.status(), "normal leaderboard").toBe(200);
    const normalBody = await normal.json();
    expect(normalBody.rounds).toHaveLength(1);
    expect(normalBody.rounds[0].rankings).toHaveLength(1);
    expect(normalBody.rounds[0].rankings[0].full_name).toBe("Leaderboard Diver");

    const carry = await request.get(`/api/scoreboard/${child.id}/leaderboard`);
    expect(carry.status(), "carry leaderboard").toBe(200);
    const carryBody = await carry.json();
    expect(carryBody.rounds).toHaveLength(1);
    const carryRow = carryBody.rounds[0].rankings[0];
    expect(carryRow.full_name).toBe("Leaderboard Diver");
    expect(Number(carryRow.cumulative_total)).toBeGreaterThan(Number(carryRow.round_total));
  } finally {
    await setup.deleteOrg(orgId);
  }
});
