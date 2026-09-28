// Shared places (WA Art 4.1.5: equal totals share the place, the next
// place skips). The Control Room's standings, the scoreboard's "Currently
// Nth" and catch-up, and the recap's rank badges all numbered by list
// position, so two divers on the same total read as 1st and 2nd. DB-less.
const { test } = require("node:test");
const assert = require("node:assert/strict");

let mod;
async function load() {
  if (!mod) mod = await import("../src/lib/standings.js");
  return mod;
}

test("equal totals share the place and the next place skips", async () => {
  const { sharedRanks } = await load();
  const rows = [{ total: "300.50" }, { total: "300.50" }, { total: 290 }, { total: 280 }, { total: 280 }, { total: 270 }];
  assert.deepEqual(sharedRanks(rows), [1, 1, 3, 4, 4, 6]);
});

test("floating-point noise doesn't split a tie", async () => {
  const { sharedRanks } = await load();
  assert.deepEqual(sharedRanks([{ total: 0.1 + 0.2 }, { total: 0.3 }]), [1, 1]);
});

test("a server-supplied rank wins, list position is the last resort", async () => {
  const { placeOf } = await load();
  const rows = [{ total: 300, rank: "1" }, { total: 300, rank: "1" }, { total: 250, rank: "3" }];
  assert.equal(placeOf(rows, 1), 1);
  assert.equal(placeOf(rows, 2), 3);
  // no rank on the rows: computed from the totals
  assert.equal(placeOf([{ total: 5 }, { total: 5 }], 1), 1);
  assert.equal(placeOf([], 0), null);
  assert.equal(placeOf(rows, -1), null);
});
