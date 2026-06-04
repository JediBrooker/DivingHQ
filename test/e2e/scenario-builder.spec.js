// Smoke tests for the composed e2e scenario builder.
//
// The builder is intentionally small infrastructure: it wraps the
// raw _setup.js primitives so authz and workflow specs can request
// a realistic host/guest event world without repeating the same
// org/user/event/dive-list setup every time.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test("createEventScenario builds a cross-federation event world", async ({ request }) => {
  const scenario = await setup.createEventScenario(request, {
    crossFederation: true,
    withCoach: true,
    withDiveList: true,
    judgeCount: 3,
    event: {
      name: "Scenario Builder CrossFed",
      total_rounds: 1,
      number_of_judges: 3,
    },
  });

  try {
    expect(scenario.hostOrg.orgId).not.toBe(scenario.competitorOrg.orgId);
    expect(scenario.coach?.token).toBeTruthy();
    expect(scenario.judges).toHaveLength(3);

    const rows = await setup.pool.query(
      `SELECT
          EXISTS (
            SELECT 1 FROM event_participating_orgs
             WHERE event_id = $1 AND org_id = $2
          ) AS invited,
          (
            SELECT COUNT(*)::int FROM competitor_dive_lists
             WHERE event_id = $1 AND competitor_id = $3
          ) AS dive_rows,
          (
            SELECT COUNT(*)::int FROM event_judges
             WHERE event_id = $1
          ) AS judge_rows,
          (
            SELECT org_id FROM users WHERE id = $3
          ) AS competitor_org_id,
          (
            SELECT org_id FROM coach_diver_links
             WHERE coach_id = $4 AND diver_id = $3
          ) AS coach_link_org_id`,
      [
        scenario.event.id,
        scenario.competitorOrg.orgId,
        scenario.competitor.userId,
        scenario.coach.userId,
      ],
    );

    expect(rows.rows[0]).toMatchObject({
      invited: true,
      dive_rows: 1,
      judge_rows: 3,
      competitor_org_id: scenario.competitorOrg.orgId,
      coach_link_org_id: scenario.competitorOrg.orgId,
    });
  } finally {
    await scenario.cleanup();
  }
});
