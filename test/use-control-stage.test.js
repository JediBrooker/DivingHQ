// Pins the shared stage derivation (P5) to the exact transitions
// ControlView.vue derives inline, so V1 and V2 can't drift. DB-less.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let orderWorkflowStateFor, workflowModeFor, WORKFLOW_STEPS

before(async () => {
  ;({ orderWorkflowStateFor, workflowModeFor, WORKFLOW_STEPS } = await import(
    '../src/composables/useControlStage.js'
  ))
})

test('workflowMode: Upcoming -> setup, Live -> meet, Completed -> review', () => {
  assert.equal(workflowModeFor({ status: 'Upcoming' }), 'setup')
  assert.equal(workflowModeFor({ status: 'Live' }), 'meet')
  assert.equal(workflowModeFor({ status: 'Completed' }), 'review')
  assert.equal(workflowModeFor(null), 'setup') // no event -> setup, never blank
})

test('orderWorkflowState walks check-in -> random -> sign-off -> start', () => {
  assert.equal(orderWorkflowStateFor(null), null)
  const base = { status: 'Upcoming' }
  assert.equal(orderWorkflowStateFor({ ...base }), 'check-in')
  assert.equal(orderWorkflowStateFor({ ...base, check_in_done_at: 't' }), 'random')
  assert.equal(
    orderWorkflowStateFor({ ...base, check_in_done_at: 't', dive_order_randomised_at: 't' }),
    'sign-off',
  )
  assert.equal(
    orderWorkflowStateFor({
      ...base,
      check_in_done_at: 't',
      dive_order_randomised_at: 't',
      dive_order_signed_off_at: 't',
    }),
    'start',
  )
})

test('orderWorkflowState: any status past Upcoming -> live', () => {
  assert.equal(orderWorkflowStateFor({ status: 'Live' }), 'live')
  assert.equal(orderWorkflowStateFor({ status: 'Completed' }), 'live')
})

test('WORKFLOW_STEPS is the canonical pre-meet order', () => {
  assert.deepEqual(WORKFLOW_STEPS, ['check-in', 'random', 'sign-off', 'start'])
})

// A6-35. Event ids are UUIDs, so the old Number(a.id) - Number(b.id)
// tie-break was always NaN and two Live events created in the same
// instant (seeded or imported together) kept whatever order the API gave
// them, which could swap 'Pool 1' / 'Pool 2', their chips and hotkeys
// between reloads.
test('pools created in the same instant order by id, whatever the input order', async () => {
  const { liveEventsInOrder } = await import('../src/composables/useControlStage.js')
  const at = '2026-09-01T10:00:00.000Z'
  const a = { id: '5eed0008-0000-0000-0000-00000000000a', status: 'Live', created_at: at }
  const b = { id: '5eed0008-0000-0000-0000-00000000000b', status: 'Live', created_at: at }
  const c = { id: '1eed0008-0000-0000-0000-00000000000c', status: 'Live', created_at: '2026-09-01T11:00:00.000Z' }
  const ids = (list) => liveEventsInOrder(list).map((e) => e.id)
  assert.deepEqual(ids([b, c, a]), [a.id, b.id, c.id])
  assert.deepEqual(ids([a, c, b]), [a.id, b.id, c.id])
})
