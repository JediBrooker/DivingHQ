// The spectator scoreboard (and so /broadcast, the /broadcast/all grid and
// the OBS overlay, which all boot this view) has to keep up with a live
// event on its own. It used to refresh standings, history and Up Next
// only when someone announced (which the Control Room never managed, see
// control-v2-tools) or corrected a score, so a projector opened at the
// start of a meet showed its first snapshot all day and never flipped to
// the recap.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { liveEvent, emitAck, signIn, trackSockets } = require("./_meetday");

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

// A correction has to reach a scoreboard that's already open. The page
// re-read its standings through the IndexedDB cache, which calls a live
// copy fresh for 5s and a recap for a day, so a correction a moment after
// the last refresh (and any correction once the recap was up) put the old
// numbers straight back on screen. The rehearsal caught both.
test("a score correction reaches an open scoreboard, live and on the recap", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Scoreboard Correction" });
  const { event, diveId, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Correction Event", diverNames: ["AAA Fix"],
  });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", {
    event_id: event.id, competitor_id: divers[0].userId, round_number: 1,
    full_name: "AAA Fix", diverName: "AAA Fix", dd: 1.5, status: "ready",
  })).toMatchObject({ ok: true });

  await page.goto(`/scoreboard/${event.id}`);
  await expect(page.locator(".sb-name").first()).toContainText("AAA Fix", { timeout: 10_000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  // 6 and one 8 are trimmed: (7 + 7 + 8) x 1.5 = 33.0
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId,
    scores: [6, 7, 7, 8, 8],
  });
  const standing = page.locator(".sb-col-standings .standing").first();
  await expect(standing.locator(".standing-score")).toHaveText("33.0", { timeout: 8_000 });

  const scoreId = async (judge) => (await setup.pool.query(
    "SELECT id FROM scores WHERE event_id = $1 AND competitor_id = $2 AND judge_id = $3",
    [event.id, divers[0].userId, judge.userId],
  )).rows[0].id;
  const correct = async (judge, score) => {
    const res = await request.put(`/api/scores/${await scoreId(judge)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { score, reason: "e2e correction" },
    });
    expect(res.status()).toBe(200);
  };

  // Straight after that refresh, well inside the 5s the cached copy
  // counts as fresh: J1's 6 becomes a 9, so (7 + 8 + 8) x 1.5 = 34.5.
  await correct(judges[0], 9);
  await expect(standing.locator(".standing-score")).toHaveText("34.5", { timeout: 4_000 });

  // Once it's Completed the recap takes over, cached for a day. J2's 7
  // becomes a 10: (8 + 8 + 9) x 1.5 = 37.5.
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Completed" });
  const recap = page.locator(".sb-completed");
  await expect(recap).toContainText("34.5", { timeout: 8_000 });
  await correct(judges[1], 10);
  await expect(recap).toContainText("37.5", { timeout: 4_000 });
  await expect(recap).not.toContainText("34.5");
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

// Art 4.1.5: equal totals share the place. The Control Room's standings,
// the scoreboard's "Currently Nth" and its recap badges numbered by list
// position, so a tie read 1st and 2nd next to a panel saying 1 and 1.
test("tied divers share the place everywhere it's shown", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Shared Places" });
  const { event, diveId, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Tie Event", diverNames: ["AAA Tie", "BBB Tie", "CCC Tie"], rounds: 2,
  });
  // AAA and BBB on identical panels, CCC behind
  for (const [d, score] of [[divers[0], 7], [divers[1], 7], [divers[2], 6]]) {
    for (const j of judges) {
      await setup.insertScore({ eventId: event.id, competitorId: d.userId, judgeId: j.userId, diveId, roundNumber: 1, score });
    }
  }
  expect(await emitAck(baseURL, adminToken, "set_active_diver", {
    event_id: event.id, competitor_id: divers[1].userId, round_number: 2,
    full_name: "BBB Tie", diverName: "BBB Tie", dd: 1.5, status: "ready",
  })).toMatchObject({ ok: true });

  const sctx = await browser.newContext();
  const spage = await sctx.newPage();
  await spage.goto(`/scoreboard/${event.id}`);
  await expect(spage.locator(".sb-name").first()).toContainText("BBB Tie", { timeout: 10_000 });
  await expect(spage.locator(".sb-live-rank")).toContainText("1st", { timeout: 6_000 });

  const cctx = await browser.newContext();
  const cpage = await cctx.newPage();
  await signIn(cpage, username);
  await cpage.goto(`/control?event=${event.id}`);
  const ranks = cpage.locator(".cv2-srow-rank");
  await expect(ranks).toHaveCount(3, { timeout: 10_000 });
  expect(await ranks.allInnerTexts()).toEqual(["1", "1", "3"]);

  await sctx.close(); await cctx.close();
  await setup.deleteOrg(orgId);
});

// A deep link has to wait for /api/archive before it knows its event, and
// it used to show the meets list while it waited: an OBS overlay or a
// venue projector flashed the whole list on air at every load.
test("a broadcast deep link never flashes the meets list while it loads", async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Scoreboard Deep Link" });
  const { event } = await liveEvent(request, { orgId, adminToken, name: "Deep Link Event", diverNames: ["AAA Deep"] });
  await page.route(/\/api\/archive(\?.*)?$/, async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue().catch(() => {});
  });
  await page.goto(`/scoreboard/${event.id}/broadcast`);
  // Sample while /api/archive is still held back (a web-first assertion
  // would just wait the flash out).
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(300);
    expect(await page.locator(".meets-mode").count()).toBe(0);
  }
  await expect(page.locator(".sb-body")).toBeVisible({ timeout: 10_000 });
  await setup.deleteOrg(orgId);
});

// On an ordinary deep link the holding text shows, and like the rest of
// the scoreboard it's in the spectator's language.
test("a deep link's loading placeholder is in the viewer's language", async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Scoreboard Deep Link FR" });
  const { event } = await liveEvent(request, { orgId, adminToken, name: "Deep Link FR", diverNames: ["AAA FR"] });
  await page.addInitScript(() => { try { localStorage.setItem("locale", "fr"); } catch { /* private mode */ } });
  await page.route(/\/api\/archive(\?.*)?$/, async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue().catch(() => {});
  });
  await page.goto(`/scoreboard/${event.id}`);
  await expect(page.locator(".sb-deeplink-pending")).toHaveText("Chargement…");
  await expect(page.locator(".sb-body")).toBeVisible({ timeout: 10_000 });
  await setup.deleteOrg(orgId);
});

// The catch-up box counted the dive on the board as still to come even
// after its panel was in and its points were in the standings. After R2 of
// 3 it said "2 dives left", and after the very last dive of the event the
// projector still said "1 dive left", with the averages it asked for
// spread over a dive that would never happen.
test("the catch-up box stops counting a dive once it's been scored", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Scoreboard Catch-up" });
  try {
    const { event, diveId, divers, judges } = await liveEvent(request, {
      orgId, adminToken, name: "Catch-up Event", diverNames: ["AAA Lead", "BBB Chase"], rounds: 3,
    });
    const [lead, chaser] = divers;
    const insertPanel = async (who, round, score) => {
      for (const j of judges) {
        await setup.insertScore({ eventId: event.id, competitorId: who.userId, judgeId: j.userId, diveId, roundNumber: round, score });
      }
    };
    // AAA stays ahead throughout: a dive ahead and 8s to BBB's 6s.
    await insertPanel(lead, 1, 8);
    await insertPanel(lead, 2, 8);
    await insertPanel(chaser, 1, 6);
    const up = (round) => emitAck(baseURL, adminToken, "set_active_diver", {
      event_id: event.id, competitor_id: chaser.userId, round_number: round,
      full_name: "BBB Chase", diverName: "BBB Chase", dd: 1.5, status: "ready",
    });

    expect(await up(2)).toMatchObject({ ok: true });
    await page.goto(`/scoreboard/${event.id}`);
    const head = page.locator(".sb-projection-chase .sb-projection-head");
    // R2 and R3 still to dive
    await expect(head).toContainText(/\b2\s+dives left/, { timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await setup.submitPanelScores({
      baseURL, judges, eventId: event.id, competitorId: chaser.userId, roundNumber: 2, diveId, scores: [6, 6, 6, 6, 6],
    });
    // R2's points are in the standings now, only R3 is left
    await expect(page.locator(".sb-live-total-value")).toBeVisible({ timeout: 6_000 });
    await expect(head).toContainText(/\b1\s+dive left/, { timeout: 8_000 });

    await insertPanel(lead, 3, 8);
    expect(await up(3)).toMatchObject({ ok: true });
    await expect(page.locator(".sb-round-pill")).toContainText("Round 3", { timeout: 6_000 });
    await expect(head).toContainText(/\b1\s+dive left/, { timeout: 8_000 });
    await setup.submitPanelScores({
      baseURL, judges, eventId: event.id, competitorId: chaser.userId, roundNumber: 3, diveId, scores: [6, 6, 6, 6, 6],
    });
    // The event's last dive is in: nothing left to catch up with
    await expect(head).toContainText(/no dives left/i, { timeout: 8_000 });
    await expect(page.locator(".sb-projection .sb-catchup-row")).toHaveCount(0);
  } finally {
    await setup.deleteOrg(orgId);
  }
});

// A spectator who opened or reloaded the board mid-dive got a row of empty
// pills, and that dive never got a Dive Total: the pills only ever came
// from score_received broadcasts, so whatever was sent before the page
// joined was gone for good. A phone whose socket dropped for a moment
// (Safari drops it whenever the screen locks) missed the scores sent
// meanwhile the same way. The board asks for the dive's stored scores when
// it lands on a diver, and again when its socket comes back.
test("a board opened mid-dive, or back from a dropped connection, shows the judges already in", async ({ page, context, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Scoreboard Mid-dive" });
  try {
    const { event, diveId, divers, judges } = await liveEvent(request, {
      orgId, adminToken, name: "Mid-dive Event", diverNames: ["AAA Early", "BBB Later"],
    });
    const up = (d, name) => emitAck(baseURL, adminToken, "set_active_diver", {
      event_id: event.id, competitor_id: d.userId, round_number: 1,
      full_name: name, diverName: name, dd: 1.5, status: "ready",
    });
    const score = (i, d, value) => setup.submitJudgeScore({
      baseURL, token: judges[i].token, eventId: event.id, competitorId: d.userId, roundNumber: 1, diveId, score: value,
    });

    expect(await up(divers[0], "AAA Early")).toMatchObject({ ok: true });
    await score(2, divers[0], 6);
    await score(3, divers[0], 6.5);
    await score(4, divers[0], 7);

    await trackSockets(page);
    await page.goto(`/scoreboard/${event.id}`);
    await expect(page.locator(".sb-name").first()).toContainText("AAA Early", { timeout: 10_000 });
    const pills = page.locator(".sb-live-judges .j-score");
    await expect(pills).toHaveText(["—", "—", "6.0", "6.5", "7.0"], { timeout: 6_000 });

    // The rest of the panel comes in live, and the dive gets its total:
    // 6.0 and 8.0 trimmed, (6.5 + 7.0 + 7.5) x 1.5 = 31.5
    await score(0, divers[0], 7.5);
    await score(1, divers[0], 8);
    await expect(pills).toHaveText(["7.5", "8.0", "6.0", "6.5", "7.0"], { timeout: 6_000 });
    await expect(page.locator(".sb-live-total-value")).toHaveText("31.5");

    // A reload mid-dive puts the same pills back, total and all, and so
    // does a venue screen opening /broadcast (the same view) right now.
    await page.reload();
    await expect(pills).toHaveText(["7.5", "8.0", "6.0", "6.5", "7.0"], { timeout: 10_000 });
    await expect(page.locator(".sb-live-total-value")).toHaveText("31.5");
    const tv = await context.newPage();
    await tv.goto(`/scoreboard/${event.id}/broadcast`);
    await expect(tv.locator(".sb-live-judges .j-score")).toHaveText(["7.5", "8.0", "6.0", "6.5", "7.0"], { timeout: 10_000 });
    await expect(tv.locator(".sb-live-total-value")).toHaveText("31.5");
    await tv.close();

    // Next diver, then the phone loses its connection while two judges score.
    expect(await up(divers[1], "BBB Later")).toMatchObject({ ok: true });
    await expect(page.locator(".sb-name").first()).toContainText("BBB Later", { timeout: 6_000 });
    await expect(pills).toHaveText(["—", "—", "—", "—", "—"]);
    await context.setOffline(true);
    try {
      await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
      await expect(page.locator(".conn-banner")).toBeVisible({ timeout: 10_000 });
      await score(0, divers[1], 5);
      await score(1, divers[1], 5.5);
      // still down, so neither score reached the page live
      await expect(page.locator(".conn-banner")).toBeVisible();
      await expect(pills).toHaveText(["—", "—", "—", "—", "—"]);
    } finally {
      await context.setOffline(false);
    }
    await expect(page.locator(".conn-banner")).toHaveCount(0, { timeout: 15_000 });
    await expect(pills).toHaveText(["5.0", "5.5", "—", "—", "—"], { timeout: 6_000 });
  } finally {
    await setup.deleteOrg(orgId);
  }
});
