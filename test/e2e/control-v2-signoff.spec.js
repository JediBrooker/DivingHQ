// Referee sign-off from the Control Room's Setup stage. Sign-off happens
// while the event is still Upcoming, and the Control Room only joins an
// event's socket room once it's Live, so the answer used to go to a room
// the laptop wasn't in. The dialog sat on "Waiting for ..." (or kept
// showing the code) until someone closed it and reloaded. These drive the
// referee's half over the API and check the laptop moves on by itself.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn } = require("./_meetday");

test.describe.configure({ mode: "serial" });

const world = {};

test.beforeAll(async ({ request }) => {
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "V2 Signoff Diving",
  });
  Object.assign(world, { orgId, username, adminToken });
  const referee = await setup.insertUser({ orgId, role: "referee", fullName: "Rhea Referee" });
  const login = await setup.loginAs(request, referee.username);
  world.referee = { ...referee, token: login.token };
});

test.afterAll(async () => {
  if (world.orgId) await setup.deleteOrg(world.orgId);
});

// An Upcoming event parked on the sign-off step: checked in and drawn.
async function eventAtSignoff(request, name) {
  const event = await setup.createEvent(request, {
    adminToken: world.adminToken, name, total_rounds: 1, number_of_judges: 3, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId: world.orgId, role: "diver", fullName: `${name} Diver` });
  await setup.insertDiveList({ eventId: event.id, competitorId: diver.userId, dives: [{ round_number: 1, dive_id: diveId }] });
  await setup.pool.query(
    "UPDATE events SET check_in_done_at = now(), dive_order_randomised_at = now() WHERE id = $1",
    [event.id],
  );
  return event;
}

async function openSignoff(page, event) {
  await signIn(page, world.username);
  await page.goto(`/control?event=${event.id}`);
  const primary = page.locator(".setup-primary");
  await expect(primary).toContainText(/Referee Sign Off/i, { timeout: 10_000 });
  await primary.click();
  const dialog = page.locator('.lb-modal[role="dialog"]');
  await expect(dialog).toBeVisible();
  // The referee list loads after the dialog mounts.
  await expect(dialog.locator("select.select option", { hasText: "Rhea Referee" })).toHaveCount(1, { timeout: 5_000 });
  return { primary, dialog };
}

function asReferee() {
  return { Authorization: `Bearer ${world.referee.token}` };
}

test("push: the dialog closes by itself once the referee approves", async ({ page, request }) => {
  test.setTimeout(90_000);
  const event = await eventAtSignoff(request, "Signoff Push");
  const { primary, dialog } = await openSignoff(page, event);

  await dialog.locator("select.select").selectOption({ label: "Rhea Referee" });
  const sent = page.waitForResponse((r) => r.url().includes("/dive-order/sign-off/request") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: /Send sign-off request/ }).click();
  const { request_id } = await (await sent).json();
  await expect(dialog.locator(".signoff-waiting")).toContainText("Rhea Referee");

  const res = await request.post(`/api/events/${event.id}/dive-order/sign-off/respond`, {
    headers: asReferee(), data: { request_id, decision: "approve" },
  });
  expect(res.status()).toBe(200);

  await expect(dialog).toBeHidden({ timeout: 6_000 });
  await expect(primary).toContainText(/Start Event/i);
});

test("push: a refusal shows in the dialog instead of waiting forever", async ({ page, request }) => {
  test.setTimeout(90_000);
  const event = await eventAtSignoff(request, "Signoff Deny");
  const { primary, dialog } = await openSignoff(page, event);

  await dialog.locator("select.select").selectOption({ label: "Rhea Referee" });
  const sent = page.waitForResponse((r) => r.url().includes("/dive-order/sign-off/request") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: /Send sign-off request/ }).click();
  const { request_id } = await (await sent).json();

  const res = await request.post(`/api/events/${event.id}/dive-order/sign-off/respond`, {
    headers: asReferee(), data: { request_id, decision: "deny" },
  });
  expect(res.status()).toBe(200);

  await expect(dialog.locator(".msg-error")).toContainText(/declined/i, { timeout: 6_000 });
  await expect(dialog.locator(".signoff-waiting")).toHaveCount(0);
  await expect(primary).toContainText(/Referee Sign Off/i);
});

test("code: the dialog closes by itself once the referee enters the code", async ({ page, request }) => {
  test.setTimeout(90_000);
  const event = await eventAtSignoff(request, "Signoff Code");
  const { primary, dialog } = await openSignoff(page, event);

  // The e2e server has no APP_BASE_URL, and the code endpoint refuses
  // without one (the QR link would otherwise trust the Host header). So
  // the code row goes in by hand, exactly what the endpoint would have
  // written, and the dialog's POST gets that row back. Everything after
  // (the referee typing it in, the answer reaching the laptop) is real.
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const ins = await setup.pool.query(
    `INSERT INTO referee_signoff_requests (event_id, requested_by, target_referee_id, handoff_code)
     SELECT $1, id, $3, $4 FROM users WHERE username = $2
     RETURNING id, expires_at`,
    [event.id, world.username, world.referee.userId, code],
  );
  await page.route("**/dive-order/sign-off/code", (route) => route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, request_id: ins.rows[0].id, code, expires_at: ins.rows[0].expires_at }),
  }));

  await dialog.getByRole("button", { name: /Code on referee/ }).click();
  await dialog.locator("select.select").selectOption({ label: "Rhea Referee" });
  await dialog.getByRole("button", { name: /Generate code/ }).click();
  await expect(dialog.locator(".signoff-code-value")).toHaveText(code);

  const res = await request.post("/api/sign-off/code/verify", { headers: asReferee(), data: { code } });
  expect(res.status()).toBe(200);

  await expect(dialog).toBeHidden({ timeout: 6_000 });
  await expect(primary).toContainText(/Start Event/i);
});

