// Global toast / notify composable. A small STACK of snackbars at the
// bottom of the viewport (newest lowest) — any view can fire one without
// prop-drilling. A stack (not a single slot) is what lets two Live pools
// each surface a toast without the second silently dropping the first's
// action: e.g. pool A's 12s "undo finalise" survives when pool B toasts
// within the window. Capped so the screen never fills up.
//
// Three flavours of API:
//
//   1. Convenience wrappers for the common cases:
//
//        showSuccess('Roster imported — 12 divers added')
//        showError('Failed to save: network unreachable')
//        showInfo('Late entry added — Avery Ueno scheduled in Round 1')
//        showWarning('Entries close in 1 hour')
//
//   2. Action-bearing toast (e.g. an Undo / Retry / View button):
//
//        showNotify({
//          message: 'Withdrew Avery Ueno from this round.',
//          kind:    'info',
//          actionLabel: 'Undo',
//          onAction:    () => reinstateDiver(...),
//          timeoutMs:   8000,
//        })
//
//   3. Legacy showUndo() kept as a sugar over showNotify so the
//      withdraw / finalise call sites that already use it don't
//      change. See useUndo.js for the back-compat exports.
//
// The component (UndoBar.vue) reads the same shared ref this
// module writes to, so a single global render covers every
// caller.

import { ref } from 'vue'

// Shared reactive stack — newest LAST. Each toast owns its own
// auto-dismiss timer (keyed by id) so they expire independently.
const toasts = ref([])
const timers = new Map() // id -> setTimeout handle
const MAX_TOASTS = 3
let seq = 0

// Kind → default auto-dismiss in ms. Errors stick around longer
// because the operator may need to read them; success toasts
// fade quickly so they don't hang around after a quick action.
const DEFAULT_TIMEOUTS = {
  success: 3500,
  info:    5000,
  warn:    6500,
  error:   8000,
  danger:  8000,        // legacy alias for error
}

/**
 * Fire a toast.
 *
 * @param {object}   opts
 * @param {string}   opts.message     — human-facing text
 * @param {string}   [opts.kind]      — 'success' | 'info' | 'warn' | 'error'
 * @param {string}   [opts.actionLabel] — e.g. 'Undo', 'Retry', 'View'
 * @param {Function} [opts.onAction]  — handler for the action button
 * @param {number}   [opts.timeoutMs] — ms before auto-dismiss; 0 = sticky
 */
export function showNotify(opts = {}) {
  const message = opts.message
  if (!message) return null
  const kind = normaliseKind(opts.kind)
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUTS[kind] ?? 5000

  const id = ++seq
  toasts.value.push({
    id,
    message,
    kind,
    actionLabel: opts.actionLabel || null,
    onAction:    typeof opts.onAction === 'function' ? opts.onAction : null,
  })
  // Cap the stack. Evict the OLDEST toast that carries no action first,
  // so an Undo handle is never silently dropped while plain toasts pile
  // up; only if every toast carries an action do we drop the oldest.
  while (toasts.value.length > MAX_TOASTS) {
    let idx = toasts.value.findIndex((t) => !t.onAction)
    if (idx === -1) idx = 0
    removeAt(idx)
  }
  if (timeoutMs > 0) {
    timers.set(id, setTimeout(() => dismissNotify(id), timeoutMs))
  }
  return id
}

function removeAt(idx) {
  const t = toasts.value[idx]
  if (!t) return
  const h = timers.get(t.id)
  if (h) { clearTimeout(h); timers.delete(t.id) }
  toasts.value.splice(idx, 1)
}

/**
 * Dismiss a toast by id. With no id, clears the whole stack
 * (back-compat with the old single-toast dismiss).
 */
export function dismissNotify(id) {
  if (id == null) {
    for (const h of timers.values()) clearTimeout(h)
    timers.clear()
    toasts.value = []
    return
  }
  const idx = toasts.value.findIndex((t) => t.id === id)
  if (idx !== -1) removeAt(idx)
}

// Read-only handle (the toast stack) for the renderer to subscribe to.
export function useNotifyState() {
  return toasts
}

/**
 * Run a toast's action handler then dismiss it. With no id, fires the
 * newest actionable toast (back-compat). Errors surface as a fresh
 * error toast so the operator notices instead of silently losing the click.
 */
export async function fireAction(id) {
  const list = toasts.value
  const t = id == null
    ? [...list].reverse().find((x) => x.onAction)
    : list.find((x) => x.id === id)
  if (!t || !t.onAction) return
  // Optimistically dismiss first so the operator doesn't see a
  // stuck "running…" state if the handler is async.
  dismissNotify(t.id)
  try {
    await t.onAction()
  } catch (err) {
    showNotify({
      message: `${t.actionLabel || 'Action'} failed: ${err?.message || 'Unknown error'}`,
      kind:    'error',
      timeoutMs: 6000,
    })
  }
}

// ---- Convenience wrappers --------------------------------

export function showSuccess(message, opts = {}) {
  showNotify({ ...opts, message, kind: 'success' })
}
export function showError(message, opts = {}) {
  showNotify({ ...opts, message, kind: 'error' })
}
export function showInfo(message, opts = {}) {
  showNotify({ ...opts, message, kind: 'info' })
}
export function showWarning(message, opts = {}) {
  showNotify({ ...opts, message, kind: 'warn' })
}

// ---- Internals -------------------------------------------

function normaliseKind(kind) {
  if (!kind) return 'info'
  if (kind === 'danger') return 'error' // legacy alias
  if (['success', 'info', 'warn', 'error'].includes(kind)) return kind
  return 'info'
}
