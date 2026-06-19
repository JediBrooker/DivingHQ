// Contract for the synchro Exec/Sync grouping the Control Room History
// uses (synchroJudgeGroups + groupedSynchroScoresForDisplay). DB-less.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let synchroJudgeGroups, groupedSynchroScoresForDisplay
before(async () => {
  ;({ synchroJudgeGroups, groupedSynchroScoresForDisplay } = await import('../src/composables/useScoreCategories.js'))
})

test('synchroJudgeGroups maps panel positions to Exec A / Exec B / Sync', () => {
  assert.deepEqual(synchroJudgeGroups(7), { a: [1, 2], b: [3, 4], sync: [5, 6, 7] })
  assert.deepEqual(synchroJudgeGroups(9), { a: [1, 2], b: [3, 4], sync: [5, 6, 7, 8, 9] })
  assert.deepEqual(synchroJudgeGroups(11), { a: [1, 2, 3], b: [4, 5, 6], sync: [7, 8, 9, 10, 11] })
  assert.equal(synchroJudgeGroups(5), null) // non-synchro panel -> caller falls back to flat
  assert.equal(synchroJudgeGroups(6), null)
})

test('grouped display returns 3 labelled clusters with the right judge counts (7-judge)', () => {
  const groups = groupedSynchroScoresForDisplay('8.0,8.0,7.5,8.0,9.0,9.0,9.0', 7)
  assert.equal(groups.length, 3)
  assert.deepEqual(groups.map((g) => g.label), ['Exec A', 'Exec B', 'Sync'])
  assert.deepEqual(groups.map((g) => g.role), ['a', 'b', 'sync'])
  assert.deepEqual(groups.map((g) => g.scores.length), [2, 2, 3])
  // 7-judge synchro now mirrors the 9-judge execution rule: the single
  // lowest + highest execution marks are cancelled ACROSS both divers'
  // four marks (2 dropped), while all 3 sync marks are kept.
  const byRole = Object.fromEntries(groups.map((g) => [g.role, g]))
  assert.equal(byRole.sync.scores.filter((s) => s.dropped).length, 0, 'all 3 sync kept')
  assert.equal(
    [...byRole.a.scores, ...byRole.b.scores].filter((s) => s.dropped).length,
    2,
    'exec cancels exactly 1 low + 1 high across both divers',
  )
})

test('grouped display is null for a non-synchro panel size', () => {
  assert.equal(groupedSynchroScoresForDisplay('7.0,7.5,8.0,8.5,9.0', 5), null)
})
