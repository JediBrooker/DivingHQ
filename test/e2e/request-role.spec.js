// Asking for a role after signup, through the real profile page, and
// the coach option on the signup form.
//
// The routing rules (who reviews what, one pending per role, the day's
// wait after a decline) are pinned in test/integration.test.js. This
// covers the part only a browser can: the button is on your own
// profile, the dialog offers what you don't already hold, sending it
// lands a pending request and the history shows it.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const world = {};

async function signIn(page, username) {
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test.beforeAll(async ({ request }) => {
  const { orgId } = await setup.createOrgAndAdmin(request, { orgName: "Role Request Fed" });
  world.orgId = orgId;
  world.diver = await setup.insertUser({ orgId, role: "diver", fullName: "Maya Ortiz" });
});

test.afterAll(async () => {
  if (world.orgId) await setup.deleteOrg(world.orgId);
});

test("a diver asks to judge from their own profile", async ({ page }) => {
  await signIn(page, world.diver.username);
  await page.goto("/profile");
  await page.locator("[data-test-id=request-role-button]").click();

  const dialog = page.locator("[data-test-id=request-role-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/federation's admins review/)).toBeVisible();

  // Diver is already theirs, so it isn't offered again.
  const select = dialog.locator("#request-role-select");
  await expect(select.locator('option[value="diver"]')).toHaveCount(0);
  await expect(select.locator('option[value="coach"]')).toHaveCount(1);

  await select.selectOption("judge");
  await dialog.locator("#request-role-note").fill("Level 1 judge since 2024");
  await dialog.getByRole("button", { name: /Send request/ }).click();

  // The request shows as waiting, and judge drops out of the picker.
  await expect(dialog.getByText("Waiting")).toBeVisible();
  await expect(select.locator('option[value="judge"]')).toHaveCount(0);

  const r = await setup.pool.query(
    "SELECT requested_role, status, note FROM role_requests WHERE user_id = $1",
    [world.diver.userId],
  );
  expect(r.rows).toEqual([{ requested_role: "judge", status: "pending", note: "Level 1 judge since 2024" }]);
});

test("founding a club on signup defaults the requested role to coach", async ({ page }) => {
  // Nothing is submitted here, so Antigua never gets an account.
  await page.goto("/register");
  await page.locator("select").first().selectOption("ATG");
  const role = page.locator("select").filter({ has: page.locator('option[value="coach"]') });
  await expect(role).toHaveValue("diver");

  const club = page.locator("select").filter({ has: page.locator('option[value="new"]') });
  await club.selectOption("new");
  await expect(role).toHaveValue("coach");

  // A choice they made themselves sticks.
  await role.selectOption("judge");
  await club.selectOption("");
  await club.selectOption("new");
  await expect(role).toHaveValue("judge");
});
