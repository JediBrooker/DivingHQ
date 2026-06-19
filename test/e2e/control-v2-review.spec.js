// P8.1: ControlViewV2 Review mode. Flag-on only. A Completed event shows
// its final standings (read from /api/scoreboard/:id) + a link to the
// public scoreboard.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });
test.beforeEach(() => {
  test.skip(process.env.VITE_CONTROL_V2 !== "on", "V2 flag off; review mode is a V2-only surface");
});

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test("a Completed event shows the final standings", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Review Diving",
  });
  const event = await setup.createEvent(request, {
    adminToken, name: "Review Event", total_rounds: 1, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Podium Diver" });
  await setup.insertDiveList({ eventId: event.id, competitorId: diver.userId, dives: [{ round_number: 1, dive_id: diveId }] });
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `RV J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  await setup.submitPanelScores({ baseURL, judges, eventId: event.id, competitorId: diver.userId, roundNumber: 1, diveId });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Completed" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await page.locator(".stage-row", { hasText: "Review Event" }).click();

  await expect(page.locator('.cv2-mode[aria-label="Review"]')).toBeVisible();
  await expect(page.locator(".review-row")).toHaveCount(1);
  await expect(page.locator(".review-name")).toContainText("Podium Diver");
});
