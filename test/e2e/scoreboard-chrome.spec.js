// The spectator scoreboard's chrome around the scores: the status badge in
// the header and the broadcast screen's floating exit control. Both came
// out of the meet rehearsal.
//
//   * An event that hadn't started yet wore the red Live badge, so a
//     spectator who opened the board early (the meets list links to
//     upcoming events) was told it was live next to "Waiting...".
//   * On /broadcast the fixed exit X sat on top of the recap's
//     PDF / CSV / Start list buttons, and a click on the right end of
//     "Start list" left broadcast mode instead.
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

test("the broadcast recap leaves nothing clickable under the exit X", async ({ browser, request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Broadcast Recap" });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const { event, diveId, divers, judges } = await liveEvent(request, {
      orgId, adminToken, name: "Finished Event", diverNames: ["AAA Done"],
    });
    for (const j of judges) {
      await setup.insertScore({ eventId: event.id, competitorId: divers[0].userId, judgeId: j.userId, diveId, roundNumber: 1, score: 7 });
    }
    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Completed" });

    const page = await ctx.newPage();
    await page.goto(`/scoreboard/${event.id}/broadcast`);
    await expect(page.locator(".sb-completed")).toBeVisible({ timeout: 10_000 });
    const exit = page.locator(".broadcast-exit");
    await expect(exit).toBeVisible();
    // Anything on the recap a click could be meant for, that the X covers.
    const covered = await page.evaluate(() => {
      const x = document.querySelector(".broadcast-exit").getBoundingClientRect();
      return [...document.querySelectorAll(".sb-completed a, .sb-completed button")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          return !(r.right <= x.left || x.right <= r.left || r.bottom <= x.top || x.bottom <= r.top);
        })
        .map((el) => el.textContent.trim());
    });
    expect(covered).toEqual([]);
    // A projector has no use for the exports, same as the stream overlay.
    await expect(page.locator(".sb-completed .export-actions")).toHaveCount(0);

    // The ordinary recap still has them.
    await page.goto(`/scoreboard/${event.id}`);
    await expect(page.locator(".sb-completed .export-actions a")).toHaveText(["PDF", "CSV", "Start list"], { timeout: 10_000 });
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});
