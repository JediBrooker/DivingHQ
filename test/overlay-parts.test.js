// Unit tests for src/lib/overlayParts.js.
//
// This module is the only thing that answers "is this URL an overlay, and what
// should it show". Two files used to answer that question separately, with
// copy-pasted string lists, and the failure was silent both ways round: the
// chroma colour would not paint, or the app sidebar would render on top of a
// live broadcast. So the parser gets pinned down hard here.

const { test } = require("node:test");
const assert = require("node:assert/strict");

let mod;
async function load() {
  if (!mod) mod = await import("../src/lib/overlayParts.js");
  return mod;
}

test("the three legacy spellings keep their exact meaning", async () => {
  const { resolveOverlay, overlayClasses } = await load();

  for (const spelling of ["1", "true"]) {
    const r = resolveOverlay({ overlay: spelling });
    assert.equal(r.active, true, `${spelling} is an overlay`);
    assert.equal(r.legacy, spelling);
    assert.equal(r.parts, null, "legacy shapes are not part-driven");
    assert.deepEqual(overlayClasses(r), { "overlay-mode": true });
  }

  const min = resolveOverlay({ overlay: "minimal" });
  assert.equal(min.legacy, "minimal");
  assert.deepEqual(overlayClasses(min), { "overlay-mode": true, "overlay-minimal": true });
});

test("an unrecognised overlay value is not an overlay at all", async () => {
  const { resolveOverlay, overlayClasses } = await load();
  // Better a normal scoreboard than a half-styled one an operator cannot
  // debug from the side of a pool.
  for (const junk of ["yes", "0", "minimal ", "MINIMAL", "custom-x", ""]) {
    const r = resolveOverlay({ overlay: junk });
    assert.equal(r.active, false, `${JSON.stringify(junk)} must not activate`);
    assert.deepEqual(overlayClasses(r), {});
  }
  assert.equal(resolveOverlay({}).active, false);
  assert.equal(resolveOverlay(null).active, false);
  // ?parts= on its own does nothing. One gate, not two.
  assert.equal(resolveOverlay({ parts: "judges" }).active, false);
});

test("parts are allowlisted, deduped, and order preserved", async () => {
  const { parseParts } = await load();

  assert.deepEqual(parseParts("judges,diver"), ["judges", "diver"]);
  assert.deepEqual(parseParts(" JUDGES , diver "), ["judges", "diver"]);
  assert.deepEqual(parseParts("judges,judges,judges"), ["judges"]);
  assert.deepEqual(parseParts(null), []);
  assert.deepEqual(parseParts(""), []);

  // The whole point: nothing unknown escapes into a class name.
  assert.deepEqual(parseParts("judges,../../etc,sb-col-history"), ["judges"]);
  assert.deepEqual(parseParts("diver;standings"), []);
  assert.deepEqual(parseParts('judges" onload="x'), []);
});

test("custom with no usable parts falls back rather than handing OBS a blank frame", async () => {
  const { resolveOverlay } = await load();

  assert.deepEqual(resolveOverlay({ overlay: "custom", parts: "" }).parts,
    ["round", "diver", "dive", "judges"]);
  assert.deepEqual(resolveOverlay({ overlay: "custom" }).parts,
    ["round", "diver", "dive", "judges"]);
  assert.deepEqual(resolveOverlay({ overlay: "custom", parts: "nonsense" }).parts,
    ["round", "diver", "dive", "judges"]);
});

test("presets are just named part sets", async () => {
  const { resolveOverlay, OVERLAY_PRESETS, PART_KEYS } = await load();

  assert.deepEqual(resolveOverlay({ overlay: "judges" }).parts, ["judges"]);
  assert.deepEqual(resolveOverlay({ overlay: "diver" }).parts, ["round", "diver", "dive"]);
  assert.deepEqual(resolveOverlay({ overlay: "detailed" }).parts, PART_KEYS);

  // Mutating what a preset handed back must not poison the next reader.
  const first = resolveOverlay({ overlay: "judges" });
  first.parts.push("standings");
  assert.deepEqual(resolveOverlay({ overlay: "judges" }).parts, ["judges"]);
  assert.deepEqual(OVERLAY_PRESETS.judges, ["judges"]);
});

test("classes carry every selected part, and flag an empty centre card", async () => {
  const { resolveOverlay, overlayClasses } = await load();

  const judges = overlayClasses(resolveOverlay({ overlay: "judges" }));
  assert.equal(judges["overlay-mode"], true);
  assert.equal(judges["overlay-parts"], true);
  assert.equal(judges["has-judges"], true);
  assert.equal(judges["has-standings"], undefined);
  assert.equal(judges["no-centre"], undefined, "judges lives in the centre card");

  // Standings alone: nothing in the centre, so the card must not draw.
  const side = overlayClasses(resolveOverlay({ overlay: "custom", parts: "standings" }));
  assert.equal(side["no-centre"], true);
  assert.equal(side["has-standings"], true);

  const both = overlayClasses(resolveOverlay({ overlay: "custom", parts: "standings,history" }));
  assert.equal(both["no-centre"], true);
});

test("buildOverlayUrl round-trips through resolveOverlay", async () => {
  const { buildOverlayUrl, resolveOverlay } = await load();

  assert.equal(
    buildOverlayUrl({ origin: "https://divinghq.app", eventId: "abc", preset: "1" }),
    "https://divinghq.app/scoreboard/abc?overlay=1",
  );
  assert.equal(
    buildOverlayUrl({ origin: "https://divinghq.app", eventId: "abc", preset: "minimal", bg: "ff00ff" }),
    "https://divinghq.app/scoreboard/abc?overlay=minimal&bg=ff00ff",
  );

  const url = buildOverlayUrl({
    origin: "", eventId: "e1", preset: "custom", parts: ["judges", "standings"],
  });
  assert.equal(url, "/scoreboard/e1?overlay=custom&parts=judges%2Cstandings");

  // Whatever we emit, the parser must read back the same shape.
  const query = Object.fromEntries(new URLSearchParams(url.split("?")[1]));
  assert.deepEqual(resolveOverlay(query).parts, ["judges", "standings"]);

  assert.equal(buildOverlayUrl({ eventId: null }), "");
  // A preset never carries a parts list, even if one is passed by mistake.
  assert.equal(
    buildOverlayUrl({ eventId: "e1", preset: "judges", parts: ["history"] }),
    "/scoreboard/e1?overlay=judges",
  );
});
