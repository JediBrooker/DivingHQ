// Who may see an event that isn't public yet.
//
// Live and Completed events are public: the scoreboard, history, round
// dives and participating list all open to anyone. Before that (an
// Upcoming event, or one flipped back to Upcoming for a redo) only the
// people involved see it: a sysadmin, the host org, and any federation
// on the event's participating list. The last one matters because a
// visiting federation's divers can enter the event (lib/dive-list-submit
// checks the same list) and need its prescribed dives to do so.
//
// routes/scoreboard.js's ensureScoreboardVisible applies the same rule
// to /api/scoreboard; the pre-meet reads under routes/ use this.

const PUBLIC_STATUSES = new Set(["Live", "Completed"]);

// `event` is { id, org_id, status }; `user` is req.user or null.
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

module.exports = { canSeeEvent };
