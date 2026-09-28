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
