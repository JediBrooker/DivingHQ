// Helpers for rendering per-judge scores as colour-coded chips.
// Used by the Scoreboard and Archive views, keep them in sync so
// dive breakdowns look identical wherever they appear.

// World Aquatics award descriptions (WA Art 10.1.1). Each slug maps to
// a colour class in src/styles/app.css (.j-failed, .j-very-deficient, …).
//   0          Completely failed  → failed
//   0.5 – 2.0  Very Deficient     → very-deficient
//   2.5 – 4.5  Deficient          → deficient
//   5.0 – 6.5  Satisfactory       → satisfactory
//   7.0 – 8.0  Good               → good
//   8.5 – 9.5  Very Good          → very-good
//   10         Excellent          → excellent
export function scoreCategory(s) {
  if (s == null || Number.isNaN(s)) return null
  if (s === 0)   return 'failed'
  if (s <= 2.0)  return 'very-deficient'
  if (s <= 4.5)  return 'deficient'
  if (s <= 6.5)  return 'satisfactory'
  if (s <= 8.0)  return 'good'
  if (s <= 9.5)  return 'very-good'
  return 'excellent'   // 10
}

// Standard World Aquatics trim rules for an individual diving panel:
//   3 judges  → keep all
//   5 judges  → drop high + low
//   7 judges  → drop 2 high + 2 low
//   9 judges  → drop 2 high + 2 low
//  11 judges  → drop 3 high + 3 low
export function trimCount(numJudges) {
  if (!numJudges || numJudges <= 3) return 0
  if (numJudges === 5)  return 1
  if (numJudges === 7)  return 2
  if (numJudges === 9)  return 2
  if (numJudges === 11) return 3
  return 0
}

// World Aquatics synchronised panel layout, which judges score
// what role, by position. A 7-judge synchro panel is 4 execution
// judges split 2+2 across the divers, plus 3 synchronisation
// judges. Returns null for non-synchro panels.
export function synchroJudgeGroups(numJudges) {
  if (numJudges === 7)  return { a: [1, 2],    b: [3, 4],    sync: [5, 6, 7] }
  if (numJudges === 9)  return { a: [1, 2],    b: [3, 4],    sync: [5, 6, 7, 8, 9] }
  if (numJudges === 11) return { a: [1, 2, 3], b: [4, 5, 6], sync: [7, 8, 9, 10, 11] }
  return null
}

export function synchroGroupDropCount(role, numJudges) {
  if (numJudges === 11 && (role === 'a' || role === 'b')) return 1
  if ((numJudges === 9 || numJudges === 11) && role === 'sync') return 1
  return 0
}

// Returns the role of a single judge, or null if outside a
// recognised synchro panel.
export function synchroRoleForJudge(judgeNumber, numJudges) {
  const groups = synchroJudgeGroups(numJudges)
  if (!groups) return null
  if (groups.a.includes(judgeNumber))    return 'a'
  if (groups.b.includes(judgeNumber))    return 'b'
  if (groups.sync.includes(judgeNumber)) return 'sync'
  return null
}

// Annotate scores under World Aquatics synchro trim rules:
// drops are computed *within* each judge group (Exec A, Exec B,
// Sync) rather than across the whole panel. Returns the same
// {value, dropped, category}[] shape as annotatedScores so the
// chip rendering stays uniform.
// Mark the lowest `dropCount` and highest `dropCount` values among the
// given 1-based judge numbers as dropped, keyed by 0-based index into
// `values`. Stable on ties, the lowest judge number stays on the
// "kept" side. No-op when the group's too small to trim.
function markDroppedEnds(judgeNumbers, values, dropCount, dropped) {
  if (dropCount <= 0 || judgeNumbers.length <= dropCount * 2) return
  const indexed = judgeNumbers
    .map(jn => ({ idx: jn - 1, val: values[jn - 1] }))
    .sort((a, b) => a.val - b.val || a.idx - b.idx)
  indexed.slice(0, dropCount).forEach(x => dropped.add(x.idx))
  indexed.slice(indexed.length - dropCount).forEach(x => dropped.add(x.idx))
}

export function annotatedSynchroScores(scoresStr, numJudges) {
  const values = (scoresStr || '')
    .split(',')
    .map(s => parseFloat(s))
    .filter(n => !Number.isNaN(n))
  const groups = synchroJudgeGroups(numJudges)
  if (!groups || values.length !== numJudges) {
    // Unknown / partial panel, fall back to flat individual rules
    return annotatedScores(scoresStr, numJudges)
  }
  const dropped = new Set()
  if (numJudges === 7 || numJudges === 9) {
    // WA Art 9.1.5.4 execution rule, applied to both the 9-judge panel
    // and the (non-WA) 7-judge panel since both share a 2+2 execution
    // layout: cancel one high + one low execution mark ACROSS both
    // Athletes' four marks (not within each pair). The sync group drops
    // high+low only when it has five judges (9-judge); the 7-judge
    // panel's three sync marks are all kept. Both panels end on five
    // counted marks, so × 0.6 normalises to the individual scale.
    markDroppedEnds([...groups.a, ...groups.b], values, 1, dropped)
    markDroppedEnds(groups.sync, values, synchroGroupDropCount('sync', numJudges), dropped)
  } else {
    for (const [role, judgeNumbers] of Object.entries(groups)) {
      markDroppedEnds(judgeNumbers, values, synchroGroupDropCount(role, numJudges), dropped)
    }
  }
  return values.map((v, i) => ({
    value: v,
    dropped: dropped.has(i),
    category: scoreCategory(v),
  }))
}

// View-friendly grouping. Returns:
//   [{ role, label, scores: [{value, dropped, category}, …] }, …]
// or null for non-synchro panels, caller falls back to flat
// rendering in that case.
export function groupedSynchroScoresForDisplay(scoresStr, numJudges) {
  const groups = synchroJudgeGroups(numJudges)
  if (!groups) return null
  const annotated = annotatedSynchroScores(scoresStr, numJudges)
  return [
    { role: 'a',    label: 'Exec A', scores: groups.a.map(jn => annotated[jn - 1]).filter(Boolean) },
    { role: 'b',    label: 'Exec B', scores: groups.b.map(jn => annotated[jn - 1]).filter(Boolean) },
    { role: 'sync', label: 'Sync',   scores: groups.sync.map(jn => annotated[jn - 1]).filter(Boolean) },
  ]
}

// Parses a comma-separated score string and annotates each value
// with its category and whether the trim rule would drop it.
// Ties are broken by original index, matching how the lowest
// judge id is treated as the "first" of a tied pair.
export function annotatedScores(scoresStr, numJudges) {
  const values = (scoresStr || '')
    .split(',')
    .map(s => parseFloat(s))
    .filter(n => !Number.isNaN(n))
  const drop = trimCount(numJudges)
  const dropped = new Set()
  if (drop > 0 && values.length > drop * 2) {
    const indexed = values.map((v, i) => ({ v, i }))
    indexed.sort((a, b) => a.v - b.v || a.i - b.i)
    indexed.slice(0, drop).forEach(x => dropped.add(x.i))
    indexed.slice(indexed.length - drop).forEach(x => dropped.add(x.i))
  }
  return values.map((v, i) => ({
    value: v,
    dropped: dropped.has(i),
    category: scoreCategory(v),
  }))
}
