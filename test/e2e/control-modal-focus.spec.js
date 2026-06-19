// P2: modal focus-management gate (written before the modal fan-out).
//
// Proves BaseModal's a11y contract on the first migrated modal
// (CheckInModal): on open, focus moves into the dialog; Tab/Shift+Tab
// stay trapped inside; Esc closes and returns focus to the opener.
// This is the behaviour the other six control-modal migrations inherit.
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

async function inDialog(page) {
  return page.evaluate(
    () => !!document.activeElement?.closest('.lb-modal[role="dialog"]'),
  );
}

test("check-in modal traps focus and restores it to the opener on close", async ({ request, page }) => {
  test.setTimeout(90_000);
  // Hold the layout still under the actionability checks.
  await page.emulateMedia({ reducedMotion: "reduce" });

  // Minimal check-in-ready event: an Upcoming event with one diver who
  // has a dive list, so the Control Room shows the "Check In Divers"
  // workflow button (orderWorkflowState === 'check-in', roster.length).
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS",
    orgName: "Modal Focus Diving",
  });
  await setup.insertClub({ orgId, name: "Focus Club", shortCode: "FOC" });
  const event = await setup.createEvent(request, {
    adminToken,
    name: "Focus Control Event",
    total_rounds: 2,
    number_of_judges: 5,
    height: "3m",
  });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Focus Diver" });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  await setup.insertDiveList({
    eventId: event.id,
    competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");

  // Select the event in the header picker -> loads the roster.
  await page.locator(".event-title-select").selectOption({ label: event.name });
  await page.waitForLoadState("networkidle");

  // Open the check-in modal from the workflow button.
  const trigger = page.getByRole("button", { name: /check in divers/i });
  await trigger.waitFor({ state: "visible" });
  await trigger.click();

  // The dialog is open and focus moved inside it.
  const dialog = page.locator('.lb-modal[role="dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(await inDialog(page)).toBe(true);

  // Tab stays trapped: many tabs forward never escape the dialog.
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    expect(await inDialog(page)).toBe(true);
  }
  // Shift+Tab too.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inDialog(page)).toBe(true);
  }

  // Esc closes and returns focus to the opener.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const restored = await page.evaluate(() => (document.activeElement?.textContent || "").trim());
  expect(restored).toContain("Check In Divers");
});
