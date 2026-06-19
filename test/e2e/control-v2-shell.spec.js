// ControlViewV2 shell — the top event bar lists every event and selecting
// one focuses exactly one stage mode. ControlViewV2 is the only Control
// Room now (the legacy ControlView was removed at cutover).
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

async function makeEvents(request, orgName) {
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS",
    orgName,
  });
  await setup.insertClub({ orgId, name: "V2 Club", shortCode: "V2C" });
  const upcoming = await setup.createEvent(request, {
    adminToken, name: "V2 Upcoming", total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const live = await setup.createEvent(request, {
    adminToken, name: "V2 Live", total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  await setup.setEventStatus(request, { adminToken, eventId: live.id, status: "Live" });
  return { orgId, username, adminToken, upcoming, live };
}

test("top bar lists every event; selecting one focuses exactly one mode", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username } = await makeEvents(request, "V2 Shell Diving");
  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");

  // The bar shows the Live event as a chip; the All events menu lists both.
  await expect(page.locator(".cv2-chip")).toHaveCount(1);
  await page.locator(".cv2-allbtn").click();
  await expect(page.locator(".cv2-allitem")).toHaveCount(2);
  await page.locator(".cv2-allbtn").click();

  // Select the Upcoming event -> center shows EXACTLY ONE mode (Setup).
  await setup.selectControlEvent(page, "V2 Upcoming");
  await expect(page.locator(".cv2-mode")).toHaveCount(1);
  await expect(page.locator('.cv2-mode[aria-label="Setup"]')).toBeVisible();

  // Roving focus moved into the (visually-hidden) stage heading.
  const focusCls = await page.evaluate(() => document.activeElement?.className || "");
  expect(focusCls).toContain("cv2-sr-title");
});

test("?event= deep-link preselects in V2; a Live event shows the Live mode", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username, live } = await makeEvents(request, "V2 Deeplink Diving");
  await signIn(page, username);
  await page.goto(`/control?event=${live.id}`);
  await page.waitForLoadState("networkidle");

  // The focused event's name lives in the top bar chip now.
  await expect(page.locator(".cv2-chip.is-focused")).toContainText("V2 Live");
  // Live mode renders the three-column board (History · pool · Standings),
  // not the old placeholder .cv2-mode panel.
  await expect(page.locator('.cv2-live-layout[aria-label="Live"]')).toBeVisible();
  await expect(page.locator(".cv2-pool")).toHaveCount(1);
});
