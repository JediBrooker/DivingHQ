// Control Room keyboard map, pure and framework-free so it's unit-testable
// and so ControlViewV2's keydown handler stays a thin dispatcher.
//
// Every action key resolves to the FOCUSED pool (the view decides which
// event that is), so a keypress can never touch a background pool. Number
// keys 1..N only SWITCH the focused pool, they never act on one.
//
// Guards: modifier combos (Cmd/Ctrl/Alt) are left alone so the global
// Cmd/Ctrl-K command palette and browser shortcuts keep working, and the
// handler skips keys fired while typing, inside a dialog, or (for Space
// and the arrows) on a control that already owns that key. See
// hotkeyBlocked.

// True when the event target is a field that should keep the keystroke,
// so hotkeys never stomp the command-palette input, the event search,
// a hold-reason field, etc.
export function isTypingTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

// Controls that Space activates. The window listener used to eat Space
// on these (preventDefault, then advance), so a focused Hold button
// advanced the diver instead of holding, and Space on a confirm's "Move
// on" queued a second confirm rather than answering the first.
const SPACE_OWNERS = [
  'button', 'a[href]', 'summary', '[role="button"]', '[role^="menuitem"]',
  '[role="option"]', '[role="tab"]', '[role="checkbox"]', '[role="switch"]', '[role="radio"]',
].join(', ')
// Widgets where the arrow keys move around inside the widget.
const ARROW_OWNERS = [
  '[role="menu"]', '[role^="menuitem"]', '[role="listbox"]', '[role="option"]',
  '[role="tablist"]', '[role="tab"]', '[role="radiogroup"]', '[role="radio"]',
].join(', ')

function within(el, selector) {
  return !!(el && typeof el.closest === 'function' && el.closest(selector))
}

// True when a keydown should be left alone rather than read as a hotkey.
// modalOpen is the caller's "is a modal dialog up" (the view checks for
// [aria-modal="true"]): while one is, the keyboard belongs to it, so
// f / r / c / h can't reach a pool from behind a correction dialog. A key
// pressed inside any dialog, modal or not (the Tools drawer), stays there
// too.
export function hotkeyBlocked(e, { modalOpen = false } = {}) {
  if (!e) return true
  if (modalOpen) return true
  const target = e.target
  if (isTypingTarget(target)) return true
  if (within(target, '[role="dialog"], [aria-modal="true"]')) return true
  const key = e.key
  if ((key === ' ' || key === 'Spacebar') && within(target, SPACE_OWNERS)) return true
  if (key && key.startsWith('Arrow') && within(target, ARROW_OWNERS)) return true
  return false
}

// Map a keydown event to an intent, or null if the key isn't bound.
// liveCount caps the number keys to the events actually live.
//   { action: 'focus',   arg: n }              : switch to the Nth Live pool
//   { action: 'advance' }                      : Next Diver / Finalise (focused)
//   { action: 'announce' }                     : announce standings (focused)
//   { action: 'hold' }                         : hold/resume (focused)
//   { action: 'ref', arg: 'failed'|'cap'|'redive' }  : referee call (focused)
export function controlKeyIntent(e, liveCount = 0) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey) return null
  const key = e.key
  if (/^[1-9]$/.test(key)) {
    const n = Number(key)
    return n <= liveCount ? { action: 'focus', arg: n } : null
  }
  if (key === ' ' || key === 'Spacebar' || key === 'ArrowRight') return { action: 'advance' }
  const k = key && key.length === 1 ? key.toLowerCase() : key
  switch (k) {
    case 'l': return { action: 'announce' }
    case 'h': return { action: 'hold' }
    case 'f': return { action: 'ref', arg: 'failed' }
    case 'r': return { action: 'ref', arg: 'redive' }
    case 'c': return { action: 'ref', arg: 'cap' }
    default: return null
  }
}
