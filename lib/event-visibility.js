// lib/event-visibility.js: who may read an event's scores.
//
// A Live or Completed event is public. Before that (Upcoming, or any other
// status) its scores are Control Room try-outs, lib/records ignores them
// for the same reason, so only the host org, a participating org, or a
// sysadmin can see them. Everyone else gets a 404, same as for an event
// that doesn't exist, so the id doesn't confirm anything.
//
// The scoreboard used to hold this rule on its own. The results exports,
// the score sheet and the judge ranking analysis had no gate at all, and
// handed out practice scores with a "final_rank" to anyone. They all ask
// here now. req.user comes from optionalAuth (header or session cookie),
// so staff opening an export link from the app still get in.

async function eventVisibleTo(pool, eventId, user) {
  const ev = await pool.query("SELECT id, org_id, status FROM events WHERE id = $1", [eventId]);
  if (!ev.rows.length) return false;
  const event = ev.rows[0];
  if (["Live", "Completed"].includes(event.status)) return true;
  if (user?.is_system_admin || (user?.org_id && user.org_id === event.org_id)) return true;
  if (user?.org_id) {
    const part = await pool.query(
      "SELECT 1 FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2",
      [eventId, user.org_id],
    );
    if (part.rows.length) return true;
  }
  return false;
}

// Express flavour: answers the 404 itself and returns false, or returns
// true and lets the handler carry on.
async function ensureEventVisible(pool, req, res, eventId) {
  if (await eventVisibleTo(pool, eventId, req.user)) return true;
  res.status(404).json({ error: "Event not found" });
  return false;
}

module.exports = { eventVisibleTo, ensureEventVisible };
