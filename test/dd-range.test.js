// src/lib/ddRange.js, the Dive Directory page's copy of the custom-dive DD
// range (the server's is lib/custom-dive-dd.js, which is what refuses).
// DB-less, runs in test:safe.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let officialDdRanges, ddRangeFor, isOutsideOfficialRange, heightNumber

before(async () => {
  ;({ officialDdRanges, ddRangeFor, isOutsideOfficialRange, heightNumber } = await import('../src/lib/ddRange.js'))
})

// Rows the way /api/dive-directory sends them: numeric columns as strings.
const rows = [
  { dive_code: '101', position: 'C', height: '1.0', dd: '1.2', is_custom: false },
  { dive_code: '5337', position: 'D', height: '1.0', dd: '3.4', is_custom: false },
  { dive_code: '101', position: 'B', height: '3.0', dd: '1.5', is_custom: false },
  { dive_code: '109', position: 'C', height: '3.0', dd: '4.8', is_custom: false },
  // Custom rows never widen the range, whatever their DD.
  { dive_code: '901', position: 'B', height: '3.0', dd: '9.9', is_custom: true },
]

test('heights read the same from the form and from the database', () => {
  assert.equal(heightNumber('3m'), 3)
  assert.equal(heightNumber('7.5m'), 7.5)
  assert.equal(heightNumber('3.0'), 3)
  assert.equal(heightNumber(10), 10)
  assert.equal(heightNumber(''), null)
})

test('the range is per height, from the official rows only', () => {
  const r = officialDdRanges(rows)
  assert.deepEqual(ddRangeFor(r, '3m'), { min: 1.5, max: 4.8, fromAllHeights: false })
  assert.deepEqual(ddRangeFor(r, '1.0'), { min: 1.2, max: 3.4, fromAllHeights: false })
})

test('a height with no official dives falls back to every official dive', () => {
  const r = officialDdRanges(rows)
  assert.deepEqual(ddRangeFor(r, '0m'), { min: 1.2, max: 4.8, fromAllHeights: true })
  assert.equal(ddRangeFor(officialDdRanges([]), '3m'), null, 'nothing to go on')
})

test('only custom rows outside their range are flagged', () => {
  const r = officialDdRanges(rows)
  assert.equal(isOutsideOfficialRange(r, rows[4]), true)
  assert.equal(isOutsideOfficialRange(r, { height: '3.0', dd: '4.8', is_custom: true }), false, 'the ends count')
  assert.equal(isOutsideOfficialRange(r, { height: '1.0', dd: '4.0', is_custom: true }), true, 'fine at 3m, not at 1m')
  assert.equal(isOutsideOfficialRange(r, { height: '0.0', dd: '0.5', is_custom: true }), true)
  assert.equal(isOutsideOfficialRange(r, { height: '3.0', dd: '1.5', is_custom: false }), false, 'core rows never')
  assert.equal(isOutsideOfficialRange(officialDdRanges([]), { height: '3.0', dd: '2', is_custom: true }), true)
})
