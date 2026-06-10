// Short-TTL cache for the archive listing endpoints' unbounded
// all-time aggregations (/api/archive and /api/archive/clubs).
// Every first-time Scoreboard visitor hits both, and each one
// re-scans scores ⨝ users ⨝ events across the platform's whole
// history. Same strategy as lib/scoreboard-cache.js, simplified
// to two fixed keys.
//
// Why this lives in lib/ and not inside routes/archive.js: the
// listing's `status` field is load-bearing — ScoreboardView picks
// the live vs recap layout from it (currentEvent/isCompleted), so
// a stale entry doesn't just delay a "LIVE NOW" banner, it renders
// the wrong page mode for a freshly-completed event. The event
// status-flip route therefore invalidates this cache on every
// successful transition (and on event delete); the TTL only
// bounds staleness for fields where a 60s lag is genuinely
// harmless (current_round, last_diver_name, counts).
//
// Single-process design — same caveat as lib/scoreboard-cache.js.

const ARCHIVE_TTL_MS = 60_000;
const cache = new Map(); // key → { payload, expiresAt }

function get(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function set(key, payload) {
  if (payload == null) return;
  cache.set(key, { payload, expiresAt: Date.now() + ARCHIVE_TTL_MS });
}

// Drop everything. Called from the event status-flip and delete
// routes — both keys derive from the events table, and the next
// listing request rebuilds them in one query each.
function invalidate() {
  cache.clear();
}

// Periodic sweep so a quiet deployment doesn't pin the last
// payload forever. unref()'d so the timer never holds the
// process open (same posture as the idempotency sweeper).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, ARCHIVE_TTL_MS).unref?.();

module.exports = { get, set, invalidate, ARCHIVE_TTL_MS };
