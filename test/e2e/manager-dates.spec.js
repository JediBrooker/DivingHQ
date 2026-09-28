// Dates and times in the Meet Manager, with the browser in a different
// zone from the database. The e2e box and CI both run everything in one
// zone, which is how these went unnoticed: a manager elsewhere saved an
// event and its entry deadline moved by the gap between the two.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn } = require("./_meetday");

test.describe.configure({ mode: "serial" });

// A browser zone guaranteed to be hours away from the database's.
async function otherZone() {
  const tz = (await setup.pool.query("SHOW timezone")).rows[0].TimeZone || "UTC";
  return /^(UTC|Etc\/UTC|GMT|Europe\/London)$/i.test(tz) ? "Australia/Sydney" : "Europe/London";
}

test("a no-op edit leaves entries_close_at exactly where it was", async ({ browser, request }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Manager TZ" });
  const ev = await setup.createEvent(request, { adminToken, name: "TZ Deadline Event", total_rounds: 1, number_of_judges: 5 });
  await setup.pool.query("UPDATE events SET entries_close_at = '2026-10-01T09:00:00Z' WHERE id = $1", [ev.id]);

  const ctx = await browser.newContext({ timezoneId: await otherZone() });
  const page = await ctx.newPage();
  await signIn(page, username);
  await page.goto("/manager");
  await page.getByRole("button", { name: /Your events|All events/i }).first().click();
  const row = page.locator(".event-item", { hasText: "TZ Deadline Event" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator(".dropdown-host button", { hasText: "⋯" }).first().click();
  await row.locator(".event-overflow-menu .dropdown-item", { hasText: /Edit event/i }).click();
  const form = page.locator("form.form-stack").filter({ has: page.locator('input[type="datetime-local"]') }).first();
  await expect(form.locator('input[type="datetime-local"]').first()).not.toHaveValue("");
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/events/${ev.id}`) && r.request().method() === "PUT");
  await form.locator("button.btn-primary-lg[type=submit]").click();
  expect((await saved).status()).toBe(200);

  const r = await setup.pool.query("SELECT entries_close_at FROM events WHERE id = $1", [ev.id]);
  expect(new Date(r.rows[0].entries_close_at).toISOString()).toBe("2026-10-01T09:00:00.000Z");
  await ctx.close();
  await setup.deleteOrg(orgId);
});
