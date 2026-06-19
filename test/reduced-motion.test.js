// Unit coverage for the P1 app-channel pub/sub (useAppChannel) -- the
// module-singleton replacement for the window.__openCommandPalette /
// window.__replayRoleTour globals. DB-less; runs in test:safe.
//
// useReducedMotion is intentionally NOT unit-tested here: it is a
// browser matchMedia singleton, and the repo avoids loading Vue
// composables into node tests (see test/body-scroll-lock.test.js). It
// is covered by test/e2e/reduced-motion.spec.js via emulateMedia.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");

let channel;
before(async () => {
  // ESM source; resolves thanks to src/package.json "type": "module".
  channel = await import("../src/composables/useAppChannel.js");
});

test("openCommandPalette fires current subscribers", () => {
  let n = 0;
  const off = channel.onOpenCommandPalette(() => { n++; });
  channel.openCommandPalette();
  channel.openCommandPalette();
  assert.equal(n, 2);
  off();
});

test("a late subscriber receives only emits after it subscribed (no mount-order dependency)", () => {
  let early = 0, late = 0;
  const offEarly = channel.onOpenCommandPalette(() => { early++; });
  channel.openCommandPalette(); // early:1
  const offLate = channel.onOpenCommandPalette(() => { late++; });
  channel.openCommandPalette(); // early:2 late:1
  assert.equal(early, 2);
  assert.equal(late, 1);
  offEarly();
  offLate();
});

test("unsubscribing stops delivery", () => {
  let n = 0;
  const off = channel.onOpenCommandPalette(() => { n++; });
  off();
  channel.openCommandPalette();
  assert.equal(n, 0);
});

test("replayRoleTour is an independent channel from openCommandPalette", () => {
  let tour = 0, palette = 0;
  const offT = channel.onReplayRoleTour(() => { tour++; });
  const offP = channel.onOpenCommandPalette(() => { palette++; });
  channel.openCommandPalette();
  assert.equal(tour, 0);
  assert.equal(palette, 1);
  channel.replayRoleTour();
  assert.equal(tour, 1);
  offT();
  offP();
});
