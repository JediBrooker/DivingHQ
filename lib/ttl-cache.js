// Small in-memory TTL map, the one the server's hand-rolled caches share
// (lib/scoreboard-cache.js, lib/archive-cache.js). Before this each of
// them carried its own copy of the same expire-on-read get, the same
// set-with-expiresAt and the same periodic sweep.
//
// What it does:
//   * get(key) returns the value, or null once it has expired (and drops
//     it on the way).
//   * set(key, value) stores it for ttlMs. null / undefined mean "nothing
//     to cache" and are ignored, which every caller wanted anyway.
//   * delete, clear, deletePrefix for invalidation.
//   * an unref'd sweep drops entries nobody reads again, so a quiet key
//     doesn't pin its payload forever. It never holds the process open.
//
// Anything smarter (per-event generations, derived keys) stays with the
// caller. This is only the storage.
//
// Single process, like everything else in lib/ that keeps state in
// memory: a second worker would have its own copy.

function createTtlCache({ ttlMs, sweepMs = Math.max(ttlMs / 2, 1000) }) {
  if (!(ttlMs > 0)) throw new Error("createTtlCache requires a positive ttlMs");
  const store = new Map(); // key -> { value, expiresAt }

  function get(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return hit.value;
  }

  function set(key, value) {
    if (value == null) return;
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  function del(key) {
    store.delete(key);
  }

  function clear() {
    store.clear();
  }

  // The store stays small (a handful of live events times a couple of
  // kinds) so a linear pass is fine.
  function deletePrefix(prefix) {
    for (const key of store.keys()) {
      if (typeof key === "string" && key.startsWith(prefix)) store.delete(key);
    }
  }

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt <= now) store.delete(key);
    }
  }, sweepMs).unref?.();

  return { get, set, delete: del, clear, deletePrefix };
}

module.exports = createTtlCache;
