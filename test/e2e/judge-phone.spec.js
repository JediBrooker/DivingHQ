// The judge screen on a phone, the way the rehearsal dry run used it:
// five phones opened /judge before the start, then scored a meet.
//
//   * A judge who opened /judge before Start Event never got the first
//     diver. The page looked for a Live panel once, on mount, and never
//     again, so it sat on "Waiting" until someone reloaded.
//   * The "Judging panel is live" banner parked itself over Submit and
//     Signal Referee (bottom right, above everything) for an hour.
//
// Phone sizes are set per context (Chromium with a mobile viewport), the
// chromium project itself runs with no viewport. Set E2E_SHOT_DIR to keep
// a screenshot of what the phone showed.
const path = require("node:path");
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

function overlaps(a, b) {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

async function shot(page, name) {
  if (!process.env.E2E_SHOT_DIR) return;
  await page.screenshot({ path: path.join(process.env.E2E_SHOT_DIR, `${name}.png`), animations: "disabled" });
}

async function eventLiveRows(userId, eventId) {
  const r = await setup.pool.query(
    `SELECT status FROM notifications
      WHERE user_id = $1 AND category = 'event_live' AND data->>'event_id' = $2`,
    [userId, eventId],
  );
  return r.rows.map((x) => x.status);
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
    // The banner would only have brought them here, so it's cleared.
    await expect(page.locator(".notif-card")).toHaveCount(0);
    await expect.poll(() => eventLiveRows(judges[0].userId, event.id), { timeout: 5_000 })
      .toEqual(["acknowledged"]);
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

test("banners on the judge screen stay clear of the keypad, Submit and Signal Referee", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Banner" });
  const X = await liveEvent(request, {
    orgId, adminToken, name: "Banner Own", diverNames: ["CCC Own"], status: "Upcoming",
  });
  // A second panel the same judge sits on, starting while they score X.
  const Y = await setup.createEvent(request, { adminToken, name: "Banner Next", total_rounds: 1, number_of_judges: 5, height: "3m" });
  await setup.assignJudges(request, { adminToken, eventId: Y.id, judgeIds: X.judges.map((j) => j.userId) });

  const { ctx, page } = await phone(browser, 390, 664);
  try {
    await signIn(page, X.judges[0].username);
    // Opened from the dashboard card, so the URL already names the event.
    await page.goto(`/judge?event=${X.event.id}`);
    await setup.setEventStatus(request, { adminToken, eventId: X.event.id, status: "Live" });
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(X.event, X.divers[0], "CCC Own")))
      .toMatchObject({ ok: true });
    await expect(page.locator(".diver-name")).toContainText("CCC Own", { timeout: 6_000 });
    // Their own event's "panel is live" is acknowledged, never drawn.
    await expect.poll(() => eventLiveRows(X.judges[0].userId, X.event.id), { timeout: 5_000 })
      .toEqual(["acknowledged"]);
    await expect(page.locator(".notif-card")).toHaveCount(0);

    await setup.setEventStatus(request, { adminToken, eventId: Y.id, status: "Live" });
    const card = page.locator(".notif-card", { hasText: "Banner Next" });
    await expect(card).toBeVisible({ timeout: 6_000 });
    await shot(page, "judge-banner-390x664");

    const cardBox = await card.boundingBox();
    for (const sel of [".keypad", ".submit-btn", ".signal-btn", ".score-number"]) {
      const box = await page.locator(sel).boundingBox();
      expect(overlaps(cardBox, box), `${sel} is covered by the banner`).toBe(false);
    }
    // And the keypad still takes the tap, with the banner up.
    await page.locator(".keypad .key", { hasText: /^8$/ }).click();
    await page.locator(".submit-btn").click();
    await expect(page.locator(".judge-panel-tile.mine .judge-panel-tile-score")).toHaveText("8.0", { timeout: 6_000 });
    await expect(card).toBeVisible();
    // It still goes where it always went.
    await card.locator(".notif-title").click();
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${Y.id}$`));
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});
