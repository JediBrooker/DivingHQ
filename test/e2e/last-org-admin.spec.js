// The last org admin of a federation, through the real screens.
//
// The rule itself (who counts, the lock that stops two admins leaving at
// once, the transfer and suspend paths) is pinned in
// test/integration.test.js. What only a browser shows is what the person
// sees when they're refused: the delete dialog says why in their own
// words instead of "Internal server error", and in User Manager the Org
// Admin box doesn't stay unticked after the server said no.

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
  // createOrgAndAdmin's federation is claimed and has exactly one admin.
  world.fed = await setup.createOrgAndAdmin(request, { orgName: "Last Admin Fed" });
});

test.afterAll(async () => {
  if (world.fed) await setup.deleteOrg(world.fed.orgId);
});

test("the only admin is told to appoint someone before deleting their account", async ({ page }) => {
  await signIn(page, world.fed.username);
  await page.goto("/profile");
  await page.locator("[data-test-id=delete-account-button]").click();
  await page.locator('.delete-modal input[type="password"]').fill(setup.TEST_PASSWORD);
  await page.locator(".delete-modal .btn-danger").click();

  const error = page.locator("[data-test-id=delete-account-error]");
  await expect(error).toContainText("You're the last administrator of your organisation");
  await expect(error).toContainText("@");
  const row = await setup.pool.query("SELECT deleted_at FROM users WHERE id = $1", [world.fed.adminId]);
  expect(row.rows[0].deleted_at).toBeNull();
});

test("unticking your own Org Admin is refused and the box ticks itself back", async ({ page }) => {
  await signIn(page, world.fed.username);
  await page.goto("/users");
  await page.locator("tr.user-row", { hasText: world.fed.username }).click();

  const orgAdmin = page.locator(".drawer-role", { hasText: "Org Admin" }).locator('input[type="checkbox"]');
  await expect(orgAdmin).toBeChecked();
  await orgAdmin.uncheck();

  await expect(page.getByText("That would leave the organisation with no administrator")).toBeVisible();
  await expect(orgAdmin).toBeChecked();
  const roles = await setup.pool.query(
    "SELECT role::text AS role FROM user_org_roles WHERE user_id = $1 AND org_id = $2",
    [world.fed.adminId, world.fed.orgId],
  );
  expect(roles.rows.map((r) => r.role)).toContain("org_admin");
});
