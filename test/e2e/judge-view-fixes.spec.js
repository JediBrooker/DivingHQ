// Judge screen regressions: whose diver it shows, what a re-dive does to
// the keypad, and the synchro role line.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, emitAck, roomWatcher } = require("./_meetday");

test.describe.configure({ mode: "serial" });

// The server replays state_update for every live event on the platform
// to each socket that connects. The judge screen took whichever came in
// last, so a judge waiting on an event that hadn't started got another
// org's diver, with Submit enabled, and fired a my-judge-number request
// for every one of them.
test("a judge only ever sees their own event's diver", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const other = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Other Org" });
  const Y = await liveEvent(request, { orgId: other.orgId, adminToken: other.adminToken, name: "Someone Else's", diverNames: ["YYY Foreign"] });
  expect(await emitAck(baseURL, other.adminToken, "set_active_diver", {
    event_id: Y.event.id, competitor_id: Y.divers[0].userId, full_name: "YYY Foreign", diverName: "YYY Foreign",
    round_number: 1, dive_code: "101", position: "B", dd: 1.5, number_of_judges: 5, status: "ready",
  })).toMatchObject({ ok: true });

  const mine = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Own Org" });
  const X = await liveEvent(request, { orgId: mine.orgId, adminToken: mine.adminToken, name: "Not Started", diverNames: ["XXX Mine"] });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const judgeNumberCalls = [];
  page.on("request", (req) => {
    const m = req.url().match(/\/api\/events\/([^/]+)\/my-judge-number/);
    if (m) judgeNumberCalls.push(m[1]);
  });
  // Cut the websocket once the page is up, like a wifi blip: it's the
  // reconnect's replay that lands while the judge screen is listening.
  const links = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    links.push({ ws, server: ws.connectToServer() });
  });
  await signIn(page, X.judges[0].username);
  await page.goto(`/judge?event=${X.event.id}`);
  await page.waitForLoadState("networkidle");
  await expect.poll(() => links.length, { timeout: 8_000 }).toBeGreaterThan(0);
  for (const { ws, server } of links.splice(0)) {
    await server.close().catch(() => {});
    await ws.close().catch(() => {});
  }
  await expect.poll(() => links.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);

  await expect(page.locator(".diver-name")).not.toContainText("YYY Foreign");
  await expect(page.locator(".dive-pill.dd")).toHaveText("DD —");
  expect(judgeNumberCalls.filter((id) => id !== X.event.id)).toEqual([]);

  // ...and once their own event's diver goes up, that shows
  expect(await emitAck(baseURL, mine.adminToken, "set_active_diver", {
    event_id: X.event.id, competitor_id: X.divers[0].userId, full_name: "XXX Mine", diverName: "XXX Mine",
    round_number: 1, dive_code: "101", position: "B", dd: 1.5, number_of_judges: 5, status: "ready",
  })).toMatchObject({ ok: true });
  await expect(page.locator(".diver-name")).toContainText("XXX Mine", { timeout: 6_000 });
  await ctx.close();
  await setup.deleteOrg(other.orgId);
  await setup.deleteOrg(mine.orgId);
});

// referee_redive marks the round's scores 'redive' until each judge scores
// again, but nothing listened for referee_action_redive: judges kept a
// locked keypad and the operator kept five filled tiles and an armed Next.
test("a re-dive reopens the judges' keypads and resets the operator's tiles", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Redive" });
  const { event, divers, diveId, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Redive Event", diverNames: ["AAA Redive", "BBB Redive"],
  });
  const room = await roomWatcher(baseURL, event.id);

  const cctx = await browser.newContext();
  const cpage = await cctx.newPage();
  await signIn(cpage, username);
  await cpage.goto(`/control?event=${event.id}`);
  const card = cpage.locator(`.cv2-pool[data-event-id="${event.id}"]`);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Redive", { timeout: 10_000 });
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);

  // J1 scores from the judge screen, so their keypad locks
  const jctx = await browser.newContext();
  const jpage = await jctx.newPage();
  await signIn(jpage, judges[0].username);
  await jpage.goto(`/judge?event=${event.id}`);
  await expect(jpage.locator(".diver-name")).toContainText("AAA Redive", { timeout: 8_000 });
  await jpage.locator(".keypad .key", { hasText: /^8$/ }).click();
  await jpage.locator(".submit-btn").click();
  await expect(jpage.locator(".keypad .key", { hasText: /^8$/ })).toBeDisabled({ timeout: 6_000 });

  await setup.submitPanelScores({
    baseURL, judges: judges.slice(1), eventId: event.id,
    competitorId: divers[0].userId, roundNumber: 1, diveId,
  });
  await expect(card.locator(".cv2-tile.scored")).toHaveCount(5, { timeout: 8_000 });
  await expect(card.locator(".cv2-primary")).toBeEnabled();

  await card.locator(".cv2-ref-btn", { hasText: "Re-dive" }).click();
  await expect.poll(() => room.seen.redive.length, { timeout: 6_000 }).toBeGreaterThan(0);

  await expect(card.locator(".cv2-tile.scored")).toHaveCount(0, { timeout: 6_000 });
  await expect(card.locator(".cv2-primary")).toBeDisabled();
  await expect(jpage.locator(".keypad .key", { hasText: /^8$/ })).toBeEnabled();
  await expect(jpage.locator(".submit-btn")).toBeEnabled();

  room.close();
  await cctx.close(); await jctx.close();
  await setup.deleteOrg(orgId);
});

// synchroRole only knew 9 and 11 judges, and the Manager allows 7.
test("a judge on a 7-judge synchro panel is told what they're scoring", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Synchro Seven" });
  const { event, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Seven Synchro", diverNames: ["AAA Seven"], judges: 7, eventType: "synchro_pair",
  });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", {
    event_id: event.id, competitor_id: divers[0].userId, full_name: "AAA Seven", diverName: "AAA Seven",
    round_number: 1, dive_code: "101", position: "B", dd: 1.5, number_of_judges: 7,
    event_type: "synchro_pair", status: "ready",
  })).toMatchObject({ ok: true });

  const roles = {};
  for (const [i, want] of [[0, "EXEC A"], [2, "EXEC B"], [4, "SYNCHRONISATION"]]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, judges[i].username);
    await page.goto(`/judge?event=${event.id}`);
    await expect(page.locator(".diver-name")).toContainText("AAA Seven", { timeout: 8_000 });
    await expect(page.locator(".synchro-role")).toContainText(want, { timeout: 6_000 });
    roles[i] = want;
    await ctx.close();
  }
  expect(Object.keys(roles)).toHaveLength(3);
  await setup.deleteOrg(orgId);
});
