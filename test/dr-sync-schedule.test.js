// The optional DiveRecorder sync (DR_IMPORT_SYNC_HOURS) used a plain
// setInterval(hours * 3600000). Node clamps any delay past 2^31-1 ms
// (about 24.8 days) to 1 ms, so a "monthly" 720 started an import every
// millisecond. repeatEvery honours long periods by waiting in capped
// steps.

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const { repeatEvery } = require("../lib/diverecorder-import-runner");

const HOUR = 3600 * 1000;

test("repeatEvery waits the whole period, however long", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const runs = [];
    repeatEvery(720 * HOUR, () => runs.push(Date.now()));
    mock.timers.tick(1);
    assert.equal(runs.length, 0, "not straight away");
    mock.timers.tick(719 * HOUR);
    assert.equal(runs.length, 0, "not before the period is up");
    mock.timers.tick(HOUR);
    assert.equal(runs.length, 1);
    mock.timers.tick(720 * HOUR);
    assert.equal(runs.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("repeatEvery still fires on an ordinary daily cadence", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    let n = 0;
    repeatEvery(24 * HOUR, () => { n += 1; });
    // One day at a time: the mock moves the clock to the end of a tick
    // before it runs anything due in it.
    for (let d = 0; d < 3; d++) mock.timers.tick(24 * HOUR);
    assert.equal(n, 3);
  } finally {
    mock.timers.reset();
  }
});
