// A referee Cap or Failed on a dive the panel has already scored. The
// server rewrites the stored scores and History / Standings re-read them,
// but the live screens kept showing the awards from before the call until
// the next diver: in the rehearsal the spectator's current-dive panel said
// 37.0 for a dive the referee had failed. The Control Room's tiles, the
// scoreboard's pills and dive total and the judge's own panel all have to
// follow the call (WA 8.6.6 for a failed dive, 8.4.7 for a cap).
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, roomWatcher } = require("./_meetday");

test.describe.configure({ mode: "serial" });

test("a Cap and then a Failed call reach the Control Room tiles, the scoreboard and the judge's panel", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Referee Live Calls" });
  const { event, divers, diveId, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Referee Calls", diverNames: ["AAA Called", "BBB Called"],
  });
  const room = await roomWatcher(baseURL, event.id);

  // The Control Room puts AAA up.
  const cctx = await browser.newContext();
  const cpage = await cctx.newPage();
  await signIn(cpage, username);
  await cpage.goto(`/control?event=${event.id}`);
  const card = cpage.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Called", { timeout: 10_000 });
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);

  const sctx = await browser.newContext();
  const spage = await sctx.newPage();
  await spage.goto(`/scoreboard/${event.id}`);
  await expect(spage.locator(".sb-name").first()).toContainText("AAA Called", { timeout: 10_000 });
  // Nothing on screen shows the page joined the event room (see
  // scoreboard-live-refresh), so give get_active_diver a moment.
  await spage.waitForLoadState("networkidle");
  await spage.waitForTimeout(1000);

  const jctx = await browser.newContext();
  const jpage = await jctx.newPage();
  await signIn(jpage, judges[0].username);
  await jpage.goto(`/judge?event=${event.id}`);
  await expect(jpage.locator(".diver-name")).toContainText("AAA Called", { timeout: 8_000 });
  await jpage.waitForLoadState("networkidle");

  const tiles = card.locator(".cv2-tile");
  const pills = spage.locator(".sb-live-judges .j-score");
  const total = spage.locator(".sb-live-total-value");
  const panel = jpage.locator(".judge-panel-tile-score");
  const everywhere = async (want, diveTotal) => {
    await expect(tiles).toHaveText(want, { timeout: 6_000 });
    await expect(pills).toHaveText(want, { timeout: 6_000 });
    await expect(panel).toHaveText(want, { timeout: 6_000 });
    await expect(total).toHaveText(diveTotal, { timeout: 6_000 });
  };

  // The 1.5 and one 8 are trimmed: (6 + 7 + 8) x 1.5 = 31.5
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId,
    scores: [6, 1.5, 7, 8, 8],
  });
  await everywhere(["6.0", "1.5", "7.0", "8.0", "8.0"], "31.5");

  // Cap 2.0 from the Control Room: everything above 2 comes down to it,
  // the 1.5 stays. Trimmed: (2 + 2 + 2) x 1.5 = 9.0
  await card.locator(".cv2-ref-btn", { hasText: "Cap 2.0" }).click();
  await everywhere(["2.0", "1.5", "2.0", "2.0", "2.0"], "9.0");

  // Failed: 0 points for the dive.
  await card.locator(".cv2-ref-failed").click();
  await everywhere(["0.0", "0.0", "0.0", "0.0", "0.0"], "0.0");
  // History and Standings got there too (score_corrected), as before.
  const histCard = cpage.locator(".cv2-hcard", { hasText: "AAA Called" });
  await expect(histCard.locator(".cv2-hcard-total")).toHaveText("0.00", { timeout: 8_000 });

  room.close();
  await cctx.close(); await sctx.close(); await jctx.close();
  await setup.deleteOrg(orgId);
});
