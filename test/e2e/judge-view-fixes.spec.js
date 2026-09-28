// Judge screen regressions: whose diver it shows, what a re-dive does to
// the keypad, and the synchro role line.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, emitAck } = require("./_meetday");

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
