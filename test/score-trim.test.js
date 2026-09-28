// Pure unit tests for the World Aquatics trim algorithm. Doesn't need a DB
// or a running server, just the algorithm in
// src/composables/useScoreTrim.js. Catches drift in:
//   * which scores get marked as dropped under each panel size
//   * synchro sub-panel boundaries (7/9/11 judges)
//   * tie-break stability (lowest judge_number wins on ties)
//
// We dynamically import() the ESM source from this CommonJS test file.
// Node resolves it as ESM thanks to src/package.json's
// "type": "module".

const { test } = require("node:test");
const assert = require("node:assert/strict");

let annotateJudgeRows, scoreCategory;

test.before(async () => {
  const mod = await import("../src/composables/useScoreTrim.js");
  annotateJudgeRows = mod.annotateJudgeRows;
  scoreCategory     = mod.scoreCategory;
});

// Helper that builds a judges array of {judge_number, score} from a
// shorthand list of scores. Judge numbers are 1-based and dense.
function panel(scores) {
  return scores.map((s, i) => ({ judge_number: i + 1, score: s }));
}

// =====================================================================
// scoreCategory boundaries. Duplicated in test/syntax.test.js to catch
// drift in the source; this file pulls the live function so any drift
// in the algorithm gets caught here too.
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
// Individual panel trims: drop k highest + k lowest.
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
// Tie-break stability: when two judges score the same number, the
// lower judge_number stays in (matches SQL ORDER BY).
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
// Synchro sub-panel boundaries. 7-judge: 4 execution judges
// (1+2 exec A, 3+4 exec B) and 3 sync judges (5..7). Like the 9-judge
// panel, execution drops 1 high + 1 low across both athletes' four
// marks (keep 2); the 3 sync marks are all kept since a 3-judge group
// has nothing to drop. 9-judge: same execution rule, plus the 5-judge
// sync group drops 1 high + 1 low (keep 3). Per WA Art 9.1.5.4.
// 11-judge: 1..3 exec A, 4..6 exec B, 7..11 sync, with drops computed
// within each sub-panel.
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
// Defensive cases the algorithm has to handle without throwing, just
// in case something upstream hands it garbage.
// =====================================================================

test("empty judges → empty result", () => {
  assert.deepEqual(annotateJudgeRows([], 5, "individual"), []);
});

test("non-array input → empty result", () => {
  assert.deepEqual(annotateJudgeRows(null, 5, "individual"), []);
  assert.deepEqual(annotateJudgeRows(undefined, 5, "individual"), []);
});

test("unknown panel size → no drops (matches calc_event_dive_points)", () => {
  // 4-judge panel doesn't exist in World Aquatics's table, so the
  // algorithm should leave everything in rather than guess.
  const out = annotateJudgeRows(panel([5, 6, 7, 8]), 4, "individual");
  assert.deepEqual(out.map(o => o.dropped), [false, false, false, false]);
});

test("each row carries its category alongside the dropped flag", () => {
  const out = annotateJudgeRows(panel([0, 5, 9.5]), 3, "individual");
  assert.equal(out[0].category, "failed");
  assert.equal(out[1].category, "satisfactory");
  assert.equal(out[2].category, "very-good");
});

// ---- Live panel for the spectator scoreboard -------------------------
// The live pills used to be a flat trim over the scores in arrival order,
// placed in slot i and labelled as judge i+1, and the dive total skipped
// the synchro x0.6. livePanel places each score under its own judge and
// only trims (and totals) once the whole panel is in.

test("livePanel: a score sits under its own judge while the panel fills", async () => {
  const { livePanel } = await import("../src/composables/useScoreTrim.js");
  const p = livePanel([{ judge_number: 3, value: 8.5 }], 5, "individual", 2.0);
  assert.deepEqual(p.slots.map((s) => (s.filled ? s.value : null)), [null, null, 8.5, null, null]);
  assert.deepEqual(p.slots.map((s) => s.judge_number), [1, 2, 3, 4, 5]);
  assert.equal(p.slots[2].dropped, false);
  assert.equal(p.total, null, "no total on a partial panel");
});

test("livePanel: individual trim and total once the panel is in", async () => {
  const { livePanel } = await import("../src/composables/useScoreTrim.js");
  const scores = [7, 7.5, 8, 8.5, 9].map((v, i) => ({ judge_number: i + 1, value: v }));
  const p = livePanel(scores, 5, "individual", 1.5);
  assert.deepEqual(p.slots.filter((s) => s.dropped).map((s) => s.judge_number), [1, 5]);
  assert.equal(p.total.toFixed(2), "36.00");
});

