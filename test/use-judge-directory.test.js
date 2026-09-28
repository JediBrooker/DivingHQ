// useJudgeDirectory, the search behind /judges and the By Judge tab of
// /judge-analysis. DB-less, runs in test:safe. A fake auth store records
// the URLs the composable asks for, which is the part both views depend on.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let useJudgeDirectory, nextTick

before(async () => {
  ;({ useJudgeDirectory } = await import('../src/composables/useJudgeDirectory.js'))
  ;({ nextTick } = await import('vue'))
})

function fakeAuth({ loggedIn = true, total = 120, fail = null } = {}) {
  const calls = []
  return {
    calls,
    isLoggedIn: loggedIn,
    async apiFetch(url) {
      calls.push(url)
      if (fail) throw fail
      if (url === '/api/orgs/all') return [{ id: 'o1', name: 'Diving Australia' }]
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset'))
      const n = Math.max(0, Math.min(50, total - offset))
      return { rows: Array.from({ length: n }, (_, i) => ({ id: `j${offset + i}` })), total }
    },
  }
}

test('builds the query from the filters, trimming and upper-casing the country', async () => {
  const auth = fakeAuth()
  const d = useJudgeDirectory(auth)
  d.q.value = '  anna '
  await d.load()
  assert.equal(auth.calls.at(-1), '/api/judges/directory?q=anna&limit=50&offset=0')

  d.countryCode.value = ' aus'
  await nextTick() // the org/country watcher reloads from page one
  assert.equal(auth.calls.at(-1), '/api/judges/directory?q=anna&country_code=AUS&limit=50&offset=0')
})

test('pages through and reports the range', async () => {
  const auth = fakeAuth({ total: 120 })
  const d = useJudgeDirectory(auth)
  await d.load()
  assert.equal(d.pageInfo.value, 'Showing 1–50 of 120')
  d.nextPage() // apiFetch is called before load's first await, so no wait needed
  assert.equal(d.offset.value, 50)
  assert.match(auth.calls.at(-1), /offset=50$/)
  d.prevPage()
  assert.equal(d.offset.value, 0)
})

test('nextPage stops at the last page', async () => {
  const auth = fakeAuth({ total: 40 })
  const d = useJudgeDirectory(auth)
  await d.load()
  const before = auth.calls.length
  d.nextPage()
  assert.equal(auth.calls.length, before)
  assert.equal(d.offset.value, 0)
})

test('clearFilters resets every filter and goes back to page one', async () => {
  const auth = fakeAuth()
  const d = useJudgeDirectory(auth)
  d.q.value = 'x'
  d.offset.value = 50
  d.clearFilters()
  assert.equal(d.q.value, '')
  assert.equal(d.offset.value, 0)
  assert.equal(auth.calls.at(-1), '/api/judges/directory?limit=50&offset=0')
})

test('a failed load empties the list and uses the caller\'s wording when the error has none', async () => {
  const auth = fakeAuth({ fail: new Error('') })
  const d = useJudgeDirectory(auth, { errorText: 'Could not load judges' })
  await d.load()
  assert.equal(d.error.value, 'Could not load judges')
  assert.deepEqual(d.rows.value, [])
  assert.equal(d.total.value, 0)
  assert.equal(d.loading.value, false)
})

test('the federation list is only asked for with a session', async () => {
  const anon = fakeAuth({ loggedIn: false })
  await useJudgeDirectory(anon).loadOrgs()
  assert.deepEqual(anon.calls, [])

  const auth = fakeAuth()
  const d = useJudgeDirectory(auth)
  await d.loadOrgs()
  assert.equal(d.orgs.value.length, 1)
})
