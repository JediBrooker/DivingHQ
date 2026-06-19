// P2: modal focus-management + render gate (written before the fan-out).
//
// Proves BaseModal's a11y contract on the migrated control modals: on
// open, focus moves into the dialog; Tab/Shift+Tab stay trapped; Esc
// closes and returns focus to the opener. Also render-checks the two
// structurally-riskiest migrations -- LateEntry (always-mounted :open)
// and Randomise (inner-wrapper frame).
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

function headers(token) {
  return { Authorization: `Bearer ${token}` };
}

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

// An Upcoming event with one rostered diver, so the Control Room shows
// the pre-meet workflow buttons (check-in -> randomise -> sign-off) and
// the + Add / Adjust controls.
async function checkInEvent(request, orgName) {
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS",
    orgName,
  });
  await setup.insertClub({ orgId, name: "Modal Club", shortCode: "MOD" });
  const event = await setup.createEvent(request, {
    adminToken,
    name: "Modal Control Event",
    total_rounds: 2,
    number_of_judges: 5,
    height: "3m",
  });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Modal Diver" });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  await setup.insertDiveList({
    eventId: event.id,
    competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });
  return { orgId, username, adminToken, event };
}

async function gotoControlEvent(page, event) {
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await page.locator(".event-title-select").selectOption({ label: event.name });
  await page.waitForLoadState("networkidle");
}

test("check-in modal traps focus and restores it to the opener on close", async ({ request, page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { username, event } = await checkInEvent(request, "Modal Focus Diving");
  await signIn(page, username);
  await gotoControlEvent(page, event);

  const trigger = page.getByRole("button", { name: /check in divers/i });
  await trigger.waitFor({ state: "visible" });
  await trigger.click();

  const dialog = page.locator('.lb-modal[role="dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(await inDialog(page)).toBe(true);

  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    expect(await inDialog(page)).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inDialog(page)).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const restored = await page.evaluate(() => (document.activeElement?.textContent || "").trim());
  expect(restored).toContain("Check In Divers");
});

test("late-entry modal opens (always-mounted :open) and traps focus", async ({ request, page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { username, event } = await checkInEvent(request, "Modal LateEntry Diving");
  await signIn(page, username);
  await gotoControlEvent(page, event);

  const add = page.getByRole("button", { name: /^\+ Add$/ });
  await add.waitFor({ state: "visible" });
  await add.click();

  const dialog = page.locator('.lb-modal[role="dialog"]');
  await expect(dialog).toBeVisible();
  expect(await inDialog(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("randomise draw modal opens (migrated inner frame renders) and closes", async ({ request, page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { username, adminToken, event } = await checkInEvent(request, "Modal Randomise Diving");
  // Advance past check-in via API so the workflow button is "Randomise".
  await request.post(`/api/events/${event.id}/check-in/confirm`, { headers: headers(adminToken) });

  await signIn(page, username);
  await gotoControlEvent(page, event);

  const trigger = page.getByRole("button", { name: /randomise dive order/i });
  await trigger.waitFor({ state: "visible" });
  await trigger.click();

  const dialog = page.locator('.lb-modal[role="dialog"]');
  await expect(dialog).toBeVisible();
  // The migrated inner wrapper still carries the .randomise-modal classes.
  await expect(dialog.locator(".randomise-modal")).toBeVisible();
  expect(await inDialog(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
