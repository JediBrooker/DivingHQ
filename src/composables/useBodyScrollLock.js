// Body-scroll-lock composable for modals.
//
// Why this exists:
//
//   iOS Safari doesn't respect `document.body.style.overflow =
//   'hidden'` reliably. With a fixed-position modal open, the
//   user can still drag on the backdrop area (or on the safe-
//   area gutter above a small modal) and the underlying page
//   will scroll behind it. When they close the modal, they're
//   left in a different scroll position than they started,
//   disorienting on a Dashboard that drifted ten event-rows
//   during a confirm dialog.
//
//   The robust pattern (used by react-bottom-sheet, body-scroll-
//   lock-upgrade, vant, naive-ui, etc.) is:
//
//     onLock:
//       1. Read the current window scrollY.
//       2. Set body { position: fixed; top: -scrollY; left: 0;
//                    right: 0; width: 100%; }
//       3. Body's content is now locked at the user's previous
//          position. Touches on the backdrop have nowhere to
//          scroll.
//     onUnlock:
//       1. Read back the saved scrollY.
//       2. Clear all the body styles we set.
//       3. window.scrollTo(0, scrollY) to restore the position.
//
//   This is iOS Safari's only reliable scroll-lock approach, but
//   it works on every other browser too (Chrome / Firefox /
//   desktop Safari are all fine with the same pattern), so one
//   code path covers all platforms.
//
// Reference counting:
//
//   Multiple modals can be open at once (e.g. a Confirm dialog
//   on top of an open Drawer). A naive boolean lock would unlock
//   the body when the *inner* modal closes even if the outer is
//   still open. The shared counter in body-scroll-lock-core.js
//   handles that.
//
// Usage:
//
//   import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
//   const { lock, unlock } = useBodyScrollLock()
//   watch(isOpen, v => v ? lock() : unlock())
//   // OR, declaratively:
//   const { lockWhile } = useBodyScrollLock()
//   lockWhile(isOpen)
//
// The pure mechanics live in body-scroll-lock-core.js, this file
// is just the Vue lifecycle / watch wiring. Tests target the core
// directly so they don't have to stub out Vue.

import { onUnmounted, watch } from 'vue'
import { createBodyScrollLock } from './body-scroll-lock-core'

// Resolve the env once, lazily, so the module import itself is
// safe under SSR (Vite's SSR pre-render builds run this file at
// build time with no globals available).
function resolveEnv() {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return [null, null]
  }
  return [window, document]
}

/**
 * useBodyScrollLock: returns helpers and auto-cleans up on
 * component unmount.
 *
 * @returns {{
 *   lock: () => void,
 *   unlock: () => void,
 *   lockWhile: (ref) => void,   // declarative wrapper around watch()
 * }}
 */
export function useBodyScrollLock() {
  const [win, doc] = resolveEnv()
  const inst = createBodyScrollLock(win, doc)

  function lockWhile(isOpen) {
    watch(isOpen, (v) => {
      if (v) inst.lock()
      else inst.unlock()
    }, { immediate: true })
  }

  // Belt-and-braces: if the component unmounts while it's still
  // holding locks (e.g. router-pushed away with a modal open),
  // release them so the next page doesn't come up frozen.
  onUnmounted(() => inst.releaseAll())

  return {
    lock: inst.lock,
    unlock: inst.unlock,
    lockWhile,
  }
}
