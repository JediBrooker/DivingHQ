// The diver's /me/meet/<event> page following the event's status without a
// reload. The rehearsal left it open on a diver's phone through the
// finalise: it kept saying LIVE, with "Need 34.6 more pts" under it, until
// the diver reloaded. Finalising sends one broadcast, event_status_changed,
// and the page only listened for scores and diver changes.
//
// A phone can miss that broadcast too (the screen locks, the socket drops),
// so the page also re-reads its bundle when the socket comes back.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn } = require("./_meetday");

test.describe.configure({ mode: "serial" });

async function meetDayEvent(request, name) {
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: `${name} Org` });
  const event = await setup.createEvent(request, {
    adminToken, name, number_of_judges: 5, total_rounds: 2, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: `${name} Diver` });
  await setup.insertDiveList({
    eventId: event.id, competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: diveId }, { round_number: 2, dive_id: diveId }],
  });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  return { orgId, adminToken, event, diver };
}

test("the meet-day page follows the event to Completed and back without a reload", async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken, event, diver } = await meetDayEvent(request, "Meet Day Finish");
  try {
    await signIn(page, diver.username);
    await page.goto(`/me/meet/${event.id}`);
    const pill = page.locator(".page-sub .status-pill");
    await expect(pill).toContainText(/live/i, { timeout: 10_000 });

    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Completed" });
    await expect(pill).toContainText(/completed/i, { timeout: 5_000 });
    await expect(page.locator(".md-hint")).toContainText(/this event is over/i);

    // Undone from the Manager: Live again, and the hint goes.
    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
    await expect(pill).toContainText(/live/i, { timeout: 5_000 });
    await expect(page.locator(".md-hint")).toHaveCount(0);
  } finally {
    await setup.deleteOrg(orgId);
  }
});

test("a meet-day page that missed the finish catches up when its socket comes back", async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId, event, diver } = await meetDayEvent(request, "Meet Day Missed");
  const links = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    links.push({ ws, server: ws.connectToServer() });
  });
  try {
    await signIn(page, diver.username);
    await page.goto(`/me/meet/${event.id}`);
    const pill = page.locator(".page-sub .status-pill");
    await expect(pill).toContainText(/live/i, { timeout: 10_000 });
    await expect.poll(() => links.length, { timeout: 8_000 }).toBeGreaterThan(0);

    // Finished in the database only, so no broadcast goes out, and the
    // phone's link drops the way a locked screen's does. Nothing else on
    // the page polls, so only the reconnect can bring the finish in.
    await setup.pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [event.id]);
    await page.waitForTimeout(1_000);
    await expect(pill).toContainText(/live/i);
    for (const { ws, server } of links.splice(0)) {
      await server.close().catch(() => {});
      await ws.close().catch(() => {});
    }
    await expect(pill).toContainText(/completed/i, { timeout: 15_000 });
    await expect(page.locator(".md-hint")).toContainText(/this event is over/i);
  } finally {
    await setup.deleteOrg(orgId);
  }
});
