// The spectator scoreboard (and so /broadcast, the /broadcast/all grid and
// the OBS overlay, which all boot this view) has to keep up with a live
// event on its own. It used to refresh standings, history and Up Next
// only when someone announced (which the Control Room never managed, see
// control-v2-tools) or corrected a score, so a projector opened at the
// start of a meet showed its first snapshot all day and never flipped to
// the recap.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { liveEvent, emitAck } = require("./_meetday");

test.describe.configure({ mode: "serial" });

test("standings refresh when a dive's panel completes, and the recap takes over on finalise", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Scoreboard Refresh" });
  const { event, diveId, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Refresh Event", diverNames: ["AAA Refresh", "BBB Refresh"], rounds: 2,
  });
  const ack = await emitAck(baseURL, adminToken, "set_active_diver", {
    event_id: event.id, competitor_id: divers[0].userId, round_number: 1,
    full_name: "AAA Refresh", diverName: "AAA Refresh", dd: 1.5, status: "ready",
  });
  expect(ack).toMatchObject({ ok: true });

  await page.goto(`/scoreboard/${event.id}`);
  await expect(page.locator(".sb-label").first()).toContainText("Current Performer", { timeout: 10_000 });
  await expect(page.locator(".sb-name").first()).toContainText("AAA Refresh");
  // The server replays every live diver to a fresh socket before the page
  // has asked to join the event room, so the name alone doesn't prove the
  // page will hear the scores. Nothing on screen shows the join; give the
  // get_active_diver round trip a moment.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  const standings = page.locator(".sb-col-standings .standing");
  await expect(standings).toHaveCount(0);

  await setup.submitPanelScores({ baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId });
  await expect(page.locator(".sb-live-judges .j-score:not(.j-empty)")).toHaveCount(5, { timeout: 6_000 });
  // no reload, no announce: the completed panel alone brings the row in
  await expect(standings).toHaveCount(1, { timeout: 8_000 });
  await expect(standings.first()).toContainText("AAA Refresh");

  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Completed" });
  await expect(page.locator(".sb-completed")).toBeVisible({ timeout: 8_000 });
  await setup.deleteOrg(orgId);
});

// The live pills were the Nth score to arrive in slot N (under judge N's
// name), trimmed flat, and the synchro dive total skipped the x0.6.
test("live pills sit under their own judge, and a synchro total uses the WA trim and 0.6", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Scoreboard Synchro" });
  const { event, diveId, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Synchro Pills", diverNames: ["AAA Pair"], judges: 9, eventType: "synchro_pair",
  });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", {
    event_id: event.id, competitor_id: divers[0].userId, round_number: 1,
    full_name: "AAA Pair", diverName: "AAA Pair", dd: 3.0, event_type: "synchro_pair",
    number_of_judges: 9, status: "ready",
  })).toMatchObject({ ok: true });

  await page.goto(`/scoreboard/${event.id}`);
  await expect(page.locator(".sb-label").first()).toContainText("Current Performer", { timeout: 10_000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  const pills = page.locator(".sb-live-judges .j-score");
  await expect(pills).toHaveCount(9);

  // J3 first: it shows in the third seat, not the first
  const vals = [7, 8, 6, 9, 7, 7, 8, 8, 9];
  await setup.submitJudgeScore({ baseURL, token: judges[2].token, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId, score: vals[2] });
  await expect(pills.nth(2)).toHaveText("6.0", { timeout: 6_000 });
  await expect(pills.nth(0)).toHaveText("—");

  for (const i of [0, 1, 3, 4, 5, 6, 7, 8]) {
    await setup.submitJudgeScore({ baseURL, token: judges[i].token, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId, score: vals[i] });
  }
  await expect(page.locator(".sb-live-total-value")).toHaveText("68.4", { timeout: 6_000 });
  const dropped = await pills.evaluateAll((els) => els.map((el, i) => (el.classList.contains("j-dropped") ? i + 1 : null)).filter(Boolean));
  expect(dropped).toEqual([3, 4, 5, 9]);
  await setup.deleteOrg(orgId);
});
