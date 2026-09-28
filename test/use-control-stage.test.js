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

// Events created in one transaction share created_at to the microsecond.
// The tie-break was Number(a.id) - Number(b.id), NaN for a UUID, so ties
// kept whatever order /api/events happened to return and pool card N,
// chip N and hotkey N could point at different pools after a reload.
test('liveEventsInOrder: a created_at tie still sorts the same way every time', async () => {
  const { liveEventsInOrder, compareByCreation } = await import('../src/composables/useControlStage.js')
  const t = '2026-09-28T10:00:00.000Z'
  const a = { id: 'c16a33ae-0000-4000-8000-000000000001', created_at: t, status: 'Live' }
  const b = { id: '0b9f1e2d-0000-4000-8000-000000000002', created_at: t, status: 'Live' }
  const c = { id: 'e0000000-0000-4000-8000-000000000003', created_at: '2026-09-28T09:00:00.000Z', status: 'Live' }
  const one = liveEventsInOrder([a, b, c]).map((e) => e.id)
  const two = liveEventsInOrder([b, c, a]).map((e) => e.id)
  assert.deepEqual(one, two)
  assert.equal(one[0], c.id) // oldest first still wins
  assert.ok(Number.isFinite(compareByCreation(a, b)))
  assert.notEqual(compareByCreation(a, b), 0)
})
