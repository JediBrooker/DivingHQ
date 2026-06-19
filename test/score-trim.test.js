// Pure unit tests for the World Aquatics trim algorithm. Doesn't need a DB
// or a running server — just the algorithm in
// src/composables/useScoreTrim.js. Catches drift in:
//   * which scores get marked as dropped under each panel size
//   * synchro sub-panel boundaries (7/9/11 judges)
//   * tie-break stability (lowest judge_number wins on ties)
//
// We dynamically import() the ESM source from this CommonJS test
// file. Node resolves the file as ESM thanks to src/package.json's
// "type": "module".

const { test } = require("node:test");
const assert = require("node:assert/strict");

let annotateJudgeRows, scoreCategory;

test.before(async () => {
  const mod = await import("../src/composables/useScoreTrim.js");
  annotateJudgeRows = mod.annotateJudgeRows;
  scoreCategory     = mod.scoreCategory;
});

// Helper: build a judges array of {judge_number, score} from a
// shorthand list of scores. Judge numbers are 1-based and dense.
function panel(scores) {
  return scores.map((s, i) => ({ judge_number: i + 1, score: s }));
}

// =====================================================================
// scoreCategory boundaries — duplicated in test/syntax.test.js to
// catch drift in the source. This file pulls the live function so
// any drift in the algorithm is caught here too.
// =====================================================================

test("scoreCategory returns the expected World Aquatics bucket", () => {
  assert.equal(scoreCategory(0),    "failed");
  assert.equal(scoreCategory(1),    "very-deficient");
  assert.equal(scoreCategory(2.0),  "very-deficient");
  assert.equal(scoreCategory(2.5),  "deficient");
  assert.equal(scoreCategory(4.5),  "deficient");
  assert.equal(scoreCategory(5.0),  "satisfactory");
  assert.equal(scoreCategory(6.0),  "satisfactory");
  assert.equal(scoreCategory(6.5),  "satisfactory");
  assert.equal(scoreCategory(7.0),  "good");
  assert.equal(scoreCategory(8.0),  "good");
  assert.equal(scoreCategory(9.0),  "very-good");
  assert.equal(scoreCategory(9.5),  "very-good");
  assert.equal(scoreCategory(10.0), "excellent");
});

// =====================================================================
// Individual panel trims — drop k highest + k lowest.
// =====================================================================

test("3-judge panel — no drops", () => {
  const out = annotateJudgeRows(panel([5, 7, 9]), 3, "individual");
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(o => o.dropped), [false, false, false]);
});

test("5-judge panel — drop the high and the low", () => {
  // [5, 6, 7, 8, 9] → drop 5 and 9, keep 6, 7, 8
  const out = annotateJudgeRows(panel([5, 6, 7, 8, 9]), 5, "individual");
  assert.deepEqual(out.map(o => o.dropped), [true, false, false, false, true]);
});

test("7-judge panel — drop 2 high + 2 low", () => {
  const out = annotateJudgeRows(panel([4, 5, 6, 7, 8, 9, 10]), 7, "individual");
  // 4, 5 drop low; 9, 10 drop high; 6, 7, 8 keep
  assert.deepEqual(out.map(o => o.dropped),
    [true, true, false, false, false, true, true]);
});

test("9-judge panel — drop 2 high + 2 low (individual)", () => {
  const out = annotateJudgeRows(panel([1, 2, 3, 4, 5, 6, 7, 8, 9]), 9, "individual");
  // 1, 2 drop low; 8, 9 drop high; middle five keep
  assert.deepEqual(out.map(o => o.dropped),
    [true, true, false, false, false, false, false, true, true]);
});

