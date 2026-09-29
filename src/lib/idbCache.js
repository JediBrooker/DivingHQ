// Tiny IndexedDB wrapper for offline API caching.
//
// Why not the Cache API (used in the service worker)?
//   - SW Cache API is keyed by Request, kind of awkward for headers/auth.
//   - We want to expose entries from the page side too, so the UI can
//     show "stale data, refreshing" while the network call is in
//     flight. IndexedDB works in both contexts.
//
// Schema:
//   db    : 'dive-recorder-cache'
//   store : 'api'
//   key   : <user-fingerprint>:<url>
//   value : { data, ts }   ts is Date.now() at write time
//
// The user-fingerprint prefix matters for security: previously the
// key was just the URL, which meant after user A logged out, user B
// logging in on the same browser would see A's cached responses
// flash up before the network call landed (real PII leak on shared
// poolside devices). Each user now has their own keyspace, and logout
// also wipes the store via clearSessionCache().
//
// Phase 3 of the offline-resilience work (docs/offline-p1-design.md
// references P3) adds TTL and invalidate helpers on top of the SWR
// base:
//
//   * cachedFetch(…, { maxAgeMs }): hard age boundary. If the cached
//     entry is older than maxAgeMs we DON'T serve it, we await the
//     network instead. Use for time-sensitive reads (active
//     scoreboard) where stale data would mislead.
//   * idbInvalidate(predicate): cursor-walk + delete every key whose
//     URL matches the predicate. invalidateEventScores wraps it for
//     the socket events that move an event's scores.

const DB_NAME = 'dive-recorder-cache'
const STORE   = 'api'
const VERSION = 1

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null)
  }
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => resolve(null)   // never reject, caller falls back
  })
  return dbPromise
}

export async function idbGet(key) {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror   = () => resolve(null)
  })
}

export async function idbSet(key, data) {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ data, ts: Date.now() }, key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => resolve()
  })
}

export async function idbDelete(key) {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => resolve()
  })
}

// Wipe every cached API response. Call from logout so user B doesn't
// inherit user A's cached payloads on a shared device.
export async function idbClear() {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror    = () => resolve()
  })
}

// Pure helper: is a cached entry past its hard TTL?
// Exposed for unit tests.
export function isCacheExpired(cached, maxAgeMs, now = Date.now()) {
  if (!cached) return true
  if (maxAgeMs == null) return false  // no TTL set = SWR forever
  return (now - cached.ts) > maxAgeMs
}

// Stale-while-revalidate fetch helper. Returns:
//   { data, fromCache, age }
// where data is the parsed JSON, fromCache is true when served
// from IDB (with a network revalidation fired in the background),
// and age is the cache entry's age in ms (0 if fresh from network).
//
// onUpdate is called when the background revalidation lands, so
// the caller can swap the displayed data once the network catches
// up. Failures are swallowed, if both cache and network are
// unavailable it just returns { data: null }.
//
// maxAgeMs is the hard TTL. When unset (the original behaviour), any
// cached entry is served while network revalidates. When set, entries
// older than maxAgeMs are NOT served, we await the network instead.
// Use for reads where serving very stale data would mislead (active
// scoreboard, judge panel state).
export async function cachedFetch(url, fetchOptions = {}, { onUpdate, maxAgeMs, fingerprint } = {}) {
  // Per-user cache key so user A's cached responses are invisible to
  // user B. Signed-in reads pass the identity fingerprint (the auth
  // store's cachedApiFetch does it for you); anything else is a public
  // read and shares the 'anon' keyspace. There used to be a fallback
  // that sliced one out of an Authorization: Bearer header, but since
  // the cookie migration nothing in the SPA sends one.
  const key = `${fingerprint ?? 'anon'}:${url}`
  const cached = await idbGet(key)
  const expired = isCacheExpired(cached, maxAgeMs)
  let returned = false
  let returnValue

  // Kick off the network revalidation regardless. If we have a
  // cache entry, return it now and let the network update on the
  // side; if not, await the network.
  const network = (async () => {
    try {
      const r = await fetch(url, fetchOptions)
      // Auth failures invalidate the cache: never serve a stale
      // response after the user has lost access.
      if (r.status === 401 || r.status === 403) {
        idbDelete(key)
        return null
      }
      if (!r.ok) return null
      const body = await r.json()
      idbSet(key, body)            // fire and forget
      return body
    } catch {
      return null
    }
  })()

  // SWR path: serve the cached value immediately, refresh in
  // background. Only fires when we have a cached entry AND it's
  // within its TTL (or no TTL is set).
  if (cached && !expired) {
    returned = true
    returnValue = { data: cached.data, fromCache: true, age: Date.now() - cached.ts }
    network.then((fresh) => {
      if (fresh && onUpdate) onUpdate(fresh)
    })
  }

  if (!returned) {
    const fresh = await network
    if (fresh) returnValue = { data: fresh, fromCache: false, age: 0 }
    else if (cached && !expired) {
      // Network failed but we have a non-expired cached entry.
      // Should be rare since the SWR path above already caught
      // the happy case, this is just a safety net for the race
      // where the cache shape changed between the initial read
      // and now.
      returnValue = { data: cached.data, fromCache: true, age: Date.now() - cached.ts }
    } else {
      returnValue = { data: null, fromCache: false, age: 0 }
    }
  }

  return returnValue
}

