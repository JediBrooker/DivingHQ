// routes/diver-profile.js: the bits of /api/divers/:id/analytics that
// moved out of SQL. placings and streak are now counted in JS from the
// one FULL_FIELD_RANKING read, so pin that they give what the old
// COUNT(*) FILTER query and streak loop gave.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { placingsFrom, streakFrom } =
  require("../routes/diver-profile").__test__;

// pg returns RANK() (bigint) as a string, so the fixtures do too.
const rows = (...ranks) => ranks.map((rank) => ({ rank: String(rank) }));

test("placings buckets ranks the way the old SQL did", () => {
  assert.deepEqual(placingsFrom(rows(1, 2, 3, 4, 8, 9, 1, 12)), {
    gold: 2, silver: 1, bronze: 1, finalist: 2, further: 2, total_meets: 8,
  });
});

test("placings with no meets is the all-zero object, keys in the same order", () => {
  const p = placingsFrom([]);
  assert.deepEqual(p, { gold: 0, silver: 0, bronze: 0, finalist: 0, further: 0, total_meets: 0 });
  assert.deepEqual(Object.keys(p), ["gold", "silver", "bronze", "finalist", "further", "total_meets"]);
});

test("streak counts wins, then podiums, newest first", () => {
  assert.deepEqual(streakFrom(rows(1, 1, 1, 5)), { kind: "win", length: 3 });
  assert.deepEqual(streakFrom(rows(1, 2, 1, 4)), { kind: "podium", length: 3 });
  assert.deepEqual(streakFrom(rows(3, 2, 1, 9)), { kind: "podium", length: 3 });
  assert.deepEqual(streakFrom(rows(4, 1, 1)), { kind: null, length: 0 });
  assert.deepEqual(streakFrom([]), { kind: null, length: 0 });
});
