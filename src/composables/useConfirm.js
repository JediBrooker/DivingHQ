// Promise-based confirm dialog composable, replaces the native
// window.confirm() with a styled modal that can:
//
//   - show a richer body (consequences, side effects)
//   - render a list of "what will happen" bullet points
//   - configure the confirm button label + variant
//   - be dismissed via Esc or outside-click
//
// Usage:
//
//   import { confirmAction } from '@/composables/useConfirm'
//
//   if (!await confirmAction({
//         title: 'Withdraw diver?',
//         body:  `Avery Ueno will be hidden from the active dive
//                  order. Their existing scores stay in the audit
//                  log + history.`,
//         consequences: [
//           'They will be skipped in subsequent rounds',
//           'Standings recompute without their scores',
//         ],
//         confirmLabel: 'Withdraw',
//         confirmKind:  'danger',     // 'primary' | 'danger' | 'warn'
//       })) return
//
// Confirms are QUEUED, not preempted: opening a second dialog while
// the first is still open lines it up behind the first instead of
// silently resolving the first to false. This matters once two Live
// pools can each raise a confirm (a partial-scores skip, a finalise),
// since the old preempt behaviour made pool A's finalise quietly
// resolve to `false` (= "operator declined") the moment pool B raised
// its own dialog. One dialog renders at a time (the queue head);
// answering it pops the next.

import { ref } from 'vue'

const confirmState = ref(null) // the queue HEAD's display state, or null
const queue = []               // [{ state, resolve }] FIFO
let seq = 0                     // monotonic id source (Date.now collides on rapid opens)

/**
 * Open a confirm modal. Resolves true if the user confirms,
 * false if they cancel / press Esc / click outside.
 *
 * @param {object}   opts
 * @param {string}   opts.title           - modal heading
 * @param {string}   [opts.body]          - descriptive paragraph
 * @param {string[]} [opts.consequences]  - bullet list of what'll happen
 * @param {string}   [opts.confirmLabel]  - primary button text
 * @param {string}   [opts.cancelLabel]   - cancel button text
 * @param {string}   [opts.confirmKind]   - 'primary' | 'danger' | 'warn'
 * @returns {Promise<boolean>}
 */
export function confirmAction(opts = {}) {
  return new Promise((resolve) => {
    const entry = {
      resolve,
      state: {
        title:        opts.title || 'Confirm',
        body:         opts.body || '',
        consequences: Array.isArray(opts.consequences) ? opts.consequences : [],
        confirmLabel: opts.confirmLabel || 'Confirm',
        cancelLabel:  opts.cancelLabel  || 'Cancel',
        confirmKind:  opts.confirmKind  || 'primary',
        id:           ++seq,
      },
    }
    queue.push(entry)
    // if this is the only entry, it's the head -> show it now
    if (queue.length === 1) confirmState.value = entry.state
  })
}

export function useConfirmState() { return confirmState }

export function resolveConfirm(value) {
  const entry = queue.shift()
  // Surface the next queued dialog (or clear it) BEFORE resolving, so
  // a handler that chains another confirm enqueues behind a clean head.
  confirmState.value = queue.length ? queue[0].state : null
  if (entry) entry.resolve(!!value)
}
