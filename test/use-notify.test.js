// Contract for the notify STACK. DB-less; runs in test:safe. Proves a
// second toast no longer drops the first's action handle, the stack caps
// without silently evicting an Undo, and dismiss/fire target by id.
const { test, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

let showNotify, dismissNotify, useNotifyState, fireAction, showSuccess

before(async () => {
  ;({ showNotify, dismissNotify, useNotifyState, fireAction, showSuccess } = await import('../src/composables/useNotify.js'))
})

beforeEach(() => { dismissNotify() }) // clear the whole stack

test('two toasts coexist; the first keeps its action handle', () => {
  const toasts = useNotifyState()
  showNotify({ message: 'finalised A', actionLabel: 'Undo', onAction: () => {}, timeoutMs: 0 })
  showNotify({ message: 'finalised B', timeoutMs: 0 })
  assert.equal(toasts.value.length, 2)
  // The first toast (with the Undo) is still present and actionable.
  const first = toasts.value.find((t) => t.message === 'finalised A')
  assert.ok(first && typeof first.onAction === 'function')
})

test('fireAction(id) runs the right toast and removes it', async () => {
  const toasts = useNotifyState()
  let undone = 0
  const id = showNotify({ message: 'undo me', actionLabel: 'Undo', onAction: () => { undone++ }, timeoutMs: 0 })
  showNotify({ message: 'other', timeoutMs: 0 })
  await fireAction(id)
  assert.equal(undone, 1)
  assert.equal(toasts.value.some((t) => t.id === id), false)
  assert.equal(toasts.value.length, 1) // the other survives
})

test('cap evicts the oldest NO-action toast first, sparing an Undo', () => {
  const toasts = useNotifyState()
  showNotify({ message: 'undoable', actionLabel: 'Undo', onAction: () => {}, timeoutMs: 0 })
  showSuccess('plain 1', { timeoutMs: 0 })
  showSuccess('plain 2', { timeoutMs: 0 })
  showSuccess('plain 3', { timeoutMs: 0 }) // 4th -> over cap of 3
  assert.equal(toasts.value.length, 3)
  // The Undo toast must survive; the oldest plain one was evicted.
  assert.ok(toasts.value.some((t) => t.actionLabel === 'Undo'))
  assert.equal(toasts.value.some((t) => t.message === 'plain 1'), false)
})

test('dismissNotify(id) removes only that toast; dismissNotify() clears all', () => {
  const toasts = useNotifyState()
  const a = showNotify({ message: 'a', timeoutMs: 0 })
  showNotify({ message: 'b', timeoutMs: 0 })
  dismissNotify(a)
  assert.equal(toasts.value.length, 1)
  dismissNotify()
  assert.equal(toasts.value.length, 0)
})
