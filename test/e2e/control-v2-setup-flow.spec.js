// P7.2: ControlViewV2 Setup workflow actions, flag-on only. The workflow
// primary opens the migrated check-in modal; confirming advances the
// stage in place (orderWorkflowState check-in -> random), so the primary
// morphs to Randomise, proving the migrated modals drive V2's stage.
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

test("check-in: the workflow primary opens the modal; confirm advances to Randomise", async ({ request, page }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Setup Flow Diving",
  });
  await setup.insertClub({ orgId, name: "SF Club", shortCode: "SFC" });
  const event = await setup.createEvent(request, {
    adminToken, name: "Flow Event", total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Flow Diver" });
  await setup.insertDiveList({ eventId: event.id, competitorId: diver.userId, dives: [{ round_number: 1, dive_id: diveId }] });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Flow Event");

  // Stage is check-in, so the primary opens the check-in modal.
  const primary = page.locator(".setup-primary");
  await expect(primary).toContainText(/Check In Divers/i);
  await primary.click();
  const dialog = page.locator('.lb-modal[role="dialog"]');
  await expect(dialog).toBeVisible();

  // Mark the diver present, then confirm check-in complete.
  await dialog.locator(".chip-present").first().click();
  await dialog.locator(".wf-btn-red").click();

  // Stage advanced check-in -> random, so the primary morphs to Randomise.
  await expect(primary).toContainText(/Randomise/i, { timeout: 6_000 });
  await expect(dialog).toBeHidden();
});
