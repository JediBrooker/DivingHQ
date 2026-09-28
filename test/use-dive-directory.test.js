// useDiveDirectory, the one cached read of /api/dive-directory the dive
// list editors and the directory page share. DB-less, runs in test:safe.
// The bug it closed: TeamDiveListView kept cachedApiFetch's wrapper
// object instead of the rows and the picker crashed on .filter.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let useDiveDirectory

before(async () => {
  ;({ useDiveDirectory } = await import('../src/composables/useDiveDirectory.js'))
})

function fakeAuth(result) {
  const calls = []
  return {
    calls,
    async cachedApiFetch(url, opts) {
      calls.push({ url, opts })
      return typeof result === 'function' ? result() : result
    },
  }
}

test('unwraps the cached result into the rows', async () => {
  const rows = [{ id: 1, dive_code: '101' }]
  const auth = fakeAuth({ data: rows, fromCache: true, age: 5 })
  const { dives, reload } = useDiveDirectory(auth)
  assert.deepEqual(await reload(), rows)
  assert.deepEqual(dives.value, rows)
  assert.equal(auth.calls[0].url, '/api/dive-directory')
  assert.equal(auth.calls[0].opts.cache.maxAgeMs, 24 * 60 * 60 * 1000)
})

test('no data (offline, nothing cached) reads as an empty directory', async () => {
  const { dives, reload } = useDiveDirectory(fakeAuth({ data: null, fromCache: false, age: 0 }))
  await reload()
  assert.deepEqual(dives.value, [])
})

test('a background revalidation replaces the rows, junk does not', async () => {
  const auth = fakeAuth({ data: [{ id: 1 }] })
  const { dives, reload } = useDiveDirectory(auth)
  await reload()
  const { onUpdate } = auth.calls[0].opts.cache
  onUpdate([{ id: 1 }, { id: 2 }])
  assert.equal(dives.value.length, 2)
  onUpdate({ error: 'nope' })
  assert.equal(dives.value.length, 2)
})

test('errors reach the caller', async () => {
  const { reload } = useDiveDirectory(fakeAuth(() => { throw new Error('boom') }))
  await assert.rejects(reload(), /boom/)
})
