// Contract for the confirm QUEUE. DB-less; runs in test:safe. Proves the
// property the old single-slot version lacked: a second confirm raised
// while the first is open queues behind it instead of resolving the first
// to false (the cross-pool finalise-vs-finalise hazard).
const { test, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

let confirmAction, useConfirmState, resolveConfirm

before(async () => {
  ;({ confirmAction, useConfirmState, resolveConfirm } = await import('../src/composables/useConfirm.js'))
})

beforeEach(() => {
  // Drain any leftover dialogs between tests.
  const state = useConfirmState()
  let guard = 0
  while (state.value && guard++ < 10) resolveConfirm(false)
})

test('a second confirm queues behind the first instead of preempting it', async () => {
  const state = useConfirmState()
  const a = confirmAction({ title: 'A', confirmLabel: 'A' })
  const b = confirmAction({ title: 'B', confirmLabel: 'B' })

  // Only A is showing; B waits.
  assert.equal(state.value.title, 'A')

  // Resolve A true -> it resolves true (NOT false), then B surfaces.
  resolveConfirm(true)
  assert.equal(await a, true)
  assert.equal(state.value.title, 'B')

  resolveConfirm(false)
  assert.equal(await b, false)
  assert.equal(state.value, null)
})

test('resolving with no queue is a no-op (no throw)', () => {
  const state = useConfirmState()
  assert.equal(state.value, null)
  resolveConfirm(true) // must not throw
  assert.equal(state.value, null)
})

test('each dialog gets a distinct id even when opened in the same tick', () => {
  const state = useConfirmState()
  confirmAction({ title: 'one' })
  const firstId = state.value.id
  confirmAction({ title: 'two' })
  resolveConfirm(true) // pop "one" -> "two" shows
  assert.notEqual(state.value.id, firstId)
  resolveConfirm(true)
})
