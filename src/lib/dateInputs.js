// Converting between what date/time inputs hold and what the API stores.
//
// <input type="datetime-local"> holds a wall clock with no zone
// ('2026-10-01T10:00'). The events API casts whatever it gets with
// ::timestamptz, which reads a zone-less string in the database session's
// zone, not the browser's. So a manager anywhere but the DB's zone had
// scheduled_at and entries_close_at land hours off, and because the edit
// form turned the stored instant back into a *browser-local* wall clock,
// a Save with nothing changed moved entries_close_at again every time.
// The fix is to send an instant: the wall clock read in the browser's own
// zone, as ISO with a Z.
//
// Plain JS so node:test can import it.

// '2026-10-01T10:00' in the browser's zone -> '2026-10-01T09:00:00.000Z'.
// '' (a cleared field) and anything unparseable -> null, which the API
// takes as "no value".
export function localInputToIso(value) {
  if (!value || typeof value !== 'string') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// An instant from the API -> the 'YYYY-MM-DDTHH:mm' wall clock a
// datetime-local input wants, in the browser's zone. '' when there's
// nothing usable.
export function isoToLocalInput(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---- DATE columns ---------------------------------------------------
//
// meets.start_date / end_date and sessions.session_date are plain DATEs,
// but node-pg turns a DATE into a Date at the *server process's* local
// midnight and JSON sends that in UTC. A server east of UTC (Sydney, say)
// answers "2023-05-28T14:00:00.000Z" for 29 May. Slicing the first ten
// characters gave the day before, so Edit Meet showed and saved 28-30 May
// for a 29-31 May meet, one day earlier on every save, and "Duplicate to
// next day" proposed the same day. Showing it with new Date() was a day
// out for anyone west of the server.
//
// The value is always the server zone's midnight, so shifting it forward
// and reading the UTC date gets the calendar date back for any server
// zone from UTC-10 (Hawaii) to UTC+13 (New Zealand summer), which is every
// zone anyone would host this in. A bare 'YYYY-MM-DD' passes straight
// through, so this keeps working if the server ever starts sending DATEs
// as strings.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const MIDNIGHT_SHIFT_MS = 13 * 60 * 60 * 1000

export function dateOnly(value) {
  if (!value) return ''
  if (typeof value === 'string' && DATE_ONLY.test(value)) return value
  const d = value instanceof Date ? value : new Date(value)
  const t = d.getTime()
  if (Number.isNaN(t)) return ''
  return new Date(t + MIDNIGHT_SHIFT_MS).toISOString().slice(0, 10)
}

// 'YYYY-MM-DD' plus n calendar days, in plain calendar arithmetic (no
// zone gets a say).
export function addDays(dateStr, n) {
  const m = DATE_ONLY.exec(dateStr || '')
  if (!m) return ''
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(n || 0))
  return new Date(t).toISOString().slice(0, 10)
}

// 'YYYY-MM-DD' as a local Date on that day, for toLocaleDateString and
// friends. Noon, so no daylight-saving edge can tip it into a neighbour.
export function dateOnlyToLocalDate(dateStr) {
  const m = DATE_ONLY.exec(dateStr || '')
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
}
