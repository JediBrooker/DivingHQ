// The judge screen on a phone, the way the rehearsal dry run used it:
// five phones opened /judge before the start, then scored a meet. Five
// things went wrong there and each has a test here.
//
//   * A judge who opened /judge before Start Event never got the first
//     diver. The page looked for a Live panel once, on mount, and never
//     again, so it sat on "Waiting" until someone reloaded.
//   * The "Judging panel is live" banner parked itself over Submit and
//     Signal Referee (bottom right, above everything) for an hour.
//   * On an iPhone 13 sized screen the keypad keys were 18px tall.
//   * A judge who reloaded after scoring got an open keypad and an empty
//     tile, nothing to say their score was already in.
//   * When an event finished its judges stayed on the last diver with
//     Submit lit. A score sent then was refused (event_not_live) and sat
//     in the outbox as a generic failure, which read like a broken phone.
//
// Phone sizes are set per context (Chromium with a mobile viewport), the
// chromium project itself runs with no viewport. Set E2E_SHOT_DIR to keep
// a screenshot of each phone size.
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, emitAck, roomWatcher, trackSockets } = require("./_meetday");

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

// What's in the phone's outbox, read straight out of IndexedDB. Only call
// this once the page has queued something: opening a database that isn't
// there yet would create it empty, and the app's own upgrade would never run.
async function outboxEntries(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("divinghq-outbox");
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("outbox")) { db.close(); resolve([]); return; }
      const all = db.transaction("outbox").objectStore("outbox").getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => { db.close(); resolve([]); };
    };
  }));
}

