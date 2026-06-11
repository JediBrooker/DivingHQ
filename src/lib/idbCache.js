// Tiny IndexedDB wrapper for offline API caching.
//
// Why not the Cache API (used in the service worker)?
//   - SW Cache API is keyed by Request, awkward for headers/auth.
//   - We want to expose entries from the page side too (so the
//     UI can show "stale data — refreshing" while the network
//     call is in flight). IndexedDB works in both contexts.
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
// poolside devices). Each user now has their own keyspace; logout
// also wipes the store via clearSessionCache().
//
// Phase 3 of the offline-resilience work (docs/offline-p1-design.md
// references P3) adds TTL + invalidate + prefetch helpers on top
// of the SWR base:
//
//   * cachedFetch(…, { maxAgeMs }) — hard age boundary. If the
//     cached entry is older than maxAgeMs we DON'T serve it; we
//     await the network instead. Use for time-sensitive reads
//     (active scoreboard) where stale data would mislead.
//   * idbInvalidate(predicate)     — cursor-walk + delete every
//     key whose URL matches the predicate. Wired to socket
//     events (score_received → invalidate /api/scoreboard/:id;
//     state_update → invalidate event metadata).
//   * prefetch(urls, fetchOpts)    — fan-out cachedFetch over a
//     list of URLs. Used at meet-load time to warm caches for
//     dive directory + roster + panel + schedule before the
//     user lands on any view that consumes them.

// Explicit .js extension — this module is also loaded by the
// node:test suite, where extensionless ESM specifiers don't
// resolve.
import { fingerprintFromToken } from './userFingerprint.js'

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
    req.onerror   = () => resolve(null)   // never reject — caller falls back
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
// up. Failures are swallowed — if both cache and network are
// unavailable, returns { data: null }.
//
// maxAgeMs is the hard TTL. When unset (the original behaviour),
// any cached entry is served while network revalidates. When set,
// entries older than maxAgeMs are NOT served — we await the
// network instead. Use for reads where serving very stale data
// would mislead (active scoreboard, judge panel state).
export async function cachedFetch(url, fetchOptions = {}, { onUpdate, maxAgeMs, fingerprint } = {}) {
  // Per-user cache key so user A's cached responses are invisible to
  // user B. Since the cookie migration the auth store passes the
  // identity fingerprint in explicitly (the JWT is no longer readable
  // from JS to derive one); fall back to the Authorization header for
  // any caller that still sends a Bearer token, then 'anon' for public
  // reads.
  let fp = fingerprint
  if (fp == null) {
    const authHeader =
      (fetchOptions.headers && (fetchOptions.headers.Authorization
        || fetchOptions.headers.authorization)) || ''
    fp = fingerprintFromToken(String(authHeader).replace(/^Bearer\s+/i, ''))
  }
  const key = `${fp}:${url}`
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
      // Auth failures invalidate the cache — never serve a stale
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
      // Should be rare since the SWR path above caught the
      // happy case; safety net for the race where the cache
      // shape changed between the initial read and now.
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
//   * useSocket listeners: score_received → invalidate the
//     event's /api/scoreboard cache; state_update → invalidate
//     event metadata; meet_held → invalidate meet hold state.
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
      // separate — fingerprints are URL-safe so they don't
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

// Pre-fetch a list of URLs into the cache. Fire-and-forget;
// failures are swallowed. Called at meet-load time so the
// downstream views (judge, scoreboard, control room) all hit
// warm cache instead of cold network.
//
// Each url can be either a string or a { url, fetchOptions } pair.
// fetchOptions defaults to the shared `fetchOptions` arg.
export async function prefetch(urls, fetchOptions = {}) {
  await Promise.all((urls || []).map((entry) => {
    const url = typeof entry === 'string' ? entry : entry.url
    const opts = (typeof entry === 'object' && entry.fetchOptions) || fetchOptions
    return cachedFetch(url, opts).catch(() => null)
  }))
}
