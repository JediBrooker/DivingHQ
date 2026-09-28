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
// Clearing on the flip isn't enough by itself though. A rebuild that
// missed just before the flip reads the old status (or doesn't see the
// event at all yet), finishes a moment after invalidate() has run, and
// then caches what it read for the full 60s. On a big database the
// listing takes a couple hundred ms to build, so that window is real;
// it's what made the team recap e2e flaky. Same fix as
// lib/scoreboard-cache.js: invalidate() bumps a generation, the route
// reads generation() before it queries and hands it back to set(), and
// set() drops the rows if the number moved in between.
//
// Single-process design, same caveat as lib/scoreboard-cache.js.

const createTtlCache = require("./ttl-cache");

const ARCHIVE_TTL_MS = 60_000;
// Swept once a TTL, so a quiet deployment doesn't pin the last payload
// forever.
const cache = createTtlCache({ ttlMs: ARCHIVE_TTL_MS, sweepMs: ARCHIVE_TTL_MS });

// One counter for the whole cache, not one per key, because
// invalidate() wipes both keys at once anyway.
let gen = 0;

function generation() {
  return gen;
}

const get = cache.get;

// Rows read starting at generation `g` only get cached if nothing was
// invalidated while the query ran. No `g` means the old unconditional
// write, for any caller that doesn't care.
function set(key, value, g) {
  if (g != null && g !== gen) return;
  cache.set(key, value);
}

// Drop everything. Called from the event status-flip and delete
// routes, since both keys derive from the events table, and the
// next listing request rebuilds them in one query each.
function invalidate() {
  gen += 1;
  cache.clear();
}

module.exports = { get, set, invalidate, generation };
