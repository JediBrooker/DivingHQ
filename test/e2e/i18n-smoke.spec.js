// Locale smoke coverage.
//
// The goal is not translation quality; it is to catch broken
// dictionaries, raw key leakage, blank pages, and RTL boot issues
// across representative public + authenticated routes.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const RAW_KEY_RE = /\b(?:auth|common|dashboard|manager|home|coach|scoreboard|nav)\.[a-z0-9_.-]+\b/i;

async function assertHealthyPage(page, label) {
  await expect(page.locator("body"), label).toBeVisible();
  const text = (await page.locator("body").innerText()).trim();
  expect(text.length, `${label} rendered text`).toBeGreaterThan(40);
  expect(text, `${label} raw i18n key`).not.toMatch(RAW_KEY_RE);
}

for (const locale of ["es", "de", "ar"]) {
  test(`locale smoke: ${locale}`, async ({ request, page }) => {
    test.setTimeout(60_000);

    const { orgId, username } = await setup.createOrgAndAdmin(request, {
      countryCode: locale === "de" ? "DEU" : locale === "es" ? "ESP" : "UAE",
      orgName: `Locale ${locale.toUpperCase()} Federation`,
    });
    try {
      const adminLogin = await setup.loginAs(request, username);
      await setup.insertClub({
        orgId,
        name: `Locale ${locale.toUpperCase()} Diving Club`,
        shortCode: locale.toUpperCase(),
      });
      await setup.createEvent(request, {
        adminToken: adminLogin.token,
        name: `Locale ${locale.toUpperCase()} Event`,
        total_rounds: 2,
        number_of_judges: 5,
        height: "3m",
      });

      const apiErrors = setup.collectApiErrors(page);
      await page.addInitScript((code) => {
        localStorage.setItem("locale", code);
        localStorage.setItem("setup.wizardCompleted.v1", "1");
        localStorage.setItem("setup.wizardDismissed.v1", "1");
      }, locale);

      await page.goto("/");
      await assertHealthyPage(page, `${locale} home`);

      await page.goto("/login");
      await assertHealthyPage(page, `${locale} login`);
      await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
      await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeVisible();

      await page.locator('input[autocomplete="username"]').fill(username);
      await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
      await assertHealthyPage(page, `${locale} dashboard`);

      await page.goto("/manager");
      await assertHealthyPage(page, `${locale} manager`);
      // Master–detail Meet Manager: the "+ New event" action in the
      // detail header proves the page mounted in this locale (the
      // button text is not translated, so it's locale-stable).
      await expect(page.getByRole("button", { name: /\+ New event/i })).toBeVisible();

      const dir = await page.evaluate(() => document.documentElement.getAttribute("dir"));
      expect(dir).toBe(locale === "ar" ? "rtl" : "ltr");
      expect(apiErrors).toEqual([]);
    } finally {
      await setup.deleteOrg(orgId);
    }
  });
}
