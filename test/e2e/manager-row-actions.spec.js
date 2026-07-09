// P10 Cluster 2: event-row action consolidation. Each row reads as ONE
// dominant primary (the status-aware RouterLink), and every secondary
// (Teams / Advance / Super-Final seed+view) plus the maintenance actions
// live behind the single ⋯ menu primitive. Proves a team event doesn't
// have an inline "Teams"/advance button on the row, that "Teams…" is
// reachable in the menu, and that the menu keeps single-open + close
// semantics.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test("a row shows one primary; the secondaries live in the ⋯ menu", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Row Actions Diving",
  });
  await setup.createEvent(request, {
    adminToken, name: "Team Row Event", event_type: "team",
    total_rounds: 2, number_of_judges: 5, height: "3m",
  });

  await signIn(page, username);
  await page.goto("/manager");
  await expect(page.getByRole("button", { name: /\+ New event/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Your events|All events/i }).first().click();

  const row = page.locator(".event-item", { hasText: "Team Row Event" });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // ONE dominant primary on the row: the status-aware RouterLink, and
  // no inline Teams button or advance-btn competing with it.
  await expect(row.locator(".actions a.btn")).toHaveCount(1);
  await expect(row.locator(".actions > .advance-btn")).toHaveCount(0);
  await expect(row.locator(".actions > button", { hasText: "Teams" })).toHaveCount(0);

  // The secondary moved into the ⋯ menu.
  await row.locator(".dropdown-host button", { hasText: "⋯" }).first().click();
  const menu = row.locator(".event-overflow-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".dropdown-item", { hasText: /Teams/i })).toBeVisible();
  // Maintenance actions still present in the same menu.
  await expect(menu.locator(".dropdown-item", { hasText: /Edit event/i })).toBeVisible();

  // Single-open + outside-click close.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(menu).toHaveCount(0);
});
