// The judge pad on small iPhones, measured the way a meet hands it to a
// phone: a real Control Room payload (src/lib/activeDiver.js) with one of
// the longest dive descriptions in the directory, at the viewport Safari
// actually leaves, with and without another judge flagging the referee.
//
// The rehearsal found Submit partly off the bottom of an iPhone SE and
// Signal Referee below the fold there and on a 13 mini. On an iPhone 13
// the pad fitted exactly, until a colleague flagged the referee: the
// "Judge 2 flagged the referee" strip added a line and pushed Signal
// Referee off, and pushed the keypad down mid-entry. A description that
// wrapped onto its own line did the same on every phone. judge-phone.spec.js
// sized the SE at its full screen and used a short 101B, so it passed.
//
// Runs in Chromium (the chromium project) and in WebKit, the engine iOS
// Safari is (the mobile-safari project picks this file up too).
const path = require("node:path");
const { test, expect, devices } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent, emitAck } = require("./_meetday");

test.describe.configure({ mode: "serial" });

// Viewports are what Safari leaves with its bars showing, the way a judge
// opens /judge from a link. Playwright's iPhone 13 and 13 mini already
// are; its SE (3rd gen) is the whole screen, which is what the pad gets
// installed to the home screen. On those three everything fits, header
// and all. The two shorter ones keep the keypad, Submit and Signal
// Referee whole and let the header scroll inside itself, down to the
// diver and the dive, with the panel's tiles the first thing to go.
const PHONES = [
  { name: "iPhone SE (3rd gen), home screen", device: "iPhone SE (3rd gen)", whole: true },
  { name: "iPhone SE (3rd gen) in Safari", device: "iPhone SE (3rd gen)", viewport: { width: 375, height: 548 } },
  { name: "iPhone 13 mini in Safari", device: "iPhone 13 Mini", whole: true },
  { name: "iPhone 13 in Safari", device: "iPhone 13", whole: true },
  { name: "iPhone SE (1st gen)", device: "iPhone SE" },
];

// What ControlViewV2 sends for the dive: the roster row plus the display
// fields activeDiverPayload adds. 5355B is "Reverse 2½ Somersaults 2½
// Twists Pike" on the pad, as long as descriptions get.
function controlRoomPayload(event, diver) {
  return {
    event_id: event.id, competitor_id: diver.userId, partner_id: null,
    full_name: "Liam O'Connor", diverName: "Liam O'Connor",
    round_number: 1, dive_code: "5355", position: "B", diveCode: "5355B", dd: 3.7,
    description: "Reverse 2½ Somersaults 2½ Twists",
    country_code: "RHSL", club_name: "DivingHQ Rehearsal Club", club_code: "RHSL",
    number_of_judges: 5, event_type: "individual",
    eventName: event.name, status: "ready",
  };
}

async function shot(page, name) {
  if (!process.env.E2E_SHOT_DIR) return;
  await page.screenshot({ path: path.join(process.env.E2E_SHOT_DIR, `${name}.png`), animations: "disabled" });
}

// Where everything sits, in viewport pixels. The header can scroll inside
// itself on the smallest screens, so "visible" for what's in it means
// inside the header's own box as well as on screen.
async function measure(page) {
  return page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, height: b.height };
    };
    const pad = document.querySelector(".judge-layout");
    const header = document.querySelector(".judge-header");
    return {
      vh: window.innerHeight,
      overflow: pad.scrollHeight - pad.clientHeight,
      headerOverflow: header.scrollHeight - header.clientHeight,
      keys: [...document.querySelectorAll(".keypad .key")].map((k) => k.getBoundingClientRect().height),
      keypad: box(".keypad"),
      submit: box(".submit-btn"),
      signal: box(".signal-btn"),
      header: box(".judge-header"),
      diver: box(".diver-name"),
      code: box(".dive-pill.code"),
      alert: box(".judge-panel-alert"),
    };
  });
}

function onScreen(m, what, label) {
  const b = m[what];
  expect(b, `${label}: ${what} is there`).not.toBeNull();
  expect(b.top, `${label}: top of ${what}`).toBeGreaterThanOrEqual(-0.5);
  expect(b.bottom, `${label}: bottom of ${what}`).toBeLessThanOrEqual(m.vh + 0.5);
}

