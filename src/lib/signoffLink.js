// Where a referee sign-off request opens: the Control Room on the event
// being signed off, with the request's Approve / Deny banner on top
// (NotificationCenter reads signoff_request). The links used to carry the
// request alone, and a referee who tapped one from their dashboard landed
// on "No event selected" with nothing showing the order they were asked
// to approve. routes/control-room-signoff.js writes the same link into the
// notification it sends.
//
// Plain JS, no Vue, so the node:test suite can import it straight.

export function signoffLink({ event_id: eventId, request_id: requestId } = {}) {
  const q = new URLSearchParams()
  if (eventId) q.set('event', String(eventId))
  if (requestId) q.set('signoff_request', String(requestId))
  const qs = q.toString()
  return qs ? `/control?${qs}` : '/control'
}
