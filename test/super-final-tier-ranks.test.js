// Unit coverage for assignSharedTierRanks, the within-tier shared-
// place ranking used to assemble the Super-Final 1-12 standings.
// World Aquatics Art 4.1.5 (equal totals share a place) + Diving World
// Cup §3.1.2 (tied prize positions split equally). DB-less.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assignSharedTierRanks } = require("../routes/events/super-final-bridge");

const total = (r) => r.total;
const ranks = (out) => out.map((o) => o.rank);
const tied = (out) => out.map((o) => o.is_tied);

test("distinct totals → sequential ranks from the base, none tied", () => {
  const out = assignSharedTierRanks(
    [{ total: 100 }, { total: 90 }, { total: 80 }, { total: 70 }], 1, total,
  );
  assert.deepEqual(ranks(out), [1, 2, 3, 4]);
  assert.deepEqual(tied(out), [false, false, false, false]);
});

test("a tie shares the rank and the next skips (1, 2, 2, 4)", () => {
  const out = assignSharedTierRanks(
    [{ total: 100 }, { total: 90 }, { total: 90 }, { total: 80 }], 1, total,
  );
  assert.deepEqual(ranks(out), [1, 2, 2, 4]);
  assert.deepEqual(tied(out), [false, true, true, false]);
});

test("base offset is respected (tier 2 starts at position 5)", () => {
  const out = assignSharedTierRanks([{ total: 60 }, { total: 50 }], 5, total);
  assert.deepEqual(ranks(out), [5, 6]);
  assert.deepEqual(tied(out), [false, false]);
});

test("tie at the tier base shares the base rank (5, 5), trailing continues", () => {
  const out = assignSharedTierRanks(
    [{ total: 60 }, { total: 60 }, { total: 40 }], 5, total,
  );
  assert.deepEqual(ranks(out), [5, 5, 7]);
  assert.deepEqual(tied(out), [true, true, false]);
});

test("the next tier base = base + competitor count (a shared place still consumes a slot)", () => {
  // Four finalists, two tied for 2nd → ranks 1,2,2,4 but 4 slots used,
  // so tier 2 must start at base 1 + 4 = 5.
  const t1 = assignSharedTierRanks(
    [{ total: 100 }, { total: 90 }, { total: 90 }, { total: 80 }], 1, total,
  );
  const nextBase = 1 + t1.length;
  assert.equal(nextBase, 5);
});

test("string totals (numeric coming back from pg) are coerced", () => {
  const out = assignSharedTierRanks(
    [{ total: "100.00" }, { total: "100.00" }, { total: "90.00" }], 1, total,
  );
  assert.deepEqual(ranks(out), [1, 1, 3]);
  assert.deepEqual(tied(out), [true, true, false]);
});

test("custom total accessor (cumulative_total for the SF tier)", () => {
  const out = assignSharedTierRanks(
    [{ cumulative_total: 150 }, { cumulative_total: 150 }], 5,
    (r) => r.cumulative_total,
  );
  assert.deepEqual(ranks(out), [5, 5]);
  assert.deepEqual(tied(out), [true, true]);
});