// The judge scores 7.5 with no signal, the event is finalised meanwhile,
// and they go to the dashboard before the phone is back. The app-wide
// drain sends the score from there and the server refuses it, with no
// judge screen open to hear about it.
async function scoreRefusedOnDashboard(page, ctx, request, { adminToken, eventId }) {
  await ctx.setOffline(true);
  await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
  await expect(page.locator(".status-dot.connected")).toHaveCount(0, { timeout: 10_000 });
  await page.locator(".keypad .key", { hasText: /^7$/ }).click();
  await page.locator(".keypad .key-half").click();
  await page.locator(".submit-btn").click();
  await expect.poll(async () => (await outboxEntries(page)).map((e) => e.status)).toEqual(["pending"]);

  await setup.setEventStatus(request, { adminToken, eventId, status: "Completed" });
  // Leaving with a score still queued asks first.
  page.once("dialog", (d) => d.accept());
  await page.locator(".btn-back-judge", { hasText: "Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await ctx.setOffline(false);
  await expect.poll(
    async () => (await outboxEntries(page)).map((e) => [e.status, e.last_error, !!e.acknowledged_at]),
    { timeout: 20_000 },
  ).toEqual([["rejected", "event_not_live", false]]);
}

// Back to the judge screen the way the dashboard's event link goes, in
// the app. page.goto would reload, and on a fresh load the socket's connect
// replay can put the next diver up before the outbox has even been read,
// which is a different path from the one a judge takes.
async function backToJudge(page, to) {
  await page.evaluate((path) => document.querySelector("#app").__vue_app__.config.globalProperties.$router.push(path), to);
}

async function refusalsTold(page) {
  return (await outboxEntries(page)).map((e) => [e.status, !!e.acknowledged_at]);
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
    await expect(page.locator(".judge-id")).toContainText("— J1");
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

// Real phone sizes. The two iPhones are the smallest the judges use and
// have to fit the whole pad with no scrolling; the original SE is the
// floor and may scroll, but its keys still meet the 44px minimum.
const PHONES = [
  { name: "iPhone 13", width: 390, height: 664, fits: true },
  { name: "iPhone SE 3rd gen", width: 375, height: 667, fits: true },
  { name: "Pixel 7", width: 412, height: 839, fits: true },
  { name: "iPhone SE 1st gen", width: 320, height: 568, fits: false },
];

test("the keypad keeps thumb-sized keys on small phones", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Keypad" });
  const solo = await liveEvent(request, { orgId, adminToken, name: "Keypad Solo", diverNames: ["DDD Keypad"] });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(solo.event, solo.divers[0], "DDD Keypad")))
    .toMatchObject({ ok: true });
  // Synchro is the tallest header: two names and the "You are scoring" line.
  const sync = await liveEvent(request, {
    orgId, adminToken, name: "Keypad Synchro", diverNames: ["EEE Synchro"], judges: 7, eventType: "synchro_pair",
  });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(sync.event, sync.divers[0], "EEE Synchro", {
    number_of_judges: 7, event_type: "synchro_pair", partner_name: "FFF Partner",
  }))).toMatchObject({ ok: true });

  const cases = [
    ...PHONES.map((p) => ({ ...p, ev: solo, diver: "DDD Keypad" })),
    { ...PHONES[1], name: "iPhone SE 3rd gen synchro", ev: sync, diver: "EEE Synchro" },
  ];
  try {
    for (const c of cases) {
      const { ctx, page } = await phone(browser, c.width, c.height);
      try {
        await signIn(page, c.ev.judges[0].username);
        await page.goto(`/judge?event=${c.ev.event.id}`);
        await expect(page.locator(".diver-name")).toContainText(c.diver, { timeout: 8_000 });
        await expect(page.locator(".judge-id")).toContainText("— J1", { timeout: 6_000 });
        await shot(page, `judge-keypad-${c.width}x${c.height}${c.ev === sync ? "-synchro" : ""}`);

        const keys = await page.locator(".keypad .key").evaluateAll((els) =>
          els.map((e) => e.getBoundingClientRect().height));
        expect(keys).toHaveLength(12);
        expect(Math.min(...keys), `${c.name}: key height`).toBeGreaterThanOrEqual(44);

        for (const sel of [".submit-btn", ".signal-btn"]) {
          const el = page.locator(sel);
          if (!c.fits) await el.scrollIntoViewIfNeeded();
          const box = await el.boundingBox();
          expect(box.height, `${c.name}: ${sel} height`).toBeGreaterThanOrEqual(44);
          expect(box.y + box.height, `${c.name}: ${sel} is on screen`).toBeLessThanOrEqual(c.height + 0.5);
          expect(box.y, `${c.name}: ${sel} is on screen`).toBeGreaterThanOrEqual(0);
        }
        if (c.fits) {
          // Everything on one screen: nothing to scroll.
          const overflow = await page.evaluate(() => {
            const el = document.querySelector(".judge-layout");
            return el.scrollHeight - el.clientHeight;
          });
          expect(overflow, `${c.name}: the pad fits`).toBeLessThanOrEqual(1);
        }
        // The header links are still there and still tappable.
        for (const link of ["Analysis", "Dashboard"]) {
          const box = await page.locator(".btn-back-judge", { hasText: link }).boundingBox();
          expect(box.height, `${c.name}: ${link} link`).toBeGreaterThanOrEqual(32);
        }
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await setup.deleteOrg(orgId);
  }
});

