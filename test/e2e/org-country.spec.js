// The sysadmin's country fix-up in User Manager (migration 093).
//
// Signups find their federation by country, so an org with no usable
// country_code is one nobody can join. A pending federation card won't
// approve until it has a country, and live orgs that slipped through before
// register-org required one are listed with a picker. The API rules are in
// test/integration.test.js; this pins down that the screen drives them.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test("a sysadmin gives a pending federation and a live org their countries", async ({ page, request }) => {
  test.setTimeout(60_000);
  const admin = await setup.createOrgAndAdmin(request, { orgName: "Country Fix Admin Org" });
  await setup.pool.query("UPDATE users SET is_system_admin = true WHERE id = $1", [admin.adminId]);
  const tag = setup.rand();
  const mk = async (name, status) => (await setup.pool.query(
    `INSERT INTO organisations (name, country_code, slug, status)
     VALUES ($1, NULL, $2, $3) RETURNING id`,
    [name, `e2e-cc-${setup.rand()}`, status],
  )).rows[0].id;
  const pendingName = `Pending Federation ${tag}`;
  const lostName = `Lost Federation ${tag}`;
  const pendingId = await mk(pendingName, "pending");
  const lostId = await mk(lostName, "active");
  try {
    await setup.installClickHighlight(page);
    await page.goto("/login");
    await page.locator('input[autocomplete="username"]').fill(admin.username);
    await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
    await page.getByRole("button", { name: /Sign In/i }).click();
    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });

    await page.goto("/users");
    await page.getByRole("button", { name: /Pending requests/ }).click();

    // No country: say why, and hold the approval until there is one.
    const card = page.getByTestId("pending-org").filter({ hasText: pendingName });
    await expect(card.getByText(/No country set/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Approve" })).toBeDisabled();
    await card.getByRole("combobox", { name: "Country" }).selectOption("GRL");
    await card.getByRole("button", { name: "Set country" }).click();
    await expect(card.getByText("Greenland · GRL")).toBeVisible();
    await expect(card.getByRole("button", { name: "Approve" })).toBeEnabled();
    const pend = await setup.pool.query("SELECT country_code, status FROM organisations WHERE id = $1", [pendingId]);
    expect(pend.rows[0]).toEqual({ country_code: "GRL", status: "pending" });

    // A live org nobody can find by country gets the same picker.
    const block = page.getByTestId("orgs-need-country");
    const showAll = block.getByRole("button", { name: /Show all/ });
    if (await showAll.isVisible()) await showAll.click();
    const row = block.locator(".request-card").filter({ hasText: lostName });
    await row.getByRole("combobox", { name: "Country" }).selectOption("FRO");
    await row.getByRole("button", { name: "Set country" }).click();
    await expect(block.getByText(lostName)).toHaveCount(0);
    const lost = await setup.pool.query("SELECT country_code FROM organisations WHERE id = $1", [lostId]);
    expect(lost.rows[0].country_code).toBe("FRO");
  } finally {
    await setup.pool.query("DELETE FROM audit_log WHERE entity_id = ANY($1::uuid[])", [[pendingId, lostId]]);
    await setup.pool.query("DELETE FROM organisations WHERE id = ANY($1::uuid[])", [[pendingId, lostId]]);
    await setup.deleteOrg(admin.orgId);
  }
});
