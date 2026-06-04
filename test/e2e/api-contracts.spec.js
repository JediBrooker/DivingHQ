// API response contract tests for SPA-critical payloads.
//
// These are not business-flow tests. They pin the JSON shapes that
// frontend views assume exist, so route refactors fail before they
// become undefined-property bugs in Vue components.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function auth(token) { return { Authorization: `Bearer ${token}` }; }
function expectUuid(value) { expect(value).toMatch(UUID_RE); }
function expectString(value) { expect(typeof value).toBe("string"); }
function expectNumber(value) { expect(typeof value).toBe("number"); }
function expectNumericValue(value) {
  const finiteNumber = Number.isFinite(Number(value));
  expect((typeof value === "number" || typeof value === "string") && finiteNumber).toBe(true);
}
function expectNullableString(value) {
  expect(value === null || typeof value === "string").toBe(true);
}
function expectArray(value) { expect(Array.isArray(value)).toBe(true); }

function expectScoreboardPayload(body) {
  expectArray(body.standings);
  expectArray(body.history);
  expectArray(body.upcoming);
  expectArray(body.panel);

  const upcoming = body.upcoming[0];
  expectUuid(upcoming.competitor_id);
  expectString(upcoming.full_name);
  expectNumber(upcoming.round_number);
  expectNumber(upcoming.round_order);
  expectString(upcoming.dive_code);
  expectString(upcoming.position);
  expectNumericValue(upcoming.dd);
  expectNullableString(upcoming.country_code ?? null);
  expectNullableString(upcoming.club_name ?? null);
  expectNullableString(upcoming.partner_id ?? null);
  expectNullableString(upcoming.partner_name ?? null);
  expectNullableString(upcoming.partner_country ?? null);
  expectNullableString(upcoming.team_name ?? null);
  expectNullableString(upcoming.description ?? null);

  const panel = body.panel[0];
  expectUuid(panel.judge_id);
  expectNumber(panel.judge_number);
  expectString(panel.full_name);
  expectString(panel.org_name);
  expectNullableString(panel.country_code ?? null);
  expectNullableString(panel.club_name ?? null);
  expectNullableString(panel.club_code ?? null);
}

function expectCoachEventRow(row) {
  expectUuid(row.event_id);
  expectString(row.event_name);
  expectString(row.height);
  expectString(row.event_type);
  expectString(row.status);
  expectNullableString(row.meet_id ?? null);
  expectNullableString(row.meet_name ?? null);
  expectNullableString(row.entries_close_at ?? null);
  expectNullableString(row.dive_list_locks_at ?? null);
  expectNumber(row.total_rounds);
  expectNumber(row.squad_entered_count);
}

function expectCoachDiveListsResponse(body) {
  expectUuid(body.event.id);
  expectString(body.event.name);
  expectString(body.event.height);
  expectString(body.event.event_type);
  expectString(body.event.status);
  expectNumber(body.event.total_rounds);
  expect(body.event.round_rules === null || typeof body.event.round_rules === "object").toBe(true);
  expectNullableString(body.event.entries_close_at ?? null);
  expectNullableString(body.event.dive_list_locks_at ?? null);
  expectNullableString(body.event.meet_id ?? null);
  expectNullableString(body.event.meet_name ?? null);
  expectArray(body.event.prescribed_rounds);
  expectArray(body.divers);

  const diver = body.divers[0];
  expectUuid(diver.diver_id);
  expectUuid(diver.org_id);
  expectString(diver.full_name);
  expectNullableString(diver.country_code ?? null);
  expectNullableString(diver.club_name ?? null);
  expectNullableString(diver.club_code ?? null);
  expectArray(diver.dives);
  expectNullableString(diver.partner_id ?? null);
  expectNullableString(diver.partner_name ?? null);
  expectNullableString(diver.confirmed_at ?? null);
  expectNullableString(diver.withdrawn_at ?? null);
  expect(typeof diver.is_reserve).toBe("boolean");
  expect(diver.reserve_position === null || typeof diver.reserve_position === "number").toBe(true);

  const dive = diver.dives[0];
  expectNumber(dive.round_number);
  expectUuid(dive.dive_id);
  expectString(dive.dive_code);
  expectString(dive.position);
  expectNumericValue(dive.dd);
  expectNullableString(dive.description ?? null);
}

test.describe.serial("API response contracts", () => {
  let org, event, diver, diveId, coachToken;

  test.beforeAll(async ({ request }) => {
    org = await setup.createOrgAndAdmin(request, {
      orgName: "API Contract Org",
      countryCode: "AUS",
    });
    event = await setup.createEvent(request, {
      adminToken: org.adminToken,
      name: "API Contract Event",
      total_rounds: 1,
      number_of_judges: 3,
      height: "3m",
    });
    diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Contract Diver" });
    await setup.insertDiveList({
      eventId: event.id,
      competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });

    const judgeIds = [];
    for (let i = 0; i < 3; i++) {
      const judge = await setup.insertUser({
        orgId: org.orgId,
        role: "judge",
        fullName: `Contract Judge ${i + 1}`,
      });
      judgeIds.push(judge.userId);
    }
    await setup.assignJudges(request, {
      adminToken: org.adminToken,
      eventId: event.id,
      judgeIds,
    });

    const coach = await setup.insertUser({ orgId: org.orgId, role: "coach", fullName: "Contract Coach" });
    await setup.linkCoach({ coachId: coach.userId, diverId: diver.userId, orgId: org.orgId });
    ({ token: coachToken } = await setup.loginAs(request, coach.username));
  });

  test.afterAll(async () => {
    if (org) await setup.deleteOrg(org.orgId);
  });

  test("/api/scoreboard/:eventId returns the live scoreboard contract", async ({ request }) => {
    const res = await request.get(`/api/scoreboard/${event.id}?cache=skip`, {
      headers: auth(org.adminToken),
    });
    expect(res.status()).toBe(200);
    expectScoreboardPayload(await res.json());
  });

  test("/api/coach/events returns the coach event-list contract", async ({ request }) => {
    const res = await request.get("/api/coach/events", {
      headers: auth(coachToken),
    });
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expectArray(rows);
    const row = rows.find((item) => item.event_id === event.id);
    expect(row).toBeTruthy();
    expectCoachEventRow(row);
  });

  test("/api/coach/dive-lists/:event_id returns the coach editor contract", async ({ request }) => {
    const res = await request.get(`/api/coach/dive-lists/${event.id}`, {
      headers: auth(coachToken),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expectCoachDiveListsResponse(body);
    expect(body.event.id).toBe(event.id);
    expect(body.divers[0].diver_id).toBe(diver.userId);
    expect(body.divers[0].dives[0].dive_id).toBe(diveId);
  });
});
