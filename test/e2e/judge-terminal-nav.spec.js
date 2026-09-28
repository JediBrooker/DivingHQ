// The side nav's "Judge Terminal" link (and the guide's judge card) open
// /judge with no ?event=. The keypad used to lean on the server replaying
// every event's live diver to each new socket. That replay now only
// covers events the user judges or drives (it leaked other orgs' events
// and yanked keypads to the wrong diver), and it never joined a room, so
// the next diver didn't arrive. JudgeView finds the judge's own Live
// panel itself and moves to ?event=, which joins it.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test("Judge Terminal with no ?event= picks up the judge's Live panel", async ({ request, page, baseURL }) => {
  test.setTimeout(90_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Nav Judge Diving",
  });
  await setup.insertClub({ orgId, name: "Nav Judge Club", shortCode: "NJC" });
  const event = await setup.createEvent(request, {
    adminToken, name: "Nav Judge Meet", total_rounds: 1, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Navvy Diver" });
  await setup.insertDiveList({
    eventId: event.id, competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    judges.push(await setup.insertUser({ orgId, role: "judge", fullName: `Nav J${i}` }));
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

  const adminSocket = await setup.openSocket(baseURL, adminToken);
  adminSocket.emit("subscribe_event", { event_id: event.id });
  adminSocket.emit("set_active_diver", {
    event_id: event.id, competitor_id: diver.userId, round_number: 1,
    full_name: "Navvy Diver", diverName: "Navvy Diver",
    diveCode: "101B", dd: 1.5, description: "Forward Dive", position: "B",
    dive_id: diveId, eventName: "Nav Judge Meet", status: "ready",
  });

  try {
    await setup.installClickHighlight(page);
    await page.goto("/login");
    await page.locator('input[autocomplete="username"]').fill(judges[0].username);
    await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });

    await page.goto("/judge");
    await expect(page).toHaveURL(new RegExp(`/judge\\?event=${event.id}$`), { timeout: 15_000 });
    await expect(page.getByText("Navvy Diver").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".submit-btn")).toBeEnabled({ timeout: 15_000 });
  } finally {
    adminSocket.disconnect();
  }
});
