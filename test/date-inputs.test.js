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
