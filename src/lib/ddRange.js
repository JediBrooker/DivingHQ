// The DD range a custom dive has to stay inside, worked out from the
// directory rows the page already has. Mirrors lib/custom-dive-dd.js on
// the server (which is what actually refuses): the lowest to the highest
// DD among the official (core) rows at the same board height, or across
// every official row when that height has none of its own (0m, where the
// poolside drills live). The page uses it to say the range up front and
// to flag custom rows made before the rule, which a dive list won't take.

// "3m", "3.0", 3 -> 3. Heights arrive from Postgres as numeric strings and
// from the form as labels.
export function heightNumber(h) {
  if (typeof h === 'number') return h
  const n = parseFloat(String(h ?? '').replace(/m$/i, ''))
  return Number.isFinite(n) ? n : null
}

// { byHeight: Map(height -> { min, max }), all: { min, max } | null }
export function officialDdRanges(dives) {
  const byHeight = new Map()
  let all = null
  for (const d of dives || []) {
    if (d.is_custom) continue
    const h = heightNumber(d.height)
    const dd = Number(d.dd)
    if (h == null || !Number.isFinite(dd)) continue
    const cur = byHeight.get(h)
    byHeight.set(h, cur ? { min: Math.min(cur.min, dd), max: Math.max(cur.max, dd) } : { min: dd, max: dd })
    all = all ? { min: Math.min(all.min, dd), max: Math.max(all.max, dd) } : { min: dd, max: dd }
  }
  return { byHeight, all }
}

// { min, max, fromAllHeights } for a height, or null with no official rows.
export function ddRangeFor(ranges, height) {
  const h = heightNumber(height)
  const own = h == null ? null : ranges?.byHeight?.get(h)
  if (own) return { ...own, fromAllHeights: false }
  if (ranges?.all) return { ...ranges.all, fromAllHeights: true }
  return null
}

// A custom row whose DD a dive list would refuse. Core rows never are.
export function isOutsideOfficialRange(ranges, dive) {
  if (!dive?.is_custom) return false
  const range = ddRangeFor(ranges, dive.height)
  const dd = Number(dive.dd)
  if (!range) return true
  return !(dd >= range.min && dd <= range.max)
}
