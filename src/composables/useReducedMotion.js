// Reactive `prefers-reduced-motion` singleton (P1 of the meet-day
// redesign). One module-level matchMedia listener feeds a shared ref so
// JS-driven motion (sponsor cross-fade, dashboard ticker, role-tour
// slide) can go instant when the user has asked for less motion. The
// CSS side is handled by the global guard in src/styles/app.css plus
// the per-surface guards the P0 scanner tracks; this composable is only
// for motion that lives in JavaScript.
//
// SSR/test-safe: stays false when matchMedia is unavailable. Mirrors
// useConfirm.js / useNotify.js. NOTE: intentionally not unit-tested in
// node (it is a browser matchMedia singleton, and the repo avoids
// loading Vue composables into node tests -- see
// test/body-scroll-lock.test.js). It is covered by
// test/e2e/reduced-motion.spec.js via emulateMedia.
import { ref } from 'vue'

const QUERY = '(prefers-reduced-motion: reduce)'
const prefersReducedMotion = ref(false)

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mql = window.matchMedia(QUERY)
  prefersReducedMotion.value = mql.matches
  const onChange = (e) => { prefersReducedMotion.value = e.matches }
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
  else if (typeof mql.addListener === 'function') mql.addListener(onChange) // Safari <14
}

// Imperative read for non-reactive call sites (timers, event handlers).
export function reduceMotion() {
  return prefersReducedMotion.value
}

export function useReducedMotion() {
  return { prefersReducedMotion, reduceMotion }
}