test("a judge who reloads after scoring sees their score, and the keypad stays shut", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Reload" });
  const { event, divers, diveId, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Reload Event", diverNames: ["GGG Reload"],
  });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(event, divers[0], "GGG Reload")))
    .toMatchObject({ ok: true });
  const room = await roomWatcher(baseURL, event.id);

  const { ctx, page } = await phone(browser, 390, 664);
  const links = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    links.push({ ws, server: ws.connectToServer() });
  });
  const locked = async (value, tile = value) => {
    await expect(page.locator(".score-number")).toHaveText(value, { timeout: 8_000 });
    await expect(page.locator(".submit-btn")).toBeDisabled();
    await expect(page.locator(".submit-btn")).toContainText(value);
    await expect(page.locator(".keypad .key", { hasText: /^8$/ })).toBeDisabled();
    await expect(page.locator(".judge-panel-tile.mine .judge-panel-tile-score")).toHaveText(tile);
  };
  try {
    await signIn(page, judges[0].username);
    await page.goto(`/judge?event=${event.id}`);
    await expect(page.locator(".diver-name")).toContainText("GGG Reload", { timeout: 8_000 });
    await page.locator(".keypad .key", { hasText: /^8$/ }).click();
    await page.locator(".keypad .key-half").click();
    await page.locator(".submit-btn").click();
    await locked("8.5");
    // J2 scores from their own phone.
    await setup.submitPanelScores({
      baseURL, judges: [judges[1]], eventId: event.id, competitorId: divers[0].userId,
      roundNumber: 1, diveId, scores: [7],
    });
    await expect(page.locator(".judge-panel-tile").nth(1).locator(".judge-panel-tile-score")).toHaveText("7.0");

    // A wifi blip: the reconnect replays the same diver, which used to
    // wipe the keypad back open.
    await expect.poll(() => links.length, { timeout: 8_000 }).toBeGreaterThan(0);
    for (const { ws, server } of links.splice(0)) {
      await server.close().catch(() => {});
      await ws.close().catch(() => {});
    }
    await expect.poll(() => links.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    await locked("8.5");

    // A reload.
    await page.reload();
    await expect(page.locator(".diver-name")).toContainText("GGG Reload", { timeout: 8_000 });
    await locked("8.5");
    await expect(page.locator(".judge-panel-tile").nth(1).locator(".judge-panel-tile-score")).toHaveText("7.0");
    await expect(page.locator(".judge-panel-label")).toContainText("2 / 5");
    await shot(page, "judge-reloaded-after-scoring-390x664");
    // Nothing was sent again.
    const rows = await setup.pool.query(
      "SELECT score FROM scores WHERE event_id = $1 AND judge_id = $2", [event.id, judges[0].userId]);
    expect(rows.rows.map((r) => Number(r.score))).toEqual([8.5]);

    // A re-dive puts the old marks aside, so a reload after one has an
    // open keypad and an empty panel again.
    expect(await emitAck(baseURL, adminToken, "referee_redive", {
      event_id: event.id, competitor_id: divers[0].userId, round_number: 1,
    })).toMatchObject({ ok: true });
    await expect.poll(() => room.seen.redive.length, { timeout: 6_000 }).toBeGreaterThan(0);
    await page.reload();
    await expect(page.locator(".diver-name")).toContainText("GGG Reload", { timeout: 8_000 });
    await page.waitForTimeout(1000);
    await expect(page.locator(".submit-btn")).toBeEnabled();
    await expect(page.locator(".keypad .key", { hasText: /^8$/ })).toBeEnabled();
    await expect(page.locator(".judge-panel-tile.in")).toHaveCount(0);

    // Scored again, then the referee fails the dive: what comes back
    // after a reload is the stored 0, not the 8 that was typed.
    await page.locator(".keypad .key", { hasText: /^8$/ }).click();
    await page.locator(".submit-btn").click();
    await locked("8", "8.0");
    expect(await emitAck(baseURL, adminToken, "referee_failed_dive", {
      event_id: event.id, competitor_id: divers[0].userId, round_number: 1,
    })).toMatchObject({ ok: true });
    await expect(page.locator(".judge-panel-tile.mine .judge-panel-tile-score")).toHaveText("0.0", { timeout: 6_000 });
    await page.reload();
    await expect(page.locator(".diver-name")).toContainText("GGG Reload", { timeout: 8_000 });
    await locked("0", "0.0");
  } finally {
    room.close();
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});

