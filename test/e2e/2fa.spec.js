// Two-factor auth flow.
//
// What this exercises end-to-end:
//   1. Admin user starts /api/auth/2fa/setup → gets a base32
//      secret + 10 recovery codes.
//   2. Admin generates a fresh TOTP for that secret (using the
//      same speakeasy library the server uses) and POSTs it to
//      /api/auth/2fa/confirm — 2FA is now active.
//   3. Logging in with username+password no longer returns a
//      session token; instead it returns
//      { needs_totp: true, totp_token: "<5-min jwt>" }.
//   4. POSTing the totp_token + a fresh 6-digit code to
//      /api/auth/login/totp returns the real session token.
//   5. POSTing the totp_token + a recovery code (from the setup
//      response) ALSO returns a session token, AND the recovery
//      code is consumed (replaying it 401s).
//   6. /api/auth/2fa/disable with password + a current TOTP
//      clears the columns and login goes back to one-step.
//
// We use speakeasy directly to compute the TOTP — same library
// the server uses to verify, so codes match deterministically.

const { test, expect } = require("@playwright/test");
const speakeasy = require("speakeasy");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// Wait long enough for a fresh 30s TOTP window. The server's
// verify uses ±1 step (±30s), so once a code is generated it's
// good for ~60s. We don't need to wait between codes — same
// step number returns the same digits — but we DO need to make
// sure we never reuse a code in the same place where the server
// would reject it. /confirm and /login/totp both accept the
// "current" code, so back-to-back is fine.
function totpFor(secret) {
  return speakeasy.totp({
    secret,
    encoding: "base32",
  });
}

function fakeSessionToken() {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    id: "00000000-0000-4000-8000-000000000001",
    username: "totp-ui-admin",
    full_name: "TOTP UI Admin",
    org_id: "00000000-0000-4000-8000-000000000002",
    org_roles: ["org_admin"],
    is_system_admin: false,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function exerciseLoginTotpUi(page, code, responseExtras = {}) {
  let totpPayload = null;

  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ needs_totp: true, totp_token: "challenge-token" }),
    });
  });
  await page.route("**/api/auth/login/totp", async (route) => {
    totpPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: fakeSessionToken(), ...responseExtras }),
    });
  });
  await page.route("**/api/users/me/claim-candidates", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ candidates: [] }),
    });
  });

  await page.goto("/login?next=/guide");
  await page.locator('input[autocomplete="username"]').fill("totp-ui-admin");
  await page.locator('input[autocomplete="current-password"]').fill("correct-password");
  await page.getByRole("button", { name: /sign in/i }).click();

  const secondFactorInput = page.locator('input[autocomplete="one-time-code"]');
  await expect(secondFactorInput).toBeVisible();
  await secondFactorInput.fill(code);
  await page.getByRole("button", { name: /verify code/i }).click();
  await expect(page).toHaveURL(/\/guide$/);

  expect(totpPayload).toEqual({ totp_token: "challenge-token", code });
}

