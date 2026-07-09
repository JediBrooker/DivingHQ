// Pins down the P4 ranked-lane ordering: the Dashboard needs-attention lane
// floats the most urgent category to the top (live > urgent > overdue >
// everything else), keeps the chip count intact, and stays stable for ties. DB-less.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let rankAttentionChips, chipUrgencyRank, ATTENTION_RANK

before(async () => {
  ;({ rankAttentionChips, chipUrgencyRank, ATTENTION_RANK } = await import(
    '../src/composables/useAttention.js'
  ))
})

const liveChip = { id: 'live', kind: 'live', items: [{ urgency: null }] }
const upcomingUrgent = { id: 'up', kind: 'upcoming', items: [{ urgency: null }, { urgency: 'urgent' }] }
const pendingOverdue = { id: 'pend', kind: 'pending', items: [{ urgency: 'overdue' }] }
const coachCalm = { id: 'coach', kind: 'coach', items: [{ urgency: null }] }

test('chipUrgencyRank: live(0) < urgent(1) < overdue(2) < none(3)', () => {
  assert.equal(chipUrgencyRank(liveChip), ATTENTION_RANK.live)
  assert.equal(chipUrgencyRank(upcomingUrgent), ATTENTION_RANK.urgent)
  assert.equal(chipUrgencyRank(pendingOverdue), ATTENTION_RANK.overdue)
  assert.equal(chipUrgencyRank(coachCalm), ATTENTION_RANK.none)
  assert.equal(chipUrgencyRank(null), ATTENTION_RANK.none)
})

test('rankAttentionChips floats the most urgent category to the top', () => {
  // source order here is deliberately worst-first, on purpose
  const ranked = rankAttentionChips([coachCalm, pendingOverdue, upcomingUrgent, liveChip])
  assert.deepEqual(ranked.map((c) => c.id), ['live', 'up', 'pend', 'coach'])
})

test('the lane preserves the chip count exactly (no drop, no dupe)', () => {
  const input = [coachCalm, pendingOverdue, upcomingUrgent, liveChip]
  assert.equal(rankAttentionChips(input).length, input.length)
})

test('ties keep source order (stable) — two calm chips do not reorder', () => {
  const a = { id: 'a', kind: 'judge', items: [{ urgency: null }] }
  const b = { id: 'b', kind: 'coach', items: [{ urgency: null }] }
  assert.deepEqual(rankAttentionChips([a, b]).map((c) => c.id), ['a', 'b'])
  assert.deepEqual(rankAttentionChips([b, a]).map((c) => c.id), ['b', 'a'])
})

test('a live chip outranks an urgent one even when later in source order', () => {
  assert.deepEqual(rankAttentionChips([upcomingUrgent, liveChip]).map((c) => c.id), ['live', 'up'])
})

test('empty / nullish input yields an empty lane', () => {
  assert.deepEqual(rankAttentionChips([]), [])
  assert.deepEqual(rankAttentionChips(null), [])
})
