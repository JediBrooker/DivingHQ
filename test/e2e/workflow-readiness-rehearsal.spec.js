// Focused workflow/readiness + rehearsal-mode contracts.
//
// These tests hit the newer operator dashboard surfaces directly:
// /api/events/:id/readiness, dashboard.workflow_actions,
// dashboard.referee_desk, dashboard.coach_workbench, and the
// "rehearsal events are private/no-side-effects" guarantee.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

function headers(token) {
  return { Authorization: `Bearer ${token}` };
}

async function jsonOk(response, label) {
  expect(response.status(), label).toBe(200);
  return await response.json();
}

async function createJudges(request, { orgId, eventId, adminToken, count = 5 }) {
  const judges = [];
  for (let i = 1; i <= count; i++) {
    const judge = await setup.insertUser({
      orgId,
      role: "judge",
      fullName: `Workflow Judge ${i}`,
    });
    const login = await setup.loginAs(request, judge.username);
    judges.push({ ...judge, token: login.token });
  }
  await setup.assignJudges(request, {
    adminToken,
    eventId,
    judgeIds: judges.map((judge) => judge.userId),
  });
  return judges;
}

test("readiness progresses from blockers to ready and dashboard mirrors it", async ({ request }) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  try {
    const event = await setup.createEvent(request, {
      adminToken,
      name: "E2E Workflow Readiness",
      total_rounds: 2,
      number_of_judges: 5,
      height: "3m",
    });

    const readiness = async () => jsonOk(
      await request.get(`/api/events/${event.id}/readiness`, {
        headers: headers(adminToken),
      }),
      "readiness",
    );

    let state = await readiness();
    expect(state.ready).toBe(false);
    expect(state.next_action.key).toBe("roster");
    expect(state.blockers.map((b) => b.key)).toEqual([
      "roster",
      "dive_lists",
      "panel",
      "check_in",
      "order",
      "sign_off",
    ]);
    expect(state.steps).toHaveLength(6);

    let dashboard = await jsonOk(
      await request.get("/api/dashboard", { headers: headers(adminToken) }),
      "dashboard",
    );
    let action = dashboard.workflow_actions.find((row) => row.event_id === event.id);
    expect(action).toBeTruthy();
    expect(action.next_action.key).toBe("roster");
    expect(action.ready).toBe(false);

    const diver = await setup.insertUser({
      orgId,
      role: "diver",
      fullName: "Workflow Diver",
    });
    const firstDive = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    const secondDive = await setup.pickDiveId({ height: 3.0, dive_code: "201", position: "B" });

    await setup.insertDiveList({
      eventId: event.id,
      competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: firstDive }],
    });
    state = await readiness();
    expect(state.active_diver_count).toBe(1);
    expect(state.blockers.map((b) => b.key)).toContain("dive_lists");

    await setup.insertDiveList({
      eventId: event.id,
      competitorId: diver.userId,
      dives: [{ round_number: 2, dive_id: secondDive }],
    });
    state = await readiness();
    expect(state.blockers.map((b) => b.key)).not.toContain("dive_lists");
    expect(state.next_action.key).toBe("panel");

    await createJudges(request, {
      orgId,
      eventId: event.id,
      adminToken,
      count: 5,
    });
    state = await readiness();
    expect(state.judge_count).toBe(5);
    expect(state.next_action.key).toBe("check_in");

    await jsonOk(
      await request.post(`/api/events/${event.id}/check-in/confirm`, {
        headers: headers(adminToken),
      }),
      "check-in confirm",
    );
    await jsonOk(
      await request.post(`/api/events/${event.id}/dive-order/confirm`, {
        headers: headers(adminToken),
      }),
      "order confirm",
    );
    await jsonOk(
      await request.post(`/api/events/${event.id}/dive-order/sign-off`, {
        headers: headers(adminToken),
      }),
      "sign-off",
    );

    state = await readiness();
    expect(state.ready).toBe(true);
    expect(state.blockers).toEqual([]);
    expect(state.next_action.key).toBe("start");
    expect(state.steps.every((step) => step.done)).toBe(true);

    dashboard = await jsonOk(
      await request.get("/api/dashboard", { headers: headers(adminToken) }),
      "dashboard ready",
    );
    action = dashboard.workflow_actions.find((row) => row.event_id === event.id);
    expect(action.ready).toBe(true);
    expect(action.next_action.key).toBe("start");
  } finally {
    await setup.deleteOrg(orgId);
  }
});

