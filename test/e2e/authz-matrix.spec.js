// Table-driven authorization matrix tests.
//
// The older privileged-write pack asserts detailed side effects for
// individual endpoints. This file complements it by making the
// role/org/event relationship matrix explicit, so a tenant-boundary
// regression shows up as one failed row instead of a bespoke test
// buried in endpoint setup.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

function auth(token) { return { Authorization: `Bearer ${token}` }; }

async function createActor(request, scenario, actorKind, extras) {
  if (actorKind === "linked_coach") return scenario.coach;

  if (actorKind === "wrong_role_diver") {
    const session = await setup.loginAs(request, scenario.competitor.username);
    return { ...scenario.competitor, token: session.token };
  }

  if (actorKind === "no_link_coach") {
    const coach = await setup.insertUser({
      orgId: scenario.competitorOrg.orgId,
      role: "coach",
      fullName: "Matrix No Link Coach",
    });
    const session = await setup.loginAs(request, coach.username);
    return { ...coach, token: session.token };
  }

  if (actorKind === "unrelated_link_coach") {
    const otherOrg = await setup.createOrgAndAdmin(request, {
      orgName: "Matrix Unrelated Org",
      countryCode: "OTH",
    });
    extras.push(() => setup.deleteOrg(otherOrg.orgId));
    const coach = await setup.insertUser({
      orgId: otherOrg.orgId,
      role: "coach",
      fullName: "Matrix Unrelated Coach",
    });
    await setup.linkCoach({
      coachId: coach.userId,
      diverId: scenario.competitor.userId,
      orgId: otherOrg.orgId,
    });
    const session = await setup.loginAs(request, coach.username);
    return { ...coach, token: session.token };
  }

  throw new Error(`unknown actorKind: ${actorKind}`);
}

async function assertNoWithdrawStamp(eventId, competitorId) {
  const check = await setup.pool.query(
    `SELECT COUNT(*)::int AS n
       FROM competitor_dive_lists
      WHERE event_id = $1
        AND competitor_id = $2
        AND withdrawn_at IS NOT NULL`,
    [eventId, competitorId],
  );
  expect(check.rows[0].n).toBe(0);
}

test.describe.serial("Coach write authorization matrix", () => {
  const cases = [
    {
      name: "host-org linked coach",
      crossFederation: false,
      actorKind: "linked_coach",
      expectedStatus: 200,
    },
    {
      name: "invited home-federation linked coach",
      crossFederation: true,
      actorKind: "linked_coach",
      expectedStatus: 200,
    },
    {
      name: "unrelated federation link",
      crossFederation: true,
      actorKind: "unrelated_link_coach",
      expectedStatus: 403,
    },
    {
      name: "no coach link",
      crossFederation: true,
      actorKind: "no_link_coach",
      expectedStatus: 403,
    },
    {
      name: "wrong role",
      crossFederation: true,
      actorKind: "wrong_role_diver",
      expectedStatus: 403,
    },
  ];

  for (const row of cases) {
    test(`${row.name}: submit and withdraw enforce the same boundary`, async ({ request }) => {
      const extras = [];
      const scenario = await setup.createEventScenario(request, {
        crossFederation: row.crossFederation,
        withCoach: true,
        withDiveList: false,
        judgeCount: 0,
        event: {
          name: `Matrix ${row.name}`,
          total_rounds: 1,
          number_of_judges: 5,
        },
      });

      try {
        const actor = await createActor(request, scenario, row.actorKind, extras);
        const submit = await request.post(
          `/api/coach/dive-lists/${scenario.event.id}/${scenario.competitor.userId}`,
          {
            headers: auth(actor.token),
            data: { dives: [{ round_number: 1, dive_id: scenario.diveId }] },
          },
        );
        expect(submit.status()).toBe(row.expectedStatus);

        if (row.expectedStatus !== 200) {
          await setup.insertDiveList({
            eventId: scenario.event.id,
            competitorId: scenario.competitor.userId,
            dives: [{ round_number: 1, dive_id: scenario.diveId }],
          });
        }

        const withdraw = await request.post(
          `/api/coach/dive-lists/${scenario.event.id}/${scenario.competitor.userId}/withdraw`,
          {
            headers: auth(actor.token),
            data: { reason: `matrix ${row.actorKind}` },
          },
        );
        expect(withdraw.status()).toBe(row.expectedStatus);

        if (row.expectedStatus === 200) {
          expect((await withdraw.json()).rows_updated).toBe(1);
        } else {
          await assertNoWithdrawStamp(scenario.event.id, scenario.competitor.userId);
        }
      } finally {
        for (const cleanup of extras.reverse()) await cleanup();
        await scenario.cleanup();
      }
    });
  }
});
