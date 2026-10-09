// One event has one progression owner. A second operator observes until
// an explicit takeover, which immediately removes the old owner's controls.
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

async function liveEvent(request, { orgId, adminToken, name, diverNames }) {
  const event = await setup.createEvent(request, {
    adminToken, name, total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const divers = [];
  for (const dn of diverNames) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: dn });
    await setup.insertDiveList({ eventId: event.id, competitorId: d.userId, dives: [{ round_number: 1, dive_id: diveId }] });
    divers.push(d);
  }
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `${name} J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  return { event, diveId, divers, judges };
}

test("a second operator observes, then explicitly takes over the event", async ({ request, browser }) => {
  test.setTimeout(120_000);
  const { orgId, username: adminUser, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Lease Diving" });
  await setup.insertClub({ orgId, name: "LS Club", shortCode: "LSC" });
  await liveEvent(request, { orgId, adminToken, name: "Shared Pool", diverNames: ["AAA Diver"] });
  const opB = await setup.insertUser({ orgId, role: "meet_manager", fullName: "Operator B" });

  // Operator A grabs control of the event first.
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await signIn(pageA, adminUser);
  await pageA.goto("/control");
  await pageA.waitForLoadState("networkidle");
  await setup.selectControlEvent(pageA, "Shared Pool");
  await pageA.waitForTimeout(600); // give A's claim a moment to land

  // Merely opening the event must not challenge its current operator.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signIn(pageB, opB.username);
  await pageB.goto("/control");
  await pageB.waitForLoadState("networkidle");
  await setup.selectControlEvent(pageB, "Shared Pool", { takeControl: false });
  await expect(pageB.locator(".cv2-primary")).toBeDisabled();
  await expect(pageA.getByRole("button", { name: "Release control", exact: true })).toBeVisible();
  await pageB.getByRole("button", { name: "Take control", exact: true }).click();

  await expect(pageB.locator(".cv2-pool-conflict")).toContainText(/another operator/i, { timeout: 6_000 });
  await expect(pageB.locator(".cv2-primary")).toBeDisabled();
  await expect(pageA.getByRole("button", { name: "Release control", exact: true })).toBeVisible();
  await pageB.getByRole("button", { name: "Take over", exact: true }).click();
  await expect(pageB.getByRole("dialog")).toContainText("Shared Pool");
  await pageB.getByRole("dialog").getByRole("button", { name: "Take over", exact: true }).click();
  await expect(pageB.getByRole("button", { name: "Release control", exact: true })).toBeVisible();
  await expect(pageA.locator(".cv2-pool-conflict")).toContainText(/another operator/i, { timeout: 6_000 });
  await expect(pageA.locator(".cv2-primary")).toBeDisabled();

  await ctxA.close();
  await ctxB.close();
});

test("advancing the pool puts the next diver on stage", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Confirm Diving" });
  await setup.insertClub({ orgId, name: "CF Club", shortCode: "CFC" });
  const { event, diveId, divers, judges } = await liveEvent(request, { orgId, adminToken, name: "Confirm Pool", diverNames: ["AAA Diver", "ZZZ Diver"] });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Confirm Pool");

  // Advance to the next diver once the panel is in.
  await setup.submitPanelScores({ baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId });
  await expect(page.locator(".cv2-primary")).toBeEnabled({ timeout: 6_000 });
  await page.locator(".cv2-primary").click();
  await expect(page.locator(".cv2-live-diver")).toContainText("ZZZ Diver");
});
