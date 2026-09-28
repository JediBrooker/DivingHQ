// Contract for auth.apiFetch (src/stores/auth.js). DB-less, runs in
// test:safe. fetch and window are stubbed per test, so every case pins
// down exactly which requests the store made and where it navigated.
//
// The 401 cases are the important ones. Several signed-in endpoints
// answer 401 for "the password or code you just typed is wrong" (change
// password, 2FA confirm/disable, delete account, the referee credential
// sign-off), and treating every one of those as a dead session signed
// the Control Room operator out mid-meet.
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { registerSrcAlias } = require("./helpers/src-alias");

const hooked = registerSrcAlias();
let createPinia, setActivePinia, useAuthStore;

before(async () => {
  if (!hooked) return;
  ({ createPinia, setActivePinia } = await import("pinia"));
  ({ useAuthStore } = await import("../src/stores/auth.js"));
});

const SIGNED_IN = { id: "11111111-2222-3333-4444-555555555555", username: "op", org_roles: ["meet_manager"] };

let calls;
function jsonResponse(status, body) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: body == null ? {} : { "Content-Type": "application/json" },
  });
}
// routes: { 'METHOD /path': (init) => Response }
function stubFetch(routes) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const key = `${(init.method || "GET").toUpperCase()} ${url}`;
    calls.push(key);
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    return handler(init);
  };
}

beforeEach(() => {
  globalThis.window = { location: { pathname: "/profile", href: "/profile" } };
  if (hooked) setActivePinia(createPinia());
});

function signedInStore() {
  const auth = useAuthStore();
  auth.user = { ...SIGNED_IN };
  return auth;
}

test("a wrong-credential 401 on a live session keeps the user signed in", { skip: !hooked }, async () => {
  stubFetch({
    "PUT /api/users/me/password": () => jsonResponse(401, { error: "Current password is incorrect" }),
    "GET /api/auth/me": () => jsonResponse(200, { user: SIGNED_IN }),
  });
  const auth = signedInStore();
  await assert.rejects(
    auth.apiFetch("/api/users/me/password", { method: "PUT", body: "{}" }),
    (err) => err.status === 401 && err.message === "Current password is incorrect",
  );
  assert.ok(auth.isLoggedIn, "still signed in");
  assert.equal(window.location.href, "/profile", "no redirect to /login");
  assert.ok(!calls.includes("POST /api/auth/logout"), "cookie not cleared");
});

test("a 401 whose session is really gone still clears it and goes to /login", { skip: !hooked }, async () => {
  stubFetch({
    "GET /api/coach/dashboard": () => jsonResponse(401, { error: "Session expired" }),
    "GET /api/auth/me": () => jsonResponse(401, { error: "Not authenticated" }),
    "POST /api/auth/logout": () => jsonResponse(200, { ok: true }),
  });
  const auth = signedInStore();
  await assert.rejects(auth.apiFetch("/api/coach/dashboard"), (err) => err.status === 401);
  assert.equal(auth.isLoggedIn, false);
  assert.equal(window.location.href, "/login");
  assert.ok(calls.includes("POST /api/auth/logout"));
});

test("an unreachable re-probe doesn't sign anyone out", { skip: !hooked }, async () => {
  stubFetch({
    "POST /api/auth/2fa/confirm": () => jsonResponse(401, { error: "Invalid code" }),
    "GET /api/auth/me": () => { throw new TypeError("Failed to fetch"); },
  });
  const auth = signedInStore();
  await assert.rejects(auth.apiFetch("/api/auth/2fa/confirm", { method: "POST" }));
  assert.ok(auth.isLoggedIn);
  assert.equal(window.location.href, "/profile");
});

test("anonymous 401s never probe or redirect", { skip: !hooked }, async () => {
  stubFetch({
    "GET /api/judges": () => jsonResponse(401, { error: "Not authenticated" }),
  });
  const auth = useAuthStore();
  await assert.rejects(auth.apiFetch("/api/judges"), (err) => err.status === 401);
  assert.deepEqual(calls, ["GET /api/judges"]);
  assert.equal(window.location.href, "/profile");
});
