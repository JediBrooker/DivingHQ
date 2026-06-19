// P6.2: ControlViewV2 Live mode NEXT ACTION. Flag-on only. Proves the
// bottom-pinned primary: disabled until the dive's scores land, then
// "Next Diver" advances the focused pool's cursor; on the last dive it
// morphs to Finalise and runs the (reproduced) destructive finalise
// seam (confirm -> PUT Completed -> the center flips to Review).
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
    const diver = await setup.insertUser({ orgId, role: "diver", fullName: dn });
    await setup.insertDiveList({
      eventId: event.id, competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });
    divers.push(diver);
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

test("the primary arms on a full score then advances to the next diver", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Live Advance Diving",
  });
  await setup.insertClub({ orgId, name: "LA Club", shortCode: "LAC" });
  const { event, diveId, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Live Advance", diverNames: ["AAA Diver", "ZZZ Diver"],
  });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Live Advance");

  // roster[0] = "AAA Diver" (server order; alphabetical with no dive order).
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Diver");
  // Primary disabled until this dive's scores arrive.
  await expect(page.locator(".cv2-primary")).toBeDisabled();

  // A full panel for the active diver -> primary arms.
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id,
    competitorId: divers[0].userId, roundNumber: 1, diveId,
  });
  await expect(page.locator(".cv2-primary")).toBeEnabled({ timeout: 6_000 });

  // Click Next -> the cursor advances to the second diver.
  await page.locator(".cv2-primary").click();
  await expect(page.locator(".cv2-live-diver")).toContainText("ZZZ Diver");
  // ...and the primary disables again (fresh diver, no scores).
  await expect(page.locator(".cv2-primary")).toBeDisabled();
});

test("auto-advance: set Auto-next to 5s; a full panel arms a countdown that advances unaided", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Auto Advance Diving",
  });
  await setup.insertClub({ orgId, name: "AA Club", shortCode: "AAC" });
  const { event, diveId, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Auto Advance", diverNames: ["AAA Diver", "ZZZ Diver"],
  });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Auto Advance");
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Diver");

  // Open the Auto-next picker and choose 5 seconds (default is Manual).
  await page.locator(".cv2-split-aside").click();
  await page.getByRole("menuitemradio", { name: "5 seconds", exact: true }).click();
  await expect(page.locator(".cv2-autonext-menu")).toHaveCount(0);

  // A full panel arms the countdown -> the pill appears WITHOUT a click.
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id,
    competitorId: divers[0].userId, roundNumber: 1, diveId,
  });
  await expect(page.locator(".cv2-autopill")).toBeVisible({ timeout: 6_000 });

  // The countdown fires on its own and advances the focused pool's cursor
  // -- no operator click.
  await expect(page.locator(".cv2-live-diver")).toContainText("ZZZ Diver", { timeout: 12_000 });
});

test("the last dive morphs the primary to Finalise; confirming flips to Review", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Live Finalise Diving",
  });
  await setup.insertClub({ orgId, name: "LF Club", shortCode: "LFC" });
  const { event, diveId, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Live Finalise", diverNames: ["Solo Diver"],
  });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Live Finalise");
  await expect(page.locator('.cv2-live-layout[aria-label="Live"]')).toBeVisible();

  // Score the only (= last) dive -> primary morphs to Finalise.
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id,
    competitorId: divers[0].userId, roundNumber: 1, diveId,
  });
  await expect(page.locator(".cv2-primary")).toContainText(/finalise/i, { timeout: 6_000 });

  // Click -> the styled confirm modal -> confirm -> event Completed.
  await page.locator(".cv2-primary").click();
  await page.locator(".confirm-btn-primary").click();

  // The center now shows the Review mode (workflowMode flipped to review).
  await expect(page.locator('.cv2-mode[aria-label="Review"]')).toBeVisible({ timeout: 6_000 });
});
