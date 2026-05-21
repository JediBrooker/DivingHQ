// Unit tests for src/lib/idbCache.js pure helpers.
//
// IDB-touching code paths (cachedFetch, idbInvalidate, prefetch)
// are exercised via the existing integration / e2e suites, since
// adding fake-indexeddb just for the SWR layer would balloon the
// devDep set for marginal extra coverage. This file covers the
// pure functions only — isCacheExpired — because the TTL math is
// the bit most likely to drift if someone tweaks the helper.

const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let isCacheExpired

before(async () => {
  const mod = await import('../src/lib/idbCache.js')
  isCacheExpired = mod.isCacheExpired
})

test('isCacheExpired: null/undefined cached entry is treated as expired', () => {
  assert.equal(isCacheExpired(null, 1000), true)
  assert.equal(isCacheExpired(undefined, 1000), true)
})

test('isCacheExpired: no maxAgeMs means never expired', () => {
  const ancient = { data: {}, ts: 0 }  // 1970
  assert.equal(isCacheExpired(ancient, undefined), false)
  assert.equal(isCacheExpired(ancient, null), false)
})

test('isCacheExpired: entry within maxAgeMs is fresh', () => {
  const now = 1_000_000
  const entry = { data: {}, ts: now - 500 }  // 500ms ago
  assert.equal(isCacheExpired(entry, 1000, now), false)
})

test('isCacheExpired: entry past maxAgeMs is expired', () => {
  const now = 1_000_000
  const entry = { data: {}, ts: now - 1500 }  // 1.5s ago
  assert.equal(isCacheExpired(entry, 1000, now), true)
})

test('isCacheExpired: exactly at boundary is fresh (>, not >=)', () => {
  const now = 1_000_000
  const entry = { data: {}, ts: now - 1000 }  // exactly 1s ago
  assert.equal(isCacheExpired(entry, 1000, now), false)
})

test('isCacheExpired: maxAgeMs of 0 means everything is expired', () => {
  const now = 1_000_000
  // ts = now means 0ms old. With maxAgeMs=0, (now-ts) > 0 is
  // false, so technically the brand-new entry IS fresh. But
  // anything even 1ms old is expired — which matches the
  // 'force network on every request' intent of maxAgeMs=0.
  const fresh = { data: {}, ts: now }
  const oneMsOld = { data: {}, ts: now - 1 }
  assert.equal(isCacheExpired(fresh, 0, now), false)
  assert.equal(isCacheExpired(oneMsOld, 0, now), true)
})
