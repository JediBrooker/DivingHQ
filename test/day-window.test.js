// Price-window dates in the fee editor (src/lib/dayWindow.js). DB-less,
// runs in test:safe.
//
// The editor used to send bare 'YYYY-MM-DD' into timestamptz columns
// (midnight in the DB session's zone) and read them back with
// iso.slice(0, 10) (the UTC date). On a DB east of UTC every load and
// save moved the window back a day, and 'Until 31 Oct' meant midnight at
// the START of the 31st, so the last day never applied. The fix sends
// the local start and end of each day as instants and formats them back
// in local time.
//
// Pinned to Sydney (UTC+10/+11), where the drift showed. TZ has to be
// set before the first Date is made in this process.
process.env.TZ = "Australia/Sydney";
const { test, before } = require("node:test");
const assert = require("node:assert/strict");

let dayStartIso, dayEndIso, localDay;

before(async () => {
  ({ dayStartIso, dayEndIso, localDay } = await import("../src/lib/dayWindow.js"));
});

test("a window round-trips to the same dates", () => {
  const start = dayStartIso("2026-10-01");
  const end = dayEndIso("2026-10-31");
  assert.equal(localDay(start), "2026-10-01");
  assert.equal(localDay(end), "2026-10-31");
  // As Postgres hands them back: same instant, UTC spelling.
  assert.equal(localDay(new Date(start).toISOString()), "2026-10-01");
});

test("the end date is inclusive: late on the last day is still inside", () => {
  const end = Date.parse(dayEndIso("2026-10-31"));
  const lateOnTheDay = new Date(2026, 9, 31, 22, 30).getTime();
  assert.ok(lateOnTheDay <= end);
  assert.ok(new Date(2026, 10, 1, 0, 0).getTime() > end, "and the next day isn't");
});

test("blank and junk stay blank", () => {
  assert.equal(dayStartIso(""), null);
  assert.equal(dayEndIso(null), null);
  assert.equal(localDay(""), "");
  assert.equal(localDay("not a date"), "");
});
