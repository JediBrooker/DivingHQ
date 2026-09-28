// useBlockDrag (the scheduler's drag / resize helper). Mostly here for the
// pointermove guard: dragState only gets a new object when the snapped
// preview actually changes, since every block's :style reads it and a fresh
// object per pixel re-rendered the whole timeline. The rest pins what the
// guard must not break: the first move still sets the state, onUp still
// commits the right patch, Escape still cancels.
const { test, before, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

let useBlockDrag


function pointer(type, { x = 0, y = 0, shiftKey = false } = {}) {
  const e = new Event(type)
  Object.assign(e, { clientX: x, clientY: y, shiftKey })
  return e
}
const move = (opts) => document.dispatchEvent(pointer('pointermove', opts))
const up = () => document.dispatchEvent(pointer('pointerup'))
const downEvent = () => ({ button: 0, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} })

// 1.6 px/min, so the default 30 min snap step is 48 px.
const PPM = 1.6
const BLOCK = {
  id: 'b1',
  starts_at: '2026-10-01T09:00:00.000Z',
  ends_at: '2026-10-01T10:00:00.000Z',
  board_ids: ['3m'],
}

let commits
// Every drag a test makes, so a failed assertion can't leave its
// document listeners behind to muddle the next test.
const drags = []
beforeEach(() => { commits = [] })
afterEach(() => { while (drags.length) drags.pop().cancel() })

before(async () => {
  ;({ useBlockDrag } = await import('../src/composables/useBlockDrag.js'))
  // No DOM here. The composable only needs add/removeEventListener on
  // document, and a bare EventTarget covers that (including { once: true }).
  // It has to go in after the import: Vue's runtime-dom pokes at
  // document.createElement at load time if a document exists.
  globalThis.document = new EventTarget()
})

function makeDrag(extra = {}) {
  const d = useBlockDrag({
    pixelsPerMinute: PPM,
    commit: async (c) => { commits.push(c) },
    ...extra,
  })
  drags.push(d)
  return d
}

test('first pointermove sets dragState even with zero movement', () => {
  const d = makeDrag()
  d.startMove(downEvent(), BLOCK)
  assert.equal(d.dragState.value, null)
  move({ y: 0 })
  assert.ok(d.dragState.value, 'drag state set on the first move')
  assert.equal(d.dragState.value.blockId, 'b1')
  assert.equal(d.dragState.value.mode, 'move')
  assert.equal(d.dragState.value.preview.starts_at, BLOCK.starts_at)
})

test('moves inside one snap step keep the same dragState object', () => {
  const d = makeDrag()
  d.startMove(downEvent(), BLOCK)
  move({ y: 1 })
  const first = d.dragState.value
  for (let y = 2; y < 24; y++) move({ y }) // still rounds to 0 min
  assert.equal(d.dragState.value, first, 'no new object inside the step')
  move({ y: 30 }) // rounds to +30 min
  assert.notEqual(d.dragState.value, first)
  assert.equal(d.dragState.value.preview.starts_at, '2026-10-01T09:30:00.000Z')
  assert.equal(d.dragState.value.preview.ends_at, '2026-10-01T10:30:00.000Z')
  const second = d.dragState.value
  move({ y: 40 })
  assert.equal(d.dragState.value, second)
})

test('a fresh board_ids array with the same contents is not a change, new contents are', () => {
  let cols = ['3m']
  const d = makeDrag({ resolveColumnAtX: () => cols.slice() })
  d.startMove(downEvent(), BLOCK)
  move({ x: 5 })
  const first = d.dragState.value
  move({ x: 10 })
  assert.equal(d.dragState.value, first)
  cols = ['1m']
  move({ x: 200 })
  assert.notEqual(d.dragState.value, first)
  assert.deepEqual(d.dragState.value.preview.board_ids, ['1m'])
})

test('pointerup commits only the changed fields', async () => {
  const d = makeDrag({ resolveColumnAtX: () => ['3m'] })
  d.startMove(downEvent(), BLOCK)
  move({ y: 10 })
  move({ y: 50 }) // +30 min
  up()
  await new Promise((r) => setImmediate(r))
  assert.equal(d.dragState.value, null)
  assert.equal(commits.length, 1)
  assert.equal(commits[0].block, BLOCK)
  assert.deepEqual(commits[0].patch, {
    starts_at: '2026-10-01T09:30:00.000Z',
    ends_at: '2026-10-01T10:30:00.000Z',
  })
})

test('a drag that ends where it started commits nothing', async () => {
  const d = makeDrag()
  d.startMove(downEvent(), BLOCK)
  move({ y: 50 })
  move({ y: 3 })
  up()
  await new Promise((r) => setImmediate(r))
  assert.equal(commits.length, 0)
})

test('resize_bottom clamps to one step and commits ends_at only', async () => {
  const d = makeDrag()
  d.startResizeBottom(downEvent(), BLOCK)
  move({ y: -500 }) // way past the top edge
  assert.equal(d.dragState.value.preview.ends_at, '2026-10-01T09:30:00.000Z')
  const clamped = d.dragState.value
  move({ y: -600 })
  assert.equal(d.dragState.value, clamped)
  up()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(commits[0].patch, { ends_at: '2026-10-01T09:30:00.000Z' })
})

test('Escape cancels the preview and nothing commits', async () => {
  const d = makeDrag()
  d.startResizeTop(downEvent(), BLOCK)
  move({ y: 50 })
  assert.ok(d.dragState.value)
  const esc = new Event('keydown')
  esc.key = 'Escape'
  document.dispatchEvent(esc)
  assert.equal(d.dragState.value, null)
  up()
  await new Promise((r) => setImmediate(r))
  assert.equal(commits.length, 0)
})

// A6-30. On a tablet the browser takes a touch that turns into a scroll
// and fires pointercancel instead of pointerup. The gesture has to die
// there, or the next touch's pointerup commits a move by however far
// the finger travelled in between, and `if (active) return` blocks every
// other drag while it hangs around.
test('pointercancel (a touch turned scroll) cancels and nothing commits', async () => {
  const d = makeDrag()
  d.startMove(downEvent(), BLOCK)
  move({ y: 10 })
  document.dispatchEvent(pointer('pointercancel'))
  assert.equal(d.dragState.value, null)
  // The next touch somewhere else, dragged and released.
  move({ y: 300 })
  up()
  await new Promise((r) => setImmediate(r))
  assert.equal(commits.length, 0)
  // And a fresh drag works again (the stale gesture isn't holding the lock).
  d.startMove(downEvent(), BLOCK)
  move({ y: 48 })
  up()
  await new Promise((r) => setImmediate(r))
  assert.equal(commits.length, 1)
})
