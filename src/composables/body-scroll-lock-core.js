// Pure-JS body-scroll-lock implementation. No Vue, no DOM
// globals at the module scope, every API takes the `window` /
// `document` it operates on explicitly. That's what makes the
// module trivially testable (the unit suite just passes in fake
// objects) and keeps the production composable a thin Vue
// wrapper around this.
//
// See useBodyScrollLock.js for the why-this-exists narrative,
// this file is just the mechanics.

// Module-level state. One lock counter for the whole app, since
// the same body element is either locked or it isn't.
let lockCount = 0
let savedScrollY = 0
// Stash the styles we're about to OVERWRITE so unlock can restore
// the original values later (body has its own design styles that
// must not get nuked). Only populated on the 0 -> 1 transition.
let savedBodyStyles = null

function applyLock(win, doc) {
  // Only act on the 0 -> 1 transition. Nested locks are no-ops
  // at the DOM level, just bump the counter.
  if (lockCount > 0) {
    lockCount++
    return
  }
  lockCount = 1

  savedScrollY = win.scrollY || win.pageYOffset || 0
  const body = doc.body
  savedBodyStyles = {
    position: body.style.position,
    top:      body.style.top,
    left:     body.style.left,
    right:    body.style.right,
    width:    body.style.width,
    // Belt and braces: also pin overflow on the html element,
    // catches the small number of layouts where body's overflow
    // isn't actually the scroll container.
    htmlOverflow: doc.documentElement.style.overflow,
  }
  body.style.position = 'fixed'
  body.style.top      = `-${savedScrollY}px`
  body.style.left     = '0'
  body.style.right    = '0'
  body.style.width    = '100%'
  doc.documentElement.style.overflow = 'hidden'
}

function applyUnlock(win, doc) {
  if (lockCount <= 0) {
    // Already unlocked, don't underflow.
    return
  }
  lockCount--
  if (lockCount > 0) {
    // Outer modal is still open, leave the lock in place.
    return
  }

  // 1 -> 0 transition, restore body + scroll.
  const body = doc.body
  if (savedBodyStyles) {
    body.style.position = savedBodyStyles.position
    body.style.top      = savedBodyStyles.top
    body.style.left     = savedBodyStyles.left
    body.style.right    = savedBodyStyles.right
    body.style.width    = savedBodyStyles.width
    doc.documentElement.style.overflow = savedBodyStyles.htmlOverflow
    savedBodyStyles = null
  }
  // Use scrollTo with the saved offset. window.scroll() would
  // animate on some browsers if scroll-behavior: smooth is set
  // globally, and restore is supposed to be instant.
  win.scrollTo(0, savedScrollY)
}

/**
 * Public API. Each caller gets its own instance counter so
 * lockup on component unmount can release exactly what that
 * instance locked, without underflowing global state.
 *
 * Pass `null` (or just omit the args) for SSR safety, every
 * method becomes a silent no-op when there's no environment
 * to act on.
 *
 * @param {Window|null}   win
 * @param {Document|null} doc
 */
export function createBodyScrollLock(win, doc) {
  const hasEnv = !!(win && doc)
  let instanceLocks = 0

  function lock() {
    if (!hasEnv) return
    instanceLocks++
    applyLock(win, doc)
  }

  function unlock() {
    if (!hasEnv) return
    if (instanceLocks <= 0) return
    instanceLocks--
    applyUnlock(win, doc)
  }

  function releaseAll() {
    while (instanceLocks > 0) unlock()
  }

  return { lock, unlock, releaseAll }
}

// Test-only exports, read/reset module-level state. Not part
// of the public API, production code shouldn't import these.
export function __getLockCount() { return lockCount }
export function __reset() {
  lockCount = 0
  savedScrollY = 0
  savedBodyStyles = null
}
