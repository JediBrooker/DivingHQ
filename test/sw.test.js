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
    await Promise.allSettled(pending);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
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
