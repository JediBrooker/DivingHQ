// lib/dive-scores.js: the one read of a dive's stored scores, behind the
// judge keypad's /dive-scores, the spectator get_active_diver ack and the
// Control Room's /dive-panel. DB-less: a fake db records the query.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { storedDiveScores } = require("../lib/dive-scores");

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

const ROWS = [
  { judge_id: "11111111-1111-4111-8111-111111111111", judge_number: 1, score: "6.5" },
  { judge_id: "33333333-3333-4333-8333-333333333333", judge_number: 3, score: "7.0" },
];
const DIVE = { eventId: "e", competitorId: "c", roundNumber: 2 };

test("one dive, seated judges, a re-dive's set-asides left out, panel order", async () => {
  const db = fakeDb(ROWS);
  await storedDiveScores(db, DIVE);
  const { sql, params } = db.calls[0];
  assert.deepEqual(params, ["e", "c", 2]);
  assert.match(sql, /JOIN event_judges ej ON ej\.event_id = s\.event_id AND ej\.judge_id = s\.judge_id/);
  assert.match(sql, /WHERE s\.event_id = \$1 AND s\.competitor_id = \$2 AND s\.round_number = \$3/);
  assert.match(sql, /s\.status IS DISTINCT FROM 'redive'/);
  assert.match(sql, /ORDER BY ej\.judge_number\s*$/);
});

test("judge ids only when asked for: the spectator ack goes to anonymous sockets", async () => {
  const plain = await storedDiveScores(fakeDb(ROWS), DIVE);
  assert.deepEqual(plain, [{ judge_number: 1, score: 6.5 }, { judge_number: 3, score: 7 }]);
  for (const row of plain) assert.equal("judge_id" in row, false);

  const keyed = await storedDiveScores(fakeDb(ROWS), DIVE, { withJudgeIds: true });
  assert.deepEqual(keyed, [
    { judge_id: ROWS[0].judge_id, judge_number: 1, score: 6.5 },
    { judge_id: ROWS[1].judge_id, judge_number: 3, score: 7 },
  ]);
});
