// A referee's sign-off banner after their phone's socket comes back
// (src/composables/usePush.js). DB-less, runs in test:safe.
//
// A phone locks and its socket drops. A request withdrawn, replaced or
// answered elsewhere in that time sent its close to a socket that wasn't
// there, and the banner came back still offering Approve and Deny. On a
// reconnect every sign-off banner asks after its request now: the closed
// ones go, an open one stays, and one that couldn't be asked about stays
// too (better a banner that answers 409 than one that vanished while the
// request was still waiting). The e2e side is in push-clicks.spec.js.
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { registerSrcAlias } = require("./helpers/src-alias");

const hooked = registerSrcAlias();
let createPinia, setActivePinia, useAuthStore, usePush, bindPushSocket, pushNotificationForTests;

const USER = { id: "aaaaaaaa-1111-2222-3333-444444444444", username: "ref", org_roles: ["referee"] };

function installBrowser() {
  globalThis.window = { location: { pathname: "/dashboard", href: "/dashboard" } };
  Object.defineProperty(globalThis, "location", { value: { protocol: "https:", hostname: "divinghq.test" }, configurable: true, writable: true });
  // No service worker and no PushManager: usePush leaves web push alone.
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: {} });
  globalThis.fetch = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
}

function fakeSocket() {
  const handlers = {};
  return {
    on(name, fn) { (handlers[name] ||= []).push(fn); },
    off(name, fn) { handlers[name] = (handlers[name] || []).filter((f) => f !== fn); },
    emit() {},
    fire(name, payload) { for (const fn of handlers[name] || []) fn(payload); },
    count(name) { return (handlers[name] || []).length; },
  };
}

function banner(requestId, eventId = "e1") {
  return {
    id: `n-${requestId}`,
    category: "referee_signoff",
    title: "Referee sign-off requested",
    data: { event_id: eventId, request_id: requestId },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

before(async () => {
  if (!hooked) return;
  installBrowser();
  ({ createPinia, setActivePinia } = await import("pinia"));
  ({ useAuthStore } = await import("../src/stores/auth.js"));
  ({ usePush, bindPushSocket, _pushNotificationForTests: pushNotificationForTests } =
    await import("../src/composables/usePush.js"));
});

beforeEach(() => {
  if (!hooked) return;
  installBrowser();
  setActivePinia(createPinia());
});

test("a reconnect drops the banners of requests that closed, and keeps the rest", { skip: !hooked }, async () => {
  const auth = useAuthStore();
  auth.user = { ...USER };
  const asked = [];
  const statusOf = { open: "pending", gone: "expired", answered: "approved" };
  auth.apiFetch = async (url) => {
    // The sign-in watcher's inbox pull: nothing new in it.
    if (url.startsWith("/api/notifications/me")) return [];
    asked.push(url);
    const id = url.split("/").pop();
    if (id === "unknown") throw Object.assign(new Error("offline"), { status: 0 });
    if (id === "deleted") throw Object.assign(new Error("Request not found"), { status: 404 });
    return { request_id: id, status: statusOf[id] };
  };
  const { notifications } = usePush();
  const sock = fakeSocket();
  bindPushSocket(sock);
  for (const id of ["open", "gone", "answered", "unknown", "deleted"]) pushNotificationForTests(banner(id));
  pushNotificationForTests({ id: "receipt", category: "payment_receipt", title: "Receipt" });

  sock.fire("connect");
  await settle();
  await settle();

  const left = notifications.value.map((n) => n.data?.request_id || n.id).sort();
  assert.deepEqual(left, ["open", "receipt", "unknown"]);
  assert.ok(asked.every((u) => u.startsWith("/api/events/e1/dive-order/sign-off/request/")));
  assert.equal(asked.length, 5, "only the sign-off banners are asked about");

  bindPushSocket(null);
  assert.equal(sock.count("connect"), 0, "unbinding takes the reconnect listener off too");
});
