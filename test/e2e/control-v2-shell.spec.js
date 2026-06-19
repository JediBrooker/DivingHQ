// P5: ControlViewV2 shell. Runs ONLY when VITE_CONTROL_V2_ENABLED=1 (the
// webServer builds + serves V2 then). With the flag off, the whole
// existing control suite runs against the untouched ControlView.vue --
// that flag-off run IS the fallback/regression proof, so this spec skips
// there rather than asserting against V1.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });
test.beforeEach(() => {
  test.skip(process.env.VITE_CONTROL_V2_ENABLED !== "1", "V2 flag off; V1 suite is the fallback proof");
});

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

test("rail renders one row per event; selecting a row focuses exactly one mode", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username } = await makeEvents(request, "V2 Shell Diving");
  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");

  // One rail row per event (this org has exactly two).
  await expect(page.locator(".stage-row")).toHaveCount(2);

  // Select the Upcoming event -> center shows EXACTLY ONE mode (Setup).
  await page.locator(".stage-row", { hasText: "V2 Upcoming" }).click();
  await expect(page.locator(".cv2-mode")).toHaveCount(1);
  await expect(page.locator('.cv2-mode[aria-label="Setup"]')).toBeVisible();

  // Roving focus moved rail -> center heading.
  const focusCls = await page.evaluate(() => document.activeElement?.className || "");
  expect(focusCls).toContain("cv2-stage-title");
});

test("?event= deep-link preselects in V2; a Live event shows the Live mode", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username, live } = await makeEvents(request, "V2 Deeplink Diving");
  await signIn(page, username);
  await page.goto(`/control?event=${live.id}`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator(".cv2-stage-title")).toHaveText("V2 Live");
  await expect(page.locator(".cv2-mode")).toHaveCount(1);
  await expect(page.locator('.cv2-mode[aria-label="Live"]')).toBeVisible();
});
