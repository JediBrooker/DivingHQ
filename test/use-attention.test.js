// Contract for the single frontend attention selector (P3). DB-less;
// runs in test:safe. Pins the selector behaviour BEFORE any surface
// (Dashboard chip/card/badge, then the ControlViewV2 rail + strip)
// swaps onto it, so the three surfaces can't drift apart.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let attentionForEvent, attentionMarker, contributesToDiverChip

before(async () => {
  // ESM source; resolves via src/package.json "type": "module".
  ;({ attentionForEvent, attentionMarker, contributesToDiverChip } = await import(
    '../src/composables/useAttention.js'
  ))
})

const core = (overrides = []) =>
  [
    { key: 'roster', done: true },
    { key: 'dive_lists', done: true },
    { key: 'panel', done: true },
    { key: 'check_in', done: true },
    { key: 'order', done: true },
    { key: 'sign_off', done: true },
  ].map((r, i) => ({ ...r, ...(overrides[i] || {}) }))

test('attentionForEvent: counts exactly the undone, blocking core steps', () => {
  const readiness = core([{ done: false }, { done: false }, { done: false }])
  const att = attentionForEvent(readiness)
  assert.equal(att.count, 3)
  assert.equal(att.totalCount, 3)
  assert.equal(att.kind, 'blocked')
  assert.ok(att.topBlocker)
  assert.equal(att.blockerRows.length, 3)
})

test('attentionForEvent: all done -> ready, zero, no top blocker', () => {
  const att = attentionForEvent(core())
  assert.equal(att.count, 0)
  assert.equal(att.totalCount, 0)
  assert.equal(att.kind, 'ready')
  assert.equal(att.urgency, 'none')
  assert.equal(att.topBlocker, null)
})

test('a non-blocking core step does not count', () => {
  const readiness = core([{ done: false, blocking: false }])
  assert.equal(attentionForEvent(readiness).count, 0)
})

test('client extras add to blockerRows but NEVER change the 6-core count', () => {
  const readiness = core([{ done: false }]) // one core blocker
  const extras = [
    { key: 'offline', label: 'Offline' },
    { key: 'conflict', label: 'Conflict' },
  ]
  const withExtras = attentionForEvent(readiness, extras)
  const without = attentionForEvent(readiness, [])
  // core count is invariant to extras (startBlocked truth table holds)
  assert.equal(withExtras.count, 1)
  assert.equal(without.count, 1)
  // but extras are surfaced
  assert.equal(withExtras.totalCount, 3)
  assert.equal(without.totalCount, 1)
})

test('urgency escalates to critical when any row is critical', () => {
  const readiness = core([{ done: false, severity: 'critical' }])
  assert.equal(attentionForEvent(readiness).urgency, 'critical')
  const warn = core([{ done: false }])
  assert.equal(attentionForEvent(warn).urgency, 'warn')
})

test('attentionMarker yields at most one marker, with the right precedence', () => {
  const blocked = core([{ done: false }])
  // live wins over everything
  assert.deepEqual(attentionMarker(blocked, [], { live: true }), { kind: 'live', urgency: 'live' })
  // blockers beat next-action
  assert.equal(attentionMarker(blocked, [], { nextAction: true }).kind, 'blocker')
  // next-action only when clear
  assert.equal(attentionMarker(core(), [], { nextAction: true }).kind, 'next-action')
  // nothing -> null
  assert.equal(attentionMarker(core(), [], {}), null)
})

test('bundle-in-flight inputs degrade to empty, not NaN', () => {
  const att = attentionForEvent(undefined, undefined)
  assert.equal(att.count, 0)
  assert.equal(att.totalCount, 0)
  assert.equal(att.kind, 'ready')
})

test('contributesToDiverChip: only entered events count; null bundle = entered (no blink)', () => {
  assert.equal(contributesToDiverChip('e1', ['e1', 'e2']), true)
  assert.equal(contributesToDiverChip('e9', ['e1', 'e2']), false)
  assert.equal(contributesToDiverChip('e1', null), true) // bundle in flight
})
