// Referee sign-off requests: the one definition of "still waiting".
//
// A referee_signoff_requests row starts out 'pending' with a five minute
// expires_at, and nothing flips it to 'expired' when that time passes.
// Only a later action on the same row does it: the referee answering
// (who then gets a 409), or the operator sending a new request or code
// for the event, which retires the old ones. So status = 'pending' on
// its own says nothing about whether anyone is still waiting.
//
// The event readiness checklist (lib/workflow.js), the operator's
// dashboard and the meet readiness report each had their own copy of a
// pending_signoff CTE that read it that way, and an event could say
// "Waiting for <referee>" for the rest of the day after the request ran
// out. The referee desk had the expiry check, the others didn't. Anything
// that asks whether a request is live, or has lapsed, comes through here
// now so they can't drift apart again.
//
// Pure string builders, same idea as lib/scoring-sql.js. `alias` is the
// table alias the caller gave referee_signoff_requests.

// A request somebody is still waiting on: pending and not run out.
// Still just status = 'pending' as far as the partial indexes on the
// table go (idx_signoff_requests_*_pending), the expiry test only
// narrows it further.
function liveSignoffRequest(alias = "rsr") {
  return `${alias}.status = 'pending' AND ${alias}.expires_at > now()`;
}

// The other half: still marked pending in the table, but out of time.
// The Control Room's status check reports these as expired. Kept as the
// exact complement of the live test so a row can't be neither at the
// instant expires_at = now().
function lapsedSignoffRequest(alias = "rsr") {
  return `${alias}.status = 'pending' AND ${alias}.expires_at <= now()`;
}

// The pending_signoff CTE the readiness readers join onto their events:
// one row per event with a live request, carrying the name of the
// referee it's waiting on (the newest request wins, though a new one
// retires the old ones anyway). `events` names a CTE or table already in
// the query with an `id` column holding the events to look at, so the
// caller's org gate carries over and no $N placeholders get invented
// here. An event whose last request lapsed simply has no row, which the
// checklist reads as "send a request or sign off".
function pendingSignoffCte({ name = "pending_signoff", events } = {}) {
  if (!events) throw new Error("pendingSignoffCte: events (a CTE or table with an id column) is required");
  return [
    `${name} AS (`,
    "  SELECT DISTINCT ON (rsr.event_id)",
    "         rsr.event_id, u.full_name AS pending_signoff_referee_name",
    "    FROM referee_signoff_requests rsr",
    "    JOIN users u ON u.id = rsr.target_referee_id",
    `    JOIN ${events} signoff_events ON signoff_events.id = rsr.event_id`,
    `   WHERE ${liveSignoffRequest("rsr")}`,
    "   ORDER BY rsr.event_id, rsr.created_at DESC",
    ")",
  ].join("\n");
}

module.exports = {
  liveSignoffRequest,
  lapsedSignoffRequest,
  pendingSignoffCte,
};
