// P-redesign: the Live board keeps the three columns (History · pool ·
// Standings) and collapses the side columns into edge drawers when more
// than one event runs at once. Flag-on only (V2 surface).
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

async function liveEvent(request, { orgId, adminToken, name }) {
  const event = await setup.createEvent(request, {
    adminToken, name, total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: `${name} Diver` });
  await setup.insertDiveList({
    eventId: event.id, competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `${name} J${i}` });
    judges.push(j);
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  return { event, diver, diveId };
}

test("one Live event shows three columns; History and Standings collapse + reopen", async ({ request, page }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Layout Single Diving",
  });
  await setup.insertClub({ orgId, name: "LY Club", shortCode: "LYC" });
  await liveEvent(request, { orgId, adminToken, name: "Solo Pool" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Solo Pool");

  // Three columns: History (left), pool card (center), Standings (right)
  await expect(page.locator(".cv2-side-history")).toBeVisible();
  await expect(page.locator(".cv2-side-standings")).toBeVisible();
  await expect(page.locator(".cv2-pool")).toHaveCount(1);
  await expect(page.locator(".cv2-side-tab")).toHaveCount(0);

  // Collapse History -> column gets replaced by an edge drawer tab.
  await page.getByRole("button", { name: "Collapse history" }).click();
  await expect(page.locator(".cv2-side-history")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open history drawer" })).toBeVisible();
  // Standings should be untouched.
  await expect(page.locator(".cv2-side-standings")).toBeVisible();

  // Reopen History from its tab
  await page.getByRole("button", { name: "Open history drawer" }).click();
  await expect(page.locator(".cv2-side-history")).toBeVisible();
});

test("two Live events auto-collapse both side columns to drawers; a tab peeks one back", async ({ request, page }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Layout Multi Diving",
  });
  await setup.insertClub({ orgId, name: "LM Club", shortCode: "LMC" });
  await liveEvent(request, { orgId, adminToken, name: "Alpha Pool" });
  await liveEvent(request, { orgId, adminToken, name: "Bravo Pool" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Alpha Pool");

  // Two pool cards, and BOTH side columns auto-collapse to edge tabs so
  // the cards get the width they need.
  await expect(page.locator(".cv2-pool")).toHaveCount(2);
  await expect(page.locator(".cv2-side")).toHaveCount(0);
  await expect(page.locator(".cv2-side-tab")).toHaveCount(2);

  // Peeking Standings opens its drawer (focused pool) without un-collapsing History
  await page.getByRole("button", { name: "Open standings drawer" }).click();
  await expect(page.locator(".cv2-side-standings")).toBeVisible();
  await expect(page.locator(".cv2-side-history")).toHaveCount(0);
});
