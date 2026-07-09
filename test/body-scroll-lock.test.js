// Unit tests for body-scroll-lock-core.
//
// We target the pure-JS core (no Vue), passing in fake
// window/document objects so the suite stays hermetic and
// doesn't depend on any real DOM environment. The Vue composable
// useBodyScrollLock just wires the core to onUnmounted +
// watch, and that wiring is tiny enough it doesn't need its own
// unit test (the e2e mobile-safari suite already exercises the
// full path through a real browser).
//
// History: an earlier version of this test loaded the Vue
// composable directly and stubbed Vue via Module._cache.
// That worked on Node 24 locally but broke on older Node
// in CI ("paths[0] argument must be of type string. Received
// undefined") because of fragility in the ESM→CJS interop
// path. Splitting into a pure-JS core + Vue wrapper made
// the test trivial: just require the core directly.

const { test, beforeEach } = require("node:test")
const assert = require("node:assert/strict")

const corePath = require("node:path").join(
  __dirname, "..", "src", "composables", "body-scroll-lock-core.js",
)

// The core is ESM, so wrap it in a cacheable promise. That way
// each test can await loadCore() and get back the same module
// instance, mutable module-level state and all.
let coreModulePromise = null
function loadCore() {
  if (!coreModulePromise) {
    coreModulePromise = import("file://" + corePath)
  }
  return coreModulePromise
}

function makeFakeDom({ scrollY = 0 } = {}) {
  const body = {
    style: {
      position: "", top: "", left: "", right: "", width: "",
    },
  }
  const documentEl = { style: { overflow: "" } }
  const win = {
    scrollY,
    pageYOffset: scrollY,
    scrollTo(x, y) {
      this.scrollY = y
      this.pageYOffset = y
    },
  }
  const doc = { body, documentElement: documentEl }
  return { win, doc }
}

beforeEach(async () => {
  const core = await loadCore()
  core.__reset()
})

test("lock() applies body styles on 0->1 transition", async () => {
  const { createBodyScrollLock, __getLockCount } = await loadCore()
  const { win, doc } = makeFakeDom({ scrollY: 420 })
  const { lock } = createBodyScrollLock(win, doc)

  lock()

  assert.equal(doc.body.style.position, "fixed")
  assert.equal(doc.body.style.top, "-420px")
  assert.equal(doc.body.style.width, "100%")
  assert.equal(doc.documentElement.style.overflow, "hidden")
  assert.equal(__getLockCount(), 1)
})

test("nested lock() / unlock() reference-counts (2 locks, 1 unlock keeps body locked)", async () => {
  const { createBodyScrollLock, __getLockCount } = await loadCore()
  const { win, doc } = makeFakeDom({ scrollY: 100 })
  // Two separate instances sharing the same env, simulating
  // a Confirm dialog opened on top of an open Drawer. Each gets
  // its own instance counter but both feed the module-level
  // lockCount.
  const a = createBodyScrollLock(win, doc)
  const b = createBodyScrollLock(win, doc)

  a.lock()
  b.lock()
  assert.equal(__getLockCount(), 2)

  // First unlock: still locked.
  b.unlock()
  assert.equal(__getLockCount(), 1)
  assert.equal(doc.body.style.position, "fixed",
    "body should still be locked while one consumer holds the lock")

  // Second unlock: now released, body styles restored.
  a.unlock()
  assert.equal(__getLockCount(), 0)
  assert.equal(doc.body.style.position, "",
    "body position should be cleared once the last lock releases")
  assert.equal(win.scrollY, 100,
    "scroll position should be restored after final unlock")
})

test("unlock() without a preceding lock is a no-op (does not underflow)", async () => {
  const { createBodyScrollLock, __getLockCount } = await loadCore()
  const { win, doc } = makeFakeDom()
  const { unlock } = createBodyScrollLock(win, doc)

  assert.doesNotThrow(() => { unlock(); unlock(); unlock() })
  assert.equal(__getLockCount(), 0)
})

test("releaseAll() drains an instance's locks even if caller forgot to unlock", async () => {
  // Simulates Vue's onUnmounted hook firing while a modal still
  // holds the lock. Gotta release it here or the next page ends
  // up permanently frozen.
  const { createBodyScrollLock, __getLockCount } = await loadCore()
  const { win, doc } = makeFakeDom()
  const inst = createBodyScrollLock(win, doc)

  inst.lock()
  inst.lock()
  inst.lock()
  assert.equal(__getLockCount(), 3)

  inst.releaseAll()
  assert.equal(__getLockCount(), 0)
  assert.equal(doc.body.style.position, "",
    "body should be fully unlocked after releaseAll")
})

test("createBodyScrollLock(null, null) is a silent no-op (SSR-safe)", async () => {
  const { createBodyScrollLock, __getLockCount } = await loadCore()
  const inst = createBodyScrollLock(null, null)

  assert.doesNotThrow(() => {
    inst.lock()
    inst.lock()
    inst.unlock()
    inst.releaseAll()
  })
  assert.equal(__getLockCount(), 0,
    "no-op env should never touch the global lock counter")
})
