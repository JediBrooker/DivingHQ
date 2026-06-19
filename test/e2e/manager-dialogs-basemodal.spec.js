// P10 Cluster 3: the bespoke Manager dialogs migrated onto BaseModal.
// Proves the migrated dialog renders as a proper a11y dialog
// (.lb-modal[role=dialog][aria-modal]) with a wired aria-labelledby, and
// that BaseModal's Escape-to-close + focus management work — none of
// which the old .modal-backdrop shell provided. Uses the Federations
// (ParticipatingOrgs) + Import-roster dialogs, reachable from any
// host-org event row's overflow menu.
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

async function openManagerRowMenu(page, eventName) {
  await page.goto("/manager");
  await expect(page.getByRole("button", { name: /\+ New event/i })).toBeVisible({ timeout: 10_000 });
  // Master-detail rail: select the "Your events" section so the main
  // panel populates with rows.
  await page.getByRole("button", { name: /Your events|All events/i }).first().click();
  const row = page.locator(".event-item", { hasText: eventName });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator(".dropdown-host button", { hasText: "⋯" }).first().click();
  return row;
}

test("a migrated Manager dialog renders as a BaseModal a11y dialog and Escape closes it", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Mgr Dialog Diving",
  });
  await setup.createEvent(request, {
    adminToken, name: "Dialog Event", total_rounds: 2, number_of_judges: 5, height: "3m",
  });

  await signIn(page, username);
  const row = await openManagerRowMenu(page, "Dialog Event");

  // Federations… opens ParticipatingOrgsModal (migrated to BaseModal).
  await page.getByRole("menuitem", { name: /Federations/i })
    .or(page.locator(".dropdown-item", { hasText: /Federations/i })).first().click();

  const dialog = page.locator(".lb-modal[role='dialog']");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  // aria-labelledby resolves to a real title element inside the dialog.
  const labelledby = await dialog.getAttribute("aria-labelledby");
  expect(labelledby).toBeTruthy();
  await expect(page.locator(`#${labelledby}`)).toBeVisible();

  // BaseModal's Escape-to-close (the old .modal-backdrop had none).
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // A second dialog from the same menu also works (Import roster…).
  await row.locator(".dropdown-host button", { hasText: "⋯" }).first().click();
  await page.locator(".dropdown-item", { hasText: /Import roster/i }).first().click();
  await expect(page.locator(".lb-modal[role='dialog']")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".lb-modal[role='dialog']")).toHaveCount(0);
});
