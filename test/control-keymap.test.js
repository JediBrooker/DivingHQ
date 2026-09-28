// Contract for the Control Room key->intent map + typing guard. DB-less.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let controlKeyIntent, isTypingTarget
before(async () => {
  ;({ controlKeyIntent, isTypingTarget } = await import('../src/composables/useControlKeymap.js'))
})

const ev = (key, mods = {}) => ({ key, ...mods })

test('action keys map to the focused-pool intents', () => {
  assert.deepEqual(controlKeyIntent(ev(' ')), { action: 'advance' })
  assert.deepEqual(controlKeyIntent(ev('ArrowRight')), { action: 'advance' })
  assert.deepEqual(controlKeyIntent(ev('l')), { action: 'announce' })
  assert.deepEqual(controlKeyIntent(ev('H')), { action: 'hold' }) // case-insensitive
  assert.deepEqual(controlKeyIntent(ev('f')), { action: 'ref', arg: 'failed' })
  assert.deepEqual(controlKeyIntent(ev('r')), { action: 'ref', arg: 'redive' })
  assert.deepEqual(controlKeyIntent(ev('c')), { action: 'ref', arg: 'cap' })
})

test('number keys switch focus, capped to the live-pool count', () => {
  assert.deepEqual(controlKeyIntent(ev('1'), 2), { action: 'focus', arg: 1 })
  assert.deepEqual(controlKeyIntent(ev('2'), 2), { action: 'focus', arg: 2 })
  assert.equal(controlKeyIntent(ev('3'), 2), null) // 3 > 2 live pools
  assert.equal(controlKeyIntent(ev('1'), 0), null) // none live
})

test('modifier combos are left for the command palette / browser', () => {
  assert.equal(controlKeyIntent(ev('k', { metaKey: true })), null)
  assert.equal(controlKeyIntent(ev('f', { ctrlKey: true })), null)
  assert.equal(controlKeyIntent(ev(' ', { altKey: true })), null)
})

test('unmapped keys return null', () => {
  for (const k of ['k', '/', 'x', 'Enter', 'ArrowLeft', 'Tab', '?']) {
    assert.equal(controlKeyIntent(ev(k)), null, `key ${k} should be unmapped`)
  }
})

test('isTypingTarget guards inputs / textareas / selects / contenteditable', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true)
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false)
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isTypingTarget(null), false)
})

// A fake element with just enough of closest() for the guard: it answers
// from a list of selectors the element (or an ancestor) is said to match.
function el(tagName, matches = []) {
  return {
    tagName,
    closest: (sel) => (sel.split(',').map((s) => s.trim()).some((s) => matches.includes(s)) ? {} : null),
  }
}

test('hotkeyBlocked: nothing fires while a modal dialog is open', async () => {
  const { hotkeyBlocked } = await import('../src/composables/useControlKeymap.js')
  // Space on the confirm's own "Move on" button used to queue a second
  // stale confirm, and f/r/c/h acted on the pool behind a dialog.
  for (const key of [' ', 'f', 'r', 'c', 'h', 'l', '1', 'ArrowRight']) {
    assert.equal(hotkeyBlocked({ key, target: el('BODY') }, { modalOpen: true }), true, `key ${key}`)
  }
})

test('hotkeyBlocked: keys pressed inside a non-modal dialog (the Tools drawer) stay there', async () => {
  const { hotkeyBlocked } = await import('../src/composables/useControlKeymap.js')
  assert.equal(hotkeyBlocked({ key: 'f', target: el('ASIDE', ['[role="dialog"]']) }), true)
})

test('hotkeyBlocked: Space on a focused button presses the button, not Next', async () => {
  const { hotkeyBlocked } = await import('../src/composables/useControlKeymap.js')
  assert.equal(hotkeyBlocked({ key: ' ', target: el('BUTTON', ['button']) }), true)
  assert.equal(hotkeyBlocked({ key: ' ', target: el('A', ['a[href]']) }), true)
  assert.equal(hotkeyBlocked({ key: ' ', target: el('DIV', ['[role="button"]']) }), true)
  // a letter hotkey on a focused button still works, a button does
  // nothing with an 'f'
  assert.equal(hotkeyBlocked({ key: 'f', target: el('BUTTON', ['button']) }), false)
})

test('hotkeyBlocked: arrow keys inside a menu move through the menu', async () => {
  const { hotkeyBlocked } = await import('../src/composables/useControlKeymap.js')
  assert.equal(hotkeyBlocked({ key: 'ArrowRight', target: el('BUTTON', ['button', '[role^="menuitem"]']) }), true)
})

test('hotkeyBlocked: plain page focus and typing', async () => {
  const { hotkeyBlocked } = await import('../src/composables/useControlKeymap.js')
  assert.equal(hotkeyBlocked({ key: ' ', target: el('BODY') }), false)
  assert.equal(hotkeyBlocked({ key: ' ', target: el('H1') }), false)
  assert.equal(hotkeyBlocked({ key: ' ', target: el('INPUT') }), true)
  assert.equal(hotkeyBlocked({ key: 'f', target: null }), false)
})
