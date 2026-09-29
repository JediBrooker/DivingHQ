// /metrics behind the Cloudflare tunnel (lib/metrics-access.js,
// routes/metrics.js). The live box runs with METRICS_PUBLIC=true so the
// Prometheus container can scrape without a token, and the tunnel hands
// every path on divinghq.app to the app, so the endpoint was public. Now a
// request carrying Cloudflare's headers is a 404 unless it has the token,
// and a direct one (Prometheus) keeps working exactly as before.
//
// No database: the router gets a stand-in pool, the metrics registry is
// the real one.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { createMetricsGate, cameThroughCloudflare } = require("../lib/metrics-access");
const createMetricsRouter = require("../routes/metrics");
const metrics = require("../lib/metrics");

const servers = [];
after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
});

async function serve(gateOpts) {
  const app = express();
  const pool = { totalCount: 1, idleCount: 1, waitingCount: 0 };
  app.use(createMetricsRouter({ pool, metrics, logger: console, access: createMetricsGate(gateOpts) }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (headers = {}) => {
    const r = await fetch(`${base}/metrics`, { headers });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
}

// What cloudflared hands the origin for a request from the internet.
const VIA_TUNNEL = {
  "cf-ray": "8c1f0d2e3a4b5c6d-SYD",
  "cf-connecting-ip": "203.0.113.9",
  "cf-ipcountry": "AU",
  "cf-visitor": '{"scheme":"https"}',
  "cdn-loop": "cloudflare",
  "x-forwarded-for": "203.0.113.9",
  "x-forwarded-proto": "https",
};

test("the live box's settings: Prometheus scrapes, the internet gets a 404", async () => {
  // NODE_ENV=production, METRICS_PUBLIC=true, no token.
  const get = await serve({ token: null, allowPublic: true, production: true });

  const direct = await get();
  assert.equal(direct.status, 200);
  assert.match(direct.headers.get("content-type"), /text\/plain/);
  assert.match(direct.text, /dive_recorder_http_requests_total/);

  const tunnel = await get(VIA_TUNNEL);
  assert.equal(tunnel.status, 404);
  assert.equal(tunnel.text, "Not found");
  assert.equal(tunnel.headers.get("www-authenticate"), null, "no hint that a login would help");

  // Either of the two headers the brief names is enough on its own.
  assert.equal((await get({ "cf-ray": "abc-SYD" })).status, 404);
  assert.equal((await get({ "cf-connecting-ip": "198.51.100.4" })).status, 404);
  // And the lesser ones, in case a setting ever drops the first two.
  assert.equal((await get({ "cdn-loop": "cloudflare; loops=1" })).status, 404);
  assert.equal((await get({ "cf-visitor": '{"scheme":"https"}' })).status, 404);
});

test("with METRICS_TOKEN set, the bearer works both ways and nothing else does", async () => {
  const token = "m3trics-t0ken-for-the-test-suite-only";
  const get = await serve({ token, allowPublic: true, production: true });
  const auth = { authorization: `Bearer ${token}` };

  assert.equal((await get(auth)).status, 200, "Prometheus with the credential");
  assert.equal((await get({ ...VIA_TUNNEL, ...auth })).status, 200, "through the tunnel with the token");

  const noToken = await get();
  assert.equal(noToken.status, 401, "direct without the token asks for it, as before");
  assert.match(noToken.headers.get("www-authenticate"), /Bearer/);
  assert.equal((await get({ authorization: `Bearer ${token}x` })).status, 401);
  assert.equal((await get({ authorization: token })).status, 401, "not a bearer header");

  assert.equal((await get(VIA_TUNNEL)).status, 404, "tunnel without the token");
  assert.equal((await get({ ...VIA_TUNNEL, authorization: "Bearer nope" })).status, 404, "tunnel with a wrong token");
});

test("production without METRICS_PUBLIC or a token still fails closed", async () => {
  const get = await serve({ token: null, allowPublic: false, production: true });
  assert.equal((await get()).status, 401);
  assert.equal((await get(VIA_TUNNEL)).status, 404);
});

test("dev: open directly, still hidden from anything that came through Cloudflare", async () => {
  const get = await serve({ token: null, allowPublic: false, production: false });
  assert.equal((await get()).status, 200);
  assert.equal((await get(VIA_TUNNEL)).status, 404);
});

test("cameThroughCloudflare reads only Cloudflare's own headers", () => {
  assert.equal(cameThroughCloudflare({}), false);
  assert.equal(cameThroughCloudflare({ "x-forwarded-for": "203.0.113.9", "user-agent": "Prometheus/2.53.0" }), false);
  assert.equal(cameThroughCloudflare({ "cdn-loop": "fastly" }), false);
  assert.equal(cameThroughCloudflare({ "cf-ray": "" }), true, "present counts, even empty");
  assert.equal(cameThroughCloudflare({ "cf-connecting-ip": "::1" }), true);
});
