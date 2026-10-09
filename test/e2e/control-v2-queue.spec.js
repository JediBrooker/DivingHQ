// Who the Control Room's live queue walks through.
//
// /api/events/:id/roster hands back every dive-list row, withdrawn and
// reserve rows included, and the pool used to step through all of them:
// a diver scratched before the meet got announced to the judges, and a
// final seeded with reserves put Reserve 1 up after the last primary and
// then left Next disabled for good.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, roomWatcher } = require("./_meetday");

test.describe.configure({ mode: "serial" });

test("a withdrawn diver is never put up", async ({ page, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Queue Withdrawn" });
  const { event, divers } = await liveEvent(request, {
    orgId, adminToken, name: "Withdrawn Queue", diverNames: ["AAA Withdrawn", "BBB Active", "CCC Second"],
  });
  await setup.pool.query(
    "UPDATE competitor_dive_lists SET withdrawn_at = now() WHERE event_id = $1 AND competitor_id = $2",
    [event.id, divers[0].userId],
  );
  const room = await roomWatcher(baseURL, event.id);

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  await page.getByRole("button", { name: "Take control", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Release control", exact: true }).first()).toBeVisible();
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Active", { timeout: 10_000 });
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);
  expect(room.seen.state.map((s) => s.full_name)).not.toContain("AAA Withdrawn");
  room.close();
  await setup.deleteOrg(orgId);
});

test("reserves stay out of the queue, so the last primary finalises", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Queue Reserves" });
  const { event, divers, diveId, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Reserve Queue", diverNames: ["P One", "P Two"], status: "Upcoming",
  });
  await setup.pool.query(
    "UPDATE competitor_dive_lists SET display_order = CASE competitor_id WHEN $2 THEN 1 ELSE 2 END WHERE event_id = $1",
    [event.id, divers[0].userId],
  );
  // What AdvanceStageModal seeds: a reserve row with no display_order.
  const reserve = await setup.insertUser({ orgId, role: "diver", fullName: "R Reserve" });
  await setup.pool.query(
    `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id, display_order, is_reserve)
     VALUES ($1, $2, 1, $3, NULL, TRUE)`,
    [event.id, reserve.userId, diveId],
  );
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  const room = await roomWatcher(baseURL, event.id);

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  await page.getByRole("button", { name: "Take control", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Release control", exact: true }).first()).toBeVisible();
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("P One", { timeout: 10_000 });
  // The announce proves the page's socket is up and in the room, so the
  // scores below can't land before it's listening.
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);

  await setup.submitPanelScores({ baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId });
  await expect(card.locator(".cv2-primary")).toBeEnabled({ timeout: 8_000 });
  await card.locator(".cv2-primary").click();
  await expect(card.locator(".cv2-live-diver")).toContainText("P Two");

  // P Two is the last diver who competes: once scored the card offers
  // Finalise rather than walking on to the reserve.
  await setup.submitPanelScores({ baseURL, judges, eventId: event.id, competitorId: divers[1].userId, roundNumber: 1, diveId });
  await expect(card.locator(".cv2-primary")).toBeEnabled({ timeout: 8_000 });
  await expect(card.locator(".cv2-primary")).toHaveClass(/is-finalise/);
  expect(room.seen.state.map((s) => s.full_name)).not.toContain("R Reserve");
  room.close();
  await setup.deleteOrg(orgId);
});

test("the roster endpoint says which rows are reserves", async ({ request }) => {
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Queue Roster Flag" });
  const { event, diveId } = await liveEvent(request, {
    orgId, adminToken, name: "Roster Flag", diverNames: ["Flag Primary"], status: "Upcoming",
  });
  const reserve = await setup.insertUser({ orgId, role: "diver", fullName: "Flag Reserve" });
  await setup.pool.query(
    `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id, is_reserve)
     VALUES ($1, $2, 1, $3, TRUE)`,
    [event.id, reserve.userId, diveId],
  );
  const r = await request.get(`/api/events/${event.id}/roster`, { headers: { Authorization: `Bearer ${adminToken}` } });
  expect(r.status()).toBe(200);
  const rows = await r.json();
  const byName = Object.fromEntries(rows.map((row) => [row.full_name, row]));
  expect(byName["Flag Reserve"].is_reserve).toBe(true);
  expect(byName["Flag Primary"].is_reserve).toBe(false);
  await setup.deleteOrg(orgId);
});

// A no-show used to need the keyboard: Next stays disabled until a full
// panel is in, so a mouse-only operator had no way past them.
test("Skip moves past a diver with no panel, and on the last diver it offers Finalise", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Queue Skip" });
  const { event } = await liveEvent(request, { orgId, adminToken, name: "Skip Queue", diverNames: ["AAA Skip", "BBB Skip"] });

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  await page.getByRole("button", { name: "Take control", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Release control", exact: true }).first()).toBeVisible();
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Skip", { timeout: 10_000 });
  const confirm = page.locator('.confirm-backdrop[aria-modal="true"]');

  await card.locator(".cv2-skip").click();
  await expect(confirm).toContainText(/Skip/);
  await confirm.locator(".confirm-btn:not(.confirm-btn-cancel)").click();
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Skip");

  // Last diver in the queue: skipping them is finishing the event
  await card.locator(".cv2-skip").click();
  await confirm.locator(".confirm-btn:not(.confirm-btn-cancel)").click();
  // (the skip confirm may still be fading out, so look for the title)
  const finalise = page.locator(".confirm-title", { hasText: /Finalise event/ });
  await expect(finalise).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(finalise).toHaveCount(0);
  await setup.deleteOrg(orgId);
});
