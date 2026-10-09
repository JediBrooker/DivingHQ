// What the Control Room puts on the wire when a diver goes up, and what
// the judge screen and the public scoreboard make of it.
//
// The e2e suite used to emit set_active_diver by hand with diverName
// already filled in, so nobody noticed the Stage-Rail Control Room never
// sent diverName / diveCode / eventName at all: every judge saw "Waiting
// for next diver" and the scoreboard's Current Performer was blank.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, roomWatcher, emitAck } = require("./_meetday");

test.describe.configure({ mode: "serial" });

test("the Control Room's active diver shows on the judge screen and the scoreboard", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Payload Diving" });
  const { event, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Payload Event", diverNames: ["AAA Payload", "BBB Payload"],
  });
  const room = await roomWatcher(baseURL, event.id);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, username);
  await page.goto(`/control?event=${event.id}`);
  await page.getByRole("button", { name: "Take control", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Release control", exact: true }).first()).toBeVisible();
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Payload", { timeout: 10_000 });

  // Fresh event, so the room hears roster[0] once the seed grace runs out.
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);
  const sent = room.seen.state.at(-1);
  expect(sent.diverName).toBe("AAA Payload");
  expect(sent.diveCode).toBe("101B");
  expect(sent.eventName).toBe("Payload Event");

  const jctx = await browser.newContext();
  const jpage = await jctx.newPage();
  await signIn(jpage, judges[0].username);
  await jpage.goto(`/judge?event=${event.id}`);
  await expect(jpage.locator(".event-name")).toHaveText("Payload Event", { timeout: 8_000 });
  await expect(jpage.locator(".diver-name")).toContainText("AAA Payload");
  await expect(jpage.locator(".dive-pill.code")).toHaveText("101B");

  const sctx = await browser.newContext();
  const spage = await sctx.newPage();
  await spage.goto(`/scoreboard/${event.id}`);
  await expect(spage.locator(".sb-name").first()).toContainText("AAA Payload", { timeout: 10_000 });
  await expect(spage.locator(".sb-code").first()).toHaveText("101B");

  room.close();
  await ctx.close(); await jctx.close(); await sctx.close();
  await setup.deleteOrg(orgId);
});

test("a payload persisted without the display fields still renders", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  // event_live_state can still hold payloads written before the fix, and
  // the server replays them on restart. Those carry the raw roster row
  // (full_name, dive_code, position) and nothing else.
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Legacy Payload" });
  const { event, divers, diveId, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Legacy Payload Event", diverNames: ["CCC Legacy"],
  });
  const ack = await emitAck(baseURL, adminToken, "set_active_diver", {
    event_id: event.id, competitor_id: divers[0].userId, full_name: "CCC Legacy",
    round_number: 1, dive_id: diveId, dive_code: "101", position: "B", dd: 1.5,
    number_of_judges: 5, event_type: "individual", status: "ready",
  });
  expect(ack).toMatchObject({ ok: true });

  const jctx = await browser.newContext();
  const jpage = await jctx.newPage();
  await signIn(jpage, judges[0].username);
  await jpage.goto(`/judge?event=${event.id}`);
  await expect(jpage.locator(".diver-name")).toContainText("CCC Legacy", { timeout: 8_000 });
  await expect(jpage.locator(".dive-pill.code")).toHaveText("101B");

  const sctx = await browser.newContext();
  const spage = await sctx.newPage();
  await spage.goto(`/scoreboard/${event.id}`);
  await expect(spage.locator(".sb-name").first()).toContainText("CCC Legacy", { timeout: 10_000 });
  await expect(spage.locator(".sb-code").first()).toHaveText("101B");

  await jctx.close(); await sctx.close();
  await setup.deleteOrg(orgId);
});
