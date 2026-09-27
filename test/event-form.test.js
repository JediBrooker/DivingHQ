// Unit tests for src/lib/event-form.js.
//
// The Meet Manager's create wizard and edit form used to each carry their
// own copy of these helpers, and the copies had started to drift. Now both
// forms send whatever these return, so the payload shapes get pinned here:
// the server's round-rules validator reads exactly these keys and coercions.

const { test } = require("node:test");
const assert = require("node:assert/strict");

let mod;
async function load() {
  if (!mod) mod = await import("../src/lib/event-form.js");
  return mod;
}

test("round_rules payload keeps the old coercions", async () => {
  const { roundRulesFromSections } = await load();
  assert.equal(roundRulesFromSections([]), null, "no sections means legacy dd_limit mode");

  const body = roundRulesFromSections([
    { label: "Voluntary", rounds: "4", dd_limit: "7.62", min_distinct_groups: "4" },
    { label: "", rounds: "", dd_limit: "", min_distinct_groups: "" },
    { label: "Optional", rounds: 2, dd_limit: null, min_distinct_groups: "0" },
  ]);
  // JSON.stringify is what goes on the wire, so compare that byte for byte.
  assert.equal(
    JSON.stringify(body),
    JSON.stringify({
      sections: [
        { label: "Voluntary", rounds: 4, dd_limit: 7.6, min_distinct_groups: 4 },
        { label: null, rounds: 0, dd_limit: null, min_distinct_groups: null },
        { label: "Optional", rounds: 2, dd_limit: null, min_distinct_groups: null },
      ],
    }),
  );
});

test("sections hydrate from stored round_rules and survive a round trip", async () => {
  const { sectionsFromRoundRules, roundRulesFromSections } = await load();
  assert.deepEqual(sectionsFromRoundRules(null), []);
  assert.deepEqual(sectionsFromRoundRules({}), []);
  assert.deepEqual(sectionsFromRoundRules({ sections: "nope" }), []);

  const stored = {
    sections: [
      { label: "Voluntary", rounds: 4, dd_limit: 7.6, min_distinct_groups: 4 },
      { label: null, rounds: 4, dd_limit: null, min_distinct_groups: null },
    ],
  };
  const rows = sectionsFromRoundRules(stored);
  assert.deepEqual(rows, [
    { label: "Voluntary", rounds: 4, dd_limit: "7.6", min_distinct_groups: "4" },
    { label: "", rounds: 4, dd_limit: "", min_distinct_groups: "" },
  ]);
  assert.deepEqual(roundRulesFromSections(rows), stored, "editing nothing saves what was loaded");
});

test("new sections and the rounds total", async () => {
  const { newRoundSection, roundSectionsTotal } = await load();
  assert.deepEqual(newRoundSection(0), { label: "Voluntary", rounds: 4, dd_limit: "", min_distinct_groups: "" });
  assert.equal(newRoundSection(1).label, "Optional");
  assert.equal(newRoundSection(0) === newRoundSection(0), false, "each call is a fresh row");
  assert.equal(roundSectionsTotal([]), 0);
  assert.equal(roundSectionsTotal([{ rounds: "4" }, { rounds: 3 }, { rounds: "" }]), 7);
});

test("blank slots always carry _meta and are independent objects", async () => {
  const { blankRoundSlot, blankRoundSlots } = await load();
  assert.deepEqual(blankRoundSlot(), { dive_id: null, height: null, _label: "", _meta: null });
  assert.deepEqual(blankRoundSlots(undefined), []);
  assert.deepEqual(blankRoundSlots(0), []);
  const three = blankRoundSlots(3);
  assert.equal(three.length, 3);
  three[0].dive_id = "x";
  assert.equal(three[1].dive_id, null, "slots must not share one object");
});

test("round_dives payload numbers the rounds and nulls empty heights", async () => {
  const { roundDivesPayload } = await load();
  assert.equal(
    JSON.stringify(roundDivesPayload([
      { dive_id: "d1", height: "3", _label: "x", _meta: {} },
      { dive_id: null, height: "", _label: "" },
      { dive_id: "", height: null },
      { dive_id: "d4", height: 10 },
    ])),
    JSON.stringify([
      { round_number: 1, dive_id: "d1", height: 3 },
      { round_number: 2, dive_id: null, height: null },
      { round_number: 3, dive_id: null, height: null },
      { round_number: 4, dive_id: "d4", height: 10 },
    ]),
  );
});
