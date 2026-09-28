// Session scheduler regressions.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn } = require("./_meetday");

test.describe.configure({ mode: "serial" });

// The scheduler asked the server whether this user may edit the meet
// (can_edit) and then offered the Edit toggle to any org_admin anyway, so
// another federation's admin got a toggle whose every save 403'd.
test("another federation's admin gets no Edit toggle on someone else's schedule", async ({ browser, request }) => {
  test.setTimeout(90_000);
  const host = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Schedule Host" });
  const other = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Schedule Visitor" });
  const meet = (await setup.pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, 'Host Schedule Meet') RETURNING id", [host.orgId],
  )).rows[0];

  const visit = async (username) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, username);
    await page.goto(`/meet/${meet.id}/schedule`);
    await expect(page.locator(".scheduler-title")).toBeVisible({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    const toggles = await page.locator(".scheduler-edit-toggle").count();
    await ctx.close();
    return toggles;
  };
  expect(await visit(host.username)).toBe(1);
  expect(await visit(other.username)).toBe(0);
  await setup.deleteOrg(host.orgId);
  await setup.deleteOrg(other.orgId);
});
