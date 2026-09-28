// Where a notification tap, or a link to a sign-off request, actually
// takes the user. The service worker's half (answering Approve/Deny from
// the notification itself) is unit-tested in test/sw.test.js; this is the
// SPA's half.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const world = {};

test.beforeAll(async ({ request }) => {
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { orgName: "Push Click Fed" });
  world.orgId = orgId;
  world.adminToken = adminToken;
  world.event = await setup.createEvent(request, { adminToken, name: "E2E Push Click 3m" });
  world.referee = await setup.insertUser({ orgId, role: "referee", fullName: "Rita Referee" });
});

test.afterAll(async () => {
  if (world.orgId) await setup.deleteOrg(world.orgId);
});

async function signIn(page, username) {
  await setup.bypassRoleTour(page);
  const r = await page.request.post("/api/auth/login", { data: { username, password: setup.TEST_PASSWORD } });
  expect(r.status()).toBe(200);
}

test("a sign-off link brings back Approve/Deny even after the notification was read", async ({ page, request }) => {
  const res = await request.post(`/api/events/${world.event.id}/dive-order/sign-off/request`, {
    headers: { Authorization: `Bearer ${world.adminToken}` },
    data: { referee_id: world.referee.userId },
  });
  expect(res.status()).toBe(201);
  const { request_id: requestId } = await res.json();

  // Opening it from the inbox (or tapping the OS notification) acks the
  // row, which is what used to leave the referee with nothing to press.
  await setup.pool.query(
    "UPDATE notifications SET status = 'acknowledged', acknowledged_at = now() WHERE user_id = $1 AND category = 'referee_signoff'",
    [world.referee.userId],
  );

  await signIn(page, world.referee.username);
  await page.goto(`/control?signoff_request=${requestId}`);
  const banner = page.locator(".notif-referee_signoff");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await banner.locator(".notif-action-approve").click();

  await expect.poll(async () => (await setup.pool.query(
    "SELECT status FROM referee_signoff_requests WHERE id = $1", [requestId],
  )).rows[0]?.status, { timeout: 5_000 }).toBe("approved");
});

test("tapping a system notification with the app open routes that tab", async ({ page }) => {
  await signIn(page, world.referee.username);
  await page.goto("/dashboard");
  await expect(page.locator(".topbar")).toBeVisible();
  // What sw.js posts to the tab it focuses.
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
      data: { type: "notification-click", id: "00000000-0000-0000-0000-000000000000", action: "", action_url: "/inbox" },
    }));
  });
  await expect(page).toHaveURL(/\/inbox$/);
});

// Fixture orgs ping every sysadmin, and the test DB holds real browser
// subscriptions. playwright.config.js blanks the VAPID keys so none of
// that reaches an actual phone.
test("the e2e server runs with web push off", async ({ request }) => {
  const r = await request.get("/api/push/vapid-public-key");
  expect(await r.json()).toEqual({ key: "", enabled: false });
});
