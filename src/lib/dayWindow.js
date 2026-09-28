// Whole-day windows (a fee's "From" / "Until" dates) as real instants.
//
// A bare 'YYYY-MM-DD' sent into a timestamptz column is midnight in the
// DB session's time zone, and reading it back with iso.slice(0, 10)
// gives the UTC date. Those only agree on a UTC database, so on one east
// of UTC every load and save of the fee editor walked the window back a
// day. And an "Until" of midnight at the start of the day left that
// whole day out of the window.
//
// So the editor sends the start of the first day and the end of the last
// one, in the browser's zone, and shows stored instants as local dates.

function parts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''))
  return m ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : null
}

// 00:00:00.000 local on that day, as an ISO instant. null for blank.
export function dayStartIso(ymd) {
  const p = parts(ymd)
  return p ? new Date(p[0], p[1], p[2], 0, 0, 0, 0).toISOString() : null
}

// 23:59:59.999 local on that day, so the day itself is inside the window.
export function dayEndIso(ymd) {
  const p = parts(ymd)
  return p ? new Date(p[0], p[1], p[2], 23, 59, 59, 999).toISOString() : null
}

// A stored instant as the local calendar date an <input type=date> wants.
export function localDay(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
