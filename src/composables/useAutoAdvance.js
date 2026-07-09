// Auto-advance countdown (P6.4 of the redesign).
//
// The SAME auto-advance contract ControlView.vue runs inline
// (ControlView.vue:746-782), COPIED here, not extracted: the original
// SFC stays byte-identical as the V2 rollback. The frozen behaviour is:
//   * Manual mode (0s) never arms a timer.
//   * A judge flagging the referee blocks the countdown, the operator's
//     eyes belong on the dive resolution, not racing a timer.
//   * Editing the preference mid-countdown cancels the in-flight timer.
//   * Finalise is NEVER auto-fired (the caller gates on nextBtnComplete).
// The seconds preference persists in localStorage under the SAME key the
// V1 path uses, so an operator's choice carries across the flag flip.
//
// Pinned by test/use-auto-advance.test.js. No scoring/business rule.
import { ref, watch, onUnmounted, getCurrentInstance } from 'vue'

export const AUTO_ADVANCE_KEY = 'dr_control_auto_advance_seconds'

// Pure helper so the unit test can assert the persisted seconds parse
// (bad/empty localStorage -> Manual) without needing a component. `key`
// defaults to the legacy single key for back-compat.
export function readAutoAdvanceSeconds(store, key = AUTO_ADVANCE_KEY) {
  try {
    return parseInt((store && store.getItem(key)) || '0', 10) || 0
  } catch {
    return 0
  }
}

// isSignaling: () => boolean, true while a judge is flagging the
// referee; the countdown won't start (and re-arms once it clears).
// storageKey: localStorage key for the seconds preference. Per-pool
// callers namespace it by event id so two pools' cadences don't clobber
// each other, defaults to the shared legacy key.
// scheduler: optional injectable interval scheduler for tests.
export function useAutoAdvance({ isSignaling = () => false, scheduler, storageKey = AUTO_ADVANCE_KEY } = {}) {
  const setI = (scheduler && scheduler.setInterval) || ((fn, ms) => setInterval(fn, ms))
  const clearI = (scheduler && scheduler.clearInterval) || ((id) => clearInterval(id))

  const store = typeof localStorage !== 'undefined' ? localStorage : null
  const autoAdvanceSeconds = ref(readAutoAdvanceSeconds(store, storageKey))
  const autoAdvanceCountdown = ref(0) // remaining seconds; 0 = idle
  let timer = null
  let fire = null

  function cancelAutoAdvance() {
    if (timer) { clearI(timer); timer = null }
    autoAdvanceCountdown.value = 0
    fire = null
  }

  function startAutoAdvance(callback) {
    cancelAutoAdvance()
    if (!autoAdvanceSeconds.value) return // Manual mode
    if (isSignaling()) return // judge flagging the referee blocks the timer
    autoAdvanceCountdown.value = autoAdvanceSeconds.value
    fire = callback
    timer = setI(() => {
      autoAdvanceCountdown.value--
      if (autoAdvanceCountdown.value <= 0) {
        const run = fire
        cancelAutoAdvance()
        if (typeof run === 'function') run()
      }
    }, 1000)
  }

  watch(autoAdvanceSeconds, (s) => {
    try { if (store) store.setItem(storageKey, String(s)) } catch { /* private mode */ }
    // Editing the preference mid-countdown respects the operator's intent.
    cancelAutoAdvance()
  })

  // Only register the unmount hook inside a real component setup; the
  // unit test instantiates the composable standalone.
  if (getCurrentInstance()) onUnmounted(cancelAutoAdvance)

  return { autoAdvanceSeconds, autoAdvanceCountdown, startAutoAdvance, cancelAutoAdvance }
}
