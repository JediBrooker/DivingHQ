// lib/csv.js: the shared CSV escaping, formula-injection guard and
// filename slug behind the PDF / CSV exports (routes/pdf.js,
// routes/judge-ranking.js). The guard is the part that matters most, a
// regression there runs attacker text as a formula on an operator's
// machine.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { csvCell, csvRow, slugify } = require("../lib/csv");

test("formula triggers get a leading apostrophe and are quoted", () => {
  for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(csvCell(`${trigger}x`), `"'${trigger}x"`, `trigger ${JSON.stringify(trigger)}`);
  }
  assert.equal(csvCell("=cmd|'/c calc'!A0"), `"'=cmd|'/c calc'!A0"`);
});

test("RFC 4180 quoting for commas, quotes and newlines only", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(7.5), "7.5");
});

test("csvRow joins escaped cells and ends the line", () => {
  assert.equal(csvRow(["a", "b,c", null, "=1+1"]), `a,"b,c",,"'=1+1"\n`);
});

test("slugify lowercases, collapses runs and trims underscores", () => {
  assert.equal(slugify("  Men's 3m Springboard (Final)  "), "men_s_3m_springboard_final");
  assert.equal(slugify("Åre Open 2026"), "re_open_2026");
  assert.equal(slugify(null), "event");
  assert.equal(slugify("", "meet"), "meet");
  assert.equal(slugify(undefined, "diver"), "diver");
});
