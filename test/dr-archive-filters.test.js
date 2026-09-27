// routes/dr-archive.js buildMeetFilters: the q / nat / from / to filter
// shared by /api/dr-archive/meets and /meets-count. One builder means the
// page count can't disagree with the list; these pin the $N numbering
// the list relies on when it appends LIMIT / OFFSET.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildMeetFilters } = require("../routes/dr-archive");

test("no filters: no WHERE, no params", () => {
  assert.deepEqual(buildMeetFilters({}), { where: "", params: [] });
});

test("every filter, numbered in order", () => {
  assert.deepEqual(
    buildMeetFilters({ q: " Open ", nat: "aus", from: "2020-01-01", to: "2020-12-31" }),
    {
      where: "WHERE m.name ILIKE $1 AND m.country_code = $2 AND m.meet_date >= $3 AND m.meet_date <= $4",
      params: ["%Open%", "AUS", "2020-01-01", "2020-12-31"],
    },
  );
});

test("malformed dates are ignored, the numbering closes up", () => {
  assert.deepEqual(
    buildMeetFilters({ from: "last tuesday", to: "2021-06-30", nat: "gbr" }),
    { where: "WHERE m.country_code = $1 AND m.meet_date <= $2", params: ["GBR", "2021-06-30"] },
  );
});