test("admin enables 2FA, logs in via TOTP and via recovery code", async ({
  request,
}) => {
  test.setTimeout(60_000);

  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request);

  // ---- 1. Start setup. The server saves the secret to
  //         users.totp_secret but doesn't enable 2FA yet. ----
  const setupRes = await request.post("/api/auth/2fa/setup", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(setupRes.status()).toBe(200);
  const setupBody = await setupRes.json();
  expect(setupBody.base32).toBeTruthy();
  expect(setupBody.qr_data_url).toMatch(/^data:image\/png;base64,/);
  expect(Array.isArray(setupBody.recovery_codes)).toBe(true);
  expect(setupBody.recovery_codes).toHaveLength(10);
  // Each recovery code is "abcde-12345" form.
  for (const code of setupBody.recovery_codes) {
    expect(code).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
  }

  // ---- 2. Confirm with a current TOTP. ----
  const code = totpFor(setupBody.base32);
  const confirm = await request.post("/api/auth/2fa/confirm", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { code },
  });
  expect(confirm.status()).toBe(200);
  const confirmBody = await confirm.json();
  expect(confirmBody.ok).toBe(true);

  // ---- 3. Plain login is now two-step. ----
  // Note: confirming 2FA bumps token_version, which would
  // invalidate the OLD admin token if we tried to use it for
  // anything below. We don't — we go through login again.
  const stepOne = await request.post("/api/auth/login", {
    data: { username, password: setup.TEST_PASSWORD },
  });
  expect(stepOne.status()).toBe(200);
  const stepOneBody = await stepOne.json();
  expect(stepOneBody.token).toBeUndefined();
  expect(stepOneBody.needs_totp).toBe(true);
  expect(stepOneBody.totp_token).toBeTruthy();

  // ---- 4. Step two: totp_token + a 6-digit code → real JWT. --
  const stepTwo = await request.post("/api/auth/login/totp", {
    data: {
      totp_token: stepOneBody.totp_token,
      code:       totpFor(setupBody.base32),
    },
  });
  expect(stepTwo.status()).toBe(200);
  const stepTwoBody = await stepTwo.json();
  expect(stepTwoBody.token).toBeTruthy();
  const sessionToken = stepTwoBody.token;

  // ---- 5. Recovery-code path on a fresh login. ----
  const stepOneAgain = await request.post("/api/auth/login", {
    data: { username, password: setup.TEST_PASSWORD },
  });
  expect(stepOneAgain.status()).toBe(200);
  const totp_token2 = (await stepOneAgain.json()).totp_token;
  expect(totp_token2).toBeTruthy();

  const recoveryCode = setupBody.recovery_codes[0];
  const recoveryLogin = await request.post("/api/auth/login/totp", {
    data: { totp_token: totp_token2, code: recoveryCode },
  });
  expect(recoveryLogin.status()).toBe(200);
  const recoveryBody = await recoveryLogin.json();
  expect(recoveryBody.token).toBeTruthy();
  // Server also surfaces a warning when a recovery code is used.
  expect(recoveryBody.warning).toMatch(/recovery code consumed/i);

  // Replaying the same recovery code MUST 401 — they're one-time.
  const stepOneReplay = await request.post("/api/auth/login", {
    data: { username, password: setup.TEST_PASSWORD },
  });
  const totp_token3 = (await stepOneReplay.json()).totp_token;
  const replay = await request.post("/api/auth/login/totp", {
    data: { totp_token: totp_token3, code: recoveryCode },
  });
  expect(replay.status()).toBe(401);

  // ---- 6. Disable 2FA, then a plain login should one-step. ----
  // /disable requires the password (proof-of-access) and a current
  // TOTP. Use the session token we got at step 4.
  const disableRes = await request.post("/api/auth/2fa/disable", {
    headers: { Authorization: `Bearer ${sessionToken}` },
    data: {
      password: setup.TEST_PASSWORD,
      code:     totpFor(setupBody.base32),
    },
  });
  expect(disableRes.status()).toBe(200);

  const finalLogin = await request.post("/api/auth/login", {
    data: { username, password: setup.TEST_PASSWORD },
  });
  expect(finalLogin.status()).toBe(200);
  const finalBody = await finalLogin.json();
  expect(finalBody.token).toBeTruthy();
  expect(finalBody.needs_totp).toBeUndefined();

  // ---- Cleanup ----
  await setup.deleteOrg(orgId);
});

test("login UI completes the second factor with a 6-digit TOTP", async ({ page }) => {
  await exerciseLoginTotpUi(page, "123456");
});

test("login UI completes the second factor with a recovery code", async ({ page }) => {
  await exerciseLoginTotpUi(page, "abcde-12345", {
    warning: "Recovery code consumed; 9 recovery codes remain.",
  });
  await expect(page.getByText(/recovery code consumed/i)).toBeVisible();
});

// pool teardown left to process exit (Playwright tears down the
// worker process anyway). Calling pool.end() here was a foot-gun
// when two specs landed in the same worker — the second hit a
// closed pool. node-postgres handles process exit gracefully.
