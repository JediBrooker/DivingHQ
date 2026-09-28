// lib/event-visibility.js: who may read an event's scores.
//
// A Live or Completed event is public. Before that (Upcoming, or any other
// status) its scores are Control Room try-outs, lib/records ignores them
// for the same reason, so only the host org, a participating org, or a
// sysadmin can see them. Everyone else gets a 404, same as for an event
// that doesn't exist, so the id doesn't confirm anything.
//
// The participating orgs count before the meet too: a visiting
// federation's divers can enter the event (lib/dive-list-submit checks
// the same list), and they need its prescribed dives to do it.
//
// The scoreboard used to hold this rule on its own. The results exports,
// the score sheet and the judge ranking analysis had no gate at all, and
// handed out practice scores with a "final_rank" to anyone. They all ask
// here now, and so do the dive history, the prescribed dives and the
// participating list, which kept their own copy of the rule in
// routes/events/visibility.js until the bug-pass merges. req.user comes
// from optionalAuth (header or session cookie), so staff opening an export
// link from the app still get in.

const PUBLIC_STATUSES = new Set(["Live", "Completed"]);

// For a handler that already has the row. `event` is { id, org_id,
// status }; `user` is req.user or null.
async function canSeeEvent(db, event, user) {
  if (PUBLIC_STATUSES.has(event.status)) return true;
  if (!user) return false;
  if (user.is_system_admin || (user.org_id && user.org_id === event.org_id)) return true;
  if (!user.org_id) return false;
  const r = await db.query(
    "SELECT 1 FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2",
    [event.id, user.org_id],
  );
  return r.rows.length > 0;
}

// The same, starting from an id. An event that isn't there isn't visible.
async function eventVisibleTo(pool, eventId, user) {
  const ev = await pool.query("SELECT id, org_id, status FROM events WHERE id = $1", [eventId]);
  if (!ev.rows.length) return false;
  return canSeeEvent(pool, ev.rows[0], user);
}

// Express flavour: answers the 404 itself and returns false, or returns
// true and lets the handler carry on.
async function ensureEventVisible(pool, req, res, eventId) {
  if (await eventVisibleTo(pool, eventId, req.user)) return true;
  res.status(404).json({ error: "Event not found" });
  return false;
}

module.exports = { canSeeEvent, eventVisibleTo, ensureEventVisible };
