// The sums behind the scoreboard's catch-up box: what a diver has left to
// dive, and the average judge score they'd need over it to close a gap.
//
// The box used to count the dives left as total_rounds - round + 1, which
// always counts the dive on the board. Once that dive's panel was in, its
// points were in the standings beside the box and it was still counted as
// to come, so the box asked for scores on a dive that had already happened
// and spread the gap too thin. After the last dive of an event the
// projector still said "1 dive left".
//
// The scoreboard payload's `upcoming` list is every dive-list row that has
// no score yet, read in the same batch as the standings. A dive is in one
// or the other, never both, so counting a diver's rows in `upcoming` can't
// count a dive twice or miss one, whenever the payload landed.
//
// Plain JS so node:test can import it.

// A diver's dives still to come: how many, and the DD they average (the
// sum of their DDs is what the maths wants, and that's avgDd x count).
// Null when we can't tell, no id to match on or no queue loaded, so the
// caller can fall back to a rougher guess.
export function divesLeft(upcoming, competitorId) {
  if (!competitorId || !Array.isArray(upcoming)) return null
  const mine = upcoming.filter((u) => u?.competitor_id != null
    && String(u.competitor_id) === String(competitorId))
  const dds = mine.map((u) => parseFloat(u.dd)).filter((dd) => Number.isFinite(dd) && dd > 0)
  return {
    count: mine.length,
    avgDd: dds.length ? dds.reduce((a, b) => a + b, 0) / dds.length : null,
  }
}

// The average judge score needed on every remaining dive to make up `gap`
// points: `dives` dives at an average DD of `dd`, `mult` kept scores per
// dive (synchro already folded in). If every judge gives X, a dive earns
// X x mult x DD, so X = gap / (mult x dd x dives).
//
// The score is rounded up to the next half point, since that's the lowest
// score a judge can actually give that gets there (5.2 isn't a score, 5.5
// is). `possible` goes off the raw figure, so a raw 9.6 (straight 10s)
// still counts as possible. With no dives left a gap can't close at all.
// `dives` null means we don't know, and then there's no answer either way.
export function scoreToClose(gap, { dives, dd, mult }) {
  if (gap <= 0) return { score: 0, possible: true }
  if (dives === 0) return { score: null, possible: false }
  if (!dives || !dd || !mult) return { score: null, possible: null }
  const raw = gap / (mult * dd * dives)
  return { score: Math.ceil(raw * 2) / 2, possible: raw <= 10 }
}