function inHeader(m, what, label) {
  onScreen(m, what, label);
  expect(m[what].top, `${label}: ${what} inside the header`).toBeGreaterThanOrEqual(m.header.top - 0.5);
  expect(m[what].bottom, `${label}: ${what} inside the header`).toBeLessThanOrEqual(m.header.bottom + 0.5);
}

test("the judge pad fits small iPhones, with a long dive and a flagged referee", async ({ browser, browserName, request, baseURL }) => {
  test.setTimeout(180_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Judge Pad Fit" });
  const { event, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Rehearsal Mixed 3m Springboard", diverNames: ["Liam O'Connor"],
  });
  const up = controlRoomPayload(event, divers[0]);
  expect(await emitAck(baseURL, adminToken, "set_active_diver", up)).toMatchObject({ ok: true });
  // Judge 2's phone, to flag the referee from.
  const j2 = await setup.openSocket(baseURL, judges[1].token);
  const flag = (signaled) => j2.emit("judge_signal", {
    event_id: event.id, competitor_id: divers[0].userId, round_number: 1, signaled,
  });

  try {
    for (const phone of PHONES) {
      const label = `${phone.name} (${browserName})`;
      const ctx = await browser.newContext({
        ...devices[phone.device],
        ...(phone.viewport ? { viewport: phone.viewport } : {}),
        // The server's CSP upgrades asset URLs to https, which WebKit
        // follows; the test server is plain http (see mobile-safari).
        bypassCSP: true,
      });
      const page = await ctx.newPage();
      await setup.bypassRoleTour(page);
      try {
        await signIn(page, judges[0].username);
        await page.goto(`/judge?event=${event.id}`);
        await expect(page.locator(".diver-name")).toContainText("Liam O'Connor", { timeout: 8_000 });
        await expect(page.locator(".judge-id")).toContainText("— J1", { timeout: 6_000 });
        await expect(page.locator(".dive-desc")).toContainText("Reverse");
        await shot(page, `judge-pad-${phone.device.replace(/\W+/g, "-")}-${phone.viewport?.height || "full"}-${browserName}`);

        const plain = await measure(page);
        const size = `${label} ${page.viewportSize().width}x${plain.vh}`;
        expect(Math.min(...plain.keys), `${size}: key height`).toBeGreaterThanOrEqual(48);
        // Submit and Signal Referee whole, without scrolling the pad.
        expect(plain.overflow, `${size}: the pad needs no scrolling`).toBeLessThanOrEqual(1);
        onScreen(plain, "submit", size);
        onScreen(plain, "signal", size);
        onScreen(plain, "keypad", size);
        // Who and what they're scoring stay in sight.
        inHeader(plain, "diver", size);
        inHeader(plain, "code", size);
        if (phone.whole) expect(plain.headerOverflow, `${size}: the header is whole`).toBeLessThanOrEqual(1);

        // Judge 2 flags the referee: the notice shows, nothing moves.
        flag(true);
        await expect(page.locator(".judge-panel-alert")).toContainText(/2/, { timeout: 6_000 });
        await expect(page.locator(".judge-panel-tile.signaled")).toHaveCount(1);
        const flagged = await measure(page);
        await shot(page, `judge-pad-${phone.device.replace(/\W+/g, "-")}-${phone.viewport?.height || "full"}-${browserName}-flagged`);
        expect(flagged.overflow, `${size} flagged: the pad needs no scrolling`).toBeLessThanOrEqual(1);
        onScreen(flagged, "submit", `${size} flagged`);
        onScreen(flagged, "signal", `${size} flagged`);
        inHeader(flagged, "alert", `${size} flagged`);
        if (phone.whole) expect(flagged.headerOverflow, `${size} flagged: the header is whole`).toBeLessThanOrEqual(1);
        expect(Math.abs(flagged.keypad.top - plain.keypad.top), `${size}: the keypad stays put`).toBeLessThanOrEqual(0.5);
        flag(false);
        await expect(page.locator(".judge-panel-alert")).toHaveCount(0, { timeout: 6_000 });
      } finally {
        await ctx.close();
      }
    }
  } finally {
    j2.disconnect();
    await setup.deleteOrg(orgId);
  }
});
