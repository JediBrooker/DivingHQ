// Pure unit tests for the dive description / position helper in
// src/composables/useDiveLabel.js. No DB or HTTP required.
//
// The interesting case is the "trailing-position-word" guard:
// some dive directories store the position word inside the
// description ("Forward 2.5 SS Pike"), and a naive `desc + " " +
// posLabel` would render "Forward 2.5 SS Pike Pike" on the
// scoreboard. These tests lock the behaviour so that
// regression doesn't sneak back in.
//
// We dynamically import() the ESM source, same pattern as the
// score-trim tests.

const { test } = require("node:test");
const assert = require("node:assert/strict");

let diveDescription;

test.before(async () => {
  const mod = await import("../src/composables/useDiveLabel.js");
  diveDescription = mod.diveDescription;
});

test("appends position label when description is action-only", () => {
  assert.equal(
    diveDescription({ description: "Forward Dive", position: "B" }),
    "Forward Dive Pike",
  );
  assert.equal(
    diveDescription({ description: "Back 2½ Somersaults", position: "C" }),
    "Back 2½ Somersaults Tuck",
  );
});

test("does NOT double the position word when description already ends with it", () => {
  // The user-facing bug: dive_directory rows that read "Forward
  // 2.5 SS Pike" rendered as "Forward 2.5 SS Pike Pike" on the
  // scoreboard / control centre block. The trailing-word check
  // catches this; the description renders unchanged.
  assert.equal(
    diveDescription({ description: "Forward 2.5 SS Pike", position: "B" }),
    "Forward 2.5 SS Pike",
  );
});

test("trailing-position-word check is case-insensitive", () => {
  assert.equal(
    diveDescription({ description: "FORWARD DIVE PIKE", position: "B" }),
    "FORWARD DIVE PIKE",
  );
  assert.equal(
    diveDescription({ description: "forward dive pike", position: "B" }),
    "forward dive pike",
  );
});

test("position word in the middle of the description still appends a trailing one", () => {
  // "Inward Pike Tuck" ends with Tuck (matches position C) so no
  // append. But the same description with position B (Pike) means
  // the LAST word is still Tuck, not Pike, so append fires.
  assert.equal(
    diveDescription({ description: "Inward Pike Tuck", position: "C" }),
    "Inward Pike Tuck",
  );
  assert.equal(
    diveDescription({ description: "Inward Pike Tuck", position: "B" }),
    "Inward Pike Tuck Pike",
  );
});

test("missing position returns description unchanged", () => {
  assert.equal(
    diveDescription({ description: "Forward Dive", position: null }),
    "Forward Dive",
  );
  assert.equal(
    diveDescription({ description: "Forward Dive" }),
    "Forward Dive",
  );
});

test("missing description returns just the position label", () => {
  assert.equal(
    diveDescription({ description: null, position: "B" }),
    "Pike",
  );
  assert.equal(
    diveDescription({ position: "C" }),
    "Tuck",
  );
});

test("both empty returns empty string", () => {
  assert.equal(diveDescription({}), "");
  assert.equal(diveDescription({ description: null, position: null }), "");
  assert.equal(diveDescription(null), "");
});

test("trims surrounding whitespace on the description", () => {
  assert.equal(
    diveDescription({ description: "  Forward Dive  ", position: "B" }),
    "Forward Dive Pike",
  );
});
