// Cache TTL policy. Single source of truth for how long each
// kind of API read survives in the client-side IDB cache before
// we force a network round-trip.
//
// Picked per-endpoint based on:
//   * How fast the underlying data can change (5s for the live
//     scoreboard since the next dive lands every ~30s; 24h for
//     the dive directory since it only changes when a custom
//     dive gets added).
//   * Whether sockets invalidate the cache key on real change
//     (scoreboard, panel, hold state are all socket-driven, so
//     the TTL here is really just the offline-fallback window).
//   * UX cost of serving stale data (a judge looking at the
//     scoreboard catching up is fine; a judge looking at THEIR
//     own panel position would be bad if stale).
//
// Always passed as the `maxAgeMs` option to cachedApiFetch / the
// underlying cachedFetch helper. See src/lib/idbCache.js §TTL.

// Dive catalog. Only changes when an org adds a custom dive,
// which is basically a one-time setup action. 24h covers any
// realistic in-meet session.
export const DIVE_DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000

// Event metadata (name, height, judges, status, etc). Edited by
// meet managers between meets, once the meet is live it's mostly
// stable. 1h TTL plus socket-event-driven invalidation on status
// changes covers the cases we care about.
export const EVENT_METADATA_TTL_MS = 60 * 60 * 1000

// Meet metadata (name, venue, dates). Slow-changing, same
// posture as event metadata.
export const MEET_METADATA_TTL_MS = 60 * 60 * 1000

// Live scoreboard. Mirrors the server-side scoreboard-cache TTL
// in lib/scoreboard-cache.js so the client doesn't serve a value
// older than the server would. Socket-driven invalidation on
// score_received drives the real freshness.
export const SCOREBOARD_LIVE_TTL_MS = 5 * 1000

// Archive (completed-meet) scoreboard. Once Completed status is
// final the standings never change, so a 24h cache is generous.
// We rely on socket-driven invalidation to catch the rare
// admin-retroactively-edits-a-completed-meet case.
export const SCOREBOARD_ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000

// Judge panel composition. Set pre-meet, occasionally edited
// mid-meet. 5 min covers it, and manager-side edits invalidate
// the cache via a socket event anyway.
export const PANEL_TTL_MS = 5 * 60 * 1000

// Diver profile (history, analytics, dashboard). Updated as
// scores commit but the user-visible view tolerates a few
// minutes of staleness.
export const DIVER_PROFILE_TTL_MS = 5 * 60 * 1000

// Schedule. Edits happen pre-meet, then it's mostly static day-of.
export const SCHEDULE_TTL_MS = 5 * 60 * 1000
