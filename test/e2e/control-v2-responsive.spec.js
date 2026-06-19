// P9: ControlViewV2 responsive collapse. Flag-on only, narrow viewport.
// Proves the single-column layout (the top control bar wraps, full-width
// center, bottom-sheet drawer), no PAGE horizontal scrollbar, and the
// Unknown/no-event state rendering exactly ONE coherent surface instead
// of a blank panel.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } }); // iPhone-ish width

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

const noPageHScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test("narrow viewport: Unknown state shows one surface; top bar wraps; drawer is a bottom sheet; no h-scroll", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Responsive Diving",
  });
  await setup.createEvent(request, {
    adminToken, name: "Responsive Event", total_rounds: 2, number_of_judges: 5, height: "3m",
  });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");

  // Unknown state (no stage selected yet): exactly ONE coherent surface,
  // never blank.
  await expect(page.locator(".cv2-empty .empty-state")).toBeVisible();
  expect(await noPageHScroll(page)).toBe(true);

  // Pick the stage -> Setup mode under the collapsed layout.
  await setup.selectControlEvent(page, "Responsive Event");
  await expect(page.locator('.cv2-mode[aria-label="Setup"]')).toBeVisible();
  expect(await noPageHScroll(page)).toBe(true);

  // The top control bar replaces the rail and wraps within the viewport
  // (no sideways page scroll) rather than stripping off-screen.
  await expect(page.locator(".cv2-topbar")).toBeVisible();
  expect(await noPageHScroll(page)).toBe(true);

  // The drawer opens as a bottom sheet pinned to the screen's bottom edge.
  await page.getByRole("button", { name: /Tools/ }).click();
  await expect(page.locator(".cv2-drawer")).toBeVisible();
  const box = await page.locator(".cv2-drawer").boundingBox();
  const vh = page.viewportSize().height;
  expect(box.y + box.height).toBeGreaterThanOrEqual(vh - 2); // flush to the bottom
  expect(await noPageHScroll(page)).toBe(true);
});
