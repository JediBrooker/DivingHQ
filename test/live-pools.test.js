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

// A referee Failed or Cap after the panel scored used to leave the
// operator looking at the old awards until the next diver, while History
// and Standings already had the new ones.
test('applyRefereeCall holds the live tiles to the call, for that dive only', async () => {
  const { applyRefereeCall } = await import('../src/composables/useLivePools.js')
  const pool = makePoolState()
  pool.currentActive = { event_id: 'A', competitor_id: 'd', round_number: 2 }
  pool.judgeTiles = initJudgeTiles(4)
  const marks = [6, 1.5, 8.5]
  marks.forEach((score, i) => {
    applyScore(pool, { event_id: 'A', competitor_id: 'd', round_number: 2, judge_id: `j${i + 1}`, judge_number: i + 1, score }, 4)
  })

  // another dive: untouched
  assert.equal(applyRefereeCall(pool, { event_id: 'A', competitor_id: 'd', round_number: 1 }, 'failed'), false)
  assert.equal(pool.judgeTiles[0].score, '6.0')

  // cap at 2: a 1.5 stays, the rest come down; the empty seat stays empty
  assert.equal(applyRefereeCall(pool, { event_id: 'A', competitor_id: 'd', round_number: '2', cap_value: 2 }, 'cap'), true)
  assert.deepEqual(pool.judgeTiles.map((t) => t.score), ['2.0', '1.5', '2.0', '—'])
  assert.deepEqual(pool.scoresThisRound, { j1: 2, j2: 1.5, j3: 2 })

  // failed: 0 across the board
  applyRefereeCall(pool, { event_id: 'A', competitor_id: 'd', round_number: 2 }, 'failed')
  assert.deepEqual(pool.judgeTiles.map((t) => t.score), ['0.0', '0.0', '0.0', '—'])
  assert.deepEqual(pool.scoresThisRound, { j1: 0, j2: 0, j3: 0 })
  assert.equal(pool.judgeTiles[3].scored, false)
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

// Where a pool picks up when the server has no active diver. Finalising
// drops it, so an undone finalise used to land in the "nobody started this
// yet" path and put round 1 diver 1 back up (rehearsal dry run, 10c).
test('resumeIndex: no dives yet puts the first diver up', async () => {
  const { resumeIndex } = await import('../src/composables/useLivePools.js')
  const roster = [
    { competitor_id: 'a', round_number: 1 }, { competitor_id: 'b', round_number: 1 },
  ]
  assert.deepEqual(resumeIndex(roster, [], 5), { index: 0, announce: true })
  assert.deepEqual(resumeIndex(roster, null, 5), { index: 0, announce: true })
  assert.deepEqual(resumeIndex([], [], 5), { index: -1, announce: false })
  // Withdrawn and reserve rows never go up, first or otherwise.
  const withGaps = [{ competitor_id: 'w', round_number: 1, withdrawn_at: 'x' }, ...roster]
  assert.deepEqual(resumeIndex(withGaps, [], 5), { index: 1, announce: true })
})

test('resumeIndex: every dive in keeps the last one on the board and sends nothing', async () => {
  const { resumeIndex } = await import('../src/composables/useLivePools.js')
  const roster = [
    { competitor_id: 'a', round_number: 1 }, { competitor_id: 'b', round_number: 1 },
    { competitor_id: 'a', round_number: 2 }, { competitor_id: 'b', round_number: 2 },
  ]
  const full = [1, 2, 3]
  const history = roster.map((r) => ({ ...r, judge_scores: full }))
  assert.deepEqual(resumeIndex(roster, history, 3), { index: 3, announce: false })
})

test('resumeIndex: part way through, the dive after the furthest one judged goes up', async () => {
  const { resumeIndex } = await import('../src/composables/useLivePools.js')
  const roster = [
    { competitor_id: 'a', round_number: 1 }, { competitor_id: 'b', round_number: 1 },
    { competitor_id: 'a', round_number: 2 }, { competitor_id: 'b', round_number: 2 },
  ]
  const history = [
    { competitor_id: 'a', round_number: 1, judge_scores: [7, 7, 7] },
    // a short panel the operator moved past on purpose: not revisited
    { competitor_id: 'b', round_number: 1, judge_scores: [6, 6] },
    { competitor_id: 'a', round_number: 2, judge_scores: [8, 8, 8] },
  ]
  assert.deepEqual(resumeIndex(roster, history, 3), { index: 3, announce: true })
})

test('resumeIndex: the furthest dive only part judged was still going, so it goes back up', async () => {
  const { resumeIndex } = await import('../src/composables/useLivePools.js')
  const roster = [
    { competitor_id: 'a', round_number: 1 }, { competitor_id: 'b', round_number: 1 },
  ]
  const history = [
    { competitor_id: 'a', round_number: 1, judge_scores: [7, 7, 7] },
    { competitor_id: 'b', round_number: 1, judge_scores: [6] },
  ]
  assert.deepEqual(resumeIndex(roster, history, 3), { index: 1, announce: true })
})

// The Control Room forgot the live dive's scores whenever it stood a pool
// up again: a reload, a second laptop, a socket that dropped while judges
// scored, an undone finalise. selectDiver clears the tiles and only a live
// score_received could fill them, so with every score stored Next (or
// Finalise) never armed and Skip was the only way on. restoreLiveScores
// puts back what the server has for the dive on the stage.
function stored(competitorId, round, marks, extra = {}) {
  return {
    event_id: 'A',
    competitor_id: competitorId,
    round_number: round,
    referee_call: null,
    referee_cap: null,
    scores: marks.map((score, i) => ({ judge_id: `j${i + 1}`, judge_number: i + 1, score })),
    ...extra,
  }
}

function livePool(n, active = { event_id: 'A', competitor_id: 'd', round_number: 2 }) {
  const pool = makePoolState()
  pool.currentActive = active
  pool.judgeTiles = initJudgeTiles(n)
  return pool
}

test('restoreLiveScores: a full panel on the server arms the pool, quietly', async () => {
  const { restoreLiveScores } = await import('../src/composables/useLivePools.js')
  const pool = livePool(5)
  const res = restoreLiveScores(pool, stored('d', 2, [7, 7.5, 8, 8.5, 9]), 5)
  assert.deepEqual(res, { matched: true, allScoresIn: true })
  assert.deepEqual(pool.judgeTiles.map((t) => t.score), ['7.0', '7.5', '8.0', '8.5', '9.0'])
  assert.ok(pool.judgeTiles.every((t) => t.scored))
  assert.deepEqual(pool.scoresThisRound, { j1: 7, j2: 7.5, j3: 8, j4: 8.5, j5: 9 })
  assert.equal(pool.advanceArmed, true)
  // Armed by a restore, not by a dive finishing in front of the operator,
  // so the card doesn't start its auto-next countdown off a reload.
  assert.equal(pool.armedByRestore, true)
})

test('restoreLiveScores: part of the panel back, the rest live, and nobody counted twice', async () => {
  const { restoreLiveScores } = await import('../src/composables/useLivePools.js')
  const pool = livePool(5)
  const res = restoreLiveScores(pool, stored('d', 2, [9, 7]), 5)
  assert.deepEqual(res, { matched: true, allScoresIn: false })
  assert.equal(pool.advanceArmed, false)
  assert.deepEqual(pool.judgeTiles.map((t) => t.score), ['9.0', '7.0', '—', '—', '—'])

  // J1's outbox sends the same score again after the reload: still two in.
  applyScore(pool, { event_id: 'A', competitor_id: 'd', round_number: 2, judge_id: 'j1', judge_number: 1, score: 9 }, 5)
  assert.equal(Object.keys(pool.scoresThisRound).length, 2)
  for (let j = 3; j <= 5; j++) {
    applyScore(pool, { event_id: 'A', competitor_id: 'd', round_number: 2, judge_id: `j${j}`, judge_number: j, score: 7 + j / 2 }, 5)
  }
  assert.equal(pool.advanceArmed, true)
  // That one finished live, so the countdown may run as usual.
  assert.equal(pool.armedByRestore, false)
})

test('restoreLiveScores: scores that arrived live during the fetch stay put', async () => {
  const { restoreLiveScores } = await import('../src/composables/useLivePools.js')
  const pool = livePool(3)
  applyScore(pool, { event_id: 'A', competitor_id: 'd', round_number: 2, judge_id: 'j3', judge_number: 3, score: 6 }, 3)
  // The answer was put together before J3's score landed.
  const res = restoreLiveScores(pool, stored('d', 2, [7, 7.5]), 3)
  assert.deepEqual(res, { matched: true, allScoresIn: true })
  assert.deepEqual(pool.judgeTiles.map((t) => t.score), ['7.0', '7.5', '6.0'])
})

test('restoreLiveScores: another dive\'s scores never land on the stage', async () => {
  const { restoreLiveScores } = await import('../src/composables/useLivePools.js')
  const pool = livePool(3)
  assert.equal(restoreLiveScores(pool, stored('d', 1, [7, 7, 7]), 3).matched, false)
  assert.equal(restoreLiveScores(pool, stored('x', 2, [7, 7, 7]), 3).matched, false)
  assert.equal(restoreLiveScores(pool, { ...stored('d', 2, [7, 7, 7]), event_id: 'B' }, 3).matched, false)
  assert.equal(restoreLiveScores(pool, null, 3).matched, false)
  assert.equal(restoreLiveScores(makePoolState(), stored('d', 2, [7]), 3).matched, false)
  assert.ok(pool.judgeTiles.every((t) => !t.scored))
  assert.equal(pool.advanceArmed, false)
  // Ids and rounds off the wire may be strings.
  assert.equal(restoreLiveScores(pool, { ...stored('d', '2', [7, 7, 7]) }, 3).matched, true)
})

test('restoreLiveScores: a referee call already made on the dive holds what comes back', async () => {
  const { restoreLiveScores, applyRefereeCall } = await import('../src/composables/useLivePools.js')
  const failed = livePool(3)
  restoreLiveScores(failed, stored('d', 2, [7, 8, 9], { referee_call: 'failed' }), 3)
  assert.deepEqual(failed.judgeTiles.map((t) => t.score), ['0.0', '0.0', '0.0'])
  assert.deepEqual(failed.scoresThisRound, { j1: 0, j2: 0, j3: 0 })

  const capped = livePool(3)
  restoreLiveScores(capped, stored('d', 2, [1.5, 8, 9], { referee_call: 'cap', referee_cap: '2.0' }), 3)
  assert.deepEqual(capped.judgeTiles.map((t) => t.score), ['1.5', '2.0', '2.0'])

  // The call came over the socket while the fetch was out, so the answer
  // still has the awards from before it.
  const raced = livePool(3)
  applyRefereeCall(raced, { event_id: 'A', competitor_id: 'd', round_number: 2 }, 'failed')
  restoreLiveScores(raced, stored('d', 2, [7, 8, 9]), 3)
  assert.deepEqual(raced.judgeTiles.map((t) => t.score), ['0.0', '0.0', '0.0'])

  // A new diver forgets the call.
  raced.roster = [{ event_id: 'A', competitor_id: 'e', round_number: 2 }]
  selectDiver(raced, 0, 3)
  assert.equal(raced.refereeCall, null)
  restoreLiveScores(raced, stored('e', 2, [7, 8, 9]), 3)
  assert.deepEqual(raced.judgeTiles.map((t) => t.score), ['7.0', '8.0', '9.0'])
})

test('restoreLiveScores: synchro seats keep their own tiles, whatever order they come in', async () => {
  const { restoreLiveScores } = await import('../src/composables/useLivePools.js')
  const pool = livePool(9)
  // Exec A 1-2, Exec B 3-4, Sync 5-9 (synchroJudgeGroups for 9). Sent
  // out of order, two seats still to score.
  const scores = [9, 3, 6, 1, 7].map((jn) => ({ judge_id: `j${jn}`, judge_number: jn, score: jn }))
  const res = restoreLiveScores(pool, { ...stored('d', 2, []), scores }, 9)
  assert.deepEqual(res, { matched: true, allScoresIn: false })
  assert.deepEqual(
    pool.judgeTiles.map((t) => (t.scored ? t.score : '—')),
    ['1.0', '—', '3.0', '—', '—', '6.0', '7.0', '—', '9.0'],
  )
  assert.equal(pool.judgeTiles[8].judgeId, 'j9')
})

test('a re-dive drops a restore-armed state and the call with it', async () => {
  const { restoreLiveScores, applyRedive } = await import('../src/composables/useLivePools.js')
  const pool = livePool(3)
  restoreLiveScores(pool, stored('d', 2, [7, 8, 9], { referee_call: 'cap', referee_cap: 2 }), 3)
  assert.equal(pool.advanceArmed, true)
  applyRedive(pool, { event_id: 'A', competitor_id: 'd', round_number: 2 }, 3)
  assert.equal(pool.advanceArmed, false)
  assert.equal(pool.armedByRestore, false)
  assert.equal(pool.refereeCall, null)
})

// A reconnect has to take the server's word for the dive, not just add to
// what the pool already had. A re-dive or a Failed / Cap called from
// another device while this one's socket was down never reached the pool,
// and putting back only the scores it was missing left the old panel's
// tiles up with Next armed: pressing it closed the re-dive on two of five
// scores. The read rebuilds the dive now, keeping only what came in live
// after it went out (liveMark).
const live = (judge, score, extra = {}) => ({
  event_id: 'A', competitor_id: 'd', round_number: 2, judge_id: `j${judge}`, judge_number: judge, score, ...extra,
})

test('restoreLiveScores: a re-dive this pool missed takes the old panel off and disarms Next', async () => {
  const { restoreLiveScores, liveMark } = await import('../src/composables/useLivePools.js')
  const pool = livePool(5)
  for (let j = 1; j <= 5; j++) applyScore(pool, live(j, 6 + j / 2), 5)
  assert.equal(pool.advanceArmed, true)
  const before = pool.rediveSeq
  // Offline: the referee calls a re-dive elsewhere, J1 and J2 score again.
  const since = liveMark(pool)
  const res = restoreLiveScores(pool, stored('d', 2, [5, 5.5]), 5, { since })
  assert.deepEqual(res, { matched: true, allScoresIn: false })
  assert.deepEqual(pool.judgeTiles.map((t) => t.score), ['5.0', '5.5', '—', '—', '—'])
  assert.deepEqual(pool.scoresThisRound, { j1: 5, j2: 5.5 })
  assert.equal(pool.advanceArmed, false)
  assert.equal(pool.armedByRestore, false)
  // The card restarts the diver's clock and drops any countdown off it.
  assert.equal(pool.rediveSeq, before + 1)
})

test('restoreLiveScores: a Failed call this pool missed brings every tile to 0, still armed', async () => {
  const { restoreLiveScores, liveMark } = await import('../src/composables/useLivePools.js')
  const pool = livePool(3)
  for (let j = 1; j <= 3; j++) applyScore(pool, live(j, 7 + j), 3)
  const seq = pool.rediveSeq
  const res = restoreLiveScores(pool, stored('d', 2, [0, 0, 0], { referee_call: 'failed' }), 3, { since: liveMark(pool) })
  assert.deepEqual(res, { matched: true, allScoresIn: true })
  assert.deepEqual(pool.judgeTiles.map((t) => t.score), ['0.0', '0.0', '0.0'])
  assert.equal(pool.advanceArmed, true)
  // It finished live in front of the operator, that hasn't changed.
  assert.equal(pool.armedByRestore, false)
  assert.equal(pool.rediveSeq, seq, 'nothing was set aside')
  assert.deepEqual(pool.refereeCall?.call, 'failed')
})

test('restoreLiveScores: what came in live after the read went out wins, what came before it doesn\'t', async () => {
  const { restoreLiveScores, liveMark } = await import('../src/composables/useLivePools.js')
  const pool = livePool(3)
  applyScore(pool, live(1, 8), 3)
  const since = liveMark(pool)
  // J3 lands while the read is out; the answer was put together before it.
  applyScore(pool, live(3, 6.5), 3)
  // J1's 8 was corrected to 7.5 before the read: the server's value stands.
  const res = restoreLiveScores(pool, stored('d', 2, [7.5, 7]), 3, { since })
  assert.deepEqual(res, { matched: true, allScoresIn: true })
  assert.deepEqual(pool.judgeTiles.map((t) => t.score), ['7.5', '7.0', '6.5'])
  assert.deepEqual(pool.scoresThisRound, { j1: 7.5, j2: 7, j3: 6.5 })
})

test('restoreLiveScores: a call heard live during the read holds it, an older one gives way to the server', async () => {
  const { restoreLiveScores, liveMark, applyRefereeCall } = await import('../src/composables/useLivePools.js')
  const dive = { event_id: 'A', competitor_id: 'd', round_number: 2 }

  const during = livePool(3)
  const since = liveMark(during)
  applyRefereeCall(during, { ...dive, cap_value: 2 }, 'cap')
  restoreLiveScores(during, stored('d', 2, [1.5, 8, 9]), 3, { since })
  assert.deepEqual(during.judgeTiles.map((t) => t.score), ['1.5', '2.0', '2.0'])

  // A Failed this pool heard, then a re-dive it didn't: the server has
  // cleared the call, so the fresh scores aren't zeroed.
  const before = livePool(3)
  applyRefereeCall(before, dive, 'failed')
  restoreLiveScores(before, stored('d', 2, [6, 6.5]), 3, { since: liveMark(before) })
  assert.equal(before.refereeCall, null)
  assert.deepEqual(before.judgeTiles.map((t) => t.score), ['6.0', '6.5', '—'])
})

test('restoreLiveScores: a judge signalling the referee keeps the flag through a rebuild', async () => {
  const { restoreLiveScores, liveMark, applyJudgeSignal } = await import('../src/composables/useLivePools.js')
  const pool = livePool(3)
  applyJudgeSignal(pool, { event_id: 'A', competitor_id: 'd', round_number: 2, judge_number: 2, signaled: true })
  restoreLiveScores(pool, stored('d', 2, [7]), 3, { since: liveMark(pool) })
  assert.deepEqual(pool.judgeTiles.map((t) => t.signaled), [false, true, false])
})
