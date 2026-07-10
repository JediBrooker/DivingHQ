// The Broadcast panel's overlay picker.
//
// The picker's only job is to produce a URL. A Browser Source runs on a
// different machine, in a different browser, with no session, so the URL is
// the entire configuration channel. Whatever the wireframe shows has to be
// what lands in that input box.
//
// Drives the real path an operator takes: Tools → Broadcast → Open broadcast
// chooser → Stream to OBS.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

let world;

async function openObsPanel(page, eventName) {
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, eventName);
  await page.getByRole("button", { name: "Tools" }).click();
  await page.locator(".cv2-drawer-row", { hasText: "Broadcast" }).click();
  await page.locator(".cv2-drawer-action", { hasText: "Open broadcast chooser" }).click();
  await page.locator(".broadcast-option", { hasText: /Stream to OBS/i }).click();
  await expect(page.locator(".opp")).toBeVisible({ timeout: 10_000 });
}

const url = (page) => page.locator(".obs-url-input").inputValue();
const preset = (page, label) => page.locator(".opp-preset", { hasText: new RegExp(`^${label}$`, "i") });

test.beforeAll(async ({ request }) => {
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Picker Diving",
  });
  await setup.insertClub({ orgId, name: "Picker Club", shortCode: "PKC" });
  const event = await setup.createEvent(request, {
    adminToken, name: "Picker Meet", total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const d = await setup.insertUser({ orgId, role: "diver", fullName: "Pick Diver" });
  await setup.insertDiveList({
    eventId: event.id, competitorId: d.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  world = { orgId, username, event };
});

test.afterAll(async () => {
  if (world?.orgId) await setup.deleteOrg(world.orgId);
});

test.beforeEach(async ({ page }) => {
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(world.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
});

test("defaults to the full board, which is the URL this panel always produced", async ({ page }) => {
  await openObsPanel(page, "Picker Meet");
  expect(await url(page)).toBe(`${new URL(page.url()).origin}/scoreboard/${world.event.id}?overlay=1`);
  await expect(preset(page, "Full board")).toHaveClass(/opp-preset-on/);

  // The two frozen shapes are drawn, not editable. Assert on the inputs: a
  // disabled fieldset disables its controls, which is the bit that matters.
  await expect(page.locator(".opp-check input").first()).toBeDisabled();
});

test("presets write themselves into the URL", async ({ page }) => {
  await openObsPanel(page, "Picker Meet");
  const origin = new URL(page.url()).origin;

  for (const [label, expected] of [
    ["Lower third", "overlay=minimal"],
    ["Detailed", "overlay=detailed"],
    ["Diver only", "overlay=diver"],
    ["Judges only", "overlay=judges"],
  ]) {
    await preset(page, label).click();
    expect(await url(page), `${label} -> ${expected}`)
      .toBe(`${origin}/scoreboard/${world.event.id}?${expected}`);
  }
});

test("the wireframe lights up the blocks a preset actually shows", async ({ page }) => {
  await openObsPanel(page, "Picker Meet");

  await preset(page, "Judges only").click();
  const litFor = () => page.locator(".opp-wire .wf-on").count();
  // Judges is one block drawn as five chips.
  expect(await litFor()).toBe(5);

  await preset(page, "Diver only").click();
  expect(await litFor()).toBe(3); // round, diver, dive

  await preset(page, "Full board").click();
  expect(await litFor()).toBe(14); // 9 single blocks + 5 judge chips
});

test("custom mode: checkboxes and wireframe drive the same selection and the same URL", async ({ page }) => {
  await openObsPanel(page, "Picker Meet");
  const origin = new URL(page.url()).origin;

  // Stepping into Custom carries the shape you were looking at.
  await preset(page, "Judges only").click();
  await preset(page, "Custom").click();
  await expect(page.locator(".opp-check input").first()).toBeEnabled();
  expect(await url(page)).toBe(`${origin}/scoreboard/${world.event.id}?overlay=custom&parts=judges`);

  // Tick standings via the checkbox list.
  await page.locator(".opp-check", { hasText: "Standings" }).locator("input").check();
  expect(await url(page)).toBe(
    `${origin}/scoreboard/${world.event.id}?overlay=custom&parts=judges%2Cstandings`,
  );

  // And add completed dives by clicking the wireframe block. Same selection.
  await page.locator(".opp-wire rect").first().click();
  expect(await url(page)).toContain("parts=judges%2Cstandings%2Chistory");
  await expect(page.locator(".opp-check", { hasText: "Completed dives" }).locator("input")).toBeChecked();

  // Order is canonical, not click order, so the URL is stable across sessions.
  await page.locator(".opp-check", { hasText: "Round" }).locator("input").check();
  expect(await url(page)).toContain("parts=round%2Cjudges%2Cstandings%2Chistory");
});

test("clearing every block blocks Copy rather than handing OBS a blank frame", async ({ page }) => {
  await openObsPanel(page, "Picker Meet");

  await preset(page, "Custom").click();
  await page.locator(".opp-linkbtn", { hasText: "Clear" }).click();

  await expect(page.locator(".opp-warn")).toBeVisible();
  await expect(page.locator(".obs-url-copy")).toBeDisabled();
  await expect(page.locator(".broadcast-picker-actions .btn-primary")).toHaveClass(/disabled/);

  await page.locator(".opp-linkbtn", { hasText: "Select all" }).click();
  await expect(page.locator(".opp-warn")).toHaveCount(0);
  await expect(page.locator(".obs-url-copy")).toBeEnabled();
  expect(await url(page)).toContain("parts=round%2Cdiver%2Cdive%2Cjudges%2Ctotal%2Crank%2Ccatchup%2Cupnext%2Cstandings%2Chistory");
});

test("the URL the picker emits actually renders that shape", async ({ page, context }) => {
  await openObsPanel(page, "Picker Meet");
  await preset(page, "Custom").click();
  await page.locator(".opp-linkbtn", { hasText: "Clear" }).click();
  await page.locator(".opp-check", { hasText: "Judge scores" }).locator("input").check();
  await page.locator(".opp-check", { hasText: "Standings" }).locator("input").check();
  const composed = await url(page);

  // Open it the way OBS would: a fresh, anonymous context.
  const anon = await context.browser().newContext();
  const source = await anon.newPage();
  await source.goto(composed);
  await source.waitForTimeout(1200);

  expect(await source.locator(".sb-live-judges").isVisible()).toBe(true);
  expect(await source.locator(".sb-col-standings").isVisible()).toBe(true);
  expect(await source.locator(".sb-col-history").isVisible()).toBe(false);
  expect(await source.locator(".sb-name").isVisible()).toBe(false);
  expect(await source.locator(".sb-user").isVisible().catch(() => false),
    "no app chrome on a broadcast source").toBe(false);

  await anon.close();
});
