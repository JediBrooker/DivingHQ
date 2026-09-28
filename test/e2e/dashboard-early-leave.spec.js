// Leaving the dashboard before its first /api/dashboard bundle is back.
//
// onMounted awaits the bundle and then decides the /setup redirect and
// starts the poll, the socket handlers and the visibility listener. If the
// user has already clicked away by then, onUnmounted has run first, so
// none of that should happen: no bounce to /setup from the page they went
// to, and nothing left behind that keeps asking for the bundle.
//
// The bundle is held with page.route until after the user has navigated,
// which is the slow-network case this is about.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

async function signIn(page, username) {
  await setup.bypassRoleTour(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
}

// Holds the first /api/dashboard request until release() is called.
async function holdFirstBundle(page) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = false;
  let count = 0;
  await page.route("**/api/dashboard", async (route) => {
    count += 1;
    if (!held) { held = true; await gate; }
    await route.continue();
  });
  return { release, count: () => count };
}

test("a fresh org admin who leaves early isn't bounced to /setup later", async ({ request, page }) => {
  test.setTimeout(60_000);
  // No events and no clubs, so the dashboard would normally redirect.
  const { username } = await setup.createOrgAndAdmin(request);
  const bundle = await holdFirstBundle(page);

  await signIn(page, username);
  await page.waitForURL(/\/dashboard$/);
  await page.locator('a[href="/scoreboard"]').first().click();
  await page.waitForURL(/\/scoreboard/);

  bundle.release();
  // Give the late bundle (and the /api/clubs check after it) time to land.
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toBe("/scoreboard");
});

test("nothing keeps refetching the bundle after an early leave", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username, adminToken } = await setup.createOrgAndAdmin(request);
  await setup.createEvent(request, { adminToken });   // no redirect path
  const bundle = await holdFirstBundle(page);

  await signIn(page, username);
  await page.waitForURL(/\/dashboard$/);
  await page.locator('a[href="/scoreboard"]').first().click();
  await page.waitForURL(/\/scoreboard/);

  bundle.release();
  await page.waitForTimeout(1500);
  const before = bundle.count();
  // Coming back to the tab is what the dashboard's visibility listener
  // refetches on. It should be gone along with the dashboard.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(800);
  expect(bundle.count()).toBe(before);
});
