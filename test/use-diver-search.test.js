// useDiverSearch, the /api/divers/search typeahead the dashboard, the
// command palette and Compare share. DB-less, runs in test:safe.
// The race it closed: without aborting, a slow reply for an older query
// could land after a newer one (or after the box was cut below two
// chars) and paint the wrong divers.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let useDiverSearch

before(async () => {
  ;({ useDiverSearch } = await import('../src/composables/useDiverSearch.js'))
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// apiFetch stand-in: each call hands back a promise the test settles by
// hand, and rejects like fetch does when its signal aborts.
function fakeAuth() {
  const calls = []
  return {
    calls,
    apiFetch(url, opts = {}) {
      let resolve, reject
      const p = new Promise((res, rej) => { resolve = res; reject = rej })
      opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      calls.push({ url, signal: opts.signal, resolve, reject })
      return p
    },
  }
}

test('short queries clear the list without asking the server', async () => {
  const auth = fakeAuth()
  const s = useDiverSearch(auth, { delay: 1 })
  s.results.value = [{ id: 'old' }]
  s.search(' a ')
  await sleep(10)
  assert.equal(auth.calls.length, 0)
  assert.deepEqual(s.results.value, [])
})

test('debounces to one trimmed, encoded request and stores the rows', async () => {
  const auth = fakeAuth()
  const s = useDiverSearch(auth, { delay: 5 })
  s.search('an')
  s.search('ann')
  s.search('  ann lee ')
  await sleep(20)
  assert.equal(auth.calls.length, 1)
  assert.equal(auth.calls[0].url, '/api/divers/search?q=ann%20lee')
  assert.equal(s.loading.value, true)
  auth.calls[0].resolve([{ id: 1 }])
  await sleep(0)
  assert.deepEqual(s.results.value, [{ id: 1 }])
  assert.equal(s.loading.value, false)
})

test('a newer query aborts the older request, whose late reply is ignored', async () => {
  const auth = fakeAuth()
  const s = useDiverSearch(auth, { delay: 1 })
  s.search('ab')
  await sleep(10)
  s.search('abc')
  assert.equal(auth.calls[0].signal.aborted, true)
  await sleep(10)
  auth.calls[1].resolve([{ id: 'abc' }])
  auth.calls[0].resolve([{ id: 'ab' }])   // too late, already superseded
  await sleep(0)
  assert.deepEqual(s.results.value, [{ id: 'abc' }])
})

test('cutting the query below two chars mid-request leaves it empty and idle', async () => {
  const auth = fakeAuth()
  const s = useDiverSearch(auth, { delay: 1 })
  s.search('ab')
  await sleep(10)
  assert.equal(s.loading.value, true)
  s.search('a')
  auth.calls[0].resolve([{ id: 'ab' }])
  await sleep(0)
  assert.deepEqual(s.results.value, [])
  assert.equal(s.loading.value, false)
})

test('a failed request clears the list by default, keepOnError keeps it', async () => {
  for (const [opts, expected] of [[{}, []], [{ keepOnError: true }, [{ id: 'prev' }]]]) {
    const auth = fakeAuth()
    const s = useDiverSearch(auth, { delay: 1, ...opts })
    s.results.value = [{ id: 'prev' }]
    s.search('abc')
    await sleep(10)
    auth.calls[0].reject(new Error('500'))
    await sleep(0)
    assert.deepEqual(s.results.value, expected)
    assert.equal(s.loading.value, false)
  }
})

test('trim: false sends the query as typed', async () => {
  const auth = fakeAuth()
  const s = useDiverSearch(auth, { delay: 1, trim: false })
  s.search('ab ')
  await sleep(10)
  assert.equal(auth.calls[0].url, '/api/divers/search?q=ab%20')
})

test('clear() drops a pending search and the results', async () => {
  const auth = fakeAuth()
  const s = useDiverSearch(auth, { delay: 5 })
  s.results.value = [{ id: 'x' }]
  s.search('abc')
  s.clear()
  await sleep(20)
  assert.equal(auth.calls.length, 0)
  assert.deepEqual(s.results.value, [])
})
