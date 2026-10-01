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

// Approve pressed on the OS notification: the worker has answered it, and
// the copy of that request in the open tab's banner has to go, not sit
// there offering buttons that now only earn an "already approved" error.
test("a sign-off answered from the notification leaves the open tab's banner", async ({ page, request }) => {
  const event = await setup.createEvent(request, { adminToken: world.adminToken, name: "E2E Push Answered 1m" });
  const res = await request.post(`/api/events/${event.id}/dive-order/sign-off/request`, {
    headers: { Authorization: `Bearer ${world.adminToken}` },
    data: { referee_id: world.referee.userId },
  });
  expect(res.status()).toBe(201);
  const { request_id: requestId } = await res.json();
  const notifId = (await setup.pool.query(
    "SELECT notification_id FROM referee_signoff_requests WHERE id = $1", [requestId],
  )).rows[0].notification_id;

  await signIn(page, world.referee.username);
  await page.goto(`/control?signoff_request=${requestId}`);
  const banner = page.locator(".notif-referee_signoff");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  // What sw.js posts to every tab after answerSignoff succeeds.
  await page.evaluate((id) => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "notification-answered", id } }));
  }, notifId);
  await expect(banner).toBeHidden();
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

// The socket message that takes a closed request's banner down can miss a
// phone (it was asleep, say). Approve then got "Could not record approve:
// Request already expired" and the dead banner stayed. It goes now, with
// a word on why, and a link to a request that's closed says so too.
test("Approve on a request that closed while the phone wasn't listening takes the banner down", async ({ page, request }) => {
  const event = await setup.createEvent(request, { adminToken: world.adminToken, name: "E2E Push Gone 3m" });
  const res = await request.post(`/api/events/${event.id}/dive-order/sign-off/request`, {
    headers: { Authorization: `Bearer ${world.adminToken}` },
    data: { referee_id: world.referee.userId },
  });
  expect(res.status()).toBe(201);
  const { request_id: requestId } = await res.json();

  // Keep reconnect checks on the phone's stale view until it answers.
  // Otherwise a background read can retire the banner before the click
  // and this stops exercising the expired request's response at all.
  const statusUrl = `/api/events/${event.id}/dive-order/sign-off/request/${requestId}`;
  await page.route(statusUrl, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, status: "pending" } });
  });

  await signIn(page, world.referee.username);
  await page.goto(`/control?event=${event.id}&signoff_request=${requestId}`);
  const banner = page.locator(".notif-referee_signoff");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  // Replaced behind the phone's back: what the server writes when a newer
  // request comes in, minus the socket message the phone missed.
  await setup.pool.query("UPDATE referee_signoff_requests SET status = 'expired' WHERE id = $1", [requestId]);
  await setup.pool.query("UPDATE notifications SET status = 'expired' WHERE data->>'request_id' = $1", [requestId]);

  await banner.locator(".notif-action-approve").click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".notify-bar")).toContainText(/no longer open/i);
  await expect(page.locator(".notify-bar-error")).toHaveCount(0);
  const ev = await setup.pool.query("SELECT dive_order_signed_off_at FROM events WHERE id = $1", [event.id]);
  expect(ev.rows[0].dive_order_signed_off_at).toBeNull();

  // Opening the link again: nothing to answer, and it says so.
  await page.unroute(statusUrl);
  await page.reload();
  await expect(page.locator(".notify-bar")).toContainText(/no longer open/i, { timeout: 10_000 });
  await expect(banner).toHaveCount(0);
});

// A referee answers this at the poolside on a phone. Approve and Deny were
// 30px tall next to a 44px dismiss ✕, under the 44px touch target the ✕
// (and WCAG 2.5.5) already go by.
test("the sign-off banner's Approve and Deny are full-size touch targets on a phone", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const event = await setup.createEvent(request, { adminToken: world.adminToken, name: "E2E Push Targets 3m" });
  const res = await request.post(`/api/events/${event.id}/dive-order/sign-off/request`, {
    headers: { Authorization: `Bearer ${world.adminToken}` },
    data: { referee_id: world.referee.userId },
  });
  expect(res.status()).toBe(201);
  const { request_id: requestId } = await res.json();

  await signIn(page, world.referee.username);
  await page.goto(`/control?event=${event.id}&signoff_request=${requestId}`);
  const banner = page.locator(".notif-referee_signoff", { hasText: "E2E Push Targets 3m" });
  await expect(banner).toBeVisible({ timeout: 10_000 });
  for (const sel of [".notif-action-approve", ".notif-action-deny", ".notif-dismiss"]) {
    const box = await banner.locator(sel).boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(44);
  }
});

// The usual case for a referee's phone: it locks and its socket drops. A
// request withdrawn in that time (or replaced, or answered on another
// device) sent its close to a socket that wasn't there, and the banner
// came back from the lock screen still offering Approve and Deny. Tapping
// it failed cleanly, but it shouldn't have been there to tap.
test("a sign-off withdrawn while the phone was offline leaves its banner when it's back", async ({ page, request, context }) => {
  test.setTimeout(60_000);
  const event = await setup.createEvent(request, { adminToken: world.adminToken, name: "E2E Push Offline 3m" });
  await signIn(page, world.referee.username);
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle").catch(() => {});
  const res = await request.post(`/api/events/${event.id}/dive-order/sign-off/request`, {
    headers: { Authorization: `Bearer ${world.adminToken}` },
    data: { referee_id: world.referee.userId },
  });
  expect(res.status()).toBe(201);
  const { request_id: requestId } = await res.json();
  const banner = page.locator(".notif-referee_signoff", { hasText: "E2E Push Offline 3m" });
  await expect(banner).toBeVisible({ timeout: 10_000 });

  await context.setOffline(true);
  // Long enough for the socket to notice and drop.
  await page.waitForTimeout(2_000);
  const cancel = await request.post(`/api/events/${event.id}/dive-order/sign-off/request/${requestId}/cancel`, {
    headers: { Authorization: `Bearer ${world.adminToken}` },
  });
  expect(await cancel.json()).toEqual({ ok: true, status: "expired" });
  await context.setOffline(false);

  await expect(banner).toHaveCount(0, { timeout: 15_000 });
});
