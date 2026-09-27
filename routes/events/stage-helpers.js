// SQL helpers the event routes share: the stage-chain writes (advance,
// the three Super Final seeds, the synchro replacement) and the
// prescribed round dives on event create/update.
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
//   { competitor_id, dive_id, round_number, display_order,
//     group_number, is_reserve, reserve_position }
// with anything left out written as NULL (is_reserve as FALSE), which
// is what the per-stage inserts wrote explicitly or by column default
// (group_number and reserve_position have none, is_reserve defaults to
// FALSE). Rows go in in array order, so the per-row cdl_snapshot_rep
// trigger sees them in the same order a row-at-a-time loop would.
async function insertDiveListRows(db, eventId, rows) {
  if (!rows.length) return;
  const col = (key, empty = null) => rows.map((r) => r[key] ?? empty);
  await db.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, dive_id, round_number,
        display_order, group_number, is_reserve, reserve_position)
     SELECT $1::uuid, t.competitor_id, t.dive_id, t.round_number,
            t.display_order, t.group_number, t.is_reserve, t.reserve_position
     FROM UNNEST($2::uuid[], $3::uuid[], $4::int[], $5::int[],
                 $6::int[], $7::boolean[], $8::int[])
       AS t(competitor_id, dive_id, round_number, display_order,
            group_number, is_reserve, reserve_position)`,
    [
      eventId,
      col("competitor_id"), col("dive_id"), col("round_number"), col("display_order"),
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

module.exports = {
  parseLockMinutes,
  insertDiveListRows,
  loadStop1Lists,
  insertRoundDives,
};
