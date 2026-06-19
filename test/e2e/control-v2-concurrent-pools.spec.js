// P5: concurrent multi-pool Live. Flag-on only (V2). Two events in one
// org both Live; a full panel of scores for the NON-focused pool routes
// to THAT pool and fills its tiles, WITHOUT moving the operator's center
// focus -- the property V1 cannot give (it drops non-focused scores at
// ControlView.vue:2094-2095). Selecting the other pool then shows its
// already-filled tiles (state was kept, not rebuilt -> no focus thrash).
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });
test.beforeEach(() => {
  test.skip(process.env.VITE_CONTROL_V2_ENABLED !== "1", "V2 flag off; concurrent pools are a V2-only surface");
});

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

  // The rail shows both Live pools.
  await expect(page.locator(".stage-row")).toHaveCount(2);

  // Focus Pool A; its tiles start empty.
  await page.locator(".stage-row", { hasText: "Pool A" }).click();
  await expect(page.locator(".cv2-stage-title")).toHaveText("Pool A");
  await expect(page.locator(".cv2-tile.scored")).toHaveCount(0);

  // Inject a full 5-judge panel for Pool B (the NON-focused pool).
  await setup.submitPanelScores({
    baseURL, judges: B.judges, eventId: B.event.id,
    competitorId: B.diver.userId, roundNumber: 1, diveId: B.diveId,
  });
  // Let the score_received broadcasts arrive + route.
  await page.waitForTimeout(1500);

  // Center STILL on Pool A (no focus thrash); Pool A's tiles untouched.
  await expect(page.locator(".cv2-stage-title")).toHaveText("Pool A");
  await expect(page.locator(".cv2-tile.scored")).toHaveCount(0);

  // Select Pool B -> its tiles are ALREADY filled (state kept while
  // non-focused, not rebuilt on select).
  await page.locator(".stage-row", { hasText: "Pool B" }).click();
  await expect(page.locator(".cv2-stage-title")).toHaveText("Pool B");
  await expect(page.locator(".cv2-tile.scored")).toHaveCount(5);
});
