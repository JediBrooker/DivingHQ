// The scoreboard's catch-up sums (src/lib/catchUp.js). The box counted the
// dive on the board as still to come after it had been scored, so after
// the last dive of an event it said "1 dive left". It counts the diver's
// unscored dives now, the same payload the standings come from.

const { test } = require("node:test");
const assert = require("node:assert/strict");

let mod;
async function load() {
  if (!mod) mod = await import("../src/lib/catchUp.js");
  return mod;
}

const row = (competitor_id, round_number, dd) => ({ competitor_id, round_number, dd });

test("dives left are the diver's unscored rows, nobody else's", async () => {
  const { divesLeft } = await load();
  const upcoming = [row("a", 2, "2.0"), row("b", 2, "1.5"), row("a", 3, "3.0"), row("b", 3, "1.5")];
  assert.deepEqual(divesLeft(upcoming, "a"), { count: 2, avgDd: 2.5 });
  // The dive just scored is out of the queue, so it isn't counted again.
  assert.deepEqual(divesLeft([row("a", 3, "3.0")], "a"), { count: 1, avgDd: 3 });
  // After the event's last dive there's nothing, not one.
  assert.deepEqual(divesLeft([], "a"), { count: 0, avgDd: null });
  assert.deepEqual(divesLeft([row("b", 3, 1.5)], "a"), { count: 0, avgDd: null });
  // A row with no DD still counts as a dive.
  assert.deepEqual(divesLeft([row("a", 2, null), row("a", 3, "2.0")], "a"), { count: 2, avgDd: 2 });
});

test("dives left can't be told without an id or a queue", async () => {
  const { divesLeft } = await load();
  assert.equal(divesLeft([row("a", 2, 2)], null), null);
  assert.equal(divesLeft(null, "a"), null);
  assert.equal(divesLeft(undefined, "a"), null);
});

test("the score to close a gap, rounded up to a half point", async () => {
  const { scoreToClose } = await load();
  // 10.5 points over 1 dive of DD 1.5 with 3 kept scores: 10.5 / 4.5 = 2.33, so 2.5
  assert.deepEqual(scoreToClose(10.5, { dives: 1, dd: 1.5, mult: 3 }), { score: 2.5, possible: true });
  // the same gap over two dives needs half as much
  assert.deepEqual(scoreToClose(10.5, { dives: 2, dd: 1.5, mult: 3 }), { score: 1.5, possible: true });
  // straight 10s don't get there
  assert.deepEqual(scoreToClose(100, { dives: 1, dd: 2, mult: 3 }), { score: 17, possible: false });
  // 9.6 raw needs straight 10s, which is still possible
  assert.deepEqual(scoreToClose(57.6, { dives: 1, dd: 2, mult: 3 }), { score: 10, possible: true });
  // already level or ahead
  assert.deepEqual(scoreToClose(0, { dives: 1, dd: 2, mult: 3 }), { score: 0, possible: true });
  assert.deepEqual(scoreToClose(-4, { dives: 0, dd: 2, mult: 3 }), { score: 0, possible: true });
});

test("no dives left means a gap can't close; an unknown count gives no answer", async () => {
  const { scoreToClose } = await load();
  assert.deepEqual(scoreToClose(7.2, { dives: 0, dd: 2, mult: 3 }), { score: null, possible: false });
  assert.deepEqual(scoreToClose(7.2, { dives: null, dd: 2, mult: 3 }), { score: null, possible: null });
  assert.deepEqual(scoreToClose(7.2, { dives: 2, dd: null, mult: 3 }), { score: null, possible: null });
});
