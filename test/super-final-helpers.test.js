// Unit coverage for the dive-off tie-break helpers used to wire a
// recorded dive-off (tiebreak_dive_offs, Appendix 3 §6) into the
// Super-Final H2H pair results and SF-group finalist selection.
// Pure functions, no DB involved.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  diveOffPairKey,
  resolvePairWinner,
  compareSfFinalists,
} = require("../lib/super-final-helpers");

test("diveOffPairKey is order-independent and pair-specific", () => {
  assert.equal(diveOffPairKey("a", "b"), diveOffPairKey("b", "a"));
  assert.notEqual(diveOffPairKey("a", "b"), diveOffPairKey("a", "c"));
});

test("resolvePairWinner: distinct totals → higher total wins, resolved_by total", () => {
  const r = resolvePairWinner("a", 100, "b", 90, new Map());
  assert.deepEqual(r, { winner_id: "a", tied_on_total: false, resolved_by: "total" });
  assert.equal(resolvePairWinner("a", 80, "b", 90, new Map()).winner_id, "b");
});

test("resolvePairWinner: tied with no dive-off → unresolved", () => {
  const r = resolvePairWinner("a", 100, "b", 100, new Map());
  assert.deepEqual(r, { winner_id: null, tied_on_total: true, resolved_by: null });
});

test("resolvePairWinner: tied with a dive-off → dive-off winner", () => {
  const m = new Map([[diveOffPairKey("a", "b"), "b"]]);
  const r = resolvePairWinner("a", 100, "b", 100, m);
  assert.deepEqual(r, { winner_id: "b", tied_on_total: true, resolved_by: "dive_off" });
});

test("resolvePairWinner: a stale dive-off is ignored once totals differ", () => {
  const m = new Map([[diveOffPairKey("a", "b"), "b"]]);
  const r = resolvePairWinner("a", 110, "b", 100, m);
  assert.equal(r.winner_id, "a");
  assert.equal(r.resolved_by, "total");
});

test("resolvePairWinner tolerates a missing dive-off map", () => {
  const r = resolvePairWinner("a", 100, "b", 100, undefined);
  assert.deepEqual(r, { winner_id: null, tied_on_total: true, resolved_by: null });
});

test("compareSfFinalists: cumulative desc, dive-off breaks an equal total", () => {
  const A = { competitor_id: "a", cumulative_total: 150 };
  const B = { competitor_id: "b", cumulative_total: 150 };
  const C = { competitor_id: "c", cumulative_total: 120 };
  // distinct → higher cumulative sorts first
  assert.ok(compareSfFinalists(A, C, new Map()) < 0);
  // tied, no dive-off → 0 (stable, caller refuses)
  assert.equal(compareSfFinalists(A, B, new Map()), 0);
  // tied, dive-off says B → B ahead of A
  const m = new Map([[diveOffPairKey("a", "b"), "b"]]);
  assert.ok(compareSfFinalists(A, B, m) > 0);
  assert.ok(compareSfFinalists(B, A, m) < 0);
  // full sort: B (dive-off winner) then A then C
  const sorted = [A, B, C].sort((x, y) => compareSfFinalists(x, y, m));
  assert.deepEqual(sorted.map((s) => s.competitor_id), ["b", "a", "c"]);
});
