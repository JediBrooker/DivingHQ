// P7.1: ControlViewV2 Setup mode. Flag-on only. An Upcoming event shows
// the pre-meet readiness checklist (what's blocking go-live) from the
// server's canonical readiness -- the four-question BLOCKERS made
// visible up front instead of buried in a stepper.
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

test("an Upcoming event shows the pre-meet readiness checklist", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Setup Diving",
  });
  await setup.createEvent(request, {
    adminToken, name: "Setup Event", total_rounds: 2, number_of_judges: 5, height: "3m",
  });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Setup Event");

  // Upcoming -> Setup mode.
  await expect(page.locator('.cv2-mode[aria-label="Setup"]')).toBeVisible();
  // The 6-core readiness checklist renders.
  await expect(page.locator(".setup-step")).toHaveCount(6);
  await expect(page.locator(".setup-checklist")).toContainText("Roster has competitors");
  // A fresh event (no roster) is blocked.
  await expect(page.locator(".setup-status.is-blocked")).toBeVisible();
});
