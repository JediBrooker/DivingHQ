// Club-first signup, end to end through the real UI (phase 1 of
// docs/club-first-onboarding.md).
//
// A club founder from a country with nobody on DivingHQ signs up by
// country, becomes their club's admin, and can run a meet without any
// federation or sysadmin in the loop. The permission edges are covered
// in test/integration.test.js; this pins down that the screens actually
// get a founder from signup to their first meet.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// Tonga: small enough that no other spec or seed touches it.
const COUNTRY = "TON";
const world = {};

async function wipeCountry() {
  const orgs = await setup.pool.query(
    "SELECT id FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'",
    [COUNTRY],
  );
  for (const { id } of orgs.rows) {
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [id]);
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
    await setup.deleteOrg(id);
  }
}

test.beforeAll(wipeCountry);
test.afterAll(wipeCountry);

test("a founder signs up by country and runs their club's first meet", async ({ page }) => {
  await setup.installClickHighlight(page);
  world.username = `e2e-founder-${setup.rand()}`;

  await page.goto("/register");
  await page.locator('input[autocomplete="name"]').fill("Sione Fifita");
  await page.locator('input[autocomplete="username"]').fill(world.username);
  await page.locator('input[autocomplete="email"]').fill(`${world.username}@example.test`);
  await page.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);

  // Country first; nobody from Tonga is on DivingHQ yet.
  const country = page.locator("select").first();
  await country.selectOption(COUNTRY);
  await expect(page.getByText(/Nobody from .* is on DivingHQ yet/)).toBeVisible();

  const club = page.locator("select").filter({ has: page.locator('option[value="new"]') });
  await club.selectOption("new");
  await page.getByPlaceholder("e.g. Sydney Springboard").fill("Nuku'alofa Divers");
  await expect(page.getByText(/You'll be this club's admin/)).toBeVisible();
  // No federation, so no org-wide meet manager on offer.
  await expect(page.locator('option[value="meet_manager"]')).toHaveCount(0);

  await page.getByRole("button", { name: /Create Account/i }).click();
  await expect(page.locator(".msg-success")).toBeVisible();

  // The country account exists, unclaimed, with the founder as club admin.
  const org = await setup.pool.query(
    "SELECT id, claim_state FROM organisations WHERE country_code = $1", [COUNTRY],
  );
  expect(org.rows).toHaveLength(1);
  expect(org.rows[0].claim_state).toBe("unclaimed");

  // No inbox in e2e, so stand in for the verification click.
  await setup.pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [world.username]);

  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(world.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });

  // Club admins get the meet screens and their club page, not the
  // federation's admin tools.
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: /My club/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Meet Manager/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /User Manager/ })).toHaveCount(0);

  await page.goto("/manager");
  await page.getByRole("button", { name: /New meet/i }).click();
  await page.getByPlaceholder("e.g. 2026 National Open").fill("Tonga Club Open");
  await page.getByRole("button", { name: /Create meet/i }).click();
  await expect(page.getByText("Tonga Club Open")).toBeVisible();

  const meet = await setup.pool.query(
    `SELECT m.host_club_id, c.name AS club
       FROM meets m JOIN clubs c ON c.id = m.host_club_id
      WHERE m.org_id = $1`,
    [org.rows[0].id],
  );
  expect(meet.rows).toHaveLength(1);
  expect(meet.rows[0].club).toBe("Nuku'alofa Divers");
});
