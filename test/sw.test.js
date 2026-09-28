// public/sw.js, run in a vm with a fake Cache Storage, fetch and clients.
//
// The service worker is plain script with no exports, so the only way to
// test it is to hand it the globals a browser would and fire events at
// it. The fakes only do what sw.js actually calls. What matters here is
// what ends up in the cache (a poisoned entry there outlives any server
// fix) and what a notification tap does.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ORIGIN = "https://divinghq.app";
const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");

const urlOf = (r) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;

function html(body = "<!doctype html><html></html>", status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function js(body = "export default 1", status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/javascript" } });
}

// Fresh worker per test. `routes` maps a pathname to a function returning
// a Response (or throwing, for "offline").
function loadSw({ routes = {}, windows = [] } = {}) {
  const listeners = {};
  const store = new Map();
  const fetches = [];
  const opened = [];
  const shown = [];

  const cacheFor = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      async put(req, res) { m.set(urlOf(req), res); },
      async match(req) { const r = m.get(urlOf(req)); return r ? r.clone() : undefined; },
      async keys() { return [...m.keys()].map((u) => new Request(u)); },
      async delete(req) { return m.delete(urlOf(req)); },
      async addAll(list) { for (const u of list) m.set(urlOf(u), js()); },
    };
  };
  const caches = {
    async open(name) { return cacheFor(name); },
    async match(req) {
      for (const m of store.values()) { const r = m.get(urlOf(req)); if (r) return r.clone(); }
      return undefined;
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
  };
  async function fetchImpl(req, init) {
    const u = new URL(urlOf(req));
    fetches.push({ url: u.pathname + u.search, method: init?.method || req.method || "GET", body: init?.body });
    const h = routes[u.pathname];
    if (!h) return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
    return h(u, init);
  }
  const clientList = windows.map((w) => ({
    url: w.url,
    visibilityState: w.visibilityState || "visible",
    focused: !!w.focused,
    messages: [],
    postMessage(m) { this.messages.push(m); },
    async focus() { this.didFocus = true; return this; },
    async navigate(to) { this.navigatedTo = to; return this; },
  }));
  const self = {
    location: new URL(ORIGIN + "/sw.js"),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {},
    registration: { showNotification: async (title, opts) => shown.push({ title, opts }) },
    clients: {
      async claim() {},
      async matchAll() { return clientList; },
      async openWindow(u) { opened.push(u); return null; },
    },
  };
  const ctx = vm.createContext({
    self, caches, fetch: fetchImpl, URL, Request, Response, Headers, Promise, console,
    setTimeout, clearTimeout, TextDecoder, TextEncoder, Date, JSON, Math,
  });
  vm.runInContext(SRC, ctx, { filename: "sw.js" });

  // Fire an event and wait for everything it handed to respondWith /
  // waitUntil, plus the fire-and-forget cache writes behind them.
  async function dispatch(type, init) {
    const pending = [];
    let response;
    const ev = {
      ...init,
      respondWith(p) { response = Promise.resolve(p); pending.push(response); },
      waitUntil(p) { pending.push(Promise.resolve(p)); },
    };
    listeners[type](ev);
    // waitUntil can be called again from inside the work it extends (the
    // shell prune does), so drain until nothing new turns up.
    for (let round = 0; round < 20; round++) {
      const batch = pending.splice(0);
      await Promise.allSettled(batch);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      if (!pending.length) break;
    }
    return response ? await response : undefined;
  }
  const req = (p, mode = "no-cors") => ({ url: ORIGIN + p, method: "GET", mode });
  const cached = async (p) => caches.match(ORIGIN + p);

  return { dispatch, req, cached, store, fetches, opened, shown, clients: clientList, cacheName: () => [...store.keys()] };
}

test("an /assets miss answered with HTML is passed through but never cached", async () => {
  const sw = loadSw({ routes: { "/assets/GuideView-abc12345.js": () => html() } });
  const res = await sw.dispatch("fetch", { request: sw.req("/assets/GuideView-abc12345.js") });
  assert.equal(res.status, 200);
  assert.equal(await sw.cached("/assets/GuideView-abc12345.js"), undefined);
});

