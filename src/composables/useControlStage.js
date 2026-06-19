// Shared meet-day stage derivation (P5 of the redesign).
//
// The SAME workflowMode / orderWorkflowState ControlView.vue derives
// inline (ControlView.vue:835-850) -- COPIED here, not extracted: the
// original SFC stays byte-identical as the V2 rollback. This copy is
// pinned by test/use-control-stage.test.js against the exact same
// transitions the ControlView e2e specs lock, so V1 and V2 cannot
// drift. Pure functions of an event object; no scoring/business rule.
import { computed, unref } from 'vue'

// Pre-meet stepper order (ControlView.vue:857).
export const WORKFLOW_STEPS = ['check-in', 'random', 'sign-off', 'start']

// null (no event) -> check-in -> random -> sign-off -> start (all
// pre-meet, Upcoming) -> live (any status past Upcoming).
export function orderWorkflowStateFor(ev) {
  if (!ev) return null
  if (ev.status !== 'Upcoming') return 'live'
  if (!ev.check_in_done_at) return 'check-in'
  if (!ev.dive_order_randomised_at) return 'random'
  if (!ev.dive_order_signed_off_at) return 'sign-off'
  return 'start'
}

// The top-level center mode: Live -> meet, Completed -> review,
// everything else (Upcoming/Setup) -> setup.
export function workflowModeFor(ev) {
  const status = ev?.status
  if (status === 'Live') return 'meet'
  if (status === 'Completed') return 'review'
  return 'setup'
}

// Composable: reactive stage state from a currentEvent ref/getter.
export function useControlStage(currentEvent) {
  const orderWorkflowState = computed(() => orderWorkflowStateFor(unref(currentEvent)))
  const workflowMode = computed(() => workflowModeFor(unref(currentEvent)))
  return { orderWorkflowState, workflowMode, WORKFLOW_STEPS }
}
