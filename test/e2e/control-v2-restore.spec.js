// P0 regression: reopening the Control Room mid-meet must RESTORE the
// event's live diver, not reset it. ControlViewV2 used to blindly emit
// set_active_diver for roster[0] on mount for EVERY Live event -- so
// merely reloading (or a second operator opening the room) yanked the
// judges' panel back to diver 1, round 1, corrupting a meet in progress.
// The fix seeds each pool from the server's AUTHORITATIVE active diver
// (get_active_diver / state_update) and only announces roster[0] when the
// server has no diver at all. Flag-on only (V2 surface).
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

async function liveEvent(request, { orgId, adminToken, name, diverNames }) {
  const event = await setup.createEvent(request, {
    adminToken, name, total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const divers = [];
  for (const dn of diverNames) {
    const diver = await setup.insertUser({ orgId, role: "diver", fullName: dn });
    await setup.insertDiveList({
      eventId: event.id, competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });
    divers.push(diver);
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

test("reloading mid-meet restores the live diver instead of resetting to diver 1", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Restore Diving",
  });
  await setup.insertClub({ orgId, name: "RS Club", shortCode: "RSC" });
  const { event, diveId, divers, judges } = await liveEvent(request, {
    orgId, adminToken, name: "Restore Meet", diverNames: ["AAA Diver", "ZZZ Diver"],
  });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Restore Meet");

  // Fresh event -> the first dive is up.
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Diver");

  // Drive the meet forward: full panel for AAA arms the primary, then
  // advancing makes ZZZ the live diver -- which emits set_active_diver,
  // so the server's authoritative active diver is now ZZZ (round 1, #2).
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id,
    competitorId: divers[0].userId, roundNumber: 1, diveId,
  });
  await expect(page.locator(".cv2-primary")).toBeEnabled({ timeout: 6_000 });
  await page.locator(".cv2-primary").click();
  await expect(page.locator(".cv2-live-diver")).toContainText("ZZZ Diver");

  // Reopen the Control Room from scratch (simulates reload / a second
  // operator window). Pre-fix this re-announced roster[0] (AAA) and reset
  // the judges; post-fix it must restore the server's live diver (ZZZ).
  await page.reload();
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Restore Meet");

  await expect(page.locator(".cv2-live-diver")).toContainText("ZZZ Diver");
  // And it must STAY on ZZZ -- prove no late roster[0] announce snaps it
  // back after the seed grace window elapses.
  await page.waitForTimeout(2_500);
  await expect(page.locator(".cv2-live-diver")).toContainText("ZZZ Diver");
});