test("a judge whose event finishes is told so, then picks up their next panel", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Finish" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Finish First", diverNames: ["HHH Last"] });
  // The same panel's next event, not started yet.
  const B = await setup.createEvent(request, { adminToken, name: "Finish Next", total_rounds: 1, number_of_judges: 5, height: "3m" });
  await setup.assignJudges(request, { adminToken, eventId: B.id, judgeIds: A.judges.map((j) => j.userId) });
  const next = await setup.insertUser({ orgId, role: "diver", fullName: "III Next" });
  await setup.insertDiveList({ eventId: B.id, competitorId: next.userId, dives: [{ round_number: 1, dive_id: A.diveId }] });

  const { ctx, page } = await phone(browser, 390, 664);
  try {
    await signIn(page, A.judges[0].username);
    await page.goto("/judge");
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${A.event.id}$`), { timeout: 8_000 });
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(A.event, A.divers[0], "HHH Last")))
      .toMatchObject({ ok: true });
    await expect(page.locator(".diver-name")).toContainText("HHH Last", { timeout: 8_000 });
    await expect(page.locator(".submit-btn")).toBeEnabled();

    await setup.setEventStatus(request, { adminToken, eventId: A.event.id, status: "Completed" });

    // Straight off the status broadcast: the diver goes, the keypad
    // shuts, and the screen says why.
    const notice = page.getByTestId("judge-finished");
    await expect(notice).toBeVisible({ timeout: 5_000 });
    await expect(notice).toContainText(/finished/i);
    await expect(page.locator(".event-name")).toContainText("Finish First");
    await expect(page.locator(".judge-header")).not.toContainText("HHH Last");
    await expect(page.locator(".submit-btn")).toBeDisabled();
    await expect(page.locator(".keypad .key", { hasText: /^8$/ })).toBeDisabled();
    await expect(page.locator(".signal-btn")).toBeDisabled();
    await expect(page.locator(".judge-id")).not.toContainText("— J1");
    // Back to waiting, the same as a phone opened before the start.
    await expect(page).toHaveURL(/\/judge$/);
    await shot(page, "judge-event-finished-390x664");

    await setup.setEventStatus(request, { adminToken, eventId: B.id, status: "Live" });
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver({ ...B, name: "Finish Next" }, next, "III Next")))
      .toMatchObject({ ok: true });
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${B.id}$`), { timeout: 5_000 });
    await expect(page.locator(".diver-name")).toContainText("III Next", { timeout: 5_000 });
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".judge-id")).toContainText("— J1");
    await expect(page.locator(".submit-btn")).toBeEnabled();
    await expect(page.locator(".keypad .key", { hasText: /^8$/ })).toBeEnabled();
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});

// The status broadcast is fire and forget and venue wifi drops things, so
// the phone may not hear the finish. The status is flipped in the database
// here so nothing goes out: the judge scores the dive still on screen.
test("a score sent after the event finished says so, and isn't retried", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Late" });
  const { event, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Late Score", diverNames: ["JJJ Late"],
  });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(event, divers[0], "JJJ Late")))
    .toMatchObject({ ok: true });
  const { ctx, page } = await phone(browser, 390, 664);
  try {
    await signIn(page, judges[0].username);
    await page.goto(`/judge?event=${event.id}`);
    await expect(page.locator(".diver-name")).toContainText("JJJ Late", { timeout: 8_000 });
    await expect(page.locator(".judge-id")).toContainText("— J1", { timeout: 6_000 });

    await setup.pool.query("UPDATE events SET status = 'Completed' WHERE id = $1", [event.id]);
    await page.locator(".keypad .key", { hasText: /^7$/ }).click();
    await page.locator(".keypad .key-half").click();
    await page.locator(".submit-btn").click();

    const notice = page.getByTestId("judge-finished");
    await expect(notice).toBeVisible({ timeout: 6_000 });
    await expect(notice).toContainText(/finished/i);
    await expect(notice).toContainText("7.5");
    await expect(page.locator(".submit-btn")).toBeDisabled();
    await expect(page.locator(".keypad .key", { hasText: /^8$/ })).toBeDisabled();
    await expect(page).toHaveURL(/\/judge$/);
    await shot(page, "judge-score-refused-390x664");

    // Not a failure waiting on a retry: nothing queued, nothing failed,
    // the entry is closed after the one answer.
    await expect(page.locator(".queued-strip")).toHaveCount(0);
    await expect(page.locator(".offline-banner")).toHaveCount(0);
    const settled = async () => (await outboxEntries(page)).map((e) => [e.status, e.attempts, e.last_error]);
    await expect.poll(settled).toEqual([["rejected", 1, "event_not_live"]]);
    // Well past the first two backoffs (1s, 2s): still one attempt.
    await page.waitForTimeout(4_000);
    expect(await settled()).toEqual([["rejected", 1, "event_not_live"]]);
    await expect(page.locator(".offline-banner")).toHaveCount(0);
    const rows = await setup.pool.query("SELECT 1 FROM scores WHERE event_id = $1", [event.id]);
    expect(rows.rows).toHaveLength(0);

    // A stale link to the finished event lands on the same notice, not
    // on an open keypad waiting for a diver who'll never come.
    await page.goto(`/judge?event=${event.id}`);
    await expect(notice).toBeVisible({ timeout: 6_000 });
    await expect(notice).not.toContainText("7.5");
    await expect(page.locator(".submit-btn")).toBeDisabled();
    await expect(page).toHaveURL(/\/judge$/);
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});

