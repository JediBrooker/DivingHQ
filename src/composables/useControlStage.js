// Shared meet-day stage derivation (P5 of the redesign).
//
// The SAME workflowMode / orderWorkflowState ControlView.vue derives
// inline (ControlView.vue:835-850), copied here rather than extracted:
// the original SFC stays byte-identical as the V2 rollback. This copy
// is pinned by test/use-control-stage.test.js against the exact same
// transitions the ControlView e2e specs lock, so V1 and V2 cannot
// drift. Pure functions of an event object, no scoring or business rules.
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

// Canonical pool order: oldest-created first, so the first event to go
// Live is "Pool 1", the next "Pool 2", and so on, stable as events
// come and go. The SAME order drives the center pool grid, the top-bar
// switch chips, AND the number-key focus map, so chip position N, grid
// card N and the "N" hotkey always point at the same pool.
export function compareByCreation(a, b) {
  const ta = a?.created_at || ''
  const tb = b?.created_at || ''
  if (ta !== tb) return ta < tb ? -1 : 1
  return Number(a?.id) - Number(b?.id)
}

// every Live event in canonical order (a fresh array, never mutates input)
export function liveEventsInOrder(events) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e.status === 'Live')
    .sort(compareByCreation)
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
