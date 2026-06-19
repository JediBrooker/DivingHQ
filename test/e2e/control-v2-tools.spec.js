// Meet-day tools (#9) on the V2 board: per-card referee actions, score
// correction from the focused History column, and announce from the
// Standings column. Flag-on only (V2 surface).
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

async function liveEvent(request, { orgId, adminToken, name }) {
  const event = await setup.createEvent(request, {
    adminToken, name, total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const divers = [];
  for (const dn of ["AAA Diver", "ZZZ Diver"]) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: dn });
    await setup.insertDiveList({ eventId: event.id, competitorId: d.userId, dives: [{ round_number: 1, dive_id: diveId }] });
    divers.push(d);
  }
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `${name} J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  return { event, diveId, divers, judges };
}

test("per-card referee actions render and fire without error", async ({ request, page }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Tools Ref" });
  await setup.insertClub({ orgId, name: "TR Club", shortCode: "TRC" });
  await liveEvent(request, { orgId, adminToken, name: "Ref Event" });

  const errors = setup.collectApiErrors(page);
  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Ref Event");

  // The three referee calls render on the live card.
  await expect(page.locator(".cv2-ref-btn")).toHaveCount(3);
  // Firing one emits to the server without throwing on the client.
  await page.locator(".cv2-ref-failed").click();
  await page.waitForTimeout(500);
  await expect(page.locator(".cv2-ref-btn")).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("score correction opens from a completed History dive and saves", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Tools Correct" });
  await setup.insertClub({ orgId, name: "TC Club", shortCode: "TCC" });
  const { event, diveId, divers, judges } = await liveEvent(request, { orgId, adminToken, name: "Correct Event" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Correct Event");

  // Complete AAA's dive -> it lands in the History column as a clickable card.
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId,
  });
  const histCard = page.locator(".cv2-hcard.is-clickable", { hasText: "AAA Diver" });
  await expect(histCard).toBeVisible({ timeout: 8_000 });

  // Open the amend modal, change J1's score, save -> modal closes.
  await histCard.click();
  await expect(page.getByText("Amend Score")).toBeVisible();
  await page.locator(".lb-body .input[type=number]").fill("6.0");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByText("Amend Score")).toHaveCount(0, { timeout: 6_000 });
});

test("announce pushes the focused pool's standings and toasts", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Tools Announce" });
  await setup.insertClub({ orgId, name: "TA Club", shortCode: "TAC" });
  const { event, diveId, divers, judges } = await liveEvent(request, { orgId, adminToken, name: "Announce Event" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Announce Event");

  // A scored dive populates standings -> Announce enables.
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id, competitorId: divers[0].userId, roundNumber: 1, diveId,
  });
  const announce = page.locator(".cv2-announce");
  await expect(announce).toBeEnabled({ timeout: 8_000 });
  await announce.click();
  await expect(page.locator(".notify-bar")).toContainText(/Announced/i, { timeout: 6_000 });
});
