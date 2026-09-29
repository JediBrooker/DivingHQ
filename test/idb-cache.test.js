// Unit tests for src/lib/idbCache.js pure helpers.
//
// IDB-touching code paths (cachedFetch, idbInvalidate)
// are exercised via the existing integration / e2e suites, since
// adding fake-indexeddb just for the SWR layer would balloon the
// devDep set for marginal extra coverage. This file just covers the
// pure functions (isCacheExpired), since the TTL math is
// the bit most likely to drift if someone tweaks the helper.

const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let isCacheExpired
let isEventScoresUrl

before(async () => {
  const mod = await import('../src/lib/idbCache.js')
  isCacheExpired = mod.isCacheExpired
  isEventScoresUrl = mod.isEventScoresUrl
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
  // anything even 1ms old is expired, which matches the
  // 'force network on every request' intent of maxAgeMs=0.
  const fresh = { data: {}, ts: now }
  const oneMsOld = { data: {}, ts: now - 1 }
  assert.equal(isCacheExpired(fresh, 0, now), false)
  assert.equal(isCacheExpired(oneMsOld, 0, now), true)
})

// invalidateEventScores drops what this matches. The recap URL was the
// one left out before: a correction on a Completed event re-read a copy
// the cache called fresh for another 24 hours.
test('isEventScoresUrl: the live board, its leaderboard and the recap for that event', () => {
  const id = '11111111-2222-3333-4444-555555555555'
  const other = '99999999-2222-3333-4444-555555555555'
  for (const url of [
    `/api/scoreboard/${id}`,
    `/api/scoreboard/${id}/leaderboard`,
    `/api/scoreboard/${id}?cache=skip`,
    `/api/archive/${id}/results`,
  ]) assert.equal(isEventScoresUrl(url, id), true, url)
  for (const url of [
    `/api/scoreboard/${other}`,
    `/api/archive/${other}/results`,
    `/api/scoreboard/${id}0`,
    '/api/archive',
    '/api/archive/clubs',
    '/api/dive-directory',
  ]) assert.equal(isEventScoresUrl(url, id), false, url)
  assert.equal(isEventScoresUrl(`/api/scoreboard/${id}`, null), false)
  assert.equal(isEventScoresUrl(null, id), false)
})
