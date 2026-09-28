// lib/archive-cache.js: the 60s cache in front of /api/archive and
// /api/archive/clubs.
//
// What's worth pinning is the generation guard. The listing's `status`
// picks the scoreboard's live vs recap layout, and a rebuild that
// started before a status flip used to finish after the flip's
// invalidate and cache the old status for a whole minute.
//
// The cache is a module singleton, so every test starts with an
// invalidate() to wipe whatever the previous one left behind.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const archiveCache = require("../lib/archive-cache");

test("a listing that raced a status flip doesn't get cached", () => {
  archiveCache.invalidate();
  const gen = archiveCache.generation();
  // ...listing query in flight, then the event flips to Completed:
  archiveCache.invalidate();
  archiveCache.set("archive", [{ id: "ev-1", status: "Live" }], gen);
  assert.equal(archiveCache.get("archive"), null, "the stale rows were dropped");

  // Same goes for the clubs key, it shares the counter.
  archiveCache.set("clubs", [{ id: "club-1" }], gen);
  assert.equal(archiveCache.get("clubs"), null);
});

test("a listing read at the current generation still caches", () => {
  archiveCache.invalidate();
  const gen = archiveCache.generation();
  const rows = [{ id: "ev-1", status: "Completed" }];
  archiveCache.set("archive", rows, gen);
  assert.deepEqual(archiveCache.get("archive"), rows);
  archiveCache.set("clubs", [{ id: "club-1" }], gen);
  assert.deepEqual(archiveCache.get("clubs"), [{ id: "club-1" }]);
});

test("the rebuild after the flip caches fine", () => {
  archiveCache.invalidate();
  const stale = archiveCache.generation();
  archiveCache.invalidate();
  const next = archiveCache.generation();
  assert.notEqual(next, stale);
  archiveCache.set("archive", [{ id: "ev-1", status: "Live" }], stale);
  archiveCache.set("archive", [{ id: "ev-1", status: "Completed" }], next);
  assert.deepEqual(archiveCache.get("archive"), [{ id: "ev-1", status: "Completed" }]);
});

test("callers without a generation keep the old unconditional write", () => {
  archiveCache.invalidate();
  archiveCache.set("archive", [{ id: "ev-1" }]);
  assert.deepEqual(archiveCache.get("archive"), [{ id: "ev-1" }]);
});

test("invalidate still clears both keys", () => {
  archiveCache.invalidate();
  const gen = archiveCache.generation();
  archiveCache.set("archive", [{ id: "ev-1" }], gen);
  archiveCache.set("clubs", [{ id: "club-1" }], gen);
  archiveCache.invalidate();
  assert.equal(archiveCache.get("archive"), null);
  assert.equal(archiveCache.get("clubs"), null);
});
