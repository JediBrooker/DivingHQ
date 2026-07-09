// Pins the P6.4 auto-advance countdown to ControlView.vue's frozen
// contract: Manual never arms, a referee signal blocks the timer, and the
// countdown decrements once per tick and fires exactly once at zero.
// DB-less, drives a fake interval scheduler so there's no real wall-clock.
const { test, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

let useAutoAdvance, readAutoAdvanceSeconds, AUTO_ADVANCE_KEY

// Minimal localStorage stub, just enough for the composable's persistence path to run.
const mem = {}
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v) },
  removeItem: (k) => { delete mem[k] },
}

// Fake scheduler: grabs the tick callback so the test can drive time itself.
function makeScheduler() {
  let cb = null
  return {
    fireOnce() { if (cb) cb() },
    scheduler: {
      setInterval: (fn) => { cb = fn; return 1 },
      clearInterval: () => { cb = null },
    },
  }
}

before(async () => {
  ;({ useAutoAdvance, readAutoAdvanceSeconds, AUTO_ADVANCE_KEY } = await import(
    '../src/composables/useAutoAdvance.js'
  ))
})

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k] })

test('readAutoAdvanceSeconds: empty/bad -> 0 (Manual), valid -> number', () => {
  assert.equal(readAutoAdvanceSeconds({ getItem: () => null }), 0)
  assert.equal(readAutoAdvanceSeconds({ getItem: () => 'oops' }), 0)
  assert.equal(readAutoAdvanceSeconds({ getItem: () => '10' }), 10)
})

test('Manual (0s) never arms the timer', () => {
  const { autoAdvanceSeconds, autoAdvanceCountdown, startAutoAdvance } = useAutoAdvance()
  autoAdvanceSeconds.value = 0
  let fired = 0
  startAutoAdvance(() => { fired++ })
  assert.equal(autoAdvanceCountdown.value, 0)
  assert.equal(fired, 0)
})

test('a referee signal blocks the countdown from starting', () => {
  let signaling = true
  const { autoAdvanceSeconds, autoAdvanceCountdown, startAutoAdvance } = useAutoAdvance({
    isSignaling: () => signaling,
  })
  autoAdvanceSeconds.value = 5
  startAutoAdvance(() => {})
  assert.equal(autoAdvanceCountdown.value, 0, 'no countdown while a judge is flagging')
  signaling = false
  startAutoAdvance(() => {})
  assert.equal(autoAdvanceCountdown.value, 5, 're-arms once the signal clears')
})

test('countdown decrements per tick and fires exactly once at zero', () => {
  const { fireOnce, scheduler } = makeScheduler()
  const { autoAdvanceSeconds, autoAdvanceCountdown, startAutoAdvance } = useAutoAdvance({ scheduler })
  autoAdvanceSeconds.value = 3
  let fired = 0
  startAutoAdvance(() => { fired++ })
  assert.equal(autoAdvanceCountdown.value, 3)
  fireOnce(); assert.equal(autoAdvanceCountdown.value, 2)
  fireOnce(); assert.equal(autoAdvanceCountdown.value, 1)
  fireOnce()
  assert.equal(autoAdvanceCountdown.value, 0, 'reset to idle after firing')
  assert.equal(fired, 1, 'callback ran once')
  fireOnce() // sanity check: extra ticks after disarm shouldn't re-fire
  assert.equal(fired, 1)
})

test('cancelAutoAdvance stops an in-flight countdown without firing', () => {
  const { fireOnce, scheduler } = makeScheduler()
  const { autoAdvanceSeconds, autoAdvanceCountdown, startAutoAdvance, cancelAutoAdvance } =
    useAutoAdvance({ scheduler })
  autoAdvanceSeconds.value = 10
  let fired = 0
  startAutoAdvance(() => { fired++ })
  fireOnce(); assert.equal(autoAdvanceCountdown.value, 9)
  cancelAutoAdvance()
  assert.equal(autoAdvanceCountdown.value, 0)
  fireOnce()
  assert.equal(fired, 0, 'a cancelled timer never fires')
})

test('AUTO_ADVANCE_KEY matches the V1 localStorage key (preference carries across the flag)', () => {
  assert.equal(AUTO_ADVANCE_KEY, 'dr_control_auto_advance_seconds')
})
