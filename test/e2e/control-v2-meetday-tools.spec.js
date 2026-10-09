// Meet-day tools the Stage-Rail cutover left without a door: the Super
// Final dive-offs (Appendix 3 §6) and synchro reserve pool (§5.1), the
// late-entry form, and the reschedule-downstream prompt after an event
// that ran long. The server still insists on the dive-offs ("Resolve
// dive-offs first") before it'll seed the semi, so a tied H2H pair
// stalled the whole Super Final.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent } = require("./_meetday");

test.describe.configure({ mode: "serial" });

async function openTool(page, label) {
  await page.locator(".cv2-act", { hasText: "Tools" }).click();
  const drawer = page.locator(".cv2-drawer");
  await expect(drawer).toBeVisible();
  await drawer.locator(".cv2-drawer-row", { hasText: label }).click();
  return drawer;
}

test("a Super Final H2H event's dive-offs open from the Tools drawer", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Tools Dive-off" });
  const { event } = await liveEvent(request, { orgId, adminToken, name: "H2H Stage", diverNames: ["AAA H2H", "BBB H2H"] });
  await setup.pool.query("UPDATE events SET event_format = 'super_final_h2h' WHERE id = $1", [event.id]);

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  await page.getByRole("button", { name: "Take control", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Release control", exact: true }).first()).toBeVisible();
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA H2H", { timeout: 10_000 });
  const drawer = await openTool(page, "Super Final");
  await expect(drawer.locator(".reserves-head-label", { hasText: "Dive-offs" })).toBeVisible();
  await drawer.getByRole("button", { name: /\+ Create/ }).click();
  await expect(page.locator('.lb-modal[role="dialog"]')).toBeVisible();
  await setup.deleteOrg(orgId);
});

test("an ordinary event has no Super Final section, but does have Late entry", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Tools Late" });
  const { event } = await liveEvent(request, { orgId, adminToken, name: "Plain Stage", diverNames: ["AAA Plain"] });

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  await page.getByRole("button", { name: "Take control", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Release control", exact: true }).first()).toBeVisible();
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Plain", { timeout: 10_000 });
  const drawer = await openTool(page, "Late entry");
  await expect(drawer.locator(".cv2-drawer-row", { hasText: "Super Final" })).toHaveCount(0);
  await drawer.getByRole("button", { name: /Add a late diver/ }).click();
  await expect(page.getByText("Add Late Diver")).toBeVisible();
  // Escape shuts the form, not the drawer behind it as well
  await page.keyboard.press("Escape");
  await expect(page.getByText("Add Late Diver")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await setup.deleteOrg(orgId);
});

test("finalising an event that ran long offers to reschedule what comes after it", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Tools Reflow" });
  const { event, divers, diveId, judges } = await liveEvent(request, { orgId, adminToken, name: "Ran Long", diverNames: ["AAA Long"] });
  const meet = (await setup.pool.query(
    "INSERT INTO meets (org_id, name) VALUES ($1, 'Reflow Meet') RETURNING id", [orgId],
  )).rows[0];
  await setup.pool.query("UPDATE events SET meet_id = $1 WHERE id = $2", [meet.id, event.id]);
  const session = (await setup.pool.query(
    "INSERT INTO sessions (meet_id, name, session_date) VALUES ($1, 'Morning', CURRENT_DATE) RETURNING id", [meet.id],
  )).rows[0];
  // The event's slot ended an hour ago; the next block hasn't started.
  await setup.pool.query(
    `INSERT INTO schedule_blocks (session_id, block_type, label, starts_at, ends_at, event_id)
     VALUES ($1, 'event_start', 'Ran Long', now() - interval '2 hours', now() - interval '1 hour', $2),
            ($1, 'ceremony', 'Medals', now() - interval '1 hour', now() - interval '30 minutes', NULL)`,
    [session.id, event.id],
  );

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  await page.getByRole("button", { name: "Take control", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Release control", exact: true }).first()).toBeVisible();
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Long", { timeout: 10_000 });
  await page.waitForTimeout(2000);
  await setup.submitPanelScores({ baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId });
  await expect(card.locator(".cv2-primary")).toHaveClass(/is-finalise/, { timeout: 8_000 });
  await card.locator(".cv2-primary").click();
  await page.locator('.confirm-backdrop[aria-modal="true"] .confirm-btn:not(.confirm-btn-cancel)').click();

  const reflow = page.locator(".reflow-modal");
  await expect(reflow).toBeVisible({ timeout: 8_000 });
  await expect(reflow).toContainText("Medals");
  await setup.deleteOrg(orgId);
});

// "Operator broadcast (this screen)" linked to /control?broadcast=1, which
// nothing read after the old Control Room went: the chooser closed and the
// screen stayed exactly as it was (and lost its ?event= on the way).
test("Operator broadcast turns this Control Room into a kiosk, and ✕ brings it back", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Tools Kiosk" });
  const { event } = await liveEvent(request, { orgId, adminToken, name: "Kiosk Stage", diverNames: ["AAA Kiosk"] });

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  await page.getByRole("button", { name: "Take control", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Release control", exact: true }).first()).toBeVisible();
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Kiosk", { timeout: 10_000 });
  await expect(page.locator(".cv2-topbar")).toBeVisible();

  const drawer = await openTool(page, "Broadcast");
  await drawer.locator(".cv2-drawer-action", { hasText: "Open broadcast chooser" }).click();
  await page.locator(".broadcast-option", { hasText: /Operator broadcast/i }).click();

  await expect(page).toHaveURL(new RegExp(`broadcast=1`));
  await expect(page).toHaveURL(new RegExp(`event=${event.id}`));
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Kiosk");
  await expect(page.locator(".cv2-topbar")).toHaveCount(0);
  await expect(page.locator(".app-shell .sidebar")).toHaveCount(0);
  await expect(page.locator(".cv2-primary")).toBeHidden();
  await expect(page.locator(".cv2-ref")).toBeHidden();

  await page.locator(".cv2-kiosk-exit").click();
  await expect(page).not.toHaveURL(/broadcast=1/);
  await expect(page.locator(".cv2-topbar")).toBeVisible();
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Kiosk");
  await setup.deleteOrg(orgId);
});
