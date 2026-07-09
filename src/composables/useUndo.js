// Legacy "undo snackbar" API. Originally its own standalone
// composable, now it's a thin shim over the more general useNotify
// system in ./useNotify.js so withdraw / finalise / etc. call sites
// keep working without any churn.
//
//   import { showUndo } from '@/composables/useUndo'
//   showUndo({
//     message: 'Withdrew Avery Ueno from this round.',
//     onUndo:  () => reinstateDiver(...),
//   })
//
// New code should reach for the convenience wrappers in useNotify
// (showSuccess / showError / showInfo / showWarning) or showNotify
// directly when an action button is wanted.

import {
  showNotify,
  dismissNotify,
  fireAction,
  useNotifyState,
} from './useNotify'

/**
 * Undo-flavoured toast. Defaults to an 8-second auto-dismiss
 * with an "Undo" action button wired to onUndo.
 */
export function showUndo({
  message,
  onUndo,
  timeoutMs = 8000,
  kind = 'info',
} = {}) {
  showNotify({
    message,
    kind,
    actionLabel: typeof onUndo === 'function' ? 'Undo' : null,
    onAction:    onUndo,
    timeoutMs,
  })
}

// Back-compat re-exports so UndoBar.vue and any view that
// imported these names continues to work.
export const dismissUndo = dismissNotify
export const fireUndo    = fireAction
export const useUndoState = useNotifyState
