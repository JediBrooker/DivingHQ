// src/lib/signoffLink.js: every "answer this sign-off" link names the
// event as well as the request, or the referee lands on an empty Control
// Room. The server's notification link is checked in
// test/signoff-withdraw.integration.test.js.
const { test } = require('node:test')
const assert = require('node:assert/strict')

test('a sign-off link opens the Control Room on its event', async () => {
  const { signoffLink } = await import('../src/lib/signoffLink.js')
  const ev = '0b6a5c1e-1111-4222-8333-944455556666'
  const req = '7d2f0a9b-aaaa-4bbb-8ccc-ddddeeeeffff'
  assert.equal(signoffLink({ event_id: ev, request_id: req }), `/control?event=${ev}&signoff_request=${req}`)
  // A row without its event still gets the banner, just no event picked.
  assert.equal(signoffLink({ request_id: req }), `/control?signoff_request=${req}`)
  assert.equal(signoffLink(), '/control')
})

// A handoff-code request has no banner to put on top of the Control Room:
// the referee types the code from the operator's screen. Following its
// card to /control found no banner and said the request was closed.
test('a handoff-code request goes where the code is typed', async () => {
  const { signoffLink } = await import('../src/lib/signoffLink.js')
  const ev = '0b6a5c1e-1111-4222-8333-944455556666'
  const req = '7d2f0a9b-aaaa-4bbb-8ccc-ddddeeeeffff'
  assert.equal(signoffLink({ event_id: ev, request_id: req, by_code: true }), '/sign-off-codes')
  assert.equal(signoffLink({ event_id: ev, request_id: req, by_code: false }), `/control?event=${ev}&signoff_request=${req}`)
})
