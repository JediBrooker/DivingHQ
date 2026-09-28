// A tab that stayed open across a deploy asks for a chunk that no longer
// exists. It should reload once onto the screen it was going to, not sit
// there ignoring the click.
//
// Service workers are blocked so page.route sees the chunk request (a
// worker would fetch it on its own and the route would never fire). The
// worker's side of this lives in test/sw.test.js.

const { test, expect } = require("@playwright/test");

test.use({ serviceWorkers: "block" });

test("a lazy screen whose chunk vanished reloads once and opens", async ({ page }) => {
  await page.goto("/privacy");
  const link = page.locator('a[href="/guide"]').first();
  await expect(link).toBeVisible();
  // Survives only as long as this document does, so it tells us whether
  // a real reload happened.
  await page.evaluate(() => { window.__openedBeforeDeploy = true; });

  let asked = 0;
  await page.route(/\/assets\/GuideView-[^/]+\.js$/, (route) => {
    asked++;
    if (asked === 1) return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
    return route.continue();
  });

  await link.click();
  await expect(page).toHaveURL(/\/guide$/, { timeout: 10_000 });
  await expect(page.locator("h1").first()).toBeVisible();
  expect(await page.evaluate(() => window.__openedBeforeDeploy)).toBeUndefined();
  expect(asked).toBe(2);
});

test("the server answers a missing /assets file with a 404, not the app shell", async ({ request }) => {
  const r = await request.get("/assets/GuideView-doesnotexist.js");
  expect(r.status()).toBe(404);
  expect(r.headers()["content-type"] || "").not.toContain("text/html");
});
