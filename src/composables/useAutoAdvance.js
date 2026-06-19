// Auto-advance countdown (P6.4 of the redesign).
//
// The SAME auto-advance contract ControlView.vue runs inline
// (ControlView.vue:746-782) -- COPIED here, not extracted: the original
// SFC stays byte-identical as the V2 rollback. The frozen behaviour is:
//   * Manual mode (0s) never arms a timer.
//   * A judge flagging the referee blocks the countdown -- the operator's
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
// (bad/empty localStorage -> Manual) without a component.
export function readAutoAdvanceSeconds(store) {
  try {
    return parseInt((store && store.getItem(AUTO_ADVANCE_KEY)) || '0', 10) || 0
  } catch {
    return 0
  }
}

// isSignaling: () => boolean -- true while a judge is flagging the
// referee; the countdown will not start (and re-arms when it clears).
// tick: optional injectable interval scheduler for tests (defaults to
// setInterval/clearInterval).
export function useAutoAdvance({ isSignaling = () => false, scheduler } = {}) {
  const setI = (scheduler && scheduler.setInterval) || ((fn, ms) => setInterval(fn, ms))
  const clearI = (scheduler && scheduler.clearInterval) || ((id) => clearInterval(id))

  const store = typeof localStorage !== 'undefined' ? localStorage : null
  const autoAdvanceSeconds = ref(readAutoAdvanceSeconds(store))
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
    try { if (store) store.setItem(AUTO_ADVANCE_KEY, String(s)) } catch { /* private mode */ }
    // Editing the preference mid-countdown respects the operator's intent.
    cancelAutoAdvance()
  })

  // Only register the unmount hook inside a real component setup; the
  // unit test instantiates the composable standalone.
  if (getCurrentInstance()) onUnmounted(cancelAutoAdvance)

  return { autoAdvanceSeconds, autoAdvanceCountdown, startAutoAdvance, cancelAutoAdvance }
}