// Invalidate cache entries whose URL matches a predicate. Walks
// every key in the store + filters. The match is on the URL part
// (after the `<fingerprint>:` prefix), so callers don't need to
// know the per-user keyspace.
//
// Two predicate shapes:
//   * string: prefix match. idbInvalidate('/api/scoreboard/')
//     deletes every /api/scoreboard/* entry across all users.
//   * function: (url) => boolean. Lets callers express more
//     specific patterns when prefix matching isn't enough.
//
// Used by:
//   * invalidateEventScores below, which the scoreboard and the
//     Control Room call off the socket (score_received,
//     score_corrected, record_broken, referee calls).
//   * The dive directory screens after a custom dive changes.
//   * Logout: idbClear() is the heavier nuke when we want to
//     drop the entire store.
export async function idbInvalidate(predicate) {
  const db = await openDb()
  if (!db) return 0
  const match = typeof predicate === 'function'
    ? predicate
    : (url) => url.startsWith(String(predicate))
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const cursorReq = store.openCursor()
    let deleted = 0
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result
      if (!cur) return  // tx.oncomplete fires next
      const key = String(cur.key)
      // key shape: '<fingerprint>:<url>'. Split on first ':' to
      // seperate them, fingerprints are URL-safe so they don't
      // contain colons.
      const colonIdx = key.indexOf(':')
      const url = colonIdx >= 0 ? key.slice(colonIdx + 1) : key
      if (match(url)) {
        cur.delete()
        deleted += 1
      }
      cur.continue()
    }
    tx.oncomplete = () => resolve(deleted)
    tx.onerror = () => resolve(deleted)
  })
}

// Is this cached URL one of the reads that carry an event's scores? The
// live scoreboard and its leaderboard (/api/scoreboard/:id and anything
// under it) and the recap (/api/archive/:id/results). Pure, so the test
// suite can pin it without an IndexedDB.
export function isEventScoresUrl(url, eventId) {
  if (!eventId || typeof url !== 'string') return false
  const board = `/api/scoreboard/${eventId}`
  return url === board
    || url.startsWith(`${board}/`)
    || url.startsWith(`${board}?`)
    || url.startsWith(`/api/archive/${eventId}/`)
}

// Drop every cached score read for one event. Call it when the socket
// says the scores moved (a dive completed, a correction, a referee call):
// until then the live board's copy counts as fresh for 5s and the recap's
// for a day, so a refresh straight after would repaint the old numbers.
// Never rejects, a cache that can't be cleared just means a slower read.
export function invalidateEventScores(eventId) {
  if (!eventId) return Promise.resolve(0)
  return idbInvalidate((url) => isEventScoresUrl(url, eventId)).catch(() => 0)
}
