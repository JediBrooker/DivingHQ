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

// The draw used to close the instant it landed: SetupStage shut the dialog
// on `randomised`, so the drawn order, Re-shuffle and "Confirm dive order"
// never showed, and the order wasn't anywhere else in Setup either.
test("randomise: the drawn order stays up until the operator confirms it", async ({ request, page }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Draw Diving",
  });
  const event = await setup.createEvent(request, {
    adminToken, name: "Draw Event", total_rounds: 1, number_of_judges: 3, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const names = ["Ada Draw", "Bea Draw", "Cai Draw", "Dee Draw"];
  for (const [i, n] of names.entries()) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: n });
    await setup.insertDiveList({ eventId: event.id, competitorId: d.userId, dives: [{ round_number: 1, dive_id: diveId }] });
    await setup.pool.query("UPDATE competitor_dive_lists SET display_order = $1 WHERE event_id = $2 AND competitor_id = $3",
      [i + 1, event.id, d.userId]);
  }
  await setup.pool.query("UPDATE events SET check_in_done_at = now() WHERE id = $1", [event.id]);

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  const primary = page.locator(".setup-primary");
  await expect(primary).toContainText(/Randomise/i, { timeout: 10_000 });
  await primary.click();

  const dialog = page.locator('.lb-modal[role="dialog"]');
  await expect(dialog.locator(".randomise-title")).toContainText(/Random Dive-Order Draw/);
  await dialog.locator(".randomise-go").click();

  // 5 s of ceremony, then the result, in the same dialog.
  await expect(dialog.locator(".randomise-title")).toContainText(/Final dive order/, { timeout: 15_000 });
  await expect(dialog.getByRole("button", { name: /Re-shuffle/ })).toBeVisible();
  const confirm = dialog.getByRole("button", { name: /Confirm dive order/ });
  await expect(confirm).toBeVisible();

  // What it shows is the order the server drew, not the one before.
  const roster = await (await request.get(`/api/events/${event.id}/roster`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  const drawn = roster.filter((r) => !r.withdrawn_at && !r.is_reserve)
    .sort((a, b) => a.display_order - b.display_order)
    .map((r) => r.full_name);
  // Each name row carries the rep code after the name, so match the start.
  await expect(dialog.locator(".randomise-row-name")).toHaveText(drawn.map((n) => new RegExp(`^${n}`)));

  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(primary).toContainText(/Referee Sign Off/i);
  // ...and Setup keeps showing it, since that's what the referee signs off.
  await expect(page.locator(".setup-order-name")).toHaveText(drawn);
  await page.reload();
  await expect(page.locator(".setup-order-name")).toHaveText(drawn, { timeout: 10_000 });
  await setup.deleteOrg(orgId);
});
