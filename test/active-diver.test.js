// The set_active_diver payload the Control Room sends, and how the judge
// screen and scoreboard read it back. DB-less, runs in test:safe.
const { test } = require("node:test");
const assert = require("node:assert/strict");

let mod;
async function load() {
  if (!mod) mod = await import("../src/lib/activeDiver.js");
  return mod;
}

const row = {
  event_id: "ev1", competitor_id: "c1", full_name: "Ana Diver",
  round_number: 2, dive_code: "105", position: "B", dd: 2.4,
  description: "Forward 2½ Somersaults", country_code: "AUS",
  number_of_judges: 5, event_type: "individual",
};

test("the payload carries the display fields the judge screen and scoreboard render", async () => {
  const { activeDiverPayload } = await load();
  const p = activeDiverPayload(row, { id: "ev1", name: "Women 3m" });
  assert.equal(p.diverName, "Ana Diver");
  assert.equal(p.diveCode, "105B");
  assert.equal(p.eventName, "Women 3m");
  assert.equal(p.status, "ready");
  // the raw row rides along, the server keys on these
  assert.equal(p.competitor_id, "c1");
  assert.equal(p.round_number, 2);
  assert.equal(p.dd, 2.4);
});

test("missing pieces come through as null, not empty strings or 'undefined'", async () => {
  const { activeDiverPayload } = await load();
  const p = activeDiverPayload({ ...row, dive_code: null, position: null, description: "" }, null);
  assert.equal(p.diveCode, null);
  assert.equal(p.position, null);
  assert.equal(p.description, null);
  assert.equal(p.eventName, null);
  assert.equal(activeDiverPayload(null, {}), null);
});

test("a payload persisted without the display fields is filled from the raw row", async () => {
  const { normaliseActiveDiver } = await load();
  const n = normaliseActiveDiver({ ...row, status: "ready" });
  assert.equal(n.diverName, "Ana Diver");
  assert.equal(n.diveCode, "105B");
});

test("a payload that already has them is left alone", async () => {
  const { normaliseActiveDiver } = await load();
  const n = normaliseActiveDiver({ ...row, diverName: "Shown Name", diveCode: "5132D" });
  assert.equal(n.diverName, "Shown Name");
  assert.equal(n.diveCode, "5132D");
  assert.equal(normaliseActiveDiver(null), null);
});