// An event put back to Upcoming (a start undone) isn't finished, and it
// says so. When it goes Live again the phone picks it back up. The server
// keeps its active diver through that (only Completed drops it), so the
// rejoin replays the diver and the keypad is theirs again.
test("an event taken off Live says so, and the judge is back on it when it restarts", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Restart" });
  const { event, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Restart Event", diverNames: ["KKK Again"],
  });
  const { ctx, page } = await phone(browser, 390, 664);
  try {
    await signIn(page, judges[0].username);
    await page.goto(`/judge?event=${event.id}`);
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(event, divers[0], "KKK Again")))
      .toMatchObject({ ok: true });
    await expect(page.locator(".diver-name")).toContainText("KKK Again", { timeout: 8_000 });

    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Upcoming" });
    const notice = page.getByTestId("judge-finished");
    await expect(notice).toBeVisible({ timeout: 5_000 });
    await expect(notice).toContainText(/no longer live/i);
    await expect(page.locator(".submit-btn")).toBeDisabled();
    await expect(page).toHaveURL(/\/judge$/);

    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${event.id}$`), { timeout: 5_000 });
    await expect(page.locator(".diver-name")).toContainText("KKK Again", { timeout: 5_000 });
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".submit-btn")).toBeEnabled();
    await page.locator(".keypad .key", { hasText: /^6$/ }).click();
    await page.locator(".submit-btn").click();
    await expect(page.locator(".judge-panel-tile.mine .judge-panel-tile-score")).toHaveText("6.0", { timeout: 6_000 });
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});

// The Control Room's Undo on "Finalised" puts the event back to Live and
// the last diver back up (docs/rehearsal.md). The phone has already gone
// to the finished notice by then, and the diver can arrive before the
// phone has picked the event up again, so it mustn't get lost in between.
test("an undone finalise puts the last diver back on the judge's phone", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Undo" });
  const { event, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Undo Event", diverNames: ["LLL Undo"],
  });
  const up = activeDiver(event, divers[0], "LLL Undo");
  expect(await emitAck(baseURL, adminToken, "set_active_diver", up)).toMatchObject({ ok: true });
  const { ctx, page } = await phone(browser, 390, 664);
  try {
    await signIn(page, judges[0].username);
    await page.goto(`/judge?event=${event.id}`);
    await expect(page.locator(".diver-name")).toContainText("LLL Undo", { timeout: 8_000 });
    await page.locator(".keypad .key", { hasText: /^8$/ }).click();
    await page.locator(".submit-btn").click();
    await expect(page.locator(".judge-panel-tile.mine .judge-panel-tile-score")).toHaveText("8.0", { timeout: 6_000 });

    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Completed" });
    await expect(page.getByTestId("judge-finished")).toBeVisible({ timeout: 5_000 });

    // Undo: back to Live and the same diver announced again at once.
    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
    expect(await emitAck(baseURL, adminToken, "set_active_diver", up)).toMatchObject({ ok: true });

    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${event.id}$`), { timeout: 5_000 });
    await expect(page.locator(".diver-name")).toContainText("LLL Undo", { timeout: 5_000 });
    await expect(page.getByTestId("judge-finished")).toHaveCount(0);
    // Their score is still in, so the keypad comes back shut on it.
    await expect(page.locator(".judge-panel-tile.mine .judge-panel-tile-score")).toHaveText("8.0", { timeout: 6_000 });
    await expect(page.locator(".submit-btn")).toBeDisabled();
    await expect(page.locator(".submit-btn")).toContainText("8");
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});

