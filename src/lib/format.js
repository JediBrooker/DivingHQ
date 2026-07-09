// Shared date/time formatters.
//
// Before this file existed, `fmtDate` / `fmtTime` / `fmtRelative` were
// copy-pasted into 11 views with subtle drift ("1m ago" vs "1 min ago",
// inconsistent default options). One source of truth keeps the SPAs
// date strings consistent across surfaces and makes future i18n a
// single-file change instead of an 11-file hunt.
//
// All helpers tolerate null / undefined / invalid input and return ''
// rather than throwing or rendering "Invalid Date".

function asDate(input) {
  if (input == null || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "Mar 14, 2026" */
export function fmtDate(input) {
  const d = asDate(input)
  if (!d) return ''
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

/** "Mar 14, 2026, 3:45 PM" */
export function fmtDateTime(input) {
  const d = asDate(input)
  if (!d) return ''
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/** "3:45 PM" */
export function fmtTime(input) {
  const d = asDate(input)
  if (!d) return ''
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  })
}

/**
 * "just now" / "5m ago" / "3h ago" / "2d ago", falls back to
 * a short date for anything older than a week.
 */
export function fmtRelative(input) {
  const d = asDate(input)
  if (!d) return ''
  const ms = Date.now() - d.getTime()
  if (ms < 0) return fmtDate(input)         // future timestamps render as absolute
  const min = Math.round(ms / 60_000)
  if (min < 1)  return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24)  return `${hr}h ago`
  const dy = Math.round(hr / 24)
  if (dy < 7)   return `${dy}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Entries-close-at presentation. Used by the dashboard pulse
 * strip + Meet Manager event rows. "entries already closed" /
 * "entries close in 5h" / "entries close in 3 days" / falls back
 * to a "Mar 14" date string when more than a week away.
 */
export function fmtCloses(input) {
  const d = asDate(input)
  if (!d) return null
  const ms = d.getTime() - Date.now()
  if (ms < 0) return 'entries already closed'
  const day = 86_400_000
  if (ms < day) {
    const hr = Math.max(1, Math.round(ms / 3_600_000))
    return `entries close in ${hr}h`
  }
  if (ms < 7 * day) {
    const dy = Math.round(ms / day)
    return `entries close in ${dy} day${dy === 1 ? '' : 's'}`
  }
  return `entries close ${d.toLocaleString(undefined, { month: 'short', day: 'numeric' })}`
}

/**
 * English ordinal for a 1-based rank: 1 → "1st", 2 → "2nd",
 * 11 → "11th", 21 → "21st". Returns '' for null/undefined.
 */
export function ordinal(n) {
  if (n == null) return ''
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

/**
 * Podium CSS class for a ZERO-based standings index: 0 → 'gold',
 * 1 → 'silver', 2 → 'bronze', '' otherwise. (placeColor in
 * profile-helpers.js is the 1-based variant with 'place-*'
 * class names.)
 */
export function rankClass(i) {
  if (i === 0) return 'gold'
  if (i === 1) return 'silver'
  if (i === 2) return 'bronze'
  return ''
}
