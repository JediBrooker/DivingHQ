// Late-arrival decision gate for deadline-sensitive writes.
//
// Implements DEC-04 from docs/offline-inventory.md: "submitted on
// time but received late" — when a client claims their action
// happened before a hard deadline but the server only saw the
// request after the deadline passed, ACCEPT the action and flag
// it for referee review. The competitor isn't at fault for the
// network outage; the referee adjudicates whether to keep the
// edit.
//
// Pure function — easy to test, no I/O, no Postgres. The caller
// composes it into the gate that wraps competitor / coach
// submission endpoints (see lib/middleware.js loadEventForEntries
// and routes/competitor.js + routes/coach.js).
//
// Three verdicts:
//
//   * 'ok'         — actor_local_time is before deadline AND
//                    server_now is before deadline. Normal accept.
//   * 'late_review'— actor_local_time is before deadline BUT
//                    server_now is past deadline. ACCEPT the
//                    write, set late_arrival_flag = true, refer
//                    to the operator review tray.
//   * 'rejected'   — actor_local_time is past deadline (no excuse).
//                    Reject the write outright.
//
// A missing actor_local_time (legacy online client) means we fall
// back to using server_now for both checks — equivalent to the
// pre-outbox behaviour.
//
// A missing deadline (event has no entries_close_at) means there's
// nothing to gate on; verdict is always 'ok'.

/**
 * @param {Object} args
 * @param {Date|string|null}  args.deadline         The hard cutoff (entries_close_at, change-of-dives window, etc.). May be null.
 * @param {Date|string|null}  args.actorLocalTime   Client's claim of when they submitted. May be null (legacy clients).
 * @param {Date}              args.serverNow        Server's current time. Caller passes new Date() in production; tests inject.
 * @param {number}            [args.maxLateReviewMs] Upper bound on how far past the deadline the SERVER can be while still granting a late_review (default 24h). Beyond this an "I was on time" claim isn't credible and is rejected outright rather than flooding the review tray.
 * @returns {{ verdict: 'ok'|'late_review'|'rejected', reason?: string }}
 */
function evaluateDeadline({ deadline, actorLocalTime, serverNow, maxLateReviewMs = 24 * 60 * 60 * 1000 }) {
  if (deadline == null) return { verdict: 'ok' };
  const deadlineMs = deadline instanceof Date ? deadline.getTime() : Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) {
    // Malformed deadline — be conservative and accept (the
    // strict gate above us would have rejected if it cared).
    return { verdict: 'ok' };
  }
  const nowMs = serverNow.getTime();

  // No actor clock claim → use server clock for both sides. This
  // matches the pre-outbox path so legacy clients see no behaviour
  // change.
  if (actorLocalTime == null) {
    if (nowMs > deadlineMs) {
      return { verdict: 'rejected', reason: 'deadline_passed' };
    }
    return { verdict: 'ok' };
  }

  const actorMs = actorLocalTime instanceof Date
    ? actorLocalTime.getTime()
    : Date.parse(actorLocalTime);
  if (!Number.isFinite(actorMs)) {
    // Garbage timestamp from the client — be conservative and use
    // server clock. Same posture as missing actor time.
    if (nowMs > deadlineMs) {
      return { verdict: 'rejected', reason: 'deadline_passed' };
    }
    return { verdict: 'ok' };
  }

  // Future-dated claim: client clock is ahead of real time (clock
  // drift or deliberate manipulation). We reject it — same posture
  // a referee would take if told "I submitted in 5 minutes' time".
  // Tolerance of 60s for normal clock drift before we flag it.
  if (actorMs > nowMs + 60_000) {
    return { verdict: 'rejected', reason: 'future_dated' };
  }

  const actorBeforeDeadline = actorMs <= deadlineMs;
  const serverBeforeDeadline = nowMs <= deadlineMs;

  if (actorBeforeDeadline && serverBeforeDeadline) {
    return { verdict: 'ok' };
  }
  if (actorBeforeDeadline && !serverBeforeDeadline) {
    // Actor claims on-time, request arrived late (the DEC-04 outage
    // case): accept + flag for referee review — but only within a
    // plausible offline window. The client controls actorLocalTime,
    // so without a ceiling it could claim "one second before the
    // deadline" days later and always buy a review. Past the window
    // the claim isn't credible; reject like any other late entry.
    if (nowMs - deadlineMs > maxLateReviewMs) {
      return { verdict: 'rejected', reason: 'late_review_window_expired' };
    }
    return { verdict: 'late_review', reason: 'arrived_after_deadline' };
  }
  // Actor claims AFTER deadline — clearly late. Server time is also
  // after by transitivity (actorMs > deadlineMs and actorMs ≤
  // nowMs + 60s ≈ nowMs ⇒ nowMs ≥ actorMs > deadlineMs).
  return { verdict: 'rejected', reason: 'deadline_passed' };
}

module.exports = { evaluateDeadline };
