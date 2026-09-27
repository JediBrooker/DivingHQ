// Tiny in-memory cache for /api/scoreboard/:eventId payloads
// (and derived per-event payloads like the /leaderboard view,
// see getDerived/setDerived below).
//
// Live meets see 5–20 connected scoreboards, all rendering off
// the same query (standings + history + up-next). Without a
// cache, a single score submission triggers re-fetches from
// every viewer in parallel, and the standings query joins across
// scores, event_judges, competitor_dive_lists, dive_directory,
// users, clubs, organisations and runs the trim-and-multiply UDF
// per dive. ~150ms × N viewers per score event chews through pool
// slots fast.
//
// Strategy: cache the rendered payload per eventId with a
// short TTL (default 5s) AND expose explicit invalidate() so
// the socket layer can flush the bucket the moment a new score
// commits. That gives us:
//   * Hot path: cache hit, ~1ms response
//   * After a score: the score handler invalidates → next
//     /api/scoreboard call rebuilds and re-caches
//   * Failsafe: TTL expires even if the invalidation hook is
//     ever dropped, so staleness is bounded
//
// Invalidation alone has a gap, though. A rebuild that started just
// before the invalidate reads the old rows, finishes just after it,
// and caches what it read, so the stale payload sits there for a full
// TTL. Any score can hit that if a refetch happens to be in flight,
// and the records check hits it nearly every time a record falls: it
// commits a few milliseconds after the score's own broadcast, which is
// exactly when the spectators' refetches go out. So every invalidate
// bumps a per-event generation; a rebuild takes generation() before it
// queries and passes it back to set(), which drops the payload if the
// number moved in the meantime.
//
// Heads up: this is a single-process design (matches the
// activeDivers / meetHolds invariant in lib/live-state.js).
// Clustering would split-brain the cache, so either move to Redis
// or stay single-instance.

const DEFAULT_TTL_MS = 5_000;

module.exports = function createScoreboardCache({ ttlMs = DEFAULT_TTL_MS } = {}) {
  // key → { payload, expiresAt }
  //
  // Two key shapes share one store:
  //   * the bare eventId: the main /api/scoreboard/:eventId
  //     payload (the original get/set API, unchanged)
  //   * `${eventId}::<kind>`: derived payloads computed from the
  //     same underlying scores (e.g. the per-round leaderboard).
  //     The "::" separator can't appear in a UUID, so derived
  //     keys can never collide with a bare eventId.
  // invalidate(eventId) clears the bare key AND every derived
  // key for that event, so the existing invalidation hooks (the
  // socket submit_score handler, the HTTP score-correction
  // handler) flush derived payloads without any change at the
  // call sites.
  const store = new Map();
  // eventId → how many times it's been invalidated. Never pruned: it's
  // one small integer per event this process has seen, and forgetting
  // one mid-rebuild would reopen the gap it's there to close.
  const generations = new Map();

  function generation(eventId) {
    return generations.get(eventId) || 0;
  }

  // A payload built from reads that started at generation `gen` is only
  // worth caching if nothing was invalidated in the meantime. Callers
  // that don't pass one get the old unconditional write.
  function fresh(eventId, gen) {
    return gen == null || gen === generation(eventId);
  }

  function derivedKey(eventId, kind) {
    return `${eventId}::${kind}`;
  }

  function readKey(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return hit.payload;
  }

  function writeKey(key, payload) {
    store.set(key, { payload, expiresAt: Date.now() + ttlMs });
  }

  function get(eventId) {
    if (!eventId) return null;
    return readKey(eventId);
  }

  function set(eventId, payload, gen) {
    if (!eventId || payload == null || !fresh(eventId, gen)) return;
    writeKey(eventId, payload);
  }

  // Derived-payload accessors, same TTL + invalidation lifecycle
  // as the main payload, keyed by (eventId, kind).
  function getDerived(eventId, kind) {
    if (!eventId || !kind) return null;
    return readKey(derivedKey(eventId, kind));
  }

  function setDerived(eventId, kind, payload, gen) {
    if (!eventId || !kind || payload == null || !fresh(eventId, gen)) return;
    writeKey(derivedKey(eventId, kind), payload);
  }

  function invalidate(eventId) {
    if (!eventId) return;
    generations.set(eventId, generation(eventId) + 1);
    store.delete(eventId);
    // Prefix invalidation: drop every derived entry for this
    // event too. The store stays small (a handful of live events
    // × a couple of kinds) so a linear sweep is fine.
    const prefix = `${eventId}::`;
    for (const key of store.keys()) {
      if (typeof key === "string" && key.startsWith(prefix)) store.delete(key);
    }
  }

  // Periodic sweep so events that go quiet (last score 10 minutes
  // ago, no more reads) don't pin there payload forever. ~half
  // the TTL is plenty of resolution.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt <= now) store.delete(key);
    }
  }, Math.max(ttlMs / 2, 1000)).unref?.();

  return { get, set, getDerived, setDerived, invalidate, generation };
};
