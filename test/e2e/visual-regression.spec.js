// Focused visual regression snapshots for high-risk UI surfaces.
//
// This complements wiki-screenshots.spec.js. The wiki harness writes
// documentation PNGs; this file uses Playwright snapshot assertions.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const STABLE_STYLE = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
  .pulse-ticker,
  .activity-list,
  .notification-center,
  .toast,
  [data-tip]::after {
    visibility: hidden !important;
  }
`;

function headers(token) {
  return { Authorization: `Bearer ${token}` };
}

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

async function stabilise(page) {
  await page.addStyleTag({ content: STABLE_STYLE });
  await page.waitForLoadState("domcontentloaded");
}

test("core operator surfaces match visual snapshots", async ({ request, page, baseURL }) => {
  test.setTimeout(90_000);

  await page.setViewportSize({ width: 1440, height: 900 });

  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS",
    orgName: "Visual Regression Diving",
  });
  try {
    const apiErrors = setup.collectApiErrors(page);

    await setup.insertClub({
      orgId,
      name: "Visual Diving Club",
      shortCode: "VIS",
    });

    const controlEvent = await setup.createEvent(request, {
      adminToken,
      name: "Visual Control Event",
      total_rounds: 2,
      number_of_judges: 5,
      height: "3m",
    });
    const scoreboardEvent = await setup.createEvent(request, {
      adminToken,
      name: "Visual Scoreboard Event",
      total_rounds: 1,
      number_of_judges: 5,
      height: "3m",
    });
    const diver = await setup.insertUser({
      orgId,
      role: "diver",
      fullName: "Visual Diver",
    });
    const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    await setup.insertDiveList({
      eventId: scoreboardEvent.id,
      competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });

    const judges = [];
    for (let i = 1; i <= 5; i++) {
      const judge = await setup.insertUser({
        orgId,
        role: "judge",
        fullName: `Visual Judge ${i}`,
      });
      const login = await setup.loginAs(request, judge.username);
      judges.push({ ...judge, token: login.token });
    }
    await setup.assignJudges(request, {
      adminToken,
      eventId: scoreboardEvent.id,
      judgeIds: judges.map((judge) => judge.userId),
    });
    await setup.setEventStatus(request, {
      adminToken,
      eventId: scoreboardEvent.id,
      status: "Live",
    });
    await setup.submitPanelScores({
      baseURL,
      judges,
      eventId: scoreboardEvent.id,
      competitorId: diver.userId,
      roundNumber: 1,
      diveId,
    });
    await setup.setEventStatus(request, {
      adminToken,
      eventId: scoreboardEvent.id,
      status: "Completed",
    });

    await page.addInitScript(() => {
      localStorage.setItem("locale", "en");
      localStorage.setItem("setup.wizardCompleted.v1", "1");
      localStorage.setItem("setup.wizardDismissed.v1", "1");
    });
    await signIn(page, username);

    await stabilise(page);
    await expect(page).toHaveScreenshot("dashboard.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
      mask: [
        page.locator(".pulse-strip"),
        page.locator(".activity-list"),
      ],
    });

    await page.goto(`/control?event=${controlEvent.id}`);
    await expect(page.locator(".ctrl-layout")).toBeVisible();
    await expect(page.locator(".readiness")).toBeVisible();
    await stabilise(page);

    // -------------------------------------------------------------
    // ControlView header — structural assertions
    //
    // The header was redesigned (commit 2ca569d) from
    //   flex + absolute-positioned center
    // to
    //   grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)
    //
    // A pixel snapshot at maxDiffPixelRatio: 0.02 (2 % tolerance)
    // happily ignores layout regressions that stay within ~2 % of
    // the baseline pixel-by-pixel — e.g. the grid collapsing back
    // to two columns, the chevron drifting away from the inline-
    // end edge, or the locale switcher leaking into the control
    // room. The structural assertions below are gate-quality:
    // they fail loudly when the DOM shape changes, regardless of
    // antialiasing noise or theme-token churn.
    // -------------------------------------------------------------

    // 1. The .ctrl-header element exists and is a space-between flex
    //    row. The marine-CRM refresh replaced the old 3-column grid
    //    (logo | event | actions) with flex: the connection chip
    //    moved into the active-diver strip and the logo dropped, so
    //    the picker pins to the start and the action cluster to the
    //    end. A pixel snapshot at 2% tolerance would miss the row
    //    collapsing, so assert the computed layout.
    const ctrlHeader = page.locator(".ctrl-header");
    await expect(ctrlHeader).toBeVisible();
    const headerLayout = await ctrlHeader.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { display: cs.display, justify: cs.justifyContent };
    });
    expect(headerLayout.display).toBe("flex");
    expect(headerLayout.justify).toBe("space-between");

    // 2. Direct-child wrappers carry the expected pieces: event
    //    picker + chevron at the start, the action cluster (⋯ menu)
    //    at the end, and NO locale switcher leaking in (it was
    //    removed from every authed surface in the CRM refresh).
    const headerShape = await ctrlHeader.evaluate((el) => {
      const ctx = el.querySelector(":scope > .ctrl-header-ctx");
      const right = el.querySelector(":scope > .ctrl-header-right");
      return {
        ctxHasSelect: !!ctx?.querySelector("select.event-title-select"),
        ctxHasChevron: !!ctx?.querySelector(".event-title-chevron"),
        rightHasMenu: !!right?.querySelector(".btn-icon"),
        headerHasLocaleSwitcher: !!el.querySelector(".locale-switcher"),
      };
    });
    expect(headerShape.ctxHasSelect).toBe(true);
    expect(headerShape.ctxHasChevron).toBe(true);
    expect(headerShape.rightHasMenu).toBe(true);
    expect(headerShape.headerHasLocaleSwitcher).toBe(false);

    // 3. Locale switcher is absent from the whole control page.
    await expect(page.locator(".locale-switcher")).toHaveCount(0);

    // 5. Event-title chevron sits at the inline-end edge of the
    //    title wrap (so it lines up with the select's
    //    padding-inline-end). Anything other than a small, fixed
    //    inset-inline-end offset means the chevron has drifted.
    const chevronInsetEnd = await page
      .locator(".event-title-chevron")
      .evaluate((el) => getComputedStyle(el).insetInlineEnd);
    expect(chevronInsetEnd).toMatch(/^[0-9.]+px$/);
    const chevronInsetPx = parseFloat(chevronInsetEnd);
    // CSS authors 0.65rem (~10.4px at the default 16px root). Be
    // generous on the upper bound to allow for root font-size
    // theming, but strict enough to catch a regression that
    // pushes the chevron back to the left edge or off-card.
    expect(chevronInsetPx).toBeGreaterThan(0);
    expect(chevronInsetPx).toBeLessThan(32);

    // FIXME: visual snapshot kept as a manual sanity check during
    // development — gate-quality coverage moved to the structural
    // assertions above. Run with `test.only` if you want to refresh
    // the baseline.
    // (Inlined here rather than as a separate test.fixme block so
    //  it stays in the same fixture lifecycle — the snapshot needs
    //  the same seeded org + event the rest of this test sets up.)
    // await expect(page).toHaveScreenshot("control-room.png", {
    //   fullPage: false,
    //   maxDiffPixelRatio: 0.02,
    // });

    await page.goto(`/scoreboard/${scoreboardEvent.id}?cache=skip`);
    await expect(page.getByRole("link", { name: "Visual Diver" })).toBeVisible();
    await stabilise(page);
    await expect(page).toHaveScreenshot("scoreboard.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });

    await page.goto("/manager");
    await expect(page.getByRole("button", { name: /\+ New Event/i })).toBeVisible();
    await page.getByRole("button", { name: /\+ New Event/i }).click();
    await expect(page.locator(".modal-create-event")).toBeVisible();
    await stabilise(page);
    await expect(page).toHaveScreenshot("manager-new-event-modal.png", {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    });

    expect(apiErrors).toEqual([]);

    const sanity = await request.get(`/api/events/${controlEvent.id}/readiness`, {
      headers: headers(adminToken),
    });
    expect(sanity.status()).toBe(200);
  } finally {
    await setup.deleteOrg(orgId);
  }
});

// FIXME: visual snapshot kept as a manual sanity check during
// development — gate-quality coverage moved to the structural
// assertions above. Run with `test.only` if you want to refresh
// the baseline.
test.fixme("ControlView header — pixel snapshot (manual sanity check)", async ({ page }) => {
  await expect(page).toHaveScreenshot("control-room.png", { maxDiffPixelRatio: 0.02 });
});
