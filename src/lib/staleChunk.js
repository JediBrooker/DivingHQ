// Recovering a tab that outlived a deploy.
//
// deploy.sh rebuilds dist/ in place, so the old hashed chunk names are
// gone the moment it finishes. A tab opened before that still holds the
// old entry chunk, and the first lazy screen or dialog it asks for comes
// back 404. The dynamic import rejects, the router swallows it, and the
// click just does nothing. Worse, the browser keeps that failed import in
// its module map for the life of the document, so retrying never helps.
//
// A single full load fixes it: it pulls the new index.html and the new
// chunk names. The guard is there so a server that really is broken
// doesn't send us round a reload loop. One try per window, then we give
// up and leave the error where it is.

const KEY = 'dhq.staleChunkReloadAt'
const WINDOW_MS = 10_000

// The messages differ per engine, and a missing chunk that came back as
// the SPA shell fails the MIME check instead of the fetch.
const PATTERNS = [
  /failed to fetch dynamically imported module/i,   // Chromium
  /error loading dynamically imported module/i,     // Firefox
  /importing a module script failed/i,              // Safari
  /unable to preload css/i,                         // vite's css preload
  /is not a valid javascript mime type/i,
]

export function isStaleChunkError(err) {
  const msg = String(err?.message || err || '')
  return PATTERNS.some((re) => re.test(msg))
}

// Returns true when it went for the reload. `go` is location.assign or
// location.reload, injected so the test doesn't need a browser.
export function reloadOnce({ storage, now = Date.now(), go }) {
  try {
    const last = Number(storage.getItem(KEY) || 0)
    if (now - last < WINDOW_MS) return false
    storage.setItem(KEY, String(now))
  } catch {
    // No sessionStorage means no loop guard, so don't risk it.
    return false
  }
  go()
  return true
}

// Wires both hooks. vite:preloadError covers lazy components and CSS
// that aren't routes; router.onError knows where the user was headed,
// so it gets first go and the reload lands on the page they clicked.
export function installStaleChunkRecovery(router) {
  if (typeof window === 'undefined') return
  // Even reading the property throws in some locked-down embeds.
  let storage = null
  try { storage = window.sessionStorage } catch { /* reloadOnce says no */ }
  router.onError((err, to) => {
    if (!isStaleChunkError(err)) return
    const target = to?.fullPath
    reloadOnce({ storage, go: () => (target ? window.location.assign(target) : window.location.reload()) })
  })
  window.addEventListener('vite:preloadError', () => {
    // Deferred so a route navigation's onError, which runs after this in
    // the same rejection, can claim the reload with its target first.
    setTimeout(() => reloadOnce({ storage, go: () => window.location.reload() }), 0)
  })
}
