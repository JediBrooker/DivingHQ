// Synchro sub-tables of the Judge Ranking Analysis
// (src/lib/judgeRankingSegments.js, rendered by JudgeRankingTable.vue).
// DB-less, runs in test:safe.
//
// WA Competition Regulations, PART FOUR (checked against
// docs/2026-02-18_World-Aquatics_CR-Final.pdf):
//   9.1.5.3  11 judges: cancel the highest and lowest execution award
//            for EACH athlete, and the highest and lowest for sync.
//   9.1.5.4  9 judges: cancel the highest and lowest execution award
//            BETWEEN BOTH athletes, and the highest and lowest for sync.
// So with 9 judges the four execution marks are one pool with two kept,
// not two pools of two with nothing cancelled. The per-role "Actual"
// totals only add up to the pair total when that's respected.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");

let synchroSegmentsFor, segmentRows;

before(async () => {
  ({ synchroSegmentsFor, segmentRows } = await import("../src/lib/judgeRankingSegments.js"));
});

function judges(n) {
  return Array.from({ length: n }, (_, i) => ({ judge_id: `j${i + 1}`, judge_number: i + 1 }));
}

// One pair, one round. Points already carry DD and the synchro factor.
function pointsLookup(byJudge) {
  return (judgeId) => (judgeId in byJudge ? byJudge[judgeId] : null);
}

const DIVER = { competitor_id: "c1", actual_rank: 1 };

function actualByRole(numJudges, byJudge) {
  const segs = synchroSegmentsFor(judges(numJudges), numJudges, "synchro_pair");
  const out = {};
  for (const seg of segs) {
    const rows = segmentRows(seg, {
      divers: [DIVER],
      totalRounds: 1,
      numJudges,
      divePointsOf: (jid) => pointsLookup(byJudge)(jid),
    });
    out[seg.role] = rows[0].segment_actual_total;
  }
  return { segs, out };
}

test("9 judges: execution is one pool across both divers, hi/lo cancelled", () => {
  // J1-J2 execution A, J3-J4 execution B, J5-J9 synchronisation.
  const byJudge = { j1: 8, j2: 7, j3: 6, j4: 9, j5: 5, j6: 6, j7: 7, j8: 8, j9: 9 };
  const { segs, out } = actualByRole(9, byJudge);
  assert.deepEqual(segs.map((s) => s.role), ["exec", "sync"]);
  assert.deepEqual(segs[0].judges.map((j) => j.judge_number), [1, 2, 3, 4]);
  // Execution: drop 9 and 6 from [8, 7, 6, 9] -> 8 + 7.
  assert.equal(out.exec, 15);
  // Sync: drop 9 and 5 -> 6 + 7 + 8.
  assert.equal(out.sync, 21);
  // Five awards kept in all, which is the pair's real dive total.
  assert.equal(out.exec + out.sync, 36);
});

test("9 judges: the hypothetical column keeps two execution awards", () => {
  const byJudge = { j1: 8, j2: 7, j3: 6, j4: 9, j5: 5, j6: 6, j7: 7, j8: 8, j9: 9 };
  const segs = synchroSegmentsFor(judges(9), 9, "synchro_pair");
  const rows = segmentRows(segs[0], {
    divers: [DIVER], totalRounds: 1, numJudges: 9, divePointsOf: (jid) => byJudge[jid] ?? null,
  });
  // "If every execution judge scored like J1": two kept awards of 8.
  assert.equal(rows[0].cells.j1.total, 16);
});

test("11 judges: execution still trims per diver", () => {
  const byJudge = {
    j1: 8, j2: 7, j3: 6,       // exec A -> 7 kept
    j4: 5, j5: 9, j6: 6,       // exec B -> 6 kept
    j7: 5, j8: 6, j9: 7, j10: 8, j11: 9, // sync -> 6 + 7 + 8
  };
  const { segs, out } = actualByRole(11, byJudge);
  assert.deepEqual(segs.map((s) => s.role), ["a", "b", "sync"]);
  assert.equal(out.a, 7);
  assert.equal(out.b, 6);
  assert.equal(out.sync, 21);
});

test("non-synchro events get no segments", () => {
  assert.equal(synchroSegmentsFor(judges(7), 7, "individual"), null);
});
