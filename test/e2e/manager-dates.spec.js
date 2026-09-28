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

// DATE columns come over as the server's midnight in UTC, so on a server
// east of UTC (this box, and production) Edit Meet sliced out the day
// before and a Save moved the meet back a day, every time.
test("Edit Meet shows the meet's own dates, and a no-op save keeps them", async ({ browser, request }) => {
  test.setTimeout(90_000);
  const { orgId, username } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Manager Dates" });
  const meet = (await setup.pool.query(
    `INSERT INTO meets (org_id, name, start_date, end_date)
     VALUES ($1, 'TZ Date Meet', '2023-05-29', '2023-05-31') RETURNING id`,
    [orgId],
  )).rows[0];

  const ctx = await browser.newContext({ timezoneId: await otherZone() });
  const page = await ctx.newPage();
  await signIn(page, username);
  await page.goto("/manager");
  await page.locator(".mgr-acc-header", { hasText: "TZ Date Meet" }).click();
  await page.locator(".mgr-detail-actions button", { hasText: /^Edit$/ }).click();
  const modal = page.locator(".modal-edit-meet");
  await expect(modal).toBeVisible();
  const dates = modal.locator('input[type="date"]');
  await expect(dates.nth(0)).toHaveValue("2023-05-29");
  await expect(dates.nth(1)).toHaveValue("2023-05-31");

  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/meets/${meet.id}`) && r.request().method() === "PUT");
  await modal.locator("button.btn-primary[type=submit]", { hasText: /Save/i }).last().click();
  expect((await saved).status()).toBe(200);
  const r = await setup.pool.query(
    "SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM meets WHERE id = $1",
    [meet.id],
  );
  expect(r.rows[0]).toEqual({ s: "2023-05-29", e: "2023-05-31" });
  await ctx.close();
  await setup.deleteOrg(orgId);
});