test("a real /assets chunk is cached and served from cache next time", async () => {
  let hits = 0;
  const sw = loadSw({ routes: { "/assets/index-abc12345.js": () => { hits++; return js("x"); } } });
  await sw.dispatch("fetch", { request: sw.req("/assets/index-abc12345.js") });
  const again = await sw.dispatch("fetch", { request: sw.req("/assets/index-abc12345.js") });
  assert.equal(await again.text(), "x");
  assert.equal(hits, 1);
});

test("a 404 for a vanished chunk is not cached", async () => {
  const sw = loadSw();
  const res = await sw.dispatch("fetch", { request: sw.req("/assets/gone-abc12345.js") });
  assert.equal(res.status, 404);
  assert.equal(await sw.cached("/assets/gone-abc12345.js"), undefined);
});

test("only an HTML navigation becomes the offline shell", async () => {
  const sw = loadSw({
    routes: {
      "/metrics": () => new Response("# HELP x", { headers: { "content-type": "text/plain" } }),
      "/dashboard": () => html("<!doctype html><p>shell</p>"),
    },
  });
  await sw.dispatch("fetch", { request: sw.req("/metrics", "navigate") });
  assert.equal(await sw.cached("/index.html"), undefined, "a text/plain page must not replace the shell");
  await sw.dispatch("fetch", { request: sw.req("/dashboard", "navigate") });
  assert.match(await (await sw.cached("/index.html")).text(), /shell/);
});

test("activate drops the old v7 cache, which may hold HTML under .js names", async () => {
  const sw = loadSw();
  await sw.dispatch("install", {});
  sw.store.set("divinghq-shell-v7", new Map([[ORIGIN + "/assets/GuideView-abc12345.js", html()]]));
  await sw.dispatch("activate", {});
  assert.ok(!sw.cacheName().includes("divinghq-shell-v7"));
  assert.equal(await sw.cached("/assets/GuideView-abc12345.js"), undefined);
});

// ---------------------------------------------------------------------
// Notification taps
// ---------------------------------------------------------------------

const SIGNOFF = {
  id: "n-1",
  category: "referee_signoff",
  action_url: "/control?signoff_request=r-1",
  event_id: "e-1",
  request_id: "r-1",
};
const tap = (data, action = "") => ({ action, notification: { data, close() {} } });

test("Approve on the sign-off notification records the answer, then acks", async () => {
  const sw = loadSw({
    routes: {
      "/api/events/e-1/dive-order/sign-off/respond": () => new Response('{"ok":true}', { status: 200 }),
      "/api/notifications/n-1/acknowledge": () => new Response('{"ok":true}'),
    },
  });
  await sw.dispatch("notificationclick", tap(SIGNOFF, "approve"));
  const respond = sw.fetches.find((f) => f.url.endsWith("/sign-off/respond"));
  assert.ok(respond, "respond was never called");
  assert.equal(respond.method, "POST");
  assert.deepEqual(JSON.parse(respond.body), { request_id: "r-1", decision: "approve" });
  assert.ok(sw.fetches.some((f) => f.url === "/api/notifications/n-1/acknowledge"));
  assert.deepEqual(sw.opened, [], "nothing to open once it's answered");
});

test("Deny that can't be recorded opens the request instead and leaves it unacked", async () => {
  const sw = loadSw({
    routes: {
      "/api/events/e-1/dive-order/sign-off/respond": () => new Response('{"error":"Unauthorized"}', { status: 401 }),
    },
  });
  await sw.dispatch("notificationclick", tap(SIGNOFF, "deny"));
  assert.ok(sw.fetches.some((f) => f.url.endsWith("/sign-off/respond")));
  assert.ok(!sw.fetches.some((f) => f.url.includes("/acknowledge")), "an unanswered request must stay in the inbox");
  assert.deepEqual(sw.opened, ["/control?signoff_request=r-1"]);
});

