// Client-side token-bucket rate limiter. The server caps set_active_diver
// at 60/min/user and SILENTLY drops anything over (no ack) -- which, with
// one operator driving N pools, can mean a diver change never reaches the
// judges. This bucket staggers bursts of emits under the server budget so
// they queue-and-drain instead of getting dropped.
//
// When tokens are available the callback runs SYNCHRONOUSLY (no delay in
// the common case). Over budget, callbacks queue and drain as the bucket
// refills. now()/schedule() are injectable for unit tests.
export function makeTokenBucket({
  capacity = 50,
  refillPerMin = 50,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  let tokens = capacity
  let last = now()
  const queue = []
  let pending = false

  function refill() {
    const t = now()
    if (t > last) {
      tokens = Math.min(capacity, tokens + ((t - last) / 60000) * refillPerMin)
      last = t
    }
  }

  function pump() {
    pending = false
    refill()
    while (queue.length && tokens >= 1) {
      tokens -= 1
      const fn = queue.shift()
      try { fn() } catch { /* a failed emit must not stall the queue */ }
    }
    if (queue.length && !pending) {
      pending = true
      // Time until the next whole token is available.
      const waitMs = Math.max(50, ((1 - tokens) / refillPerMin) * 60000)
      schedule(pump, waitMs)
    }
  }

  // Enqueue a function to run within budget. Returns nothing; the fn runs
  // now if a token is free, else when one refills.
  return function run(fn) {
    queue.push(fn)
    pump()
  }
}
