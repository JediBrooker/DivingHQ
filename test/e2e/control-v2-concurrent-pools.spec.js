// P5: concurrent multi-pool Live. Flag-on only (V2). Two events in one
// org both Live render as side-by-side pool cards. A full panel of scores
// for the NON-focused pool fills THAT card's tiles while it stays on
// screen -- the property V1 cannot give (it drops non-focused scores at
// ControlView.vue:2094-2095). Each card is scoped by [data-event-id], so
// a score lands only in its own pool and never bleeds into the other.
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

// A Live event with one rostered diver (round-1 dive list) + a full
// 5-judge panel assigned, flipped Live.
async function liveEvent(request, { orgId, adminToken, name }) {
  const event = await setup.createEvent(request, {
    adminToken, name, total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: `${name} Diver` });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  await setup.insertDiveList({
    eventId: event.id, competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `${name} J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  return { event, diver, diveId, judges };
}

test("a non-focused Live pool's scores route to it without thrashing the focused pool", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Concurrent Pools Diving",
  });
  await setup.insertClub({ orgId, name: "CP Club", shortCode: "CPC" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Pool A" });
  const B = await liveEvent(request, { orgId, adminToken, name: "Pool B" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");

  // The top bar shows both Live pools as chips.
  await expect(page.locator(".cv2-chip")).toHaveCount(2);

  // Focus Pool A; BOTH pools render as cards, side by side.
  await setup.selectControlEvent(page, "Pool A");
  await expect(page.locator(".cv2-chip.is-focused")).toContainText("Pool A");
  await expect(page.locator(".cv2-pool")).toHaveCount(2);
  const cardA = page.locator(`.cv2-pool[data-event-id="${A.event.id}"]`);
  const cardB = page.locator(`.cv2-pool[data-event-id="${B.event.id}"]`);
  await expect(cardA.locator(".cv2-tile.scored")).toHaveCount(0);
  await expect(cardB.locator(".cv2-tile.scored")).toHaveCount(0);

  // Inject a full 5-judge panel for Pool B (the NON-focused pool).
  await setup.submitPanelScores({
    baseURL, judges: B.judges, eventId: B.event.id,
    competitorId: B.diver.userId, roundNumber: 1, diveId: B.diveId,
  });

  // Pool B's card fills IN PLACE -- no focus thrash, no bleed into A.
  await expect(cardB.locator(".cv2-tile.scored")).toHaveCount(5, { timeout: 6_000 });
  await expect(page.locator(".cv2-chip.is-focused")).toContainText("Pool A");
  await expect(cardA.locator(".cv2-tile.scored")).toHaveCount(0);

  // Focusing Pool B keeps its filled tiles (state kept, not rebuilt).
  await setup.selectControlEvent(page, "Pool B");
  await expect(page.locator(".cv2-chip.is-focused")).toContainText("Pool B");
  await expect(cardB.locator(".cv2-tile.scored")).toHaveCount(5);
});
