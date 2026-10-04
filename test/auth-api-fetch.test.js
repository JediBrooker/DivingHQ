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

// The server hangs structured detail off error bodies: dive-list
// violations (lib/dive-list-submit.js), needs_totp on the credential
// sign-off. Callers branch on those, so they have to survive the throw.
test("error body fields ride along on the thrown error", { skip: !hooked }, async () => {
  stubFetch({
    "POST /api/coach/dive-lists/e1/d1": () => jsonResponse(400, {
      error: "Dive list violates the event's prescribed dives",
      violations: ["Round 2 must be 105B", "Round 4 must be 3m"],
    }),
  });
  const auth = signedInStore();
  await assert.rejects(
    auth.apiFetch("/api/coach/dive-lists/e1/d1", { method: "POST" }),
    (err) => {
      assert.equal(err.status, 400);
      assert.deepEqual(err.violations, ["Round 2 must be 105B", "Round 4 must be 3m"]);
      assert.deepEqual(err.body.violations, err.violations);
      return true;
    },
  );
});

test("a 401 needs_totp from the sign-off keeps the flag and the session", { skip: !hooked }, async () => {
  stubFetch({
    "POST /api/events/e1/dive-order/sign-off/credential": () => jsonResponse(401, { error: "TOTP code required", needs_totp: true }),
    "GET /api/auth/me": () => jsonResponse(200, { user: SIGNED_IN }),
  });
  const auth = signedInStore();
  await assert.rejects(
    auth.apiFetch("/api/events/e1/dive-order/sign-off/credential", { method: "POST" }),
    (err) => err.needs_totp === true,
  );
  assert.ok(auth.isLoggedIn);
});

// DELETE /api/dive-directory/:id answers 204 with no body. Parsing that
// as JSON threw "Unexpected end of JSON input" after the delete had
// already happened, so the page reported a failure and kept the row.
test("a 204 resolves to null instead of throwing", { skip: !hooked }, async () => {
  stubFetch({
    "DELETE /api/dive-directory/abc": () => new Response(null, { status: 204 }),
  });
  const auth = signedInStore();
  assert.equal(await auth.apiFetch("/api/dive-directory/abc", { method: "DELETE" }), null);
});

test("an empty 200 body resolves to null too", { skip: !hooked }, async () => {
  stubFetch({
    "POST /api/thing": () => new Response("", { status: 200 }),
  });
  const auth = signedInStore();
  assert.equal(await auth.apiFetch("/api/thing", { method: "POST" }), null);
});


test("a late session refresh cannot replace a newly signed-in account", { skip: !hooked }, async () => {
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  stubFetch({ "GET /api/auth/me": () => delayed });
  const auth = signedInStore();
  const refresh = auth.fetchMe();
  const replacement = { ...SIGNED_IN, id: "aaaaaaaa-2222-3333-4444-555555555555", locale: "en" };
  auth.saveSession({ user: replacement });
  finish(jsonResponse(200, { user: SIGNED_IN }));
  await refresh;
  assert.equal(auth.user.id, replacement.id);
});
