// Pools coming and going while the Control Room is open: an event started
// from the Setup stage, an event another operator starts, a socket that
// drops and comes back, a hold that was already on when the page opened.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, roomWatcher, emitAck } = require("./_meetday");

test.describe.configure({ mode: "serial" });

async function readyToStart(eventId) {
  await setup.pool.query(
    `UPDATE events SET check_in_done_at = now(), dive_order_randomised_at = now(),
            dive_order_signed_off_at = now()
      WHERE id = $1`,
    [eventId],
  );
}

test("Start Event from the Setup stage brings the pool up and announces the first diver", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Lifecycle Start" });
  const { event } = await liveEvent(request, {
    orgId, adminToken, name: "Start Here", diverNames: ["AAA Start", "BBB Start"], status: "Upcoming",
  });
  await readyToStart(event.id);
  const room = await roomWatcher(baseURL, event.id);

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  const primary = page.locator(".setup-primary");
  await expect(primary).toContainText(/Start Event/i, { timeout: 10_000 });
  await primary.click();

  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Start", { timeout: 10_000 });
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);
  expect(room.seen.state.at(-1).full_name).toBe("AAA Start");
  room.close();
  await setup.deleteOrg(orgId);
});

test("an event another operator starts shows up as a live pool", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Lifecycle Elsewhere" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Already Live", diverNames: ["AAA Live"] });
  const B = await liveEvent(request, {
    orgId, adminToken, name: "Started Elsewhere", diverNames: ["BBB Else"], status: "Upcoming",
  });
  await readyToStart(B.event.id);

  await signIn(page, username);
  await page.goto(`/control?event=${A.event.id}`);
  await expect(page.locator(`.cv2-pool[data-event-id="${A.event.id}"] .cv2-live-diver`)).toContainText("AAA Live", { timeout: 10_000 });
  await expect(page.locator(`.cv2-pool[data-event-id="${B.event.id}"]`)).toHaveCount(0);

  await setup.setEventStatus(request, { adminToken, eventId: B.event.id, status: "Live" });
  const cardB = page.locator(`.cv2-pool[data-event-id="${B.event.id}"]`);
  await expect(cardB.locator(".cv2-live-diver")).toContainText("BBB Else", { timeout: 10_000 });

  // ...and finalised elsewhere, it drops off the live board again
  await setup.setEventStatus(request, { adminToken, eventId: B.event.id, status: "Completed" });
  await expect(cardB).toHaveCount(0, { timeout: 10_000 });
  await setup.deleteOrg(orgId);
});

test("a hold that was already on shows when the Control Room opens", async ({ page, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Lifecycle Held" });
  const { event } = await liveEvent(request, { orgId, adminToken, name: "Held Before", diverNames: ["AAA Held"] });
  expect(await emitAck(baseURL, adminToken, "meet_hold", { event_id: event.id, reason: "lightning" })).toMatchObject({ ok: true });

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Held", { timeout: 10_000 });
  await expect(card.locator(".cv2-pool-heldbar")).toContainText("lightning", { timeout: 6_000 });
  await expect(page.locator(".cv2-hold-banner")).toBeVisible();
  // Held means held: the toggle offers Resume, not a second hold
  await expect(card.locator(".cv2-pool-hold")).toContainText(/Resume/);
  await setup.deleteOrg(orgId);
});

test("after the socket drops and reconnects, judge scores still reach the pool", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Lifecycle Reconnect" });
  const { event, divers, diveId, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Wifi Blip", diverNames: ["AAA Blip", "BBB Blip"],
  });
  const room = await roomWatcher(baseURL, event.id);

  // Put the page's socket.io websocket behind a route we can cut, which is
  // what a venue wifi drop or a server restart looks like from the page.
  const links = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    links.push({ ws, server });
  });

  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  const card = page.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Blip", { timeout: 10_000 });
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);
  await expect.poll(() => links.length, { timeout: 8_000 }).toBeGreaterThan(0);

  const before = links.length;
  for (const { ws, server } of links.splice(0)) {
    await server.close().catch(() => {});
    await ws.close().catch(() => {});
  }
  // socket.io reconnects on its own; wait for the fresh transport
  await expect.poll(() => links.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(before).toBeGreaterThan(0);
  await page.waitForTimeout(1500);

  await setup.submitPanelScores({ baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId });
  await expect(card.locator(".cv2-tile.scored")).toHaveCount(5, { timeout: 8_000 });
  await expect(card.locator(".cv2-primary")).toBeEnabled();
  room.close();
  await setup.deleteOrg(orgId);
});

// Leaving the Control Room before /api/events came back left a dead
// instance behind: it still stood up pools for every Live event and, with
// its socket listeners already gone, its seed timer announced diver 1 to
// the judges of any event nobody had started, and its hotkeys kept
// running on every other page.
test("leaving the Control Room mid-load doesn't announce anything afterwards", async ({ page, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Lifecycle Leave" });
  const { event } = await liveEvent(request, { orgId, adminToken, name: "Left Behind", diverNames: ["AAA Left"] });
  const room = await roomWatcher(baseURL, event.id);

  await signIn(page, username);
  await page.route(/\/api\/events(\?.*)?$/, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue().catch(() => {});
  });
  await page.goto("/control");
  await page.waitForTimeout(300);
  // In-app navigation, so the page (and the stale instance) lives on
  await page.locator(".sidebar a", { hasText: "Dashboard" }).first().click();
  await page.waitForURL(/\/dashboard$/);
  await page.waitForTimeout(5_000);
  expect(room.seen.state).toEqual([]);
  room.close();
  await setup.deleteOrg(orgId);
});
