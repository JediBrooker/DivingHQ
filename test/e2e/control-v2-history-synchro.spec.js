// Synchro History: a synchro_pair event's per-judge History chips group
// into Exec A / Exec B / Sync by panel position, flag-on only (V2 surface).
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

test("synchro History groups judge scores into Exec A / Exec B / Sync", async ({ request, page }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Synchro History Diving" });
  await setup.insertClub({ orgId, name: "SH Club", shortCode: "SHC" });

  // a 7-judge synchro event with a scored round-1 dive
  const event = await setup.createEvent(request, {
    adminToken, name: "Mixed 3m Synchro — Final", height: "3m",
    number_of_judges: 7, total_rounds: 1, event_type: "synchro_pair",
  });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Pair Lead" });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  await setup.insertDiveList({ eventId: event.id, competitorId: diver.userId, dives: [{ round_number: 1, dive_id: diveId }] });

  // 7 judges on the panel (judge_number 1..7 drives Exec/Sync grouping),
  // each with a score for the round-1 dive. Direct insert since the
  // synchro pair scoring rules aren't what's under test here.
  const judgeScores = [8.0, 8.0, 7.5, 8.0, 9.0, 9.0, 9.0];
  for (let i = 0; i < 7; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `SH Judge ${i + 1}` });
    await setup.pool.query(
      "INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)",
      [event.id, j.userId, i + 1],
    );
    await setup.pool.query(
      "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, 1, $5)",
      [event.id, diver.userId, j.userId, diveId, judgeScores[i]],
    );
  }
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Mixed 3m Synchro");

  const hcard = page.locator(".cv2-hcard", { hasText: "Pair Lead" }).first();
  await expect(hcard).toBeVisible({ timeout: 8_000 });
  // three labelled clusters, Sync carries 3 of the 7 chips (5,6,7)
  await expect(hcard.locator(".judge-group")).toHaveCount(3);
  await expect(hcard.locator(".judge-group-a .judge-group-label")).toHaveText("Exec A");
  await expect(hcard.locator(".judge-group-b .judge-group-label")).toHaveText("Exec B");
  await expect(hcard.locator(".judge-group-sync .judge-group-label")).toHaveText("Sync");
  await expect(hcard.locator(".judge-group-a .j-score")).toHaveCount(2);
  await expect(hcard.locator(".judge-group-b .j-score")).toHaveCount(2);
  await expect(hcard.locator(".judge-group-sync .j-score")).toHaveCount(3);
});
