// lib/scoped-limiter.js: a limiter mounted with limitRoutes() counts
// only the requests its own router answers.
//
// The bug it replaced: app.use(limiter, router) mounts both at "/", so
// every request that walked past counted, and a spectator's scoreboard
// polls or a plain page load could spend (and exhaust) the search and
// export buckets meant for other endpoints.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { limitRoutes } = require("../lib/scoped-limiter");

function tinyLimiter() {
  return rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: "draft-7", legacyHeaders: false });
}

async function withApp(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn((p) => fetch(base + p).then((r) => r.status));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a scoped limiter ignores requests for routes mounted after it", async () => {
  const guarded = express.Router();
  guarded.get("/api/heavy/:id", (_req, res) => res.json({ ok: true }));
  const later = express.Router();
  later.get("/api/scoreboard/:id", (_req, res) => res.json({ ok: true }));

  const app = express();
  app.use(limitRoutes(tinyLimiter(), guarded));
  app.use(later);
  app.use((_req, res) => res.status(404).send("fallback"));

  await withApp(app, async (get) => {
    for (let i = 0; i < 6; i++) assert.equal(await get("/api/scoreboard/abc"), 200);
    for (let i = 0; i < 6; i++) assert.equal(await get("/some/page"), 404);
    assert.equal(await get("/api/heavy/1"), 200);
    assert.equal(await get("/api/heavy/2"), 200);
    assert.equal(await get("/api/heavy/3"), 429, "its own routes are still limited");
  });
});

test("the unscoped mount it replaces really did count everything", async () => {
  // Pins the reason limitRoutes exists, so nobody "simplifies" it back.
  const guarded = express.Router();
  guarded.get("/api/heavy/:id", (_req, res) => res.json({ ok: true }));
  const later = express.Router();
  later.get("/api/scoreboard/:id", (_req, res) => res.json({ ok: true }));

  const app = express();
  app.use(tinyLimiter(), guarded);
  app.use(later);

  await withApp(app, async (get) => {
    assert.equal(await get("/api/scoreboard/a"), 200);
    assert.equal(await get("/api/scoreboard/b"), 200);
    assert.equal(await get("/api/scoreboard/c"), 429);
  });
});

test("limitRoutes refuses a router whose paths it can't see", () => {
  const nested = express.Router();
  nested.use((_req, _res, next) => next());
  assert.throws(() => limitRoutes(tinyLimiter(), nested), /middleware layers/);
});

test("server.js mounts no limiter bare in front of a router", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const bare = src.match(/app\.use\(\s*(createSearchLimiter\(\)|exportLimiter|bulkWriteLimiter|authLimiter)\s*,/g);
  assert.equal(bare, null, `use limitRoutes() instead: ${bare}`);
});

test("the public records read is throttled like the other public reads", () => {
  // GET /api/records dropped verifyToken for the /records page. Anything
  // anonymous that hits the database gets a limiter in this app, so
  // don't let a refactor quietly mount it bare again.
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /app\.use\(limitRoutes\(createSearchLimiter\(\),\s*recordsRouter\)\)/);
  assert.doesNotMatch(src, /app\.use\(recordsRouter\)/);
});
