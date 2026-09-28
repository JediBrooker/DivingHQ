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
//     (the scoreboard is socket-driven, so its TTL is really just
//     the offline-fallback window).
//   * UX cost of serving stale data (a spectator's scoreboard
//     catching up a few seconds late is fine).
//
// Always passed as the `maxAgeMs` option to cachedApiFetch / the
// underlying cachedFetch helper. See src/lib/idbCache.js §TTL.

// Dive catalog. Only changes when an org adds a custom dive,
// which is basically a one-time setup action. 24h covers any
// realistic in-meet session.
export const DIVE_DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000

// Meet metadata (name, venue, dates). Edited by meet managers
// between meets, once the meet is live it's mostly stable.
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
