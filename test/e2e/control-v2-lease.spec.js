// Per-event control LEASE (#lease) + drop-detection (#7). When two
// operators drive the SAME event, both get an advisory conflict warning
// (the lease never blocks). And in normal operation a confirmed
// set_active_diver never raises the "not confirmed" warning. Flag-on only.
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

test("two operators on the same event both see a conflict warning", async ({ request, browser }) => {
  test.setTimeout(120_000);
  const { orgId, username: adminUser, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Lease Diving" });
  await setup.insertClub({ orgId, name: "LS Club", shortCode: "LSC" });
  await liveEvent(request, { orgId, adminToken, name: "Shared Pool", diverNames: ["AAA Diver"] });
  const opB = await setup.insertUser({ orgId, role: "meet_manager", fullName: "Operator B" });

  // Operator A claims control of the event first.
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await signIn(pageA, adminUser);
  await pageA.goto("/control");
  await pageA.waitForLoadState("networkidle");
  await setup.selectControlEvent(pageA, "Shared Pool");
  await pageA.waitForTimeout(600); // let A's claim land

  // Operator B opens the same event -> both operators are warned.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signIn(pageB, opB.username);
  await pageB.goto("/control");
  await pageB.waitForLoadState("networkidle");
  await setup.selectControlEvent(pageB, "Shared Pool");

  await expect(pageB.locator(".cv2-pool-conflict")).toContainText(/another operator/i, { timeout: 6_000 });
  // A (the lease holder) is contested -> also warned.
  await expect(pageA.locator(".cv2-pool-conflict")).toContainText(/another operator/i, { timeout: 6_000 });

  await ctxA.close();
  await ctxB.close();
});

test("a confirmed set_active_diver raises no 'not confirmed' warning", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Confirm Diving" });
  await setup.insertClub({ orgId, name: "CF Club", shortCode: "CFC" });
  const { event, diveId, divers, judges } = await liveEvent(request, { orgId, adminToken, name: "Confirm Pool", diverNames: ["AAA Diver", "ZZZ Diver"] });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Confirm Pool");

  // Advance to the next diver -> set_active_diver is echoed back, so the
  // pool never shows the unconfirmed warning.
  await setup.submitPanelScores({ baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId });
  await expect(page.locator(".cv2-primary")).toBeEnabled({ timeout: 6_000 });
  await page.locator(".cv2-primary").click();
  await expect(page.locator(".cv2-live-diver")).toContainText("ZZZ Diver");
  await page.waitForTimeout(1_000);
  await expect(page.locator(".cv2-pool-unconfirmed")).toHaveCount(0);
});
