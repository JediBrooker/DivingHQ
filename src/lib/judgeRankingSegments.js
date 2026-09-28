// Synchro sub-tables for the Judge Ranking Analysis
// (JudgeRankingTable.vue). Pulled out of the component so the WA
// trimming rules can be unit tested (test/judge-ranking-segments.test.js).
//
// WA Competition Regulations PART FOUR:
//   9.1.5.3  11 judges: the highest and lowest execution award is
//            cancelled for EACH athlete, and the highest and lowest
//            synchronisation award.
//   9.1.5.4  9 judges: the highest and lowest execution award is
//            cancelled BETWEEN BOTH athletes, and the highest and
//            lowest synchronisation award.
//
// With 11 judges that gives three pools (Exec A, Exec B, Sync) keeping
// 1 + 1 + 3 awards. With 9 it's two pools, the four execution marks
// together keeping 2, plus Sync keeping 3. The table used to split the
// 9-judge execution marks into A and B pools of two, where "drop the
// top and bottom" cancels nothing, so its Actual totals counted all four
// and overstated the pair's execution.

// Which judges score what, by panel size. Mirrors synchroJudgeGroups in
// src/composables/useScoreCategories.js so the table groups judges the
// way the scoreboard chips do.
export function synchroRoleFor(judgeNumber, numJudges, eventType) {
  if (eventType !== 'synchro_pair') return null
  if (numJudges === 9) {
    if (judgeNumber <= 2) return 'a'
    if (judgeNumber <= 4) return 'b'
    return 'sync'
  }
  if (numJudges === 11) {
    if (judgeNumber <= 3) return 'a'
    if (judgeNumber <= 6) return 'b'
    return 'sync'
  }
  return null
}

// The sub-tables to render, each a pool the rulebook trims on its own.
// Returns null for anything that isn't synchro.
export function synchroSegmentsFor(judges, numJudges, eventType) {
  if (eventType !== 'synchro_pair') return null
  const groups = { a: [], b: [], sync: [] }
  for (const j of judges || []) {
    const r = synchroRoleFor(j.judge_number, numJudges, eventType)
    if (r && groups[r]) groups[r].push(j)
  }
  const sync = { role: 'sync', label: 'Synchronisation', judges: groups.sync }
  const segments = numJudges === 9
    ? [
        { role: 'exec', label: 'Execution — both divers', judges: [...groups.a, ...groups.b] },
        sync,
      ]
    : [
        { role: 'a', label: 'Exec A — Diver A execution', judges: groups.a },
        { role: 'b', label: 'Exec B — Diver B execution', judges: groups.b },
        sync,
      ]
  return segments.filter((g) => g.judges.length > 0)
}

// Drop one highest and one lowest, sum the rest. Two values or fewer
// means there's nothing to cancel. Trimming the dive-points is the same
// as trimming the raw awards, since DD is constant within a (pair, round).
export function trimmedSum(vals) {
  if (vals.length <= 2) return vals.reduce((a, b) => a + b, 0)
  const sorted = [...vals].sort((a, b) => a - b)
  return sorted.slice(1, -1).reduce((a, b) => a + b, 0)
}

// Awards a pool keeps after the cancellation above.
export function roleKeptCount(role) {
  if (role === 'sync') return 3
  if (role === 'exec') return 2
  return 1
}

// RANK() semantics with ties: sort rows by val() DESC (official order as
// the tie-break), then write the rank back via set().
export function rankInto(rows, val, set) {
  const sorted = [...rows].sort((a, b) =>
    val(b) - val(a) || (a.diver.actual_rank - b.diver.actual_rank))
  let prev = null, prevRank = 0
  sorted.forEach((r, idx) => {
    if (prev != null && Math.abs(val(r) - prev) < 1e-9) set(r, prevRank)
    else { set(r, idx + 1); prevRank = idx + 1 }
    prev = val(r)
  })
}

// Per-segment rows, straight from the per-dive WA points.
//   * segment_actual_total = the pool's WA contribution to the pair
//     total: sum over rounds of its awards with hi/lo cancelled. The
//     segments therefore add up to the real pair total.
//   * cells[judge_id] = "if every judge in THIS pool scored like J":
//     kept-count x that judge's own dive-points total. Ranked within the
//     segment so each sub-table stands on its own.
// divePointsOf(judgeId, competitorId, round) returns a number or null.
export function segmentRows(segment, { divers, totalRounds, divePointsOf }) {
  const kept = roleKeptCount(segment.role)
  const rows = (divers || []).map((d) => {
    let actual = 0
    const cells = {}
    for (let rnd = 1; rnd <= totalRounds; rnd++) {
      const pts = segment.judges
        .map((j) => divePointsOf(j.judge_id, d.competitor_id, rnd))
        .filter((v) => v != null)
      if (pts.length) actual += trimmedSum(pts)
    }
    for (const j of segment.judges) {
      let sum = 0, any = false
      for (let rnd = 1; rnd <= totalRounds; rnd++) {
        const p = divePointsOf(j.judge_id, d.competitor_id, rnd)
        if (p != null) { sum += p; any = true }
      }
      cells[j.judge_id] = { total: any ? kept * sum : null, rank: null }
    }
    return { diver: d, segment_actual_total: actual, cells }
  })
  rankInto(rows, (r) => r.segment_actual_total,
    (r, rank) => { r.segment_actual_rank = rank })
  for (const j of segment.judges) {
    rankInto(
      rows.filter((r) => r.cells[j.judge_id].total != null),
      (r) => r.cells[j.judge_id].total,
      (r, rank) => { r.cells[j.judge_id].rank = rank },
    )
  }
  return rows
}