test("a body tap with the app open routes that tab, preferring the one in view", async () => {
  const sw = loadSw({
    routes: { "/api/notifications/n-2/acknowledge": () => new Response("{}") },
    windows: [
      { url: ORIGIN + "/scoreboard/abc?overlay=1", visibilityState: "visible" },
      { url: ORIGIN + "/dashboard", visibilityState: "hidden" },
      { url: ORIGIN + "/manager", visibilityState: "visible", focused: true },
    ],
  });
  await sw.dispatch("notificationclick", tap({ id: "n-2", category: "judge_call", action_url: "/judge?event=e-9" }));
  const [overlay, hidden, inView] = sw.clients;
  assert.equal(inView.didFocus, true);
  // JSON round trip: the message was built inside the vm, a different realm.
  assert.deepEqual(JSON.parse(JSON.stringify(inView.messages)), [{ type: "notification-click", id: "n-2", action: "", action_url: "/judge?event=e-9" }]);
  assert.equal(overlay.messages.length + hidden.messages.length, 0, "a broadcast overlay is never hijacked");
  assert.deepEqual(sw.opened, []);
});

test("with only a broadcast overlay open, a tap opens a new window", async () => {
  const sw = loadSw({ windows: [{ url: ORIGIN + "/scoreboard/abc?overlay=minimal" }] });
  await sw.dispatch("notificationclick", tap({ id: "n-3", category: "judge_call", action_url: "/judge?event=e-9" }));
  assert.equal(sw.clients[0].messages.length, 0);
  assert.deepEqual(sw.opened, ["/judge?event=e-9"]);
});

// ---------------------------------------------------------------------
// Pruning superseded builds
// ---------------------------------------------------------------------

const CUR = "divinghq-shell-v8";
function seed(sw, entries) {
  if (!sw.store.has(CUR)) sw.store.set(CUR, new Map());
  const m = sw.store.get(CUR);
  for (const [p, body] of Object.entries(entries)) m.set(ORIGIN + p, js(body));
}
const shell = (entry) => `<!doctype html><script type="module" src="/assets/${entry}"></script>` +
  `<link rel="modulepreload" href="/assets/vendor-vue-AAAAAAAA.js"><link rel="stylesheet" href="/assets/index-CSSCSS11.css">`;

test("a fresh shell drops chunks from older builds and keeps everything the new one reaches", async () => {
  const sw = loadSw({ routes: { "/dashboard": () => html(shell("index-NEWNEW11.js")) } });
  seed(sw, {
    // new build: entry -> lazy view -> a chunk only that view imports
    "/assets/index-NEWNEW11.js": 'import("./GuideView-GUIDE111.js");const d=["assets/GuideView-GUIDE111.css"]',
    "/assets/GuideView-GUIDE111.js": 'import("./ModalBits-MODAL111.js")',
    "/assets/GuideView-GUIDE111.css": ".a{}",
    "/assets/ModalBits-MODAL111.js": "x",
    "/assets/vendor-vue-AAAAAAAA.js": "x",
    "/assets/index-CSSCSS11.css": ".b{background:url(/assets/font-FONT1111.woff2)}",
    "/assets/font-FONT1111.woff2": "x",
    // two deploys ago
    "/assets/index-OLDOLD11.js": 'import("./GuideView-OLDGUIDE.js")',
    "/assets/GuideView-OLDGUIDE.js": "x",
  });
  await sw.dispatch("fetch", { request: sw.req("/dashboard", "navigate") });
  const left = [...sw.store.get(CUR).keys()].map((u) => new URL(u).pathname).filter((p) => p.startsWith("/assets/")).sort();
  assert.deepEqual(left, [
    "/assets/GuideView-GUIDE111.css",
    "/assets/GuideView-GUIDE111.js",
    "/assets/ModalBits-MODAL111.js",
    "/assets/font-FONT1111.woff2",
    "/assets/index-CSSCSS11.css",
    "/assets/index-NEWNEW11.js",
    "/assets/vendor-vue-AAAAAAAA.js",
  ]);
});

test("nothing is pruned until the new build's own scripts are cached", async () => {
  const sw = loadSw({ routes: { "/dashboard": () => html(shell("index-NEWNEW11.js")) } });
  // First load after a deploy: the page hasn't fetched the new entry yet,
  // so we can't tell which lazy chunks it still needs.
  seed(sw, { "/assets/index-OLDOLD11.js": "x", "/assets/GuideView-SHARED11.js": "x" });
  await sw.dispatch("fetch", { request: sw.req("/dashboard", "navigate") });
  assert.ok(await sw.cached("/assets/index-OLDOLD11.js"));
  assert.ok(await sw.cached("/assets/GuideView-SHARED11.js"));
});