test("dashboard exposes referee desk and coach workbench slices", async ({ request }) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  try {
    const event = await setup.createEvent(request, {
      adminToken,
      name: "E2E Dashboard Persona Slices",
      total_rounds: 2,
      number_of_judges: 5,
      height: "3m",
    });
    const referee = await setup.insertUser({
      orgId,
      role: "referee",
      fullName: "Workflow Referee",
    });
    const refereeLogin = await setup.loginAs(request, referee.username);

    const signoff = await request.post(`/api/events/${event.id}/dive-order/sign-off/request`, {
      headers: headers(adminToken),
      data: { referee_id: referee.userId },
    });
    expect(signoff.status(), "sign-off request").toBe(201);

    const refereeDash = await jsonOk(
      await request.get("/api/dashboard", { headers: headers(refereeLogin.token) }),
      "referee dashboard",
    );
    expect(refereeDash.referee_desk).toBeTruthy();
    expect(refereeDash.referee_desk.pending_signoffs.some((row) =>
      row.event_id === event.id && row.event_name === event.name,
    )).toBe(true);

    const coach = await setup.insertUser({
      orgId,
      role: "coach",
      fullName: "Workflow Coach",
    });
    const coachLogin = await setup.loginAs(request, coach.username);
    const diver = await setup.insertUser({
      orgId,
      role: "diver",
      fullName: "Coach Workbench Diver",
    });
    await setup.pool.query(
      `INSERT INTO coach_diver_links (coach_id, diver_id, org_id)
       VALUES ($1, $2, $3)`,
      [coach.userId, diver.userId, orgId],
    );
    const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    await setup.insertDiveList({
      eventId: event.id,
      competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });

    const coachDash = await jsonOk(
      await request.get("/api/dashboard", { headers: headers(coachLogin.token) }),
      "coach dashboard",
    );
    expect(coachDash.coach.divers.some((row) => row.id === diver.userId)).toBe(true);
    expect(coachDash.coach_workbench.incomplete_lists.some((row) =>
      row.event_id === event.id
      && row.diver_id === diver.userId
      && row.incomplete === true,
    )).toBe(true);
  } finally {
    await setup.deleteOrg(orgId);
  }
});

test("rehearsal events stay private and skip archive, analytics, records, and notifications", async ({
  request,
  baseURL,
}) => {
  test.setTimeout(60_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  try {
    const event = await setup.createEvent(request, {
      adminToken,
      name: "E2E Rehearsal Event",
      total_rounds: 1,
      number_of_judges: 5,
      height: "3m",
      is_rehearsal: true,
    });
    expect(event.is_rehearsal).toBe(true);

    const edited = await request.put(`/api/events/${event.id}`, {
      headers: headers(adminToken),
      data: { name: "E2E Rehearsal Event Edited" },
    });
    expect(edited.status(), "edit rehearsal").toBe(200);
    expect((await edited.json()).is_rehearsal).toBe(true);

    const managerEvents = await jsonOk(
      await request.get("/api/events", { headers: headers(adminToken) }),
      "manager events",
    );
    expect(managerEvents.some((row) => row.id === event.id && row.is_rehearsal)).toBe(true);

    const diver = await setup.insertUser({
      orgId,
      role: "diver",
      fullName: "Rehearsal Diver",
    });
    const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    await setup.insertDiveList({
      eventId: event.id,
      competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });
    const judges = await createJudges(request, {
      orgId,
      eventId: event.id,
      adminToken,
      count: 5,
    });

    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
    await setup.submitPanelScores({
      baseURL,
      judges,
      eventId: event.id,
      competitorId: diver.userId,
      roundNumber: 1,
      diveId,
    });
    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Completed" });

    const publicEvents = await jsonOk(await request.get("/api/events"), "anonymous events");
    expect(publicEvents.map((row) => row.id)).not.toContain(event.id);

    const archive = await jsonOk(await request.get("/api/archive"), "archive");
    expect(archive.map((row) => row.id)).not.toContain(event.id);
    const archiveResults = await request.get(`/api/archive/${event.id}/results`);
    expect(archiveResults.status(), "archive results for rehearsal").toBe(404);

    const analytics = await jsonOk(
      await request.get(`/api/divers/${diver.userId}/analytics`, {
        headers: headers(adminToken),
      }),
      "rehearsal diver analytics",
    );
    expect(JSON.stringify(analytics)).not.toContain(event.id);

    const records = await jsonOk(
      await request.get(`/api/records?event_id=${event.id}`, {
        headers: headers(adminToken),
      }),
      "rehearsal records",
    );
    expect(records).toEqual([]);

    const notifications = await setup.pool.query(
      `SELECT id
         FROM notifications
        WHERE data->>'event_id' = $1
           OR action_url LIKE $2`,
      [event.id, `%${event.id}%`],
    );
    expect(notifications.rows).toHaveLength(0);
  } finally {
    await setup.deleteOrg(orgId);
  }
});
