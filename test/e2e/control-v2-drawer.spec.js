// P8 secondary-surfaces drawer. Flag-on only. Proves the drawer is closed
// (absent from the DOM) by default, opens from the stage-head Tools
// control, lazy-mounts each section's body only on open, and closes on
// Escape. The lazy-mount IS the #9 subtraction the redesign banks on.
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

test("the drawer is closed by default, opens from Tools, lazy-mounts sections, closes on Escape", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Drawer Diving",
  });
  await setup.createEvent(request, {
    adminToken, name: "Drawer Event", total_rounds: 2, number_of_judges: 5, height: "3m",
  });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Drawer Event");

  // Closed by default: NONE of the drawer markup is in the DOM.
  await expect(page.locator(".cv2-drawer")).toHaveCount(0);

  // Open from the stage-head Tools control.
  await page.getByRole("button", { name: /Tools/ }).click();
  await expect(page.locator(".cv2-drawer")).toBeVisible();

  // Each section's body is absent until its row is opened (lazy-mount).
  await expect(page.locator(".cv2-drawer-reserves")).toHaveCount(0);
  await page.getByRole("button", { name: /Reserves/ }).click();
  await expect(page.locator(".cv2-drawer-reserves")).toBeVisible();

  await expect(page.locator(".cv2-drawer-audit")).toHaveCount(0);
  await page.getByRole("button", { name: /Recent audit/ }).click();
  await expect(page.locator(".cv2-drawer-audit")).toBeVisible();
  // One section open at a time: opening audit closed reserves.
  await expect(page.locator(".cv2-drawer-reserves")).toHaveCount(0);

  // The broadcast chooser is not mounted until its section is opened.
  await expect(page.locator(".cv2-drawer-broadcast")).toHaveCount(0);
  await page.getByRole("button", { name: /Broadcast/ }).click();
  await expect(page.locator(".cv2-drawer-broadcast")).toBeVisible();

  // Escape closes the drawer entirely (markup gone again).
  await page.keyboard.press("Escape");
  await expect(page.locator(".cv2-drawer")).toHaveCount(0);
});
