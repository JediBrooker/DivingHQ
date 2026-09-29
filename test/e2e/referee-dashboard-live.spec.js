// The referee's dashboard during sign-off. In the rehearsal dry run it said
// "All quiet, nothing pending." while a sign-off request sat waiting: the
// attention lane had no chip for sign-offs at all, and the page only
// refetched on its 30 s poll, so the "Waiting for you" card turned up late
// (or after the request had already been answered from the banner).
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn } = require("./_meetday");

test.describe.configure({ mode: "serial" });

const world = {};

test.beforeAll(async ({ request }) => {
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Referee Desk Diving",
  });
  Object.assign(world, { orgId, adminToken });
  world.referee = await setup.insertUser({ orgId, role: "referee", fullName: "Remy Referee" });
  world.refToken = (await setup.loginAs(request, world.referee.username)).token;
  world.event = await setup.createEvent(request, { adminToken, name: "Desk Event 3m" });
  await setup.pool.query(
    "UPDATE events SET check_in_done_at = now(), dive_order_randomised_at = now() WHERE id = $1",
    [world.event.id],
  );
});

test.afterAll(async () => {
  if (world.orgId) await setup.deleteOrg(world.orgId);
});

test("a sign-off request shows up on the open dashboard and goes once it's answered", async ({ page, request }) => {
  test.setTimeout(90_000);
  await setup.bypassRoleTour(page);
  await signIn(page, world.referee.username);
  const lane = page.locator(".pulse-strip");
  await expect(lane.locator(".pulse-quiet")).toBeVisible({ timeout: 10_000 });

  const res = await request.post(`/api/events/${world.event.id}/dive-order/sign-off/request`, {
    headers: { Authorization: `Bearer ${world.adminToken}` },
    data: { referee_id: world.referee.userId },
  });
  expect(res.status()).toBe(201);
  const { request_id } = await res.json();

  // Well inside the 30 s poll, so this is the socket doing it.
  const chip = lane.locator(".pulse-chip.pulse-referee");
  await expect(chip).toBeVisible({ timeout: 8_000 });
  await expect(chip.locator(".pulse-num")).toHaveText("1");
  await expect(lane.locator(".pulse-quiet")).toHaveCount(0);
  const card = page.locator(`a[href="/control?signoff_request=${request_id}"]`).first();
  await expect(card).toBeVisible();

  // Answered from somewhere else (the phone's notification, say).
  const ans = await request.post(`/api/events/${world.event.id}/dive-order/sign-off/respond`, {
    headers: { Authorization: `Bearer ${world.refToken}` },
    data: { request_id, decision: "approve" },
  });
  expect(ans.status()).toBe(200);
  await expect(chip).toHaveCount(0, { timeout: 8_000 });
  await expect(lane.locator(".pulse-quiet")).toBeVisible();
});

test("a request that ran out isn't left on the desk", async ({ page, request }) => {
  test.setTimeout(60_000);
  await setup.pool.query(
    `INSERT INTO referee_signoff_requests (event_id, requested_by, target_referee_id, expires_at)
     SELECT $1, u.id, $2, now() - interval '1 minute'
       FROM users u WHERE u.org_id = $3 AND u.id <> $2 LIMIT 1`,
    [world.event.id, world.referee.userId, world.orgId],
  );
  const desk = await request.get("/api/dashboard", { headers: { Authorization: `Bearer ${world.refToken}` } });
  expect(desk.status()).toBe(200);
  expect((await desk.json()).referee_desk.pending_signoffs).toEqual([]);

  await setup.bypassRoleTour(page);
  await signIn(page, world.referee.username);
  await expect(page.locator(".pulse-strip .pulse-quiet")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".pulse-chip.pulse-referee")).toHaveCount(0);
});
