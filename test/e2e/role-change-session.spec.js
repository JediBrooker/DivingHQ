// Role changes don't sign anyone out (migration 106).
//
// Granting or revoking a role used to bump token_version, which killed
// every session the person had: a diver whose judge request got approved
// was thrown to the login page on every device. Now it bumps
// claims_version and the next request rebuilds the token from the DB.
// This drives it through a real browser so the cookie, /api/auth/me and
// the SPA's identity all have to agree.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

async function signIn(page, username) {
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

const rolesInTab = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("dhq_identity") || "null")?.org_roles || null);

test("a role granted and then revoked mid-session keeps the person signed in", async ({ request, page, baseURL }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Role Refresh Diving",
  });
  await setup.insertClub({ orgId, name: "Role Refresh Club", shortCode: "RRC" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Role Refresh Diver" });

  await signIn(page, diver.username);
  expect(await rolesInTab(page)).not.toContain("judge");

  const setRoles = async (roles) => {
    const res = await request.put(`${baseURL}/api/users/${diver.userId}/roles`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { roles },
    });
    expect(res.status(), await res.text()).toBe(200);
  };

  // Approved as a judge while the tab is open.
  await setRoles(["diver", "judge"]);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect.poll(() => rolesInTab(page), { message: "the new role arrives without signing in again" })
    .toContain("judge");
  // The server's using it too, through the same cookie.
  const me = await page.evaluate(() => fetch("/api/auth/me").then((r) => r.json()));
  expect(me.user.org_roles).toContain("judge");

  // And taken away again.
  await setRoles(["diver"]);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect.poll(() => rolesInTab(page), { message: "the revoke lands without signing out" })
    .not.toContain("judge");
});
