// The wall-clock <-> instant conversions behind the Meet Manager's date
// and time inputs. DB-less. Pinned to Europe/London so "the browser's
// zone" is something other than wherever the test box happens to be.
process.env.TZ = "Europe/London";
const { test } = require("node:test");
const assert = require("node:assert/strict");

let mod;
async function load() {
  if (!mod) mod = await import("../src/lib/dateInputs.js");
  return mod;
}

// <input type="datetime-local"> gives a zone-less wall clock. Sent as-is,
// Postgres read it in its own session zone, so a manager whose browser
// wasn't in the DB's zone got every time shifted, on every save.
test("a datetime-local value goes to the server as the instant the user meant", async () => {
  const { localInputToIso } = await load();
  // 10:00 in London on 1 October is 09:00 UTC (BST)
  assert.equal(localInputToIso("2026-10-01T10:00"), "2026-10-01T09:00:00.000Z");
  assert.equal(localInputToIso("2026-01-15T10:00"), "2026-01-15T10:00:00.000Z");
  assert.equal(localInputToIso(""), null);
  assert.equal(localInputToIso(null), null);
  assert.equal(localInputToIso("not a date"), null);
});

test("an instant from the server comes back as the same wall clock", async () => {
  const { isoToLocalInput, localInputToIso } = await load();
  assert.equal(isoToLocalInput("2026-10-01T09:00:00Z"), "2026-10-01T10:00");
  assert.equal(isoToLocalInput(null), "");
  assert.equal(isoToLocalInput("garbage"), "");
  // a no-op edit round-trips exactly
  const iso = "2026-10-01T09:00:00.000Z";
  assert.equal(localInputToIso(isoToLocalInput(iso)), iso);
});

// DATE columns (meet start/end, session_date). node-pg hands the server a
// Date at the *server's* local midnight and JSON sends it in UTC, so a
// server east of UTC says "2023-05-28T14:00:00.000Z" for 29 May. The
// Manager sliced the first ten characters and saved the day before; the
// scheduler added a UTC day and proposed the same day as "tomorrow".
test("dateOnly recovers the calendar date whichever zone the server runs in", async () => {
  const { dateOnly } = await load();
  assert.equal(dateOnly("2023-05-29"), "2023-05-29");
  assert.equal(dateOnly("2023-05-28T14:00:00.000Z"), "2023-05-29"); // server at +10
  assert.equal(dateOnly("2023-05-28T13:00:00.000Z"), "2023-05-29"); // +11 (daylight saving)
  assert.equal(dateOnly("2023-05-28T11:00:00.000Z"), "2023-05-29"); // +13 (NZ summer)
  assert.equal(dateOnly("2023-05-29T00:00:00.000Z"), "2023-05-29"); // UTC
  assert.equal(dateOnly("2023-05-29T04:00:00.000Z"), "2023-05-29"); // -4
  assert.equal(dateOnly("2023-05-29T10:00:00.000Z"), "2023-05-29"); // -10 (Hawaii)
  assert.equal(dateOnly(new Date("2023-05-28T14:00:00.000Z")), "2023-05-29");
  assert.equal(dateOnly(null), "");
  assert.equal(dateOnly("nope"), "");
});

test("addDays walks the calendar, month and year ends included", async () => {
  const { addDays } = await load();
  assert.equal(addDays("2026-06-02", 1), "2026-06-03");
  assert.equal(addDays("2026-06-30", 1), "2026-07-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("", 1), "");
});

test("a calendar date displays as that day in any browser zone", async () => {
  const { dateOnlyToLocalDate, dateOnly } = await load();
  const d = dateOnlyToLocalDate(dateOnly("2023-05-28T14:00:00.000Z"));
  assert.equal(d.getFullYear(), 2023);
  assert.equal(d.getMonth(), 4);
  assert.equal(d.getDate(), 29);
  assert.equal(dateOnlyToLocalDate(""), null);
});
