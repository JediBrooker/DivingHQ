// P7.3 / Recovery mode. Flag-on only. The cross-cutting Recovery center:
// hold the meet (useMeetHold) -> a hold banner appears; resume clears it.
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

test("recovery: hold the meet shows a banner; resume clears it", async ({ request, page }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Recovery Diving",
  });
  await setup.insertClub({ orgId, name: "RC Club", shortCode: "RCC" });
  const event = await setup.createEvent(request, {
    adminToken, name: "Recovery Event", total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Rec Diver" });
  await setup.insertDiveList({ eventId: event.id, competitorId: diver.userId, dives: [{ round_number: 1, dive_id: diveId }] });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Recovery Event");

  // Enter recovery from the top control bar.
  await page.locator(".cv2-act-recovery").click();
  await expect(page.locator('.cv2-mode[aria-label="Recovery"]')).toBeVisible();

  // Hold the meet -> prompt -> confirm -> banner.
  await page.locator(".cv2-recovery-btn", { hasText: "Hold meet" }).click();
  await page.locator(".cv2-hold-input").fill("pool maintenance");
  await page.locator(".cv2-hold-confirm").click();
  await expect(page.locator(".cv2-hold-banner")).toContainText(/Meet held/i);
  await expect(page.locator(".cv2-hold-banner")).toContainText(/pool maintenance/i);

  // Resume -> banner gone.
  await page.locator(".cv2-hold-banner button", { hasText: "Resume" }).click();
  await expect(page.locator(".cv2-hold-banner")).toHaveCount(0);
});
