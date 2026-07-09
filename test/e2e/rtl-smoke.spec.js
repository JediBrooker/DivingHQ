// RTL boot + render smoke.
//
// Boots the SPA, drives the LocaleSwitcher to Arabic, and asserts
// the basic RTL plumbing is intact:
//
//   - <html dir="rtl"> is set after the locale flip
//   - public routes (/, /login) render without throwing
//   - one authenticated route (/dashboard) renders without throwing
//   - no console errors and no >=500 API responses
//   - a screenshot is written for each route for human eyeballing
//     (Playwright stores them next to the test results directory;
//     the file path is logged so reviewers can find them)
//
// We don't snapshot the screenshots, the goal is just a visual sanity
// check, and pixel-snapshotting Arabic glyphs is fragile across
// font-rendering versions. Use:
//   npx playwright test rtl-smoke --headed
// for a live look, or open the PNGs after a headless run.

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// Where to dump screenshots. test-results/ is gitignored.
const OUT_DIR = path.resolve(__dirname, "..", "..", "test-results", "rtl-smoke");

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

test("RTL: locale switch flips <html dir> and routes render", async ({ request, page }) => {
  test.setTimeout(60_000);

  const { orgId, username } = await setup.createOrgAndAdmin(request, {
    countryCode: "UAE",
    orgName: "RTL Smoke Federation",
  });
  try {
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    const apiErrors = setup.collectApiErrors(page);

    // Suppress the first-run setup wizard so the dashboard
    // doesn't redirect us mid-route.
    await page.addInitScript(() => {
      localStorage.setItem("setup.wizardCompleted.v1", "1");
      localStorage.setItem("setup.wizardDismissed.v1", "1");
    });

    // 1) Home in English, flip to Arabic via the actual <select>.
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();

    const localeSelect = page.locator("select.locale-select").first();
    await expect(localeSelect).toBeVisible();
    await localeSelect.selectOption("ar");
    // The locale chunk needs a beat to land + setLocale() to fire.
    await expect.poll(
      async () => page.evaluate(() => document.documentElement.getAttribute("dir")),
      { timeout: 5_000 },
    ).toBe("rtl");

    await page.screenshot({ path: path.join(OUT_DIR, "home-rtl.png"), fullPage: true });

    // 2) Login: public route, Arabic locale should persist via
    //    localStorage. Dir attribute must stay rtl.
    await page.goto("/login");
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
    const dirLogin = await page.evaluate(() => document.documentElement.getAttribute("dir"));
    expect(dirLogin).toBe("rtl");
    await page.screenshot({ path: path.join(OUT_DIR, "login-rtl.png"), fullPage: true });

    // 3) Authenticated route: log in then hit /dashboard.
    await page.locator('input[autocomplete="username"]').fill(username);
    await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
    await expect(page.locator("body")).toBeVisible();
    const dirDash = await page.evaluate(() => document.documentElement.getAttribute("dir"));
    expect(dirDash).toBe("rtl");
    await page.screenshot({ path: path.join(OUT_DIR, "dashboard-rtl.png"), fullPage: true });

    // 4) Console + API errors. We tolerate the occasional 404 on
    //    optional resources (favicon, etc.); those don't go through
    //    collectApiErrors (>=500-only) and console `error` is rarely
    //    emitted for them either.
    expect(apiErrors).toEqual([]);
    // Heads up: filtering out a known benign source here, network
    // warnings logged when the dev server hasn't seeded sponsor logos
    // or inbox attachments. Adjust if a real RTL regression starts
    // firing.
    const realConsoleErrors = consoleErrors.filter((line) =>
      !/Failed to load resource/.test(line),
    );
    expect(realConsoleErrors).toEqual([]);
  } finally {
    await setup.deleteOrg(orgId);
  }
});
