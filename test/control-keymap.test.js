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
