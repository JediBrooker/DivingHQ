// Parser tests for the DiveRecorder archive importer. These run against
// saved HTML fixtures captured from the live Meet Explorer
// (test/fixtures/diverecorder/*.html), so parsing stays locked down even
// though the importer itself hits the network.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseHalfMark,
  parseLongDate,
  parseShortDate,
  parseCountryList,
  COUNTRIES,
  parseEventMeta,
  parseMeetList,
  parseEventList,
  parseSheetList,
  parseDiveSheet,
} = require("../lib/diverecorder-parser");

const FIX = path.join(__dirname, "fixtures", "diverecorder");
const read = (f) => fs.readFileSync(path.join(FIX, f), "utf8");

test("parseHalfMark handles whole and half marks", () => {
  assert.strictEqual(parseHalfMark("6"), 6);
  assert.strictEqual(parseHalfMark("5½"), 5.5);
  assert.strictEqual(parseHalfMark("<td>6½</td>"), 6.5);
  assert.strictEqual(parseHalfMark(""), null);
});

test("parseLongDate parses ordinal long dates to ISO", () => {
  assert.strictEqual(parseLongDate("24th October 2021"), "2021-10-24");
  assert.strictEqual(parseLongDate("2nd May 2026"), "2026-05-02");
  assert.strictEqual(parseLongDate("nonsense"), null);
});

test("parseShortDate combines label + year into ISO", () => {
  assert.strictEqual(parseShortDate("May 24", 2026), "2026-05-24");
  assert.strictEqual(parseShortDate("Oct 23", 2021), "2021-10-23");
  assert.strictEqual(parseShortDate("May 24", null), null);
  assert.strictEqual(parseShortDate("nonsense", 2026), null);
});

test("parseCountryList reads the nat sidebar", () => {
  const countries = parseCountryList(read("selectmeet.html"));
  assert.ok(countries.length >= 20, `expected ~22 countries, got ${countries.length}`);
  assert.ok(countries.find((c) => c.nat === "GBR" && c.name === "Great Britain"));
  assert.ok(COUNTRIES.find((c) => c.nat === "AUS"));
});

test("parseEventMeta extracts gender/height/phase", () => {
  assert.deepStrictEqual(parseEventMeta("Girls Group A+ 1m, Final"), {
    gender: "Female", height: "1m", phase: "Final",
  });
  assert.deepStrictEqual(parseEventMeta("Boys Group B Platform, Preliminary"), {
    gender: "Male", height: "Platform", phase: "Preliminary",
  });
});

test("parseMeetList finds meets with mref/name/date", () => {
  const meets = parseMeetList(read("selectmeet.html"));
  assert.ok(meets.length > 1000, `expected many meets, got ${meets.length}`);
  const southampton = meets.find((m) => m.mref === 1000);
  assert.ok(southampton, "mref 1000 present");
  assert.strictEqual(southampton.name, "Southampton Invitational 2021");
  assert.strictEqual(southampton.dateLabel, "Oct 23");
  assert.strictEqual(southampton.year, 2021);
  assert.strictEqual(southampton.meetDate, "2021-10-23");
  assert.ok(meets.every((m) => Number.isInteger(m.mref) && m.name));
});

test("parseEventList returns unique events", () => {
  const events = parseEventList(read("selectevent.html"));
  assert.ok(events.length >= 40, `expected dozens of events, got ${events.length}`);
  const e2 = events.find((e) => e.eref === 1);
  assert.strictEqual(e2.name, "Girls Group A+ 1m, Preliminary");
  const erefs = events.map((e) => e.eref);
  assert.strictEqual(new Set(erefs).size, erefs.length, "no duplicate erefs");
});

test("parseSheetList returns ranked divers + event date", () => {
  const sheet = parseSheetList(read("selectsheet.html"));
  assert.strictEqual(sheet.meetName, "Southampton Invitational 2021");
  assert.strictEqual(sheet.eventName, "Girls Group A+ 1m, Final");
  assert.strictEqual(sheet.eventDate, "2021-10-24");
  assert.strictEqual(sheet.divers.length, 6);
  const first = sheet.divers[0];
  assert.strictEqual(first.rank, 1);
  assert.strictEqual(first.name, "Olivia Wall");
  assert.strictEqual(first.club, "Dacorum Diving Club");
  assert.strictEqual(first.total, 117.85);
  assert.strictEqual(first.dref, 6074);
});

test("parseDiveSheet extracts diver, judges, and dives", () => {
  const sheet = parseDiveSheet(read("showsheet.html"));
  assert.strictEqual(sheet.diver, "Emma Bolton");
  assert.strictEqual(sheet.club, "Southampton Diving Academy");
  assert.strictEqual(sheet.birthYear, 2004);
  assert.strictEqual(sheet.judgeCount, 5);
  assert.strictEqual(sheet.rank, 2);
  assert.strictEqual(sheet.dives.length, 3);

  const d1 = sheet.dives[0];
  assert.strictEqual(d1.roundNumber, 1);
  assert.strictEqual(d1.diveCode, "203");
  assert.strictEqual(d1.position, "C");
  assert.strictEqual(d1.degreeOfDifficulty, 2.0);
  assert.deepStrictEqual(d1.judgeScores, [5.5, 6, 6.5, 6, 6.5]);
  assert.strictEqual(d1.divePoints, 37.0);
  assert.strictEqual(d1.runningTotal, 37.0);

  const d3 = sheet.dives[2];
  assert.strictEqual(d3.diveCode, "5231");
  assert.strictEqual(d3.runningTotal, 111.8);
});
