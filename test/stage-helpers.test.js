// routes/events/stage-helpers.js: the shared stage-seeding writes and
// the lock-window parse. DB-free: a fake db records what would be sent.
// The end-to-end effect (who lands in which slot) is covered by the
// advance and super-final-* Playwright specs.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseLockMinutes,
  insertDiveListRows,
  loadStop1Lists,
  insertRoundDives,
} = require("../routes/events/stage-helpers");

function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows }; },
  };
}

test("parseLockMinutes: default 30, clamped to 0..1440", () => {
  assert.equal(parseLockMinutes(undefined), 30);
  assert.equal(parseLockMinutes("soon"), 30);
  assert.equal(parseLockMinutes("45"), 45);
  assert.equal(parseLockMinutes(12.9), 12);
  assert.equal(parseLockMinutes(-10), 0);
  assert.equal(parseLockMinutes(0), 0);
  assert.equal(parseLockMinutes(99999), 1440);
});

test("parseLockMinutes: the Super Final final's own floor and default", () => {
  assert.equal(parseLockMinutes(undefined, { def: 15, min: 5 }), 15);
  assert.equal(parseLockMinutes(2, { def: 15, min: 5 }), 5);
  assert.equal(parseLockMinutes(20, { def: 15, min: 5 }), 20);
});

test("insertDiveListRows: one INSERT, columns aligned, gaps as NULL / FALSE", async () => {
  const db = fakeDb();
  await insertDiveListRows(db, "ev-1", [
    { competitor_id: "a", dive_id: "d1", round_number: 1, display_order: 2, group_number: 1, partner_id: "p" },
    { competitor_id: "b", dive_id: null, round_number: 1, is_reserve: true, reserve_position: 1 },
    { competitor_id: "c", round_number: 2, display_order: undefined, team_id: "t" },
  ]);
  assert.equal(db.calls.length, 1);
  const { sql, params } = db.calls[0];
  assert.match(sql, /INSERT INTO competitor_dive_lists/);
  assert.match(sql, /FROM UNNEST\(\$2::uuid\[\], \$3::uuid\[\], \$4::uuid\[\], \$5::uuid\[\], \$6::int\[\],\s+\$7::int\[\], \$8::int\[\], \$9::boolean\[\], \$10::int\[\]\)/);
  assert.deepEqual(params, [
    "ev-1",
    ["a", "b", "c"],          // competitor_id
    ["p", null, null],        // partner_id, a synchro pair carried along
    [null, null, "t"],        // team_id
    ["d1", null, null],       // dive_id
    [1, 1, 2],                // round_number
    [2, null, null],          // display_order
    [1, null, null],          // group_number
    [false, true, false],     // is_reserve
    [null, 1, null],          // reserve_position
  ]);
});

test("insertDiveListRows: nothing to seed, nothing sent", async () => {
  const db = fakeDb();
  await insertDiveListRows(db, "ev-1", []);
  assert.equal(db.calls.length, 0);
});

test("loadStop1Lists: competitor -> round -> dive, rounds as numbers", async () => {
  const db = fakeDb([
    { competitor_id: "a", round_number: "4", dive_id: "d4" },
    { competitor_id: "a", round_number: 5, dive_id: "d5" },
    { competitor_id: "b", round_number: 4, dive_id: null },
  ]);
  const lists = await loadStop1Lists(db, "stop1", ["a", "b"]);
  assert.deepEqual(db.calls[0].params, ["stop1", ["a", "b"]]);
  assert.match(db.calls[0].sql, /withdrawn_at IS NULL\s+AND is_reserve = FALSE/);
  assert.equal(lists.get("a").get(4), "d4");
  assert.equal(lists.get("a").get(5), "d5");
  assert.equal(lists.get("b").get(4), null);
  assert.equal(lists.has("c"), false);
});

test("insertRoundDives: blank dive and height become NULL, height as a number", async () => {
  const db = fakeDb();
  await insertRoundDives(db, "ev-2", [
    { round_number: 1, dive_id: "d1", height: "3" },
    { round_number: 2, dive_id: "", height: "" },
    { round_number: 3, dive_id: null, height: null },
    { round_number: 4, height: 10 },
  ]);
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, [
    "ev-2",
    [1, 2, 3, 4],
    ["d1", null, null, null],
    [3, null, null, 10],
  ]);
  await insertRoundDives(db, "ev-2", []);
  assert.equal(db.calls.length, 1, "an empty list sends nothing");
});