test("a missed socket message still lands: the dialog checks on the request itself", async ({ page, request }) => {
  test.setTimeout(90_000);
  const event = await eventAtSignoff(request, "Signoff Poll");
  const { primary, dialog } = await openSignoff(page, event);

  await dialog.locator("select.select").selectOption({ label: "Rhea Referee" });
  const sent = page.waitForResponse((r) => r.url().includes("/dive-order/sign-off/request") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: /Send sign-off request/ }).click();
  const { request_id } = await (await sent).json();

  // Approve straight in the database, so no socket message goes out at
  // all. Same end state as an answer that arrived while the laptop's
  // socket was reconnecting.
  await setup.pool.query(
    `UPDATE referee_signoff_requests SET status = 'approved', decision_method = 'push', responded_at = now()
      WHERE id = $1`,
    [request_id],
  );
  await setup.pool.query(
    "UPDATE events SET dive_order_signed_off_at = now(), dive_order_signed_off_by = $1 WHERE id = $2",
    [world.referee.userId, event.id],
  );

  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(primary).toContainText(/Start Event/i);
});

// The referee's phone, signed in on the dashboard where a request's
// Approve / Deny banner turns up.
async function refereePhone(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await ctx.newPage();
  await setup.bypassRoleTour(phone);
  await signIn(phone, world.referee.username);
  await expect(phone.locator(".topbar")).toBeVisible({ timeout: 10_000 });
  return { ctx, phone };
}

async function sendPush(page, dialog) {
  await dialog.locator("select.select").selectOption({ label: "Rhea Referee" });
  const sent = page.waitForResponse((r) => r.url().includes("/dive-order/sign-off/request") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: /Send sign-off request/ }).click();
  return (await (await sent).json()).request_id;
}

// Cancel used to only forget the request on the laptop. The referee's
// phone kept its banner (a reload put it back), and an Approve there still
// signed the order off behind the Control Room's back. Cancel withdraws
// it now, on both screens.
test("Cancel takes the request off the referee's phone, and a late Approve doesn't count", async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const event = await eventAtSignoff(request, "Signoff Cancel");
  const { ctx, phone } = await refereePhone(browser);
  const { primary, dialog } = await openSignoff(page, event);

  const requestId = await sendPush(page, dialog);
  const banner = phone.locator(".notif-referee_signoff", { hasText: "Signoff Cancel" });
  await expect(banner).toBeVisible({ timeout: 8_000 });

  await dialog.getByRole("button", { name: /Cancel request/ }).click();
  await expect(dialog.locator(".signoff-waiting")).toHaveCount(0);
  await expect(banner).toHaveCount(0, { timeout: 8_000 });
  await phone.reload();
  await expect(phone.locator(".topbar")).toBeVisible({ timeout: 10_000 });
  await phone.waitForLoadState("networkidle");
  await expect(banner).toHaveCount(0);

  const late = await request.post(`/api/events/${event.id}/dive-order/sign-off/respond`, {
    headers: asReferee(), data: { request_id: requestId, decision: "approve" },
  });
  expect(late.status()).toBe(409);
  const row = await setup.pool.query("SELECT dive_order_signed_off_at FROM events WHERE id = $1", [event.id]);
  expect(row.rows[0].dive_order_signed_off_at).toBeNull();
  await page.keyboard.press("Escape");
  await expect(primary).toContainText(/Referee Sign Off/i);
  await ctx.close();
});

test("a second request replaces the first on the referee's phone", async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const event = await eventAtSignoff(request, "Signoff Again");
  const { ctx, phone } = await refereePhone(browser);
  const { dialog } = await openSignoff(page, event);

  const first = await sendPush(page, dialog);
  const banner = phone.locator(".notif-referee_signoff", { hasText: "Signoff Again" });
  await expect(banner).toHaveCount(1, { timeout: 8_000 });
  await dialog.getByRole("button", { name: /Cancel request/ }).click();
  const second = await sendPush(page, dialog);
  expect(second).not.toBe(first);
  // One banner, the live one, and still one after a reload.
  await expect(banner).toHaveCount(1, { timeout: 8_000 });
  await phone.reload();
  await expect(banner).toHaveCount(1, { timeout: 10_000 });
  await banner.locator(".notif-action-approve").click();
  await expect(dialog).toBeHidden({ timeout: 8_000 });
  await expect(banner).toHaveCount(0);
  await ctx.close();
});
