// P6.3: ControlViewV2 Live BLOCKERS strip. Flag-on only. A partial panel
// surfaces "Waiting for N more judge scores" ON-CANVAS (not hidden in a
// tooltip) -- the four-question layout's BLOCKERS, answering "what's
// stopping me".
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test("a partial panel surfaces 'Waiting for N more judge scores' on-canvas", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Blockers Diving",
  });
  await setup.insertClub({ orgId, name: "BL Club", shortCode: "BLC" });
  const event = await setup.createEvent(request, {
    adminToken, name: "Live Blockers", total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Block Diver" });
  await setup.insertDiveList({ eventId: event.id, competitorId: diver.userId, dives: [{ round_number: 1, dive_id: diveId }] });
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `BL J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Live Blockers");

  // No blockers yet (no scores in).
  await expect(page.locator(".cv2-blockers")).toHaveCount(0);

  // 3 of 5 judges submit -> a partial blocker surfaces on-canvas.
  await setup.submitPanelScores({
    baseURL, judges: judges.slice(0, 3), eventId: event.id,
    competitorId: diver.userId, roundNumber: 1, diveId,
  });
  await expect(page.locator(".cv2-blockers")).toContainText(/Waiting for 2 more judge scores/i, { timeout: 6_000 });
  // And the primary stays disabled (not all scores in).
  await expect(page.locator(".cv2-primary")).toBeDisabled();
});
