// Contract for the P5 concurrent-pool live-state map. DB-less, runs in
// test:safe. Proves the one thing V1 couldnt: a score for a
// NON-focused Live pool updates THAT pool only, leaving the focused
// pool's currentActive + tiles untouched (no focus thrash, no dropped scores).
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let useLivePools, makePoolState, initJudgeTiles, applyScore
let selectDiver, buildActiveInfo, deriveStatus, rosterIndexForActive

before(async () => {
  const mod = await import('../src/composables/useLivePools.js')
  ;({ useLivePools, makePoolState, initJudgeTiles, applyScore } = mod)
  ;({ selectDiver, buildActiveInfo, deriveStatus, rosterIndexForActive } = mod)
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

  // pool B got the score plus a filled tile
  assert.equal(pools.B.scoresThisRound['B-j1'], 7.5)
  assert.equal(pools.B.judgeTiles[0].scored, true)
  assert.equal(pools.B.judgeTiles[0].score, '7.5')

  // and pool A stays completely untouched
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

test('rosterIndexForActive: a mid-meet pool restores to the live diver, NOT roster[0]', () => {
  // A roster spanning rounds (server order: round ASC). Matching keys on
  // competitor AND round, so the same diver in different rounds still counts as distinct.
  const roster = [
    { competitor_id: 'd1', round_number: 1 },
    { competitor_id: 'd2', round_number: 1 },
    { competitor_id: 'd1', round_number: 2 },
    { competitor_id: 'd2', round_number: 2 }, // <- the live diver
    { competitor_id: 'd1', round_number: 3 },
    { competitor_id: 'd2', round_number: 3 },
  ]
  // The server's authoritative active diver (set_active_diver payload shape).
  const serverActive = { event_id: 'E', competitor_id: 'd2', round_number: 2, status: 'judging' }
  // Must resolve to index 3, the SAME diver/round the server has live,
  // so reopening the Control Room never reseeds the judges to roster[0].
  assert.equal(rosterIndexForActive(roster, serverActive), 3)
  // The same competitor in a different round is NOT a match.
  assert.equal(rosterIndexForActive(roster, { competitor_id: 'd2', round_number: 3 }), 5)
})

test('rosterIndexForActive: no payload / unmappable payload / empty roster -> -1', () => {
  const roster = [{ competitor_id: 'd1', round_number: 1 }]
  assert.equal(rosterIndexForActive(roster, null), -1) // fresh event: no server diver
  assert.equal(rosterIndexForActive(roster, {}), -1) // payload missing competitor_id
  assert.equal(rosterIndexForActive(roster, { competitor_id: 'ghost', round_number: 1 }), -1) // drift
  assert.equal(rosterIndexForActive([], { competitor_id: 'd1', round_number: 1 }), -1)
  assert.equal(rosterIndexForActive(null, { competitor_id: 'd1', round_number: 1 }), -1)
})

test('rosterIndexForActive: id type coercion (string vs number competitor ids)', () => {
  const roster = [{ competitor_id: 101, round_number: '2' }]
  assert.equal(rosterIndexForActive(roster, { competitor_id: '101', round_number: 2 }), 0)
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

// The live queue only walks divers who compete. Withdrawn and reserve rows
// come back from /roster with a null round_order and used to be announced.
test('competingQueue drops withdrawn and reserve rows, keeps queue order', async () => {
  const { competingQueue } = await import('../src/composables/useLivePools.js')
  const roster = [
    { competitor_id: 'w', round_number: 1, round_order: null, withdrawn_at: '2026-01-01T00:00:00Z' },
    { competitor_id: 'a', round_number: 1, round_order: 1 },
    { competitor_id: 'b', round_number: 1, round_order: 2 },
    { competitor_id: 'r', round_number: 1, round_order: null, is_reserve: true },
    { competitor_id: 'a', round_number: 2, round_order: 1 },
    // an older server with no is_reserve column still nulls round_order
    { competitor_id: 'r2', round_number: 2, round_order: null },
  ]
  assert.deepEqual(competingQueue(roster).map((r) => `${r.competitor_id}${r.round_number}`), ['a1', 'b1', 'a2'])
  assert.deepEqual(competingQueue(null), [])
})

test('rebaseQueue follows the live diver through a roster refresh', async () => {
  const { rebaseQueue } = await import('../src/composables/useLivePools.js')
  const row = (id, round, order) => ({ competitor_id: id, round_number: round, round_order: order })
  const pool = makePoolState()
  pool.roster = [row('a', 1, 1), row('b', 1, 2), row('c', 1, 3)]
  pool.currentIndex = 1
  pool.currentActive = pool.roster[1]
  // a late entry lands in front of the live diver
  rebaseQueue(pool, [row('z', 1, 1), row('a', 1, 2), row('b', 1, 3), row('c', 1, 4)])
  assert.equal(pool.currentIndex, 2)
  assert.equal(pool.roster[pool.currentIndex].competitor_id, 'b')
  assert.equal(pool.currentActive.competitor_id, 'b')
})

test('rebaseQueue: the live diver withdrawn mid-dive leaves Next pointing at whoever was after them', async () => {
  const { rebaseQueue } = await import('../src/composables/useLivePools.js')
  const row = (id, round, order, extra = {}) => ({ competitor_id: id, round_number: round, round_order: order, ...extra })
  const pool = makePoolState()
  pool.roster = [row('a', 1, 1), row('b', 1, 2), row('c', 1, 3)]
  pool.currentIndex = 1
  pool.currentActive = pool.roster[1]
  rebaseQueue(pool, [row('a', 1, 1), row('b', 1, null, { withdrawn_at: 'now' }), row('c', 1, 2)])
  assert.equal(pool.roster.length, 2)
  // currentIndex + 1 is what advancing selects, and that should be c
  assert.equal(pool.roster[pool.currentIndex + 1].competitor_id, 'c')
  // the dive on the blocks isn't yanked away
  assert.equal(pool.currentActive.competitor_id, 'b')
})

test('rebaseQueue: nobody live yet just swaps the queue', async () => {
  const { rebaseQueue } = await import('../src/composables/useLivePools.js')
  const pool = makePoolState()
  rebaseQueue(pool, [{ competitor_id: 'a', round_number: 1, round_order: 1 }])
  assert.equal(pool.roster.length, 1)
  assert.equal(pool.currentIndex, -1)
})

// A re-dive puts the dive back to square one: the server marks its score
// rows 'redive' until each judge scores again, so the pool's tiles, its
// armed Next and its count all have to reset too.
test('applyRedive resets the live dive it names, and only that one', async () => {
  const { applyRedive } = await import('../src/composables/useLivePools.js')
  const pool = makePoolState()
  pool.currentActive = { event_id: 'A', competitor_id: 'd', round_number: 2 }
  pool.judgeTiles = initJudgeTiles(3)
  for (let j = 1; j <= 3; j++) {
    applyScore(pool, { event_id: 'A', competitor_id: 'd', round_number: 2, judge_id: `j${j}`, judge_number: j, score: 7 }, 3)
  }
  assert.equal(pool.advanceArmed, true)
  const before = pool.rediveSeq || 0

  // a different dive: nothing happens
  assert.equal(applyRedive(pool, { event_id: 'A', competitor_id: 'd', round_number: 1 }, 3), false)
  assert.equal(pool.advanceArmed, true)

  assert.equal(applyRedive(pool, { event_id: 'A', competitor_id: 'd', round_number: '2' }, 3), true)
  assert.equal(pool.advanceArmed, false)
  assert.deepEqual(pool.scoresThisRound, {})
  assert.equal(pool.judgeTiles.length, 3)
  assert.ok(pool.judgeTiles.every((t) => !t.scored))
  assert.equal(pool.rediveSeq, before + 1)
})

// /history comes back round ASC, name ASC. Reversing it put the
// reverse-alphabetical diver on top within a round, not the dive that had
// just finished, so "amend the last dive" opened someone else's.
test('historyNewestFirst: latest round first, and within it the queue order backwards', async () => {
  const { historyNewestFirst } = await import('../src/composables/useLivePools.js')
  const queue = [
    { competitor_id: 'z', round_number: 1 }, { competitor_id: 'a', round_number: 1 }, { competitor_id: 'm', round_number: 1 },
    { competitor_id: 'z', round_number: 2 }, { competitor_id: 'a', round_number: 2 },
  ]
  // what the server sends: round, then name
  const history = [
    { competitor_id: 'a', diverName: 'Ann', round_number: 1 },
    { competitor_id: 'm', diverName: 'Max', round_number: 1 },
    { competitor_id: 'z', diverName: 'Zed', round_number: 1 },
    { competitor_id: 'a', diverName: 'Ann', round_number: 2 },
    { competitor_id: 'z', diverName: 'Zed', round_number: 2 },
  ]
  const out = historyNewestFirst(history, queue).map((h) => `${h.competitor_id}${h.round_number}`)
  assert.deepEqual(out, ['a2', 'z2', 'm1', 'a1', 'z1'])
})

test('historyNewestFirst: a dive whose diver left the queue still lands in its round', async () => {
  const { historyNewestFirst } = await import('../src/composables/useLivePools.js')
  const queue = [{ competitor_id: 'a', round_number: 1 }]
  const history = [
    { competitor_id: 'gone', diverName: 'Gone', round_number: 1 },
    { competitor_id: 'a', diverName: 'Ann', round_number: 1 },
    { competitor_id: 'a', diverName: 'Ann', round_number: 2 },
  ]
  const out = historyNewestFirst(history, queue).map((h) => `${h.competitor_id}${h.round_number}`)
  assert.deepEqual(out, ['a2', 'a1', 'gone1'])
  assert.deepEqual(historyNewestFirst(null, queue), [])
})

// A coach can withdraw a diver while their event is Live; the Control Room
// reloads the roster (roster_changed) and must neither lose its place nor
// advance onto the withdrawn diver, or onto a reserve.
test('nextQueueIndex skips withdrawn rows and reserves', async () => {
  const { nextQueueIndex } = await import('../src/composables/useLivePools.js')
  const roster = [
    { competitor_id: 'a', round_number: 1 },
    { competitor_id: 'b', round_number: 1, withdrawn_at: '2026-09-28T10:00:00Z' },
    { competitor_id: 'r', round_number: 1, is_reserve: true },
    { competitor_id: 'c', round_number: 1 },
  ]
  assert.equal(nextQueueIndex(roster, -1), 0)
  assert.equal(nextQueueIndex(roster, 0), 3)
  assert.equal(nextQueueIndex(roster, 3), -1)
  assert.equal(nextQueueIndex(null, 0), -1)
})

test('roster_changed mid-dive: the stage stays on the withdrawn diver, Next goes past them', async () => {
  // What the Control Room does with it: re-read /roster and rebase the
  // pool's queue on it (refreshPoolRoster -> rebaseQueue).
  const { rebaseQueue, nextQueueIndex } = await import('../src/composables/useLivePools.js')
  const pool = makePoolState()
  pool.roster = [
    { competitor_id: 'a', round_number: 2, round_order: 1 },
    { competitor_id: 'b', round_number: 2, round_order: 2 },
    { competitor_id: 'c', round_number: 2, round_order: 3 },
  ]
  selectDiver(pool, 1, 5)
  rebaseQueue(pool, [
    { competitor_id: 'a', round_number: 2, round_order: 1 },
    { competitor_id: 'b', round_number: 2, round_order: null, withdrawn_at: 'now' },
    { competitor_id: 'c', round_number: 2, round_order: 2 },
  ])
  assert.equal(pool.currentActive.competitor_id, 'b', 'the dive in progress stays up')
  const next = nextQueueIndex(pool.roster, pool.currentIndex)
  assert.equal(pool.roster[next].competitor_id, 'c')
  assert.equal(nextQueueIndex(pool.roster, next), -1)

  const idle = makePoolState()
  rebaseQueue(idle, [{ competitor_id: 'a', round_number: 1, round_order: 1 }])
  assert.equal(idle.currentIndex, -1)
  assert.equal(idle.roster.length, 1)
})
