// Where a referee sign-off request opens: the Control Room on the event
// being signed off, with the request's Approve / Deny banner on top
// (NotificationCenter reads signoff_request). The links used to carry the
// request alone, and a referee who tapped one from their dashboard landed
// on "No event selected" with nothing showing the order they were asked
// to approve. routes/control-room-signoff.js writes the same link into the
// notification it sends.
//
// A handoff-code request (by_code on the referee desk's rows) has no
// notification and so no banner: the operator cancelled the push and put a
// code on their screen instead. Its link goes to /sign-off-codes, where the
// referee types that code. It used to open the Control Room like the
// others, find no banner, and tell the referee the request was no longer
// open while the operator's screen was still showing the code.
//
// Plain JS, no Vue, so the node:test suite can import it straight.

export function signoffLink({ event_id: eventId, request_id: requestId, by_code: byCode = false } = {}) {
  if (byCode) return '/sign-off-codes'
  const q = new URLSearchParams()
  if (eventId) q.set('event', String(eventId))
  if (requestId) q.set('signoff_request', String(requestId))
  const qs = q.toString()
  return qs ? `/control?${qs}` : '/control'
}
