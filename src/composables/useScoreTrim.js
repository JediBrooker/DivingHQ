// Per-judge trim for the "judges came back as an array of objects" case.
// The Recent-Form expansion on the diver profile (and any future
// scoreboard breakdown) consumes `[{ judge_number, score }, …]` rather
// than the comma-separated string the live scoreboard uses. Both shapes
// need the same rules, so this composable just wraps the existing
// useScoreCategories helpers and adapts the input.
//
// Returns `[{ judge_number, score, dropped, category }, …]` in the same
// order it was given. Tied scores: lowest judge_number wins on the
// "kept" side, matching the scoreboard's stable-tie behaviour.

// Relative path here (not the @/ alias) so this file is still importable
// from Node test runners that don't have Vite's path resolver. Vite's
// fine with relative paths too, so nothing changes for the SPA bundle.
import {
  scoreCategory,
  trimCount,
  synchroJudgeGroups,
  synchroGroupDropCount,
} from './useScoreCategories.js'

/**
 * @param {Array<{judge_number:number, score:number|string}>} judges
 * @param {number} numJudges
 * @param {string} [eventType]  - 'individual' | 'synchro_pair' | 'team' | …
 * @returns {Array<{judge_number:number, score:number, dropped:boolean, category:string}>}
 */
export function annotateJudgeRows(judges, numJudges, eventType) {
  if (!Array.isArray(judges) || !judges.length) return []
  const rows = judges.map(j => ({
    judge_number: Number(j.judge_number),
    score:        Number(j.score),
    dropped:      false,
    category:     scoreCategory(Number(j.score)),
  }))

  if (eventType === 'synchro_pair') {
    const groups = synchroJudgeGroups(numJudges)
    if (groups) {
      if (numJudges === 7 || numJudges === 9) {
        // WA Art 9.1.5.4 execution rule, applied to both the 9-judge
        // and (non-WA) 7-judge panels: they share a 2+2 execution
        // layout, cancel one high + one low execution mark ACROSS both
        // Athletes four marks (not within each 2-judge pair). The sync
        // group drops high+low only when it has five judges (9-judge);
        // the 7-judge panel's three sync marks are all kept. Both land
        // on five counted marks (× 0.6 → the individual scale).
        dropEndsByJudgeNumber(rows, [...groups.a, ...groups.b], 1, 1)
        const syncDrop = synchroGroupDropCount('sync', numJudges)
        if (syncDrop > 0) dropEndsByJudgeNumber(rows, groups.sync, syncDrop, syncDrop)
      } else {
        // 11-judge panel: drops computed within each sub-panel (each
        // 3-judge exec group and the 5-judge sync group).
        for (const [role, subPanel] of Object.entries(groups)) {
          const size = subPanel.length
          const dropCount = synchroGroupDropCount(role, numJudges)
          if (dropCount > 0 && size > dropCount * 2) {
            dropEndsByJudgeNumber(rows, subPanel, dropCount, dropCount)
          }
        }
      }
      return rows
    }
    // Unknown synchro panel size, fall through to flat individual.
  }

  // Individual / team / fallback: flat trim using the standard rules.
  const k = trimCount(numJudges)
  if (k > 0 && rows.length > k * 2) {
    dropEndsByJudgeNumber(rows, rows.map(r => r.judge_number), k, k)
  }
  return rows
}

/**
 * Mark the lowest `dropLow` and highest `dropHigh` scores within the
 * subset of rows whose `judge_number` is in `judgeNumbers`. Mutates rows.
 * Stable on ties, lowest judge_number wins.
 */
function dropEndsByJudgeNumber(rows, judgeNumbers, dropLow, dropHigh) {
  const want = new Set(judgeNumbers)
  const subset = rows
    .filter(r => want.has(r.judge_number))
    .map(r => ({ row: r, score: r.score, jn: r.judge_number }))
    .sort((a, b) => a.score - b.score || a.jn - b.jn)
  for (let i = 0; i < dropLow && i < subset.length; i++) {
    subset[i].row.dropped = true
  }
  for (let i = 0; i < dropHigh && (subset.length - 1 - i) >= dropLow; i++) {
    subset[subset.length - 1 - i].row.dropped = true
  }
}

/**
 * The live judge pills under the spectator scoreboard's current diver.
 *
 * `scores` is whatever has arrived so far, `[{ judge_number, value }]`,
 * in any order. Every panel seat gets a slot, and each score goes in its
 * own judge's seat, so J3 scoring first shows under J3 rather than in the
 * first slot with J1's name and link on it. Drops are only marked, and the
 * total only given, once the whole panel is in: it's the same WA trim the
 * completed dive gets (annotateJudgeRows, grouped for synchro) times DD,
 * times 0.6 for synchro. The old flat trim struck the wrong judges on a
 * synchro panel and put the total at 1/0.6 of the official figure.
 *
 * A score with no judge_number (nothing sends one today) takes the first
 * empty seat rather than getting lost.
 *
 * @returns {{ slots: Array<{judge_number:number, filled:boolean, value?:number,
 *   category?:string, dropped?:boolean}>, total: number|null }}
 */
export function livePanel(scores, numJudges, eventType, dd) {
  const n = parseInt(numJudges) || 5
  const seat = new Map()
  const loose = []
  for (const s of Array.isArray(scores) ? scores : []) {
    if (!s) continue
    const v = Number(s.value)
    if (Number.isNaN(v)) continue
    const jn = Number(s.judge_number)
    if (Number.isInteger(jn) && jn >= 1 && jn <= n && !seat.has(jn)) seat.set(jn, v)
    else loose.push(v)
  }
  for (let jn = 1; jn <= n && loose.length; jn++) {
    if (!seat.has(jn)) seat.set(jn, loose.shift())
  }

  const complete = seat.size >= n
  const dropped = new Set()
  let total = null
  if (complete) {
    const rows = annotateJudgeRows(
      Array.from({ length: n }, (_, i) => ({ judge_number: i + 1, score: seat.get(i + 1) })),
      n,
      eventType,
    )
    let kept = 0
    for (const r of rows) {
      if (r.dropped) dropped.add(r.judge_number)
      else kept += r.score
    }
    const d = parseFloat(dd)
    if (d && !Number.isNaN(d)) total = kept * d * (eventType === 'synchro_pair' ? 0.6 : 1)
  }

  const slots = []
  for (let jn = 1; jn <= n; jn++) {
    if (!seat.has(jn)) {
      slots.push({ judge_number: jn, filled: false })
      continue
    }
    const value = seat.get(jn)
    slots.push({ judge_number: jn, filled: true, value, category: scoreCategory(value), dropped: dropped.has(jn) })
  }
  return { slots, total }
}

// Re-export the bucket helper so callers that already imported the
// composable don't need a second import.
export { scoreCategory } from './useScoreCategories.js'
