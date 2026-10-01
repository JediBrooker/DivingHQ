// The spectator scoreboard's chrome around the scores: the status badge in
// the header. From the meet rehearsal:
//
//   * An event that hadn't started yet wore the red Live badge, so a
//     spectator who opened the board early (the meets list links to
//     upcoming events) was told it was live next to "Waiting...".
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { liveEvent } = require("./_meetday");

test("an event that hasn't started doesn't wear the red Live badge", async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Scoreboard Upcoming" });
  try {
    const { event } = await liveEvent(request, {
      orgId, adminToken, name: "Not Started Yet", diverNames: ["AAA Early"], status: "Upcoming",
    });
    await page.goto(`/scoreboard/${event.id}`);
    const badge = page.locator(".sb-header .status-badge");
    await expect(badge).toHaveText("Upcoming", { timeout: 10_000 });
    await expect(page.locator(".sb-header .live-badge")).toHaveCount(0);

    // Starting the event flips it, without a reload.
    await page.waitForLoadState("networkidle");
    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
    await expect(badge).toHaveText("Live", { timeout: 8_000 });
    await expect(page.locator(".sb-header .live-badge")).toHaveCount(1);
  } finally {
    await setup.deleteOrg(orgId);
  }
});
