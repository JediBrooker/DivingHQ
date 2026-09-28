// Places in a standings list, with ties shared.
//
// WA Art 4.1.5: divers on the same total share the place, and the next
// place skips (1, 1, 3). /api/scoreboard already sends `rank` from
// RANK(); the recap's archive standings don't. Numbering by list position
// instead, as the Control Room's standings, the scoreboard's "Currently
// Nth" / catch-up and the recap badges did, put two tied divers at 1st and
// 2nd right next to a standings panel showing them both 1st.
//
// Plain JS so node:test can import it.

// Totals are 2-decimal numbers that may arrive as strings; anything this
// close is the same total.
const EPS = 1e-9

// rows must already be sorted by total, highest first (every standings
// payload is). Returns the 1-based place for each row.
export function sharedRanks(rows, totalOf = (r) => r?.total) {
  const out = []
  let prevTotal = null
  let prevRank = 0
  ;(Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const total = parseFloat(totalOf(r)) || 0
    if (prevTotal !== null && Math.abs(total - prevTotal) < EPS) {
      out.push(prevRank)
    } else {
      prevRank = i + 1
      prevTotal = total
      out.push(prevRank)
    }
  })
  return out
}

// The place of rows[idx]: the server's rank when the row has one,
// otherwise worked out from the totals. null for an index that isn't in
// the list.
export function placeOf(rows, idx) {
  if (!Array.isArray(rows) || idx == null || idx < 0 || idx >= rows.length) return null
  const given = Number(rows[idx]?.rank)
  if (Number.isFinite(given) && given > 0) return given
  return sharedRanks(rows)[idx]
}
