// routes/diver-profile.js: the bits of /api/divers/:id/analytics that
// moved out of SQL. placings and streak are now counted in JS from the
// one FULL_FIELD_RANKING read, so pin that they give what the old
// COUNT(*) FILTER query and streak loop gave.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { placingsFrom, streakFrom, splitRankedRows } =
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

test("splitRankedRows gives back the two old row shapes, in order", () => {
  const nulls = { year: null, meets: null, avg_meet_total: null, best_meet_total: null, wins: null, podiums: null };
  const ev = (id, rank) => ({
    kind: "event", event_id: id, event_name: `Meet ${id}`, created_at: new Date(0),
    total: "250.50", rank: String(rank), field_size: 12, ...nulls,
  });
  const yr = (year, meets) => ({
    kind: "year", event_id: null, event_name: null, created_at: null, total: null, rank: null, field_size: null,
    year, meets, avg_meet_total: "240.10", best_meet_total: "250.50", wins: 1, podiums: 2,
  });
  const { ranked, yearOverYear } = splitRankedRows([ev("b", 1), ev("a", 3), yr(2026, 1), yr(2025, 1)]);
  assert.deepEqual(ranked.map((r) => r.event_id), ["b", "a"]);
  assert.deepEqual(Object.keys(ranked[0]),
    ["event_id", "event_name", "created_at", "total", "rank", "field_size"]);
  assert.equal(ranked[1].rank, "3");
  assert.deepEqual(yearOverYear.map((r) => r.year), [2026, 2025]);
  assert.deepEqual(Object.keys(yearOverYear[0]),
    ["year", "meets", "avg_meet_total", "best_meet_total", "wins", "podiums"]);
  // The widgets still read the same ranks off the event rows.
  assert.deepEqual(placingsFrom(ranked), { gold: 1, silver: 0, bronze: 1, finalist: 0, further: 0, total_meets: 2 });
  assert.deepEqual(splitRankedRows([]), { ranked: [], yearOverYear: [] });
});
