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

// getOrBuild: the post-score stampede. Everyone who misses at once
// should share one build, but only within a generation.

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("concurrent misses share one build and the result gets cached", async () => {
  const cache = createScoreboardCache();
  const gate = deferred();
  let builds = 0;
  const build = () => { builds++; return gate.promise; };
  const waiters = [
    cache.getOrBuild("ev-1", null, build),
    cache.getOrBuild("ev-1", null, build),
    cache.getOrBuild("ev-1", null, build),
  ];
  gate.resolve({ standings: [1] });
  const got = await Promise.all(waiters);
  assert.equal(builds, 1);
  for (const p of got) assert.deepEqual(p, { standings: [1] });
  assert.deepEqual(cache.get("ev-1"), { standings: [1] });
});

test("main payload and each derived kind build separately", async () => {
  const cache = createScoreboardCache();
  let builds = 0;
  const build = (v) => () => { builds++; return Promise.resolve(v); };
  const [main, lb] = await Promise.all([
    cache.getOrBuild("ev-1", null, build({ m: 1 })),
    cache.getOrBuild("ev-1", "leaderboard", build({ rounds: [] })),
  ]);
  assert.equal(builds, 2);
  assert.deepEqual(main, { m: 1 });
  assert.deepEqual(lb, { rounds: [] });
  assert.deepEqual(cache.getDerived("ev-1", "leaderboard"), { rounds: [] });
});

test("a request after an invalidate doesn't join the older build", async () => {
  const cache = createScoreboardCache();
  const first = deferred();
  const second = deferred();
  const old = cache.getOrBuild("ev-1", null, () => first.promise);
  cache.invalidate("ev-1");
  const fresh = cache.getOrBuild("ev-1", null, () => second.promise);
  first.resolve({ v: "old" });
  second.resolve({ v: "new" });
  assert.deepEqual(await old, { v: "old" }, "the earlier waiters still get their answer");
  assert.deepEqual(await fresh, { v: "new" });
  assert.deepEqual(cache.get("ev-1"), { v: "new" }, "only the post-invalidate build is cached");
});

test("a failed build rejects every waiter and isn't pinned", async () => {
  const cache = createScoreboardCache();
  const gate = deferred();
  const a = cache.getOrBuild("ev-1", null, () => gate.promise);
  const b = cache.getOrBuild("ev-1", null, () => gate.promise);
  gate.reject(new Error("db went away"));
  await assert.rejects(a, /db went away/);
  await assert.rejects(b, /db went away/);
  assert.equal(cache.get("ev-1"), null);
  // Next miss runs a new build rather than replaying the failure.
  const again = await cache.getOrBuild("ev-1", null, () => Promise.resolve({ ok: true }));
  assert.deepEqual(again, { ok: true });
});
