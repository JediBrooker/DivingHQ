// Which records a scoreboard dive holds, for the quiet record chip on the
// history cards and the recap.
//
// Marks come from two places: the `records` array on the scoreboard (or
// archive) payload, and record_broken off the socket while the page is
// open. The same mark often arrives through both, so they're merged here
// and matched to a rendered dive by diver, dive code, position and score.
// The score matters because a diver can meet the same dive twice in one
// event (a dive-off, say) and only the one that set the mark gets a chip.
//
// Only club, region, national and continental marks that beat a standing
// record count. Personal bests and first marks (prev_score null) are left
// out: a diver's first go at any dive is a personal best, and in a new
// club a club record as well, which is the noise that got the old record
// toasts pulled off the scoreboard.

export const RECORD_SCOPE_RANK = { club: 1, region: 2, federation: 3, continental: 4 }

export function isChipMark(m) {
  return !!m && RECORD_SCOPE_RANK[m.scope] != null && m.prev_score != null
}

// Records are stored to two decimals and a live dive total can carry more,
// so "the same score" gets a little slack.
function sameScore(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01
}

function keyOf(competitorId, diveCode, position) {
  return `${competitorId}:${diveCode}${position || ''}`
}

// Merge any number of mark lists into a lookup by diver + dive. The
// socket payload names the diver holder_id, the scoreboard payload
// competitor_id; both mean the same person here.
export function indexRecordMarks(...lists) {
  const index = new Map()
  for (const list of lists) {
    for (const m of list || []) {
      if (!isChipMark(m)) continue
      const who = m.competitor_id ?? m.holder_id
      if (!who || !m.dive_code) continue
      const key = keyOf(who, m.dive_code, m.position)
      const held = index.get(key) || []
      if (!held.some((x) => x.scope === m.scope && sameScore(x.score, m.score))) {
        held.push({ ...m, competitor_id: who })
      }
      index.set(key, held)
    }
  }
  return index
}

// Which book a mark is in. A book has one record at a time, so a newer
// mark in the same book replaces the older one, whoever set it.
export function recordBookKey(m) {
  return [m.scope, m.scope_id, m.gender, m.height, m.dive_code, m.position].join('|')
}

// A list of marks less any in the same book as `mark`. The scoreboard runs
// both its lists through this when record_broken says a book changed
// hands, or the dive that held it before keeps its chip (for everyone
// watching; a reload only ever showed the current holder). Marks from an
// older server without scope_id or height can't be matched and stay.
export function withoutBook(list, mark) {
  if (mark?.scope_id == null || !mark.height) return list || []
  const key = recordBookKey(mark)
  return (list || []).filter((m) => m.scope_id == null || !m.height || recordBookKey(m) !== key)
}

// The marks one dive row holds, biggest book first. [] means no chip.
export function marksForDive(index, dive) {
  if (!dive?.competitor_id || !dive.dive_code) return []
  const held = index.get(keyOf(dive.competitor_id, dive.dive_code, dive.position)) || []
  return held
    .filter((m) => sameScore(m.score, dive.total_dive_score))
    .sort((a, b) => RECORD_SCOPE_RANK[b.scope] - RECORD_SCOPE_RANK[a.scope])
}
