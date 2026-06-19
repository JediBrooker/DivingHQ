// Contract for the client token bucket used to stagger set_active_diver
// emits under the server's 60/min budget. DB-less; runs in test:safe.
const { test } = require('node:test')
const assert = require('node:assert/strict')

let makeTokenBucket
test.before?.(() => {})

async function load() {
  if (!makeTokenBucket) ({ makeTokenBucket } = await import('../src/lib/token-bucket.js'))
}

// A controllable clock + scheduler so the test is deterministic.
function harness() {
  let t = 0
  const timers = []
  return {
    now: () => t,
    schedule: (fn, ms) => { timers.push({ at: t + ms, fn }) },
    advance(ms) {
      t += ms
      const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)
      for (const x of due) { timers.splice(timers.indexOf(x), 1); x.fn() }
    },
  }
}

test('runs immediately while tokens are available', async () => {
  await load()
  const h = harness()
  const run = makeTokenBucket({ capacity: 3, refillPerMin: 60, now: h.now, schedule: h.schedule })
  const fired = []
  run(() => fired.push(1))
  run(() => fired.push(2))
  run(() => fired.push(3))
  assert.deepEqual(fired, [1, 2, 3]) // all synchronous, under capacity
})

test('staggers emits over budget and drains as it refills', async () => {
  await load()
  const h = harness()
  // capacity 2, refill 60/min = 1 token/sec.
  const run = makeTokenBucket({ capacity: 2, refillPerMin: 60, now: h.now, schedule: h.schedule })
  const fired = []
  for (let i = 1; i <= 5; i++) run(() => fired.push(i))
  // Only the first 2 fire immediately; the rest queue.
  assert.deepEqual(fired, [1, 2])
  h.advance(1000) // +1 token
  assert.deepEqual(fired, [1, 2, 3])
  h.advance(1000)
  assert.deepEqual(fired, [1, 2, 3, 4])
  h.advance(1000)
  assert.deepEqual(fired, [1, 2, 3, 4, 5])
})

test('a throwing callback does not stall the queue', async () => {
  await load()
  const h = harness()
  const run = makeTokenBucket({ capacity: 5, refillPerMin: 60, now: h.now, schedule: h.schedule })
  const fired = []
  run(() => { throw new Error('boom') })
  run(() => fired.push('ok'))
  assert.deepEqual(fired, ['ok'])
})
