// Control Room History follows the host-org score rule: only the meet
// managers of whoever hosts the meet can amend a score (scoreAuthority in
// lib/middleware.js, reported per event as can_change_scores on
// /api/events). At a club's meet the federation's org admin still sees
// the History column, read-only, while a meet manager who belongs to the
// club gets the amend dialog.
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

test("a club's meet: History is read-only for the federation, amendable for the club", async ({ request, page, context }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Score Authority Diving",
  });
  try {
    const { clubId } = await setup.insertClub({ orgId, name: "Harbour Divers", shortCode: "HBD" });
    const meetId = (await setup.pool.query(
      "INSERT INTO meets (org_id, name, host_club_id) VALUES ($1, 'Harbour club night', $2) RETURNING id",
      [orgId, clubId],
    )).rows[0].id;
    const event = await setup.createEvent(request, {
      adminToken, name: "Harbour Night 3m", total_rounds: 1, number_of_judges: 3, meet_id: meetId,
    });
    const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Harbour Diver", clubId });
    const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    await setup.insertDiveList({ eventId: event.id, competitorId: diver.userId, dives: [{ round_number: 1, dive_id: diveId }] });
    for (let i = 0; i < 3; i++) {
      const j = await setup.insertUser({ orgId, role: "judge", fullName: `Harbour Judge ${i + 1}` });
      await setup.pool.query("INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)", [event.id, j.userId, i + 1]);
      await setup.pool.query(
        "INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score) VALUES ($1, $2, $3, $4, 1, 7)",
        [event.id, diver.userId, j.userId, diveId],
      );
    }
    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

    // The federation's org admin created the event, but it's the club's meet.
    await signIn(page, username);
    await page.goto(`/control?event=${event.id}`);
    const card = page.locator(".cv2-hcard", { hasText: "Harbour Diver" }).first();
    await expect(card).toBeVisible({ timeout: 8_000 });
    await expect(page.locator(".cv2-side-note")).toContainText("Read-only");
    await expect(page.locator(".cv2-hcard.is-clickable")).toHaveCount(0);
    await card.click();
    await expect(page.locator(".lb-body")).toHaveCount(0);

    // A meet manager who belongs to the club can amend it.
    await context.clearCookies();
    const clubManager = await setup.insertUser({ orgId, role: "meet_manager", fullName: "Harbour Manager", clubId });
    await signIn(page, clubManager.username);
    await page.goto(`/control?event=${event.id}`);
    const amendable = page.locator(".cv2-hcard.is-clickable", { hasText: "Harbour Diver" }).first();
    await expect(amendable).toBeVisible({ timeout: 8_000 });
    await expect(page.locator(".cv2-side-note")).toHaveCount(0);
    await amendable.click();
    await expect(page.locator(".lb-body .input[type=number]")).toBeVisible();
  } finally {
    await setup.deleteOrg(orgId);
  }
});
