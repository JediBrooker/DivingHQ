// Unit coverage for the meet-readiness CSV cell renderer.
//
// Two behaviours under test:
//   1. CSV formula-injection neutralisation (OWASP): cells that
//      start with = + - @ \t \r need a literal apostrophe prefix
//      so a spreadsheet treats them as text, not a formula. Org,
//      federation, diver, and event names are all user-controlled
//      and flow straight into this export.
//   2. RFC-4180 quoting: embedded quote / comma / newline still
//      forces double-quote wrapping with quote-doubling, and that
//      has to compose correctly with the apostrophe prefix.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { csvCell } = require("../routes/meets");

test("csvCell exists as a pure exported helper", () => {
  assert.equal(typeof csvCell, "function");
});

test("neutralises a value that begins with = (the documented attack)", () => {
  // heads up: without this guard it opens as a live formula in Excel
  assert.equal(
    csvCell('=HYPERLINK("http://evil","click")'),
    `"'=HYPERLINK(""http://evil"",""click"")"`,
  );
});

test("prefixes every formula-trigger first character", () => {
  for (const trigger of ["=", "+", "-", "@"]) {
    assert.equal(
      csvCell(`${trigger}danger`),
      `'${trigger}danger`,
      `value starting with "${trigger}" should be apostrophe-prefixed`,
    );
  }
});

test("prefixes control-character triggers (tab, carriage return)", () => {
  // A leading tab is a formula trigger too; it also trips the
  // RFC-4180 quoting rule via the \r case, so assert both layers.
  assert.equal(csvCell("\tsum"), "'\tsum");
  // \r forces quoting after the apostrophe prefix is applied.
  assert.equal(csvCell("\rboom"), `"'\rboom"`);
});

test("leaves an ordinary value untouched", () => {
  assert.equal(csvCell("Aquatics AUS"), "Aquatics AUS");
  assert.equal(csvCell("Round 3"), "Round 3");
  // A minus sign mid-string is fine, only the FIRST char triggers.
  assert.equal(csvCell("Best-of-3"), "Best-of-3");
});

test("a negative number rendered as a string is neutralised", () => {
  // Counts/IDs are numbers, but a name or note could legitimately
  // start with '-' too. The guard just looks at the first char,
  // regardless of type, after stringification.
  assert.equal(csvCell(String(-5)), "'-5");
  assert.equal(csvCell(5), "5");
});

test("still applies RFC-4180 quoting for comma / quote / newline", () => {
  assert.equal(csvCell("Smith, John"), '"Smith, John"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
});

test("composes the apostrophe prefix with quoting when both apply", () => {
  // Formula trigger AND a comma → apostrophe first, then wrap.
  assert.equal(csvCell("=A1,B1"), `"'=A1,B1"`);
});

test("null / undefined / empty render as an empty cell", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(""), "");
});
