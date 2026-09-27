// Short-TTL cache for the archive listing endpoints' unbounded
// all-time aggregations (/api/archive and /api/archive/clubs).
// Every first-time Scoreboard visitor hits both, and each one
// re-scans scores ⨝ users ⨝ events across platform's whole
// history. Same storage as lib/scoreboard-cache.js (lib/ttl-cache.js),
// just two fixed keys and a wipe-everything invalidate.
//
// Why this lives in lib/ and not inside routes/archive.js: the
// listing's `status` field is load-bearing, ScoreboardView picks
// the live vs recap layout from it (currentEvent/isCompleted), so
// a stale entry doesn't just delay a "LIVE NOW" banner, it renders
// the wrong page mode for a freshly-completed event. The event
// status-flip route therefore invalidates this cache on every
// successful transition (and on event delete); the TTL only
// bounds staleness for fields where a 60s lag is genuinely
// harmless (current_round, last_diver_name, counts).
//
// Single-process design, same caveat as lib/scoreboard-cache.js.

const createTtlCache = require("./ttl-cache");

const ARCHIVE_TTL_MS = 60_000;
// Swept once a TTL, so a quiet deployment doesn't pin the last payload
// forever.
const cache = createTtlCache({ ttlMs: ARCHIVE_TTL_MS, sweepMs: ARCHIVE_TTL_MS });

const get = cache.get;
const set = cache.set;

// Drop everything. Called from the event status-flip and delete
// routes, since both keys derive from the events table, and the
// next listing request rebuilds them in one query each.
function invalidate() {
  cache.clear();
}

module.exports = { get, set, invalidate };
