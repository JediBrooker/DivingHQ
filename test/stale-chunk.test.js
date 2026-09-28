// src/lib/staleChunk.js: spotting a chunk that vanished in a deploy, and
// reloading for it at most once.

const { test } = require("node:test");
const assert = require("node:assert/strict");

let isStaleChunkError, reloadOnce;
test.before(async () => {
  ({ isStaleChunkError, reloadOnce } = await import("../src/lib/staleChunk.js"));
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test("recognises the dynamic-import failures each engine reports", () => {
  for (const msg of [
    "Failed to fetch dynamically imported module: https://divinghq.app/assets/GuideView-abc.js",
    "error loading dynamically imported module: https://divinghq.app/assets/x.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/GuideView-abc.css",
    "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of \"text/html\". 'text/html' is not a valid JavaScript MIME type.",
  ]) {
    assert.equal(isStaleChunkError(new Error(msg)), true, msg);
  }
  assert.equal(isStaleChunkError(new Error("Cannot read properties of undefined")), false);
  assert.equal(isStaleChunkError(null), false);
});

test("reloads once, then holds off inside the window", () => {
  const storage = memoryStorage();
  let n = 0;
  const go = () => n++;
  assert.equal(reloadOnce({ storage, now: 1_000_000, go }), true);
  assert.equal(reloadOnce({ storage, now: 1_004_000, go }), false);
  assert.equal(n, 1);
  // Long after, a fresh failure gets its own single try.
  assert.equal(reloadOnce({ storage, now: 1_060_000, go }), true);
  assert.equal(n, 2);
});

test("no storage, no reload (there'd be nothing stopping a loop)", () => {
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  let n = 0;
  assert.equal(reloadOnce({ storage, go: () => n++ }), false);
  assert.equal(n, 0);
});
