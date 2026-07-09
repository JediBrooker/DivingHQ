// Control Room keyboard map, pure and framework-free so it's unit-testable
// and so ControlViewV2's keydown handler stays a thin dispatcher.
//
// Every action key resolves to the FOCUSED pool (the view decides which
// event that is), so a keypress can never touch a background pool. Number
// keys 1..N only SWITCH the focused pool, they never act on one.
//
// Guards: modifier combos (Cmd/Ctrl/Alt) are left alone so the global
// Cmd/Ctrl-K command palette and browser shortcuts keep working, and the
// handler skips keys fired while typing (see isTypingTarget).

// True when the event target is a field that should keep the keystroke,
// so hotkeys never stomp the command-palette input, the event search,
// a hold-reason field, etc.
export function isTypingTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
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
