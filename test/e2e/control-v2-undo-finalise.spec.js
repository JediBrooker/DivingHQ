// Undo on the "Finalised ..." toast puts a finished event back to Live.
// The rehearsal dry run wondered whether that puts round 1 diver 1 back up
// for everyone. Finalising drops the server's active diver (and its
// persisted copy), so after an undo the server had nobody up. The tab
// that undid announced nothing, but any Control Room that stood the pool
// up fresh afterwards (a reload, a second laptop) asked the server who was
// up, got nothing, took the event for one nobody had started and announced
// diver 1 of round 1 to every judge and scoreboard, over a dive that
// already had its scores. The undo also mailed every diver "is live, good
// luck" again and buzzed the panel.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, roomWatcher } = require("./_meetday");

test.describe.configure({ mode: "serial" });

// Two divers, one round, AAA first. Live, with a room watcher listening.
async function twoDiverEvent(request, baseURL, orgName) {
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName });
  const made = await liveEvent(request, {
    orgId, adminToken, name: `${orgName} Event`, diverNames: ["AAA Undo", "BBB Undo"], status: "Upcoming",
  });
  await setup.pool.query(
    "UPDATE competitor_dive_lists SET display_order = CASE competitor_id WHEN $2 THEN 1 ELSE 2 END WHERE event_id = $1",
    [made.event.id, made.divers[0].userId],
  );
  await setup.setEventStatus(request, { adminToken, eventId: made.event.id, status: "Live" });
  const room = await roomWatcher(baseURL, made.event.id);
  return { orgId, username, adminToken, room, ...made };
}

function score(baseURL, w, i) {
  return setup.submitPanelScores({
    baseURL, judges: w.judges, eventId: w.event.id,
    competitorId: w.divers[i].userId, roundNumber: 1, diveId: w.diveId,
  });
}

async function liveNotices(eventId) {
  const r = await setup.pool.query(
    "SELECT count(*)::int AS n FROM notifications WHERE category = 'event_live' AND data->>'event_id' = $1",
    [eventId],
  );
  return r.rows[0].n;
}

test("Undo puts the last diver back up, not round 1 diver 1, and a reload keeps it there", async ({ page, request, baseURL }) => {
  test.setTimeout(150_000);
  const w = await twoDiverEvent(request, baseURL, "Undo Here");
  const { event, room } = w;

  await signIn(page, w.username);
  await page.goto(`/control?event=${event.id}`);
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Undo", { timeout: 10_000 });
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);

  await score(baseURL, w, 0);
  await expect(card.locator(".cv2-primary")).toBeEnabled({ timeout: 8_000 });
  await card.locator(".cv2-primary").click();
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Undo");
  await score(baseURL, w, 1);
  await expect(card.locator(".cv2-primary")).toHaveClass(/is-finalise/, { timeout: 8_000 });

  await card.locator(".cv2-primary").click();
  await page.locator(".confirm-btn-primary").click();
  await expect(page.locator('.cv2-mode[aria-label="Review"]')).toBeVisible({ timeout: 6_000 });
  const noticesBefore = await liveNotices(event.id);

  const before = room.seen.state.length;
  await page.locator(".notify-bar-action", { hasText: "Undo" }).click();
  await expect.poll(async () => (await setup.pool.query("SELECT status FROM events WHERE id = $1", [event.id])).rows[0].status,
    { timeout: 8_000 }).toBe("Live");
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Undo", { timeout: 8_000 });
  // Judges and the scoreboard get the diver they had before the finalise.
  await expect.poll(() => room.seen.state.slice(before).map((s) => s.full_name), { timeout: 8_000 }).toContain("BBB Undo");
  // Longer than the Control Room's 1.5 s seed grace.
  await page.waitForTimeout(3_000);
  expect(room.seen.state.slice(before).map((s) => s.full_name)).not.toContain("AAA Undo");
  // No second "is live" round of notifications for an event that's over.
  expect(await liveNotices(event.id)).toBe(noticesBefore);

  // Someone reloads the Control Room.
  await page.reload();
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Undo", { timeout: 10_000 });
  await page.waitForTimeout(3_000);
  expect(room.seen.state.slice(before).map((s) => s.full_name)).not.toContain("AAA Undo");

  room.close();
  await setup.deleteOrg(w.orgId);
});

test("a Control Room opened after a finalise was undone elsewhere doesn't announce a finished dive", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const w = await twoDiverEvent(request, baseURL, "Undo Elsewhere");
  const { event, room } = w;
  await score(baseURL, w, 0);
  await score(baseURL, w, 1);
  // Finalised and put back from the Manager: the server has nobody up.
  await setup.setEventStatus(request, { adminToken: w.adminToken, eventId: event.id, status: "Completed" });
  await setup.setEventStatus(request, { adminToken: w.adminToken, eventId: event.id, status: "Live" });
  const before = room.seen.state.length;

  await signIn(page, w.username);
  await page.goto(`/control?event=${event.id}`);
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  // Every dive is in: the board sits on the last one, ready to finalise,
  // and nothing goes out to the judges.
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Undo", { timeout: 10_000 });
  await page.waitForTimeout(3_000);
  expect(room.seen.state.slice(before)).toEqual([]);

  room.close();
  await setup.deleteOrg(w.orgId);
});

test("part way through, it picks up after the last dive judged", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const w = await twoDiverEvent(request, baseURL, "Undo Partway");
  const { event, room } = w;
  await score(baseURL, w, 0);
  await setup.setEventStatus(request, { adminToken: w.adminToken, eventId: event.id, status: "Completed" });
  await setup.setEventStatus(request, { adminToken: w.adminToken, eventId: event.id, status: "Live" });
  const before = room.seen.state.length;

  await signIn(page, w.username);
  await page.goto(`/control?event=${event.id}`);
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Undo", { timeout: 10_000 });
  await expect.poll(() => room.seen.state.slice(before).map((s) => s.full_name), { timeout: 8_000 }).toEqual(["BBB Undo"]);

  room.close();
  await setup.deleteOrg(w.orgId);
});