// A finalise undone from the Manager with nobody announced after it, then
// finalised again. The phone kept "Event finished" up through the undo
// (the server drops its diver at Completed, so nothing replayed to take
// it down), the second finish then found the notice "already on screen"
// and left ?event= where it was, and with the URL naming an event nothing
// looked for the next panel again. It sat on "Event finished" until it
// was reloaded. The undo is done twice here, the second time in the
// database only, the way a phone that missed the broadcast sees it.
test("a finalise undone with no diver, then finalised again, still lets the next panel in", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Refinalise" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Refinalise First", diverNames: ["MMM First"] });
  const B = await setup.createEvent(request, { adminToken, name: "Refinalise Next", total_rounds: 1, number_of_judges: 5, height: "3m" });
  await setup.assignJudges(request, { adminToken, eventId: B.id, judgeIds: A.judges.map((j) => j.userId) });
  const next = await setup.insertUser({ orgId, role: "diver", fullName: "NNN Next" });
  await setup.insertDiveList({ eventId: B.id, competitorId: next.userId, dives: [{ round_number: 1, dive_id: A.diveId }] });

  const { ctx, page } = await phone(browser, 390, 664);
  const notice = page.getByTestId("judge-finished");
  const finalise = async () => {
    await setup.setEventStatus(request, { adminToken, eventId: A.event.id, status: "Completed" });
    await expect(notice).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".keypad .key", { hasText: /^8$/ })).toBeDisabled();
    await expect(page).toHaveURL(/\/judge$/);
  };
  // Live again and on screen again, waiting for a diver with the keypad
  // open, not still saying it's finished.
  const backOnA = async () => {
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${A.event.id}$`), { timeout: 15_000 });
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".diver-name")).toContainText(/Waiting/);
    await expect(page.locator(".keypad .key", { hasText: /^8$/ })).toBeEnabled();
  };
  try {
    await signIn(page, A.judges[0].username);
    await page.goto(`/judge?event=${A.event.id}`);
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(A.event, A.divers[0], "MMM First")))
      .toMatchObject({ ok: true });
    await expect(page.locator(".diver-name")).toContainText("MMM First", { timeout: 8_000 });

    await finalise();
    await setup.setEventStatus(request, { adminToken, eventId: A.event.id, status: "Live" });
    await backOnA();
    await finalise();

    // No broadcast this time. The phone finds it when it wakes up (or on
    // the slow poll, which is why the wait above runs to 15s).
    await setup.pool.query("UPDATE events SET status = 'Live' WHERE id = $1", [A.event.id]);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await backOnA();
    await finalise();

    await setup.setEventStatus(request, { adminToken, eventId: B.id, status: "Live" });
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver({ ...B, name: "Refinalise Next" }, next, "NNN Next")))
      .toMatchObject({ ok: true });
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${B.id}$`), { timeout: 5_000 });
    await expect(page.locator(".diver-name")).toContainText("NNN Next", { timeout: 5_000 });
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".judge-id")).toContainText("— J1");
    await expect(page.locator(".submit-btn")).toBeEnabled();
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});

