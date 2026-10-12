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

test('late inbox and sign-off reads cannot restore a signed-out account banners', { skip: !hooked }, async () => {
  const auth = useAuthStore();
  auth.user = { ...USER };
  auth.apiFetch = async () => [];
  const push = usePush();
  await settle();
  let finish;
  auth.apiFetch = () => new Promise(resolve => { finish = resolve; });
  const pending = push.recent();
  auth.user = null;
  await settle();
  finish([{ ...banner('old-account'), status: 'sent' }]);
  await pending;
  assert.equal(push.notifications.value.some(n => n.data.request_id === 'old-account'), false);

  auth.apiFetch = async () => [];
  auth.user = { ...USER };
  await settle();
  auth.apiFetch = () => new Promise(resolve => { finish = resolve; });
  const signoff = push.showSignoff('late-signoff', { eventId: 'e1' });
  auth.user = null;
  await settle();
  finish([banner('late-signoff')]);
  assert.equal(await signoff, false);
  assert.equal(push.notifications.value.some(n => n.data.request_id === 'late-signoff'), false);
});

test('initial socket connection and reconnect recover missed notices without duplicates or cross-account data', { skip: !hooked }, async () => {
  const auth = useAuthStore();
  auth.user = { ...USER, id: 'inbox-recovery-user' };
  let rows = [];
  auth.apiFetch = async () => rows;
  const push = usePush();
  push.notifications.value = [];
  await push.recent();
  const sock = fakeSocket();
  bindPushSocket(sock);
  const missed = { id: 'missed-before-connect', category: 'event_live', title: 'Live', status: 'sent' };
  rows = [missed];
  sock.fire('connect');
  await settle();
  assert.deepEqual(push.notifications.value.map(n => n.id), [missed.id]);
  rows = [{ ...missed, id: 'missed-while-offline' }, missed];
  sock.fire('notification', missed);
  sock.fire('connect');
  await settle();
  assert.deepEqual(push.notifications.value.map(n => n.id), ['missed-while-offline', missed.id]);

  let completeRead;
  auth.apiFetch = () => new Promise(resolve => { completeRead = resolve; });
  sock.fire('connect');
  auth.user = { ...USER, id: 'another-inbox-user' };
  await settle();
  completeRead([{ ...missed, id: 'old-user-late-recovery' }]);
  await settle();
  assert.equal(push.notifications.value.some(n => n.id === 'old-user-late-recovery'), false);
  bindPushSocket(null);
});

test('a stale reconnect inbox cannot restore a notice acknowledged during its read', { skip: !hooked }, async () => {
  const auth = useAuthStore();
  auth.user = { ...USER, id: 'inbox-ack-user' };
  auth.apiFetch = async () => [];
  const push = usePush();
  await settle();
  push.notifications.value = [];
  const sock = fakeSocket();
  bindPushSocket(sock);
  const notice = { id: 'ack-during-refresh', category: 'event_live', status: 'sent' };
  pushNotificationForTests(notice);
  let completeRead;
  auth.apiFetch = url => url.includes('/notifications/me?')
    ? new Promise(resolve => { completeRead = resolve; }) : Promise.resolve({ ok: true });
  sock.fire('connect');
  await push.ack(notice.id);
  completeRead([notice, { ...notice, id: 'already-expired', status: 'expired' }]);
  await settle();
  assert.deepEqual(push.notifications.value, []);
  bindPushSocket(null);
});

test('failed acknowledgement is recoverable by the next inbox read', { skip: !hooked }, async () => {
  const auth = useAuthStore();
  auth.user = { ...USER, id: 'inbox-ack-retry-user' };
  auth.apiFetch = async () => [];
  const push = usePush();
  await settle();
  push.notifications.value = [];
  const notice = { id: 'retry-failed-ack', category: 'event_live', status: 'sent' };
  pushNotificationForTests(notice);
  let completeRead;
  auth.apiFetch = url => url.includes('/notifications/me?')
    ? new Promise(resolve => { completeRead = resolve; }) : Promise.reject(new Error('offline'));
  const reading = push.recent();
  await push.ack(notice.id);
  completeRead([notice]);
  await reading;
  assert.deepEqual(push.notifications.value, [], 'the already-running snapshot cannot undo the local action');
  auth.apiFetch = async () => [notice];
  await push.recent();
  assert.equal(push.notifications.value[0].id, notice.id, 'a fresh server read can recover the failed acknowledgement');
});

test('a sign-off closed before its inbox row arrives is never restored', { skip: !hooked }, async () => {
  const auth = useAuthStore();
  auth.user = { ...USER, id: 'inbox-close-user' };
  auth.apiFetch = async () => [];
  const push = usePush();
  await settle();
  push.notifications.value = [];
  const sock = fakeSocket();
  bindPushSocket(sock);
  const completions = [];
  auth.apiFetch = () => new Promise(resolve => { completions.push(resolve); });
  const reading = push.recent();
  const reopening = push.showSignoff('closed-before-read', { eventId: 'e1' });
  sock.fire('referee_signoff_response', { request_id: 'closed-before-read' });
  for (const finish of completions) finish([{ ...banner('closed-before-read'), status: 'sent' }]);
  await reading;
  assert.equal(await reopening, false);
  assert.deepEqual(push.notifications.value, []);
  bindPushSocket(null);
});
