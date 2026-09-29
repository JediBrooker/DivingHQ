// The judge screen on a phone, the way the rehearsal dry run used it:
// five phones opened /judge before the start, then scored a meet.
//
//   * A judge who opened /judge before Start Event never got the first
//     diver. The page looked for a Live panel once, on mount, and never
//     again, so it sat on "Waiting" until someone reloaded.
//
// Phone sizes are set per context (Chromium with a mobile viewport), the
// chromium project itself runs with no viewport.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, emitAck } = require("./_meetday");

test.describe.configure({ mode: "serial" });

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

async function phone(browser, width, height) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: PHONE_UA,
  });
  const page = await ctx.newPage();
  await setup.bypassRoleTour(page);
  return { ctx, page };
}

function activeDiver(event, diver, name, extra = {}) {
  return {
    event_id: event.id, competitor_id: diver.userId, full_name: name, diverName: name,
    round_number: 1, dive_code: "101", position: "B", dd: 1.5, number_of_judges: 5,
    eventName: event.name, status: "ready", ...extra,
  };
}

test("a judge waiting on /judge picks up the first diver when the event starts", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Waits" });
  const { event, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Waiting Start", diverNames: ["AAA Early"], status: "Upcoming",
  });
  const { ctx, page } = await phone(browser, 390, 664);
  try {
    await signIn(page, judges[0].username);
    await page.goto("/judge");
    await expect(page.locator(".diver-name")).toContainText(/Waiting/);
    // Nothing is Live yet, so the page stays where it is.
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/\/judge$/);

    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(event, divers[0], "AAA Early")))
      .toMatchObject({ ok: true });

    // Well inside the page's slow poll: the status change and the
    // panel-live notice both reach the socket straight away.
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${event.id}$`), { timeout: 5_000 });
    await expect(page.locator(".diver-name")).toContainText("AAA Early", { timeout: 5_000 });
    await expect(page.locator(".judge-id")).toContainText("J1");
    await expect(page.locator(".submit-btn")).toBeEnabled();
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});

// Neither the status broadcast nor the notice reaches this phone. Both are
// fire and forget, and venue wifi drops things. The status is flipped in
// the database here so neither goes out: the slow poll still finds it.
test("a waiting judge who hears nothing still finds the Live panel on the poll", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Poll" });
  const { event, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Quiet Start", diverNames: ["BBB Quiet"], status: "Upcoming",
  });
  const { ctx, page } = await phone(browser, 390, 664);
  try {
    await signIn(page, judges[0].username);
    await page.goto("/judge");
    await expect(page.locator(".diver-name")).toContainText(/Waiting/);
    await setup.pool.query("UPDATE events SET status = 'Live' WHERE id = $1", [event.id]);
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(event, divers[0], "BBB Quiet")))
      .toMatchObject({ ok: true });
    await expect(page.locator(".diver-name")).toContainText("BBB Quiet", { timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${event.id}$`));
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});
