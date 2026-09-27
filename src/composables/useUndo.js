// Undo-flavoured toast. This used to be its own snackbar system; now
// it's one small wrapper over the general useNotify toasts in
// ./useNotify.js (UndoBar renders those directly). The Control Room's
// finalise undo is the caller today.
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

import { showNotify } from './useNotify'

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
