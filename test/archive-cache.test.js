// lib/archive-cache.js: the 60s cache in front of /api/archive and
// /api/archive/clubs. The listing's status field picks the live vs recap
// layout, so a rebuild that raced a status flip mustn't get cached.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const archiveCache = require("../lib/archive-cache");

test("a rebuild that raced an invalidate doesn't get cached", () => {
  archiveCache.invalidate();
  const gen = archiveCache.generation();
  // ...listing query in flight, then the event flips to Completed:
  archiveCache.invalidate();
  archiveCache.set("archive", [{ status: "Live" }], gen);
  assert.equal(archiveCache.get("archive"), null, "the stale listing was dropped");

  archiveCache.set("archive", [{ status: "Completed" }], archiveCache.generation());
  assert.deepEqual(archiveCache.get("archive"), [{ status: "Completed" }]);
});

test("callers without a generation still write, and invalidate clears both keys", () => {
  archiveCache.invalidate();
  archiveCache.set("archive", [1]);
  archiveCache.set("clubs", [2]);
  assert.deepEqual(archiveCache.get("archive"), [1]);
  assert.deepEqual(archiveCache.get("clubs"), [2]);
  archiveCache.invalidate();
  assert.equal(archiveCache.get("archive"), null);
  assert.equal(archiveCache.get("clubs"), null);
});
