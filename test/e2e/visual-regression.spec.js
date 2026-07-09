// Focused visual regression snapshots for high-risk UI surfaces.
//
// This complements wiki-screenshots.spec.js: the wiki harness writes
// documentation PNGs, this file uses Playwright snapshot assertions.

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

    // Seeded so the dashboard renders the same event set the baselines
    // were captured with (the Control Room itself is no longer snapshotted
    // here, see the control-v2-*.spec.js suite).
    await setup.createEvent(request, {
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

    // (The Control Room is covered by the control-v2-*.spec.js suite now,
    // not a visual snapshot, since its DOM is intentionally fluid.)

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
  } finally {
    await setup.deleteOrg(orgId);
  }
});
