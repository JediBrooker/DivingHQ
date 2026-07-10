// Stream-overlay shapes: the presets, the part-picker, and the two rules that
// must never break.
//
//   1. ?overlay=1 / true / minimal are frozen. They are documented, they are
//      literal text in 26 locale files, and they are pasted into OBS scene
//      collections sitting on other people's machines.
//   2. Whatever an operator picks has to stay legible on chroma. A blanket
//      color:#fff over a plate that never applied has now hidden the judge
//      score chips twice. The sweep below composites every text node against
//      its real background and fails under a WCAG ratio of 3.0.
//
// The sweep runs on green and magenta, because the bug it catches is a
// plate that goes translucent and picks up the key colour.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// Every part key, and the DOM hook it owns. Mirrors src/lib/overlayParts.js.
// Kept as a literal rather than imported so a typo over there fails here.
const HOOK = {
  round:     ".sb-round-pill",
  diver:     ".sb-name",
  dive:      ".sb-badges",
  judges:    ".sb-live-judges",
  total:     ".sb-live-total-slot",
  rank:      ".sb-live-rank-slot",
  catchup:   ".sb-projection",
  upnext:    ".up-next",
  standings: ".sb-col-standings",
  history:   ".sb-col-history",
};
const ALL_PARTS = Object.keys(HOOK);

let world;

