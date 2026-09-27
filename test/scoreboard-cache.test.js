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
