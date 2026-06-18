// Self-tests for the P0 bundle-size gate. DB-less; runs in test:safe.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, ceilingFor } = require("../scripts/check-bundle-size.js");

test("passes when every tracked chunk is at or under its ceiling", () => {
  const baseline = { ceilings: { entry: 1000, control: 2000 } };
  assert.deepEqual(evaluate({ entry: 900, control: 2000 }, baseline), []);
});

test("fails when a chunk exceeds its ceiling", () => {
  const baseline = { ceilings: { entry: 1000 } };
  const failures = evaluate({ entry: 1500 }, baseline);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "over");
});

test("fails when a tracked chunk is missing from the build", () => {
  const baseline = { ceilings: { control: 2000 } };
  const failures = evaluate({ entry: 900 }, baseline);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "missing");
});

test("ceilingFor adds headroom above the measured size", () => {
  assert.ok(ceilingFor(1000) > 1000);
});
