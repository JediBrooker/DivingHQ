// lib/scoreboard-cache.js: the in-memory cache in front of
// /api/scoreboard/:eventId and its leaderboard.
//
// The part worth pinning is the generation guard. A rebuild that started
// before an invalidate and finished after it used to cache what it read,
// so a fresh score (or a record, whose transaction commits a moment
// after the score) went missing for a whole TTL.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const createScoreboardCache = require("../lib/scoreboard-cache");

test("a rebuild that raced an invalidate doesn't get cached", () => {
  const cache = createScoreboardCache();
  const gen = cache.generation("ev-1");
  // ...queries in flight, then the records transaction commits:
  cache.invalidate("ev-1");
  cache.set("ev-1", { records: [] }, gen);
  assert.equal(cache.get("ev-1"), null, "the stale payload was dropped");

  // The rebuild after it is fine.
  const next = cache.generation("ev-1");
  assert.notEqual(next, gen);
  cache.set("ev-1", { records: ["mark"] }, next);
  assert.deepEqual(cache.get("ev-1"), { records: ["mark"] });
});

test("derived payloads follow the same rule", () => {
  const cache = createScoreboardCache();
  const gen = cache.generation("ev-1");
  cache.invalidate("ev-1");
  cache.setDerived("ev-1", "leaderboard", { rounds: [] }, gen);
  assert.equal(cache.getDerived("ev-1", "leaderboard"), null);
  cache.setDerived("ev-1", "leaderboard", { rounds: [1] }, cache.generation("ev-1"));
  assert.deepEqual(cache.getDerived("ev-1", "leaderboard"), { rounds: [1] });
});

test("generations are per event, and callers without one still write", () => {
  const cache = createScoreboardCache();
  const gen = cache.generation("ev-1");
  cache.invalidate("ev-2");
  cache.set("ev-1", { ok: 1 }, gen);
  assert.deepEqual(cache.get("ev-1"), { ok: 1 }, "another event's invalidate doesn't count");

  cache.invalidate("ev-1");
  cache.set("ev-1", { ok: 2 });
  assert.deepEqual(cache.get("ev-1"), { ok: 2 });
});

test("invalidate still clears the payload and every derived one", () => {
  const cache = createScoreboardCache();
  cache.set("ev-1", { a: 1 });
  cache.setDerived("ev-1", "leaderboard", { b: 1 });
  cache.setDerived("ev-2", "leaderboard", { c: 1 });
  cache.invalidate("ev-1");
  assert.equal(cache.get("ev-1"), null);
  assert.equal(cache.getDerived("ev-1", "leaderboard"), null);
  assert.deepEqual(cache.getDerived("ev-2", "leaderboard"), { c: 1 });
});

test("entries expire after the TTL", async () => {
  const cache = createScoreboardCache({ ttlMs: 20 });
  cache.set("ev-1", { a: 1 });
  assert.deepEqual(cache.get("ev-1"), { a: 1 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cache.get("ev-1"), null);
});

// getOrBuild: the single flight in front of a rebuild. After a score,
// every open scoreboard refetches at once; they should cost one build.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("concurrent misses share one build, and the result is cached", async () => {
  const cache = createScoreboardCache();
  const d = deferred();
  let builds = 0;
  const build = () => { builds += 1; return d.promise; };
  const waiters = [1, 2, 3, 4, 5].map(() => cache.getOrBuild("ev-1", null, build));
  await Promise.resolve();
  d.resolve({ standings: ["x"] });
  const out = await Promise.all(waiters);
  assert.equal(builds, 1);
  for (const p of out) assert.deepEqual(p, { standings: ["x"] });
  assert.deepEqual(cache.get("ev-1"), { standings: ["x"] });
});

test("the main payload and a derived kind are separate flights", async () => {
  const cache = createScoreboardCache();
  let builds = 0;
  const [main, lb] = await Promise.all([
    cache.getOrBuild("ev-1", null, async () => { builds += 1; return { main: 1 }; }),
    cache.getOrBuild("ev-1", "leaderboard", async () => { builds += 1; return { rounds: [] }; }),
  ]);
  assert.equal(builds, 2);
  assert.deepEqual(main, { main: 1 });
  assert.deepEqual(lb, { rounds: [] });
  assert.deepEqual(cache.getDerived("ev-1", "leaderboard"), { rounds: [] });
});

test("a caller after an invalidate starts a fresh build, and the stale one isn't cached", async () => {
  const cache = createScoreboardCache();
  const early = deferred();
  const late = deferred();
  const builds = [];
  const first = cache.getOrBuild("ev-1", null, () => { builds.push("early"); return early.promise; });
  cache.invalidate("ev-1");
  const second = cache.getOrBuild("ev-1", null, () => { builds.push("late"); return late.promise; });
  await Promise.resolve();
  assert.deepEqual(builds, ["early", "late"]);

  early.resolve({ v: "old" });
  assert.deepEqual(await first, { v: "old" }, "the early caller still gets its answer");
  assert.equal(cache.get("ev-1"), null, "but it isn't cached");

  late.resolve({ v: "new" });
  assert.deepEqual(await second, { v: "new" });
  assert.deepEqual(cache.get("ev-1"), { v: "new" });
});

test("a failed build reaches every waiter and the next miss tries again", async () => {
  const cache = createScoreboardCache();
  const d = deferred();
  const waiters = [1, 2, 3].map(() => cache.getOrBuild("ev-1", null, () => d.promise));
  d.reject(new Error("pool exhausted"));
  const results = await Promise.allSettled(waiters);
  for (const r of results) {
    assert.equal(r.status, "rejected");
    assert.equal(r.reason.message, "pool exhausted");
  }
  assert.equal(cache.get("ev-1"), null);
  const again = await cache.getOrBuild("ev-1", null, async () => ({ ok: true }));
  assert.deepEqual(again, { ok: true });
});

test("a hit skips the build entirely", async () => {
  const cache = createScoreboardCache();
  cache.set("ev-1", { cached: true });
  const out = await cache.getOrBuild("ev-1", null, () => { throw new Error("shouldn't run"); });
  assert.deepEqual(out, { cached: true });
});
