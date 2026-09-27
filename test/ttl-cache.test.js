// lib/ttl-cache.js: the storage under lib/scoreboard-cache.js and
// lib/archive-cache.js. Their own behaviour is pinned in
// test/scoreboard-cache.test.js; this covers the shared bits.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const createTtlCache = require("../lib/ttl-cache");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("get returns what was set until the TTL runs out", async () => {
  const c = createTtlCache({ ttlMs: 20 });
  c.set("a", { n: 1 });
  assert.deepEqual(c.get("a"), { n: 1 });
  await wait(30);
  assert.equal(c.get("a"), null);
});

test("null and undefined aren't cached, missing keys read as null", () => {
  const c = createTtlCache({ ttlMs: 1000 });
  c.set("a", null);
  c.set("b", undefined);
  assert.equal(c.get("a"), null);
  assert.equal(c.get("b"), null);
  assert.equal(c.get("nope"), null);
  // Falsy but real values are kept.
  c.set("zero", 0);
  c.set("empty", []);
  assert.equal(c.get("zero"), 0);
  assert.deepEqual(c.get("empty"), []);
});

test("delete, deletePrefix and clear", () => {
  const c = createTtlCache({ ttlMs: 1000 });
  for (const k of ["ev1", "ev1::lb", "ev1::x", "ev10::lb", "ev2"]) c.set(k, k);
  c.delete("ev2");
  assert.equal(c.get("ev2"), null);
  c.deletePrefix("ev1::");
  assert.equal(c.get("ev1::lb"), null);
  assert.equal(c.get("ev1::x"), null);
  assert.equal(c.get("ev1"), "ev1", "the bare key isn't part of the prefix");
  assert.equal(c.get("ev10::lb"), "ev10::lb", "a longer id sharing the start survives");
  c.clear();
  assert.equal(c.get("ev1"), null);
  assert.equal(c.get("ev10::lb"), null);
});

test("a TTL is required", () => {
  assert.throws(() => createTtlCache({}), /positive ttlMs/);
});
