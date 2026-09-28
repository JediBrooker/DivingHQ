// Sign-out on a shared device (src/composables/useSignOut.js). DB-less,
// runs in test:safe.
//
// Two things used to survive it: the previous user's floating
// notification banners (a module-level list nobody cleared) and their
// web-push subscription, so their pushes kept landing on the meet-desk
// laptop after they'd left. The push DELETE needs the session cookie,
// so it has to go out before the logout that clears it.
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { registerSrcAlias } = require("./helpers/src-alias");

const hooked = registerSrcAlias();
let createPinia, setActivePinia, useAuthStore, signOut, usePush, pushNotificationForTests;

const USER = { id: "aaaaaaaa-1111-2222-3333-444444444444", username: "desk", org_roles: ["meet_manager"] };

let calls;
let unsubscribed;
function installBrowser({ withSubscription = true } = {}) {
  calls = [];
  unsubscribed = false;
  const sub = {
    endpoint: "https://push.example.test/abc",
    unsubscribe: async () => { calls.push("sub.unsubscribe"); unsubscribed = true; return true; },
  };
  globalThis.window = { location: { pathname: "/dashboard", href: "/dashboard" }, PushManager: function PushManager() {} };
  Object.defineProperty(globalThis, "location", { value: { protocol: "https:", hostname: "divinghq.test" }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      serviceWorker: {
        addEventListener() {},
        register: async () => ({ pushManager: { getSubscription: async () => null } }),
        getRegistration: async () => ({ pushManager: { getSubscription: async () => (withSubscription ? sub : null) } }),
      },
    },
  });
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${(init.method || "GET").toUpperCase()} ${url}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

before(async () => {
  if (!hooked) return;
  installBrowser();
  ({ createPinia, setActivePinia } = await import("pinia"));
  ({ useAuthStore } = await import("../src/stores/auth.js"));
  ({ signOut } = await import("../src/composables/useSignOut.js"));
  ({ usePush, _pushNotificationForTests: pushNotificationForTests } = await import("../src/composables/usePush.js"));
});

beforeEach(() => {
  if (!hooked) return;
  installBrowser();
  setActivePinia(createPinia());
});

test("sign-out drops the push subscription before the cookie goes", { skip: !hooked }, async () => {
  const auth = useAuthStore();
  auth.user = { ...USER };
  const pushed = [];
  await signOut(auth, { push: (to) => pushed.push(to) });
  const del = calls.indexOf("DELETE /api/push/subscribe");
  const logout = calls.indexOf("POST /api/auth/logout");
  assert.ok(del >= 0, `push DELETE sent (${calls.join(", ")})`);
  assert.ok(logout > del, "logout only after the push DELETE");
  assert.ok(unsubscribed, "browser subscription dropped too");
  assert.equal(auth.isLoggedIn, false);
  assert.deepEqual(pushed, ["/login"]);
});

test("sign-out clears the previous user's notification banners", { skip: !hooked }, async () => {
  const auth = useAuthStore();
  auth.user = { ...USER };
  const { notifications } = usePush();
  pushNotificationForTests({ id: "n1", title: "Your payment receipt", body: "Private" });
  assert.equal(notifications.value.length, 1);
  await signOut(auth, { push() {} });
  assert.equal(notifications.value.length, 0);
});

test("sign-out still completes when there's no push subscription", { skip: !hooked }, async () => {
  installBrowser({ withSubscription: false });
  const auth = useAuthStore();
  auth.user = { ...USER };
  await signOut(auth, { push() {} });
  assert.equal(auth.isLoggedIn, false);
  assert.ok(!calls.includes("DELETE /api/push/subscribe"));
});
