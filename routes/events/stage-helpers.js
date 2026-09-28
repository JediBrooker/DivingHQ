// SQL helpers the event routes share: the stage-chain writes (advance,
// the three Super Final seeds, the synchro replacement), the lock
// stamp and re-seed guard those share, and the prescribed round dives
// on event create/update.
//
// Plain functions of (db, ...) rather than factory closures so the
// sub-routers in this folder can import them without threading them
// through every mount. `db` is the caller's transaction client; none of
// these open or close a transaction themselves.

// Change-of-dives lock window in minutes, from the request body. The
// stage endpoints all clamp to a day and fall back to a default when
// the value isn't a number. The Super Final final uses its own floor
// and default (Appendix 3 §4.1), hence the options.
function parseLockMinutes(raw, { def = 30, min = 0 } = {}) {
  const n = parseInt(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(n, 24 * 60)) : def;
}

// Seed a stage's roster in one statement. `rows` are
//   { competitor_id, partner_id, team_id, dive_id, round_number,
//     display_order, group_number, is_reserve, reserve_position }
// with anything left out written as NULL (is_reserve as FALSE), which
// is what the per-stage inserts wrote explicitly or by column default
// (group_number and reserve_position have none, is_reserve defaults to
// FALSE). partner_id is how a synchro pair carries from stage to stage;
// leaving it out seeded the pair's lead alone, and the partner's
// representation snapshot (cdl_snapshot_rep) was never taken. Rows go
// in in array order, so the per-row cdl_snapshot_rep trigger sees them
// in the same order a row-at-a-time loop would.
async function insertDiveListRows(db, eventId, rows) {
  if (!rows.length) return;
  const col = (key, empty = null) => rows.map((r) => r[key] ?? empty);
  await db.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, partner_id, team_id, dive_id, round_number,
        display_order, group_number, is_reserve, reserve_position)
     SELECT $1::uuid, t.competitor_id, t.partner_id, t.team_id, t.dive_id, t.round_number,
            t.display_order, t.group_number, t.is_reserve, t.reserve_position
     FROM UNNEST($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::int[],
                 $7::int[], $8::int[], $9::boolean[], $10::int[])
       AS t(competitor_id, partner_id, team_id, dive_id, round_number,
            display_order, group_number, is_reserve, reserve_position)`,
    [
      eventId,
      col("competitor_id"), col("partner_id"), col("team_id"), col("dive_id"),
      col("round_number"), col("display_order"),
      col("group_number"), col("is_reserve", false), col("reserve_position"),
    ],
  );
}

// The dives a set of divers filed for the Stop-1 qualifier, which the
// Super Final semi and final copy their rounds from. Active,
// non-reserve rows only. Map: competitor_id -> Map(round -> dive_id).
async function loadStop1Lists(db, stop1EventId, competitorIds) {
  const r = await db.query(
    `SELECT competitor_id, round_number, dive_id
       FROM competitor_dive_lists
      WHERE event_id = $1
        AND withdrawn_at IS NULL
        AND is_reserve = FALSE
        AND competitor_id = ANY($2::uuid[])`,
    [stop1EventId, competitorIds],
  );
  const byCompetitor = new Map();
  for (const row of r.rows) {
    if (!byCompetitor.has(row.competitor_id)) byCompetitor.set(row.competitor_id, new Map());
    byCompetitor.get(row.competitor_id).set(Number(row.round_number), row.dive_id);
  }
  return byCompetitor;
}

// Write an event's operator-prescribed round dives (migration 039), one
// statement for all of them. `slots` have already been through
// validateRoundDivesShape, so round numbers are unique and a duplicate
// can only come from a race, where the (event_id, round_number) key
// still refuses it.
async function insertRoundDives(db, eventId, slots) {
  if (!slots.length) return;
  await db.query(
    `INSERT INTO event_round_dives (event_id, round_number, dive_id, height)
     SELECT $1::uuid, t.round_number, t.dive_id, t.height
     FROM UNNEST($2::int[], $3::uuid[], $4::numeric[]) AS t(round_number, dive_id, height)`,
    [
      eventId,
      slots.map((s) => s.round_number),
      slots.map((s) => s.dive_id || null),
      slots.map((s) => (s.height == null || s.height === "" ? null : Number(s.height))),
    ],
  );
}

// Stamp (or clear) dive_list_locks_at on an event. World
// Aquatics Article 6.7.3: a change-of-dives form must be
// submitted "no later than thirty (30) minutes after the end of
// the previous stage", so the advance/seed endpoints call this
// right after reseeding. NOW() approximates when the previous
// stage ended. lockMin = 0 means "no auto-lock" and clears any
// stale value left by a prior advance/seed. Runs on the caller's
// open transaction client. Returns the new lock as an ISO
// string, or null when cleared.
async function stampDiveListLock(client, eventId, lockMin) {
  if (lockMin > 0) {
    const lockRes = await client.query(
      `UPDATE events
          SET dive_list_locks_at = NOW() + ($2::int || ' minutes')::interval
        WHERE id = $1
        RETURNING dive_list_locks_at`,
      [eventId, lockMin],
    );
    return lockRes.rows[0]?.dive_list_locks_at?.toISOString() || null;
  }
  await client.query(
    "UPDATE events SET dive_list_locks_at = NULL WHERE id = $1",
    [eventId],
  );
  return null;
}

// Refuse a re-seed (advance / seed-h2h / seed-semi / seed-final)
// when the target event already has scored dives. The seed path
// does `DELETE FROM competitor_dive_lists WHERE event_id = $1`
// and `scores` cascades on competitor_dive_lists' (event_id,
// competitor_id, round_number) FK, so a re-seed without this
// guard SILENTLY destroys every recorded score. The route's
// status === 'Upcoming' gate isn't sufficient because PUT
// /api/events/:id/status lets a manager flip a Live event back
// to Upcoming.
//
// Returns null when safe; otherwise returns an Express-ready
// error string. Caller is expected to ROLLBACK + 409 on a
// non-null return.
async function refuseIfScoresExist(client, eventId) {
  const r = await client.query(
    "SELECT COUNT(*)::int AS n FROM scores WHERE event_id = $1",
    [eventId],
  );
  const n = r.rows[0]?.n || 0;
  if (n === 0) return null;
  return `Cannot re-seed: ${n} score row${n === 1 ? "" : "s"} already exist on this event. Clear the scores first (admin tooling) or use a different event.`;
}

module.exports = {
  parseLockMinutes,
  stampDiveListLock,
  refuseIfScoresExist,
  insertDiveListRows,
  loadStop1Lists,
  insertRoundDives,
};
