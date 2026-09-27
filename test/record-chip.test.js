// The scoreboard's record chip, minus the database.
//
// src/lib/recordMarks.js decides which marks a dive wears, and it has to
// keep out exactly the noise that got the old record toasts removed:
// personal bests and first marks. announceRecords (lib/records.js) is
// the one place both score paths tell the room about a record, and it
// has to drop the scoreboard cache *after* the records transaction, or a
// spectator refresh that raced it keeps serving a payload without the
// mark. The payload side is covered against Postgres in
// integration.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { announceRecords } = require("../lib/records");

let mod;
async function load() {
  if (!mod) mod = await import("../src/lib/recordMarks.js");
  return mod;
}

const mark = (over = {}) => ({
  scope: "club", scope_code: "SBD", official: true, gender: "Female",
  competitor_id: "diver-1", dive_code: "105", position: "B",
  score: 52.2, prev_score: 48.1, ...over,
});

test("personal bests and first marks never make a chip", async () => {
  const { isChipMark, indexRecordMarks } = await load();
  assert.equal(isChipMark(mark()), true);
  assert.equal(isChipMark(mark({ scope: "personal" })), false);
  assert.equal(isChipMark(mark({ prev_score: null })), false);
  assert.equal(isChipMark(mark({ prev_score: undefined })), false);
  assert.equal(isChipMark(null), false);
  // A standing record of 0 points (a failed dive can hold a book) is
  // still a record somebody beat, so only null means "first mark".
  assert.equal(isChipMark(mark({ prev_score: 0 })), true);
  const index = indexRecordMarks([mark({ scope: "personal" }), mark({ prev_score: null })]);
  assert.equal(index.size, 0);
});

test("a dive wears its marks biggest book first, matched on the score too", async () => {
  const { indexRecordMarks, marksForDive } = await load();
  const index = indexRecordMarks([
    mark({ scope: "club" }),
    mark({ scope: "continental", scope_code: "oceania" }),
    mark({ scope: "region", scope_code: "NSW", official: false }),
    mark({ scope: "federation", scope_code: "AUS" }),
  ]);
  const dive = { competitor_id: "diver-1", dive_code: "105", position: "B", total_dive_score: "52.20" };
  assert.deepEqual(marksForDive(index, dive).map((m) => m.scope), ["continental", "federation", "region", "club"]);

  // Same diver, same dive, different score: that's another attempt (a
  // dive-off, say), not the one that set the record.
  assert.deepEqual(marksForDive(index, { ...dive, total_dive_score: "47.25" }), []);
  // Someone else, or another dive, gets nothing.
  assert.deepEqual(marksForDive(index, { ...dive, competitor_id: "diver-2" }), []);
  assert.deepEqual(marksForDive(index, { ...dive, position: "C" }), []);
  assert.deepEqual(marksForDive(index, { total_dive_score: "52.20" }), []);
});

test("socket and payload copies of the same mark merge into one", async () => {
  const { indexRecordMarks, marksForDive } = await load();
  // record_broken names the diver holder_id and carries the unrounded
  // total; the stored record is rounded to two decimals.
  const live = { ...mark({ score: 52.204 }), competitor_id: undefined, holder_id: "diver-1" };
  const index = indexRecordMarks([mark()], [live]);
  const dive = { competitor_id: "diver-1", dive_code: "105", position: "B", total_dive_score: 52.204 };
  const held = marksForDive(index, dive);
  assert.equal(held.length, 1);
  assert.equal(held[0].competitor_id, "diver-1");

  // Only the live copy (the payload was fetched before the records
  // transaction committed) is still enough for the chip.
  const liveOnly = marksForDive(indexRecordMarks([], [live]), dive);
  assert.deepEqual(liveOnly.map((m) => m.scope), ["club"]);
});

test("announceRecords drops the scoreboard cache, then tells the room", async () => {
  const log = [];
  const io = { to: (room) => ({ emit: (name, payload) => log.push(["emit", room, name, payload.scope]) }) };
  const scoreboardCache = { invalidate: (id) => log.push(["invalidate", id]) };
  const broken = [{ scope: "personal" }, { scope: "club" }];
  const out = await announceRecords({
    checkAndApplyRecords: async (args) => {
      log.push(["check", args.eventId, args.competitorId, args.roundNumber]);
      return broken;
    },
    io, scoreboardCache, eventId: "ev-1", competitorId: "diver-1", roundNumber: 2,
  });
  assert.equal(out, broken);
  assert.deepEqual(log, [
    ["check", "ev-1", "diver-1", 2],
    ["invalidate", "ev-1"],
    ["emit", "event:ev-1", "record_broken", "personal"],
    ["emit", "event:ev-1", "record_broken", "club"],
  ]);
});

test("announceRecords leaves the cache alone when nothing was set, and never throws", async () => {
  const log = [];
  const io = { to: () => ({ emit: () => log.push("emit") }) };
  const scoreboardCache = { invalidate: () => log.push("invalidate") };
  assert.deepEqual(await announceRecords({
    checkAndApplyRecords: async () => [], io, scoreboardCache, eventId: "ev-1",
  }), []);
  assert.deepEqual(log, []);

  // A records failure mustn't take the score that caused it down with it.
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await announceRecords({
      checkAndApplyRecords: async () => { throw new Error("boom"); },
      io, scoreboardCache, eventId: "ev-1",
    }), []);
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(log, []);

  // No cache handed over (older callers) is fine too.
  const noCache = await announceRecords({
    checkAndApplyRecords: async () => [{ scope: "club" }], io, eventId: "ev-1",
  });
  assert.equal(noCache.length, 1);
});

// A book has one record at a time. When a second dive in the same event
// breaks it again, the first dive's chip has to go for the people who
// were watching too, not only for anyone who reloads.
test("a newer mark in the same book takes the older one's chip away", async () => {
  const { withoutBook, indexRecordMarks, marksForDive } = await load();
  const first = mark({ competitor_id: "diver-1", scope_id: "club-1", height: "3m", score: 72, prev_score: 60 });
  const second = mark({ holder_id: "diver-2", competitor_id: undefined, scope_id: "club-1", height: "3m", score: 75, prev_score: 72 });
  const otherBook = mark({ competitor_id: "diver-3", scope_id: "club-1", height: "1m", score: 40, prev_score: 30 });
  let live = [first, otherBook];
  let payload = [first];
  live = withoutBook(live, second);
  payload = withoutBook(payload, second);
  live = [...live, second];
  const index = indexRecordMarks(payload, live);
  const dive = (who, total, height = "3m") => ({ competitor_id: who, dive_code: "105", position: "B", total_dive_score: total, height });
  assert.deepEqual(marksForDive(index, dive("diver-1", 72)), [], "the first diver's chip is gone");
  assert.equal(marksForDive(index, dive("diver-2", 75)).length, 1);
  assert.equal(marksForDive(index, dive("diver-3", 40, "1m")).length, 1, "a different board is a different book");
  // Marks without the book's identity (an older server) are left alone.
  assert.deepEqual(withoutBook([mark()], second), [mark()]);
});