test("11-judge panel — drop 3 high + 3 low", () => {
  const out = annotateJudgeRows(
    panel([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    11, "individual",
  );
  assert.deepEqual(out.map(o => o.dropped),
    [true, true, true, false, false, false, false, false, true, true, true]);
});

// =====================================================================
// Tie-break stability — when two judges score the same number,
// the LOWER judge_number stays in (matches SQL ORDER BY).
// =====================================================================

test("tie at the cut: lowest judge_number wins on the kept side", () => {
  // 5-judge panel where two 9.0s tie for the high. The judge with
  // the LOWER judge_number is kept; the other is dropped.
  const out = annotateJudgeRows(panel([5, 6, 7, 9, 9]), 5, "individual");
  // judge_4 score 9 is kept; judge_5 score 9 is dropped (high cut).
  // Lowest score 5 (judge_1) is dropped.
  assert.equal(out[0].dropped, true,  "judge 1 (low) dropped");
  assert.equal(out[3].dropped, false, "judge 4 kept (lower judge_number on tie)");
  assert.equal(out[4].dropped, true,  "judge 5 dropped (higher judge_number on tie)");
});

// =====================================================================
// Synchro sub-panel boundaries — 7-judge: 4 execution judges
// (1+2 exec A, 3+4 exec B) and 3 sync judges (5..7). Like the 9-judge
// panel, execution drops 1 high + 1 low ACROSS both Athletes' four
// marks (keep 2); the 3 sync marks are all kept (a 3-judge group has
// nothing to drop). 9-judge: same execution rule, plus the 5-judge
// sync group drops 1 high + 1 low (keep 3). Per WA Art 9.1.5.4.
// 11-judge: 1..3 exec A, 4..6 exec B, 7..11 sync — drops computed
// WITHIN each sub-panel.
// =====================================================================

test("synchro 7-judge — exec drops 1+1 across both divers, all 3 sync kept", () => {
  const judges = panel([7, 8,    7, 8,    5, 7, 9]);
  const out = annotateJudgeRows(judges, 7, "synchro_pair");
  // Exec pool across both divers = judges 1-4 scores [7,8,7,8]. Drop
  // 1 low + 1 high; on the tie the lower judge_number stays kept, so
  // judge 1 (low, 7) and judge 4 (high, 8) are cancelled.
  assert.equal(out[0].dropped, true,  "exec low (judge 1) dropped");
  assert.equal(out[1].dropped, false, "judge 2 kept");
  assert.equal(out[2].dropped, false, "judge 3 kept");
  assert.equal(out[3].dropped, true,  "exec high (judge 4) dropped");
  // Sync (5..7): only 3 marks → all kept.
  assert.equal(out[4].dropped, false);
  assert.equal(out[5].dropped, false);
  assert.equal(out[6].dropped, false);
});

test("synchro 9-judge — exec drops 1+1 across both divers, sync drops 1+1", () => {
  const judges = panel([7, 8,    7, 8,    5, 6, 7, 8, 9]);
  const out = annotateJudgeRows(judges, 9, "synchro_pair");
  // Execution pool across both divers = judges 1-4 scores [7,8,7,8].
  // WA Art 9.1.5.4: drop the single low + single high. On the tie the
  // lower judge_number stays kept, so judge 1 (low, 7) and judge 4
  // (high, 8) are cancelled; judge 2 (8) and judge 3 (7) are kept.
  assert.equal(out[0].dropped, true,  "exec low (judge 1) dropped");
  assert.equal(out[1].dropped, false, "judge 2 kept");
  assert.equal(out[2].dropped, false, "judge 3 kept");
  assert.equal(out[3].dropped, true,  "exec high (judge 4) dropped");
  // Sync (5..9): drop low (5) + high (9), keep 6, 7, 8
  assert.equal(out[4].dropped, true,  "sync low dropped");
  assert.equal(out[5].dropped, false);
  assert.equal(out[6].dropped, false);
  assert.equal(out[7].dropped, false);
  assert.equal(out[8].dropped, true,  "sync high dropped");
});

test("synchro 11-judge — exec sub-panels drop 1+1, sync drops 1+1", () => {
  const judges = panel([6, 7, 8,    5, 6, 7,    4, 5, 6, 7, 8]);
  const out = annotateJudgeRows(judges, 11, "synchro_pair");
  // Exec A (1, 2, 3): scores 6, 7, 8 → drop 6 and 8, keep 7
  assert.equal(out[0].dropped, true);
  assert.equal(out[1].dropped, false);
  assert.equal(out[2].dropped, true);
  // Exec B (4, 5, 6): scores 5, 6, 7 → drop 5 and 7, keep 6
  assert.equal(out[3].dropped, true);
  assert.equal(out[4].dropped, false);
  assert.equal(out[5].dropped, true);
  // Sync (7..11): scores 4, 5, 6, 7, 8 → drop 4 and 8, keep 5, 6, 7
  assert.equal(out[6].dropped, true);
  assert.equal(out[7].dropped, false);
  assert.equal(out[8].dropped, false);
  assert.equal(out[9].dropped, false);
  assert.equal(out[10].dropped, true);
});

// =====================================================================
// Defensive cases the algorithm must handle without throwing.
// =====================================================================

test("empty judges → empty result", () => {
  assert.deepEqual(annotateJudgeRows([], 5, "individual"), []);
});

test("non-array input → empty result", () => {
  assert.deepEqual(annotateJudgeRows(null, 5, "individual"), []);
  assert.deepEqual(annotateJudgeRows(undefined, 5, "individual"), []);
});

test("unknown panel size → no drops (matches calc_event_dive_points)", () => {
  // 4-judge panel doesn't exist in World Aquatics's table; algorithm
  // should leave everything in rather than guess.
  const out = annotateJudgeRows(panel([5, 6, 7, 8]), 4, "individual");
  assert.deepEqual(out.map(o => o.dropped), [false, false, false, false]);
});

test("each row carries its category alongside the dropped flag", () => {
  const out = annotateJudgeRows(panel([0, 5, 9.5]), 3, "individual");
  assert.equal(out[0].category, "failed");
  assert.equal(out[1].category, "satisfactory");
  assert.equal(out[2].category, "very-good");
});
