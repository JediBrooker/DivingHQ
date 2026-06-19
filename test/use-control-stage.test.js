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