test("livePanel: 9-judge synchro uses the grouped WA trim and the 0.6 factor", async () => {
  const { livePanel } = await import("../src/composables/useScoreTrim.js");
  // Exec A 7, 8 | Exec B 6, 9 | Sync 7, 7, 8, 8, 9, DD 3.0.
  // calc_synchro_dive_points(ARRAY[1..9], ARRAY[7,8,6,9,7,7,8,8,9], 9, 3.0) = 68.40
  const vals = [7, 8, 6, 9, 7, 7, 8, 8, 9];
  const scores = vals.map((v, i) => ({ judge_number: i + 1, value: v }));
  const p = livePanel(scores, 9, "synchro_pair", 3.0);
  assert.deepEqual(p.slots.filter((s) => s.dropped).map((s) => s.judge_number), [3, 4, 5, 9]);
  assert.equal(p.total.toFixed(2), "68.40");
});

test("livePanel: arrival order doesn't matter, and no DD means no total", async () => {
  const { livePanel } = await import("../src/composables/useScoreTrim.js");
  const scores = [5, 1, 4, 2, 3].map((j) => ({ judge_number: j, value: 5 + j * 0.5 }));
  const p = livePanel(scores, 5, "individual", null);
  assert.deepEqual(p.slots.map((s) => s.value), [5.5, 6, 6.5, 7, 7.5]);
  assert.equal(p.total, null);
});

// ---- Score-correction preview -------------------------------------------
// The amend dialog previewed a flat trim over all nine synchro scores and
// then applied the 0.6, so its trim sum, points and delta were wrong for
// any 7/9/11-judge synchro panel. It now asks the same annotateJudgeRows
// the rest of the app uses, keyed by the real judge numbers.

test("correctionPreview: 9-judge synchro keeps what WA keeps", async () => {
  const { correctionPreview } = await import("../src/composables/useScoreTrim.js");
  // Exec A 5, 9 | Exec B 9, 9 | Sync 5 x 5, DD 2.0
  const scores = [5, 9, 9, 9, 5, 5, 5, 5, 5];
  const p = correctionPreview({
    scores, judgeNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9], idx: 4, newVal: 6,
    numJudges: 9, eventType: "synchro_pair", dd: 2.0,
  });
  // WA keeps 9, 9 (exec, one high and one low cancelled across the four)
  // and 5, 5, 5 (sync, high and low dropped) = 33. A flat trim kept 29.
  assert.equal(p.oldTrim, 33);
  assert.equal(p.oldPoints.toFixed(2), (33 * 2 * 0.6).toFixed(2));
  assert.equal(p.judgeNumber, 5);
  // J5's 6 is now the sync high, so it's dropped and the sum doesn't move
  assert.equal(p.newTrim, 33);
  assert.equal(p.dropChanged, true);
});

test("correctionPreview: individual panel, labelled by the real judge number", async () => {
  const { correctionPreview } = await import("../src/composables/useScoreTrim.js");
  // A panel whose judge numbers aren't 1..n (someone was swapped out)
  const p = correctionPreview({
    scores: [7, 7.5, 8, 8.5, 9], judgeNumbers: [2, 3, 4, 5, 6], idx: 0, newVal: 2,
    numJudges: 5, eventType: "individual", dd: 1.5,
  });
  assert.equal(p.judgeNumber, 2);
  assert.equal(p.oldTrim, 24); // 7.5 + 8 + 8.5
  assert.equal(p.newTrim, 24); // 2.0 becomes the dropped low in 7.0's place
  assert.equal(p.dropChanged, false);
  assert.equal(p.unchanged, false);
});

test("correctionPreview: nothing to show for a bad score or index", async () => {
  const { correctionPreview } = await import("../src/composables/useScoreTrim.js");
  const base = { scores: [7, 7, 7, 7, 7], judgeNumbers: [1, 2, 3, 4, 5], numJudges: 5, eventType: "individual", dd: 1.5 };
  assert.equal(correctionPreview({ ...base, idx: 0, newVal: 10.5 }), null);
  assert.equal(correctionPreview({ ...base, idx: 0, newVal: 7.3 }), null);
  assert.equal(correctionPreview({ ...base, idx: 9, newVal: 7 }), null);
});
