// Contract for the P5 concurrent-pool live-state map. DB-less; runs in
// test:safe. Proves the property V1 cannot give: a score for a
// NON-focused Live pool updates THAT pool and leaves the focused pool's
// currentActive + tiles untouched (no focus thrash, no dropped scores).
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let useLivePools, makePoolState, initJudgeTiles, applyScore
let selectDiver, buildActiveInfo, deriveStatus

before(async () => {
  const mod = await import('../src/composables/useLivePools.js')
  ;({ useLivePools, makePoolState, initJudgeTiles, applyScore } = mod)
  ;({ selectDiver, buildActiveInfo, deriveStatus } = mod)
})

function activeFor(eventId, n) {
  return {
    event_id: eventId,
    competitor_id: `${eventId}-diver`,
    round_number: 1,
  }
}

function seedPool(pools, poolFor, eventId, n) {
  const pool = poolFor(eventId)
  pool.currentActive = activeFor(eventId, n)
  pool.judgeTiles = initJudgeTiles(n)
  return pool
}

function score(eventId, judgeNumber, value, n) {
  return {
    event_id: eventId,
    competitor_id: `${eventId}-diver`,
    round_number: 1,
    judge_id: `${eventId}-j${judgeNumber}`,
    judge_number: judgeNumber,
    score: value,
  }
}

test('a score for the NON-focused pool updates that pool, not the focused one', () => {
  const { pools, poolFor, routeScore } = useLivePools()
  seedPool(pools, poolFor, 'A', 5) // focused
  seedPool(pools, poolFor, 'B', 5) // non-focused

  const res = routeScore(score('B', 1, 7.5), 5)
  assert.equal(res.matched, true)

  // Pool B got the score + a filled tile.
  assert.equal(pools.B.scoresThisRound['B-j1'], 7.5)
  assert.equal(pools.B.judgeTiles[0].scored, true)
  assert.equal(pools.B.judgeTiles[0].score, '7.5')

  // Pool A is completely untouched.
  assert.deepEqual(pools.A.scoresThisRound, {})
  assert.equal(pools.A.judgeTiles.every((t) => !t.scored), true)
})

test('a full round of scores for a pool arms ITS advance only', () => {
  const { pools, poolFor, routeScore } = useLivePools()
  seedPool(pools, poolFor, 'A', 3)
  seedPool(pools, poolFor, 'B', 3)

  let last
  for (let j = 1; j <= 3; j++) last = routeScore(score('B', j, 6 + j), 3)
  assert.equal(last.allScoresIn, true)
  assert.equal(pools.B.advanceArmed, true)
  // Focused pool A never armed.
  assert.equal(pools.A.advanceArmed, false)
  assert.equal(Object.keys(pools.A.scoresThisRound).length, 0)
})

test('a score for an unknown event or wrong competitor is a no-op', () => {
  const { pools, poolFor, routeScore } = useLivePools()
  seedPool(pools, poolFor, 'A', 5)
  // No pool for event Z.
  assert.equal(routeScore(score('Z', 1, 8), 5).matched, false)
  // Wrong competitor for A.
  const wrong = score('A', 1, 8)
  wrong.competitor_id = 'someone-else'
  assert.equal(routeScore(wrong, 5).matched, false)
  assert.deepEqual(pools.A.scoresThisRound, {})
})

test('judge_signal flips the right pool\'s tile only', () => {
  const { pools, poolFor, routeSignal } = useLivePools()
  seedPool(pools, poolFor, 'A', 5)
  seedPool(pools, poolFor, 'B', 5)
  const ok = routeSignal({
    event_id: 'B', competitor_id: 'B-diver', round_number: 1, judge_number: 2, signaled: true,
  })
  assert.equal(ok, true)
  assert.equal(pools.B.judgeTiles[1].signaled, true)
  assert.equal(pools.A.judgeTiles.every((t) => !t.signaled), true)
})

test('deriveStatus: JUDGING wins over DIVING wins over READY (verbatim ladder)', () => {
  assert.equal(deriveStatus({ hasActive: false, scoresInCount: 0, clockExpired: true }), 'ready')
  assert.equal(deriveStatus({ hasActive: true, scoresInCount: 0, clockExpired: false }), 'ready')
  assert.equal(deriveStatus({ hasActive: true, scoresInCount: 0, clockExpired: true }), 'diving')
  // a single score wins even with the clock expired
  assert.equal(deriveStatus({ hasActive: true, scoresInCount: 1, clockExpired: true }), 'judging')
})

test('buildActiveInfo: flat header object; null row -> null', () => {
  assert.equal(buildActiveInfo(null), null)
  const info = buildActiveInfo(
    { full_name: 'Avery', country_code: 'AUS', dive_code: '101', position: 'B', dd: 2.4, round_number: 1 },
    (row) => `desc-${row.dive_code}`,
  )
  assert.equal(info.name, 'Avery')
  assert.equal(info.code, '101B')
  assert.equal(info.dd, 'DD 2.4')
  assert.equal(info.desc, 'desc-101') // diveDescription (frozen seam) reused
  assert.equal(info.round_number, 1)
})

test('selectDiver: moves the cursor, clears scores, re-inits tiles, builds info', () => {
  const pool = makePoolState()
  pool.roster = [
    { competitor_id: 'd1', round_number: 1, full_name: 'One', dive_code: '101', position: 'B', dd: 2 },
    { competitor_id: 'd2', round_number: 1, full_name: 'Two', dive_code: '201', position: 'B', dd: 2 },
  ]
  pool.scoresThisRound = { x: 5 } // stale
  assert.equal(selectDiver(pool, 1, 5), true)
  assert.equal(pool.currentIndex, 1)
  assert.equal(pool.currentActive.full_name, 'Two')
  assert.deepEqual(pool.scoresThisRound, {})
  assert.equal(pool.judgeTiles.length, 5)
  assert.equal(pool.activeInfo.name, 'Two')
  // out-of-range is a no-op
  assert.equal(selectDiver(pool, 9, 5), false)
  assert.equal(pool.currentIndex, 1)
})

test('applyScore tile-matches by judge_number, then judge_id, then first unscored', () => {
  const pool = makePoolState()
  pool.currentActive = { event_id: 'A', competitor_id: 'd', round_number: 1 }
  pool.judgeTiles = initJudgeTiles(3)
  // No judge_number -> matches by judge_id, none set -> first unscored.
  applyScore(pool, { event_id: 'A', competitor_id: 'd', round_number: 1, judge_id: 'x', score: 5 }, 3)
  assert.equal(pool.judgeTiles[0].scored, true)
  assert.equal(pool.judgeTiles[0].judgeId, 'x')
})
