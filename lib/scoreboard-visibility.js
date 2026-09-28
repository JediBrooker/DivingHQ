// Who can read an event's public results (the scoreboard, its
// leaderboard, the dive-by-dive history).
//
// Live and Completed events are public. An Upcoming one is only for the
// sysadmin, its own org and the orgs taking part: scores can already sit
// on it (a Live rehearsal reset to Upcoming, a manual entry), and those
// aren't for the world yet. Anything else reads as 404, including an id
// that isn't a UUID (pg would throw on it and that came back as a 500).
//
// Lived inside routes/scoreboard.js until /api/events/:id/history turned
// out to have no gate at all; both use this now.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createScoreboardVisibility(pool) {
  // Resolves true when req may see eventId's results. Otherwise it has
  // already answered 404 and resolves false. req.user comes from
  // optionalAuth, so it's there for a signed-in caller and not otherwise.
  return async function ensureScoreboardVisible(req, res, eventId) {
    if (typeof eventId !== "string" || !UUID_RE.test(eventId)) {
      res.status(404).json({ error: "Event not found" });
      return false;
    }
    const ev = await pool.query(
      "SELECT id, org_id, status FROM events WHERE id = $1",
      [eventId],
    );
    if (!ev.rows.length) {
      res.status(404).json({ error: "Event not found" });
      return false;
    }
    const event = ev.rows[0];
    if (["Live", "Completed"].includes(event.status)) return true;
    if (req.user?.is_system_admin || req.user?.org_id === event.org_id) return true;
    if (req.user?.org_id) {
      const part = await pool.query(
        `SELECT 1 FROM event_participating_orgs
          WHERE event_id = $1 AND org_id = $2`,
        [eventId, req.user.org_id],
      );
      if (part.rows.length) return true;
    }
    res.status(404).json({ error: "Event not found" });
    return false;
  };
}

module.exports = { createScoreboardVisibility };
