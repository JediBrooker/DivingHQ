// Hold state in the Control Room is per event. The focused banner and the
// 'h' hotkey used to share one isHeld ref that never followed a change of
// focus, so holding pool A and then focusing pool B showed B as held, and
// 'h' on B sent meet_resume for B. DB-less, fake socket.
const { test } = require('node:test')
const assert = require('node:assert/strict')

function fakeSocket() {
  const handlers = new Map()
  return {
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn) },
    off(ev, fn) { handlers.get(ev)?.delete(fn) },
    fire(ev, data) { for (const fn of handlers.get(ev) || []) fn(data) },
  }
}

async function load() {
  const vue = await import('vue')
  const mod = await import('../src/composables/useMeetHold.js')
  return { ...mod, reactive: vue.reactive, ref: vue.ref, effectScope: vue.effectScope }
}

test('the focused hold follows the focused event', async () => {
  const { useMeetHold, reactive, ref, effectScope } = await load()
  const socket = fakeSocket()
  const sent = []
  const store = reactive({})
  const focused = ref({ id: 'A' })
  const scope = effectScope()
  const hold = scope.run(() => useMeetHold({
    socket, store, event: () => focused.value,
    queueSocketAction: (name, payload) => sent.push([name, payload]),
  }))

  hold.confirmHold()
  assert.equal(hold.isHeld.value, true)
  assert.deepEqual(sent.at(-1), ['meet_hold', { event_id: 'A', reason: null }])

  focused.value = { id: 'B' }
  assert.equal(hold.isHeld.value, false, 'B was never held')
  // and holding B holds B, it doesn't resume it
  hold.confirmHold()
  assert.deepEqual(sent.at(-1), ['meet_hold', { event_id: 'B', reason: null }])

  focused.value = { id: 'A' }
  assert.equal(hold.isHeld.value, true, 'A is still held')
  scope.stop()
})

test('a pool card and the focused banner share the same hold', async () => {
  const { useMeetHold, reactive, effectScope } = await load()
  const socket = fakeSocket()
  const store = reactive({})
  const scope = effectScope()
  const [card, banner] = scope.run(() => [
    useMeetHold({ socket, store, event: () => ({ id: 'A' }), queueSocketAction: () => {} }),
    useMeetHold({ socket, store, event: () => ({ id: 'A' }), queueSocketAction: () => {} }),
  ])
  card.confirmHold()
  assert.equal(banner.isHeld.value, true)
  banner.resumeMeet()
  assert.equal(card.isHeld.value, false)
  scope.stop()
})

test('server broadcasts land on the right event, whoever is focused', async () => {
  const { useMeetHold, reactive, ref, effectScope } = await load()
  const socket = fakeSocket()
  const store = reactive({})
  const focused = ref({ id: 'B' })
  const scope = effectScope()
  const hold = scope.run(() => useMeetHold({ socket, store, event: () => focused.value, queueSocketAction: () => {} }))
  socket.fire('meet_held', { event_id: 'A', reason: 'lightning' })
  assert.equal(hold.isHeld.value, false)
  focused.value = { id: 'A' }
  assert.equal(hold.isHeld.value, true)
  assert.equal(hold.holdReason.value, 'lightning')
  socket.fire('meet_resumed', { event_id: 'A' })
  assert.equal(hold.isHeld.value, false)
  scope.stop()
})

test('without a shared store each instance keeps its own', async () => {
  const { useMeetHold, effectScope } = await load()
  const socket = fakeSocket()
  const scope = effectScope()
  const [a, b] = scope.run(() => [
    useMeetHold({ socket, event: () => ({ id: 'A' }), queueSocketAction: () => {} }),
    useMeetHold({ socket, event: () => ({ id: 'B' }), queueSocketAction: () => {} }),
  ])
  a.confirmHold()
  assert.equal(a.isHeld.value, true)
  assert.equal(b.isHeld.value, false)
  scope.stop()
})