test.beforeAll(async ({ request, baseURL }) => {
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Overlay Parts Diving",
  });
  await setup.insertClub({ orgId, name: "Overlay Parts Club", shortCode: "OPC" });
  const event = await setup.createEvent(request, {
    adminToken, name: "Overlay Parts Meet", total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });

  const divers = [];
  for (const dn of ["Ada Parts", "Bo Parts", "Cy Parts", "Di Parts"]) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: dn });
    await setup.insertDiveList({
      eventId: event.id, competitorId: d.userId,
      dives: [{ round_number: 1, dive_id: diveId }, { round_number: 2, dive_id: diveId }],
    });
    divers.push(d);
  }
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `OP J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

  // Score a couple of divers so the history column, the standings and the
  // catch-up projection all have something real to render. An overlay with
  // empty panels would sail through a contrast sweep.
  for (const d of divers.slice(0, 3)) {
    await setup.submitPanelScores({
      baseURL, judges, eventId: event.id,
      competitorId: d.userId, roundNumber: 1, diveId,
    });
  }

  // Name diver 4 as the active one, in round 2, so the centre card is full:
  // name, country, dive code, DD, empty judge slots, total, rank.
  const sock = await setup.openSocket(baseURL, adminToken);
  const ack = await new Promise((res) => sock.emit("set_active_diver", {
    event_id: event.id, competitor_id: divers[3].userId,
    full_name: "Di Parts", diverName: "Di Parts", country_code: "AUS",
    round_number: 2, dive_id: diveId, diveCode: "101B", dd: 1.5,
    description: "Forward Dive Pike", status: "ready",
  }, res));
  expect(ack).toMatchObject({ ok: true });
  sock.close();

  world = { orgId, adminToken, event, divers, judges };
});

test.afterAll(async () => {
  if (world?.orgId) await setup.deleteOrg(world.orgId);
});

// Walk every leaf text node, composite its background up the ancestor chain,
// and return anything under a 3.0 contrast ratio.
async function lowContrast(page) {
  return page.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const over = (fg, bg) => {
      const a = fg.length > 3 ? fg[3] : 1;
      return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
    };
    const bgOf = (el) => {
      let node = el, acc = [255, 255, 255];
      const chain = [];
      while (node) { chain.push(node); node = node.parentElement; }
      for (const n of chain.reverse()) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.length >= 3 && (c.length < 4 || c[3] > 0)) acc = over(c, acc);
      }
      return acc;
    };
    const bad = [];
    document.querySelectorAll("*").forEach((el) => {
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === 3 && n.textContent.trim())
        .map((n) => n.textContent.trim()).join(" ");
      if (!text) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return;
      if (!el.getClientRects().length) return;
      const fg = over(parse(cs.color), bgOf(el.parentElement || el));
      const bg = bgOf(el);
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < 3.0) bad.push({ text: text.slice(0, 32), cls: el.className, ratio: +ratio.toFixed(2) });
    });
    return bad;
  });
}

const shown = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

// Put real scores in the live judge chips.
//
// It has to be done in the DOM rather than by scoring the fixture, because
// the chips are filled by score_received socket broadcasts and only for a
// page that was already watching when the score landed. A page the sweep
// opens afterwards shows five empty placeholders, and empty placeholders have
// no text, so the contrast sweep sails straight past them.
//
// That blind spot is why a blanket color:#fff painted the judge numbers white
// on their own white chips and shipped. Twice. So the sweep now builds the
// state it needs: three counted scores, one struck-through drop, the rest
// still empty, which is what a panel mid-vote looks like on air.
async function fillJudgeChips(page) {
  const filled = await page.evaluate(() => {
    const chips = [...document.querySelectorAll(".sb-live-judges .j-score")];
    if (!chips.length) return 0;
    const categories = ["j-excellent", "j-very-good", "j-good"];
    chips.forEach((el, i) => {
      if (i > 3) return; // leave the last slots empty, as a real panel would
      el.classList.remove("j-empty");
      el.classList.add(i === 3 ? "j-dropped" : categories[i]);
      if (i === 3) el.classList.add("j-good");
      el.textContent = ["8.5", "8.0", "7.5", "9.0"][i];
    });
    return chips.length;
  });
  return filled;
}

async function visibleParts(page) {
  const out = [];
  for (const key of ALL_PARTS) {
    if (await shown(page, HOOK[key])) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------
// The frozen shapes.
// ---------------------------------------------------------------

test("?overlay=1 still renders the whole board, unplated, all standings", async ({ page }) => {
  await page.goto(`/scoreboard/${world.event.id}?overlay=1`);
  await page.waitForTimeout(1200);

  const cls = await page.locator(".sb-layout").getAttribute("class");
  expect(cls).toContain("overlay-mode");
  expect(cls, "the legacy shape must not opt into the parts CSS").not.toContain("overlay-parts");
  expect(cls).not.toContain("overlay-minimal");

  expect(await visibleParts(page)).toEqual(ALL_PARTS);
  expect(await page.locator(".sb-header").isVisible()).toBe(false);
  // Unplated: the standings column keeps the page background, not an ink plate.
  const plate = await page.locator(".sb-col-standings")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(plate).toBe("rgba(0, 0, 0, 0)");
});

test("?overlay=minimal is unchanged: diver plus a top three", async ({ page }) => {
  await page.goto(`/scoreboard/${world.event.id}?overlay=minimal`);
  await page.waitForTimeout(1200);

  const cls = await page.locator(".sb-layout").getAttribute("class");
  expect(cls).toContain("overlay-minimal");
  expect(cls, "minimal is legacy, not a parts shape").not.toContain("overlay-parts");

  expect(await shown(page, ".sb-col-history")).toBe(false);
  expect(await shown(page, ".up-next")).toBe(false);
  expect(await shown(page, ".sb-projection")).toBe(false);
  expect(await shown(page, ".sb-col-standings")).toBe(true);

  const rows = await page.locator(".sb-col-standings .standing")
    .evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
  expect(rows, "minimal trims the podium to three").toBe(3);
});

test("an unknown overlay value renders the ordinary scoreboard, chrome and all", async ({ page }) => {
  await page.goto(`/scoreboard/${world.event.id}?overlay=bogus`);
  await page.waitForTimeout(1200);

  const cls = await page.locator(".sb-layout").getAttribute("class");
  expect(cls).not.toContain("overlay-mode");
  expect(await page.locator(".sb-header").isVisible()).toBe(true);
  const bg = await page.locator(".sb-layout").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg, "no chroma key for a URL we do not understand").toBe("rgba(0, 0, 0, 0)");
});

// ---------------------------------------------------------------
// The new shapes.
// ---------------------------------------------------------------

const SHAPES = [
  { name: "detailed preset", url: "overlay=detailed", expect: ALL_PARTS },
  { name: "diver preset", url: "overlay=diver", expect: ["round", "diver", "dive"] },
  { name: "judges preset", url: "overlay=judges", expect: ["judges"] },
  { name: "custom: judges + standings", url: "overlay=custom&parts=judges,standings", expect: ["judges", "standings"] },
  { name: "custom: standings only (no centre card)", url: "overlay=custom&parts=standings", expect: ["standings"] },
  { name: "custom: history only (no centre card)", url: "overlay=custom&parts=history", expect: ["history"] },
  { name: "custom: everything", url: `overlay=custom&parts=${ALL_PARTS.join(",")}`, expect: ALL_PARTS },
  { name: "custom: junk falls back", url: "overlay=custom&parts=drop-table", expect: ["round", "diver", "dive", "judges"] },
  { name: "custom: empty falls back", url: "overlay=custom&parts=", expect: ["round", "diver", "dive", "judges"] },
];

for (const shape of SHAPES) {
  test(`${shape.name} shows exactly the parts it was asked for`, async ({ page }) => {
    await page.goto(`/scoreboard/${world.event.id}?${shape.url}`);
    await page.waitForTimeout(1200);

    expect(await page.locator(".sb-layout").getAttribute("class")).toContain("overlay-parts");
    expect(await visibleParts(page)).toEqual(shape.expect.filter((p) => ALL_PARTS.includes(p)));

    // An overlay with no centre parts must not leave an empty ink plate
    // floating in the frame.
    const centreWanted = shape.expect.some((p) => !["standings", "history"].includes(p));
    expect(await shown(page, ".active-centre")).toBe(centreWanted);
  });
}

// ---------------------------------------------------------------
// Legibility, on every shape, against two chroma colours.
// ---------------------------------------------------------------

const SWEEP_SHAPES = [
  "overlay=minimal",
  "overlay=detailed",
  "overlay=diver",
  "overlay=judges",
  "overlay=custom&parts=judges,standings",
  "overlay=custom&parts=standings",
  `overlay=custom&parts=${ALL_PARTS.join(",")}`,
];

for (const bg of ["", "&bg=ff00ff"]) {
  for (const shape of SWEEP_SHAPES) {
    const label = `${shape}${bg || " (default green)"}`;
    test(`every text node stays legible: ${label}`, async ({ page }) => {
      await page.goto(`/scoreboard/${world.event.id}?${shape}${bg}`);
      await page.waitForTimeout(1000);
      await fillJudgeChips(page);
      const bad = await lowContrast(page);
      expect(bad, `low-contrast text: ${JSON.stringify(bad, null, 1)}`).toEqual([]);
    });
  }
}

// ---------------------------------------------------------------
// The trap that made this a shared module.
// ---------------------------------------------------------------

test("a signed-in operator previewing a new overlay shape gets no app chrome over it", async ({ page, request }) => {
  const { orgId, username } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Overlay Chrome Diving",
  });
  await setup.insertClub({ orgId, name: "Overlay Chrome Club", shortCode: "OCC" });
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });

  // The Preview button in the Broadcast panel opens exactly this, logged in.
  // App.vue decides whether to draw the sidebar; before the shared resolver it
  // only recognised '1', 'true' and 'minimal', so any new shape rendered the
  // whole CRM on top of the chroma key.
  for (const shape of ["overlay=judges", "overlay=detailed", "overlay=custom&parts=judges"]) {
    await page.goto(`/scoreboard/${world.event.id}?${shape}`);
    await page.waitForTimeout(900);
    expect(await page.locator(".sb-user").isVisible().catch(() => false),
      `${shape} must not render the app shell`).toBe(false);
    expect(await page.locator(".sb-layout").getAttribute("class")).toContain("overlay-mode");
  }

  // And the shell still appears where it should.
  await page.goto(`/scoreboard/${world.event.id}`);
  await page.waitForTimeout(900);
  expect(await page.locator(".sb-user").isVisible()).toBe(true);

  await setup.deleteOrg(orgId);
});