// The screen only used to report refusals sent since it opened, and the
// drain runs on every route now. A score refused while the judge was on
// the dashboard was never mentioned anywhere: not on the notice, not in
// the queued strip or the banner, which both leave a closed entry out.
test("a score refused while the judge was off the judge screen is shown when they come back", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Away" });
  const { event, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Away Event", diverNames: ["OOO Away"],
  });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(event, divers[0], "OOO Away")))
    .toMatchObject({ ok: true });
  const { ctx, page } = await phone(browser, 390, 664);
  await trackSockets(page);
  try {
    await signIn(page, judges[0].username);
    await page.goto(`/judge?event=${event.id}`);
    await expect(page.locator(".diver-name")).toContainText("OOO Away", { timeout: 8_000 });
    await expect(page.locator(".judge-id")).toContainText("— J1", { timeout: 6_000 });
    await scoreRefusedOnDashboard(page, ctx, request, { adminToken, eventId: event.id });

    await backToJudge(page, `/judge?event=${event.id}`);
    const notice = page.getByTestId("judge-finished");
    await expect(notice).toBeVisible({ timeout: 8_000 });
    await expect(notice).toContainText(/finished/i);
    await expect(notice).toContainText("7.5");
    await expect(page.locator(".event-name")).toContainText("Away Event");
    await expect(page.locator(".submit-btn")).toBeDisabled();
    await expect(page).toHaveURL(/\/judge$/);

    // Said the once. The outbox has it down as told, so the next visit
    // doesn't bring it up again.
    await expect.poll(() => refusalsTold(page)).toEqual([["rejected", true]]);
    await page.reload();
    await expect(page.locator(".diver-name")).toContainText(/Waiting/, { timeout: 8_000 });
    await page.waitForTimeout(1_000);
    await expect(page.locator(".judge-layout")).not.toContainText("7.5");
    await expect(page.locator(".notify-bar")).toHaveCount(0);
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});

// Same refusal, but by the time the judge comes back their next panel is
// running with a diver up. The notice goes up and the replayed diver takes
// it straight down again, so the lost score has to go somewhere that stays
// long enough to read.
test("a refused score is still said when the judge comes back to a panel that's already running", async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Away Next" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Away First", diverNames: ["QQQ Away"] });
  const B = await setup.createEvent(request, { adminToken, name: "Away Next", total_rounds: 1, number_of_judges: 5, height: "3m" });
  await setup.assignJudges(request, { adminToken, eventId: B.id, judgeIds: A.judges.map((j) => j.userId) });
  const next = await setup.insertUser({ orgId, role: "diver", fullName: "RRR Next" });
  await setup.insertDiveList({ eventId: B.id, competitorId: next.userId, dives: [{ round_number: 1, dive_id: A.diveId }] });
  expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver(A.event, A.divers[0], "QQQ Away")))
    .toMatchObject({ ok: true });

  const { ctx, page } = await phone(browser, 390, 664);
  await trackSockets(page);
  try {
    await signIn(page, A.judges[0].username);
    await page.goto(`/judge?event=${A.event.id}`);
    await expect(page.locator(".diver-name")).toContainText("QQQ Away", { timeout: 8_000 });
    await expect(page.locator(".judge-id")).toContainText("— J1", { timeout: 6_000 });
    await scoreRefusedOnDashboard(page, ctx, request, { adminToken, eventId: A.event.id });

    await setup.setEventStatus(request, { adminToken, eventId: B.id, status: "Live" });
    expect(await emitAck(baseURL, adminToken, "set_active_diver", activeDiver({ ...B, name: "Away Next" }, next, "RRR Next")))
      .toMatchObject({ ok: true });

    // Back in through the dashboard's link to the event that finished.
    await backToJudge(page, `/judge?event=${A.event.id}`);
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${B.id}$`), { timeout: 8_000 });
    await expect(page.locator(".diver-name")).toContainText("RRR Next", { timeout: 8_000 });
    await expect(page.locator(".notify-bar-warn")).toContainText("7.5");
    await expect(page.getByTestId("judge-finished")).toHaveCount(0);
    await expect(page.locator(".submit-btn")).toBeEnabled();
    await expect.poll(() => refusalsTold(page)).toEqual([["rejected", true]]);
  } finally {
    await ctx.close();
    await setup.deleteOrg(orgId);
  }
});
