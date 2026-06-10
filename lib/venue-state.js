// Venue scoreboard state — the canonical payload a local bridge
// service translates into Daktronics RTD packets, Colorado Time
// Systems CTS-5, OmegaTiming OSM7, ALGE Timy, or any vendor-
// specific LED-board protocol.
//
// Philosophy: DivingHQ stays vendor-agnostic. We emit a stable,
// well-documented JSON event over the existing Socket.IO transport;
// venue bridges run on a laptop in the building and translate to
// whatever serial/TCP protocol the venue hardware speaks. Federations
// can write their own bridge for any other vendor by subscribing
// to the same socket room.
//
// Wire shape (event name: `venue.scoreboard_state`):
//
//   {
//     "schema_version": 1,
//     "sequence": 42,                           // monotonic per event_id
//     "emitted_at": "2026-05-17T13:42:31Z",
//     "event_id": "uuid",
//     "event": {
//       "id": "uuid", "name": "Women's 3m Springboard",
//       "height": 3, "event_type": "individual" | "synchro_pair" | "team",
//       "status": "Live" | "Upcoming" | "Completed",
//       "round": 4,                             // current round being scored
//       "total_rounds": 6,
//       "on_hold": false,
//       "on_hold_reason": null
//     },
//     "active_diver": {                         // null when no diver on board
//       "competitor_id": "uuid",
//       "name": "Tom Daley",
//       "partner_name": null,                   // synchro: pair partner
//       "country_code": "GBR",
//       "club_code": "PLY",
//       "lane": null,                           // future hardware integration
//       "display_order": 5                      // position in the start list
//     },
//     "active_dive": {                          // null when no dive picked
//       "code": "109C",
//       "position": "",
//       "dd": 3.5,
//       "description": "Forward 4 1/2 Somersault Tuck"
//     },
//     "scores": [8.5, 8.0, 9.0, 8.5, 8.0],     // pending judges → null
//     "dive_total": 89.25,                      // null until final
//     "running_total": 312.50,
//     "current_rank": 1,
//     "field_size": 14,
//     "leaderboard": [                          // top N per top_n option
//       { "rank": 1, "name": "…", "country_code": "GBR", "total": 312.50 },
//       …
//     ]
//   }
//
// Sequence number resets on server restart (the bridge should
// re-sync from scratch via a one-shot fetch when it detects a
// sequence regression). Schema version bumps when the wire shape
// changes incompatibly.
//
// `buildScoreboardState({ ..., stamp })` — when `stamp` is true
// (the default, used by `emitVenueState`), the call advances the
// per-event sequence counter and returns the new value. When
// `stamp` is false (used by HTTP snapshot reads), the function
// returns the LAST emitted sequence without advancing — read-only
// snapshots must not perturb the socket-emit stream. Mixing the
// two modes is what kept tripping bridges into a phantom re-sync
// on every reconnect: HTTP boot would bump the counter, then the
// next socket emit would skip a number, and the bridge's
// "sequence regression" guard would treat it as a server restart.

const { perDiveSelect, perDivePointsCte } = require("./scoring-sql");

const SCHEMA_VERSION = 1;

// Per-event monotonic sequence counters. In-memory — process
// restart resets to zero. A bridge that sees a sequence decrease
// should treat it as a re-sync signal.
const sequenceCounters = new Map(); // event_id → number

function nextSequence(eventId) {
  const n = (sequenceCounters.get(eventId) || 0) + 1;
  sequenceCounters.set(eventId, n);
  return n;
}

function peekSequence(eventId) {
  return sequenceCounters.get(eventId) || 0;
}

// Drop bookkeeping for an event that's no longer streaming.
// Called when an event flips to Completed so the per-event Map
// doesn't grow unbounded over a meet-week. Idempotent — fine to
// call for an event that was never streamed.
function pruneSequenceForEvent(eventId) {
  sequenceCounters.delete(eventId);
}

// Build the canonical scoreboard_state payload for one event.
// All DB reads are scoped to the single event; ~2 queries total
// (the leaderboard + the active diver's rank share one CTE),
// safe to call on every state change.
//
// Options:
//   - stamp (default true): advance the per-event sequence counter
//       and return the new value. Pass `false` for read-only
//       snapshots (HTTP GET) so they don't perturb the socket
//       emit stream — see the block comment above.
async function buildScoreboardState({ pool, eventId, activePayload, onHoldReason = null, stamp = true }) {
  const ev = await pool.query(
    `SELECT id, name, height, event_type, status, total_rounds, number_of_judges
       FROM events WHERE id = $1`,
    [eventId],
  );
  if (!ev.rows.length) return null;
  const event = ev.rows[0];

  // Active diver block. The payload from event_live_state carries
  // round + competitor + dive info; we look up display_order +
  // country/club for the venue board's lane/chip rendering.
  let activeDiver = null;
  let activeDive = null;
  let activeRound = activePayload?.round_number || null;
  let scores = [];
  let diveTotal = null;
  let currentRank = null;
  let runningTotal = null;
  let fieldSize = null;

  if (activePayload && activePayload.competitor_id) {
    const dRes = await pool.query(
      `SELECT u.id, u.full_name, o.country_code,
              cl.short_code AS club_code,
              cdl.display_order, cdl.partner_id,
              pu.full_name AS partner_name,
              d.dive_code, d.position, d.dd, d.description
         FROM users u
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = $1
          AND cdl.competitor_id = u.id
          AND cdl.round_number = $2
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         LEFT JOIN dive_directory d ON d.id = cdl.dive_id
        WHERE u.id = $3`,
      [eventId, activeRound, activePayload.competitor_id],
    );
    if (dRes.rows.length) {
      const row = dRes.rows[0];
      activeDiver = {
        competitor_id: row.id,
        name: row.full_name,
        partner_name: row.partner_name || null,
        country_code: row.country_code || null,
        club_code: row.club_code || null,
        lane: null,
        display_order: row.display_order,
      };
      if (row.dive_code) {
        activeDive = {
          code: row.dive_code,
          position: row.position || "",
          dd: row.dd != null ? Number(row.dd) : null,
          description: row.description || null,
        };
      }

      // Current judges' scores for this active dive. NULL slots
      // (pending judges) keep the array dense at panel-size so
      // venue displays render a fixed-width N-judge strip.
      const scoreRes = await pool.query(
        `SELECT ej.judge_number, s.score
           FROM event_judges ej
           LEFT JOIN scores s
             ON s.event_id = ej.event_id
            AND s.judge_id = ej.judge_id
            AND s.competitor_id = $2
            AND s.round_number = $3
          WHERE ej.event_id = $1
          ORDER BY ej.judge_number ASC`,
        [eventId, activePayload.competitor_id, activeRound],
      );
      scores = scoreRes.rows.map(r => r.score != null ? Number(r.score) : null);

      // Dive total — present only when every judge has scored.
      // The full scoring pipeline (calc_event_dive_points) is in
      // SQL; we delegate to it so we don't drift from the rest of
      // the app's totals.
      const allIn = scores.length && scores.every(s => s != null);
      if (allIn) {
        const total = await pool.query(
          perDiveSelect({
            select:      [],
            pointsAlias: "pts",
            where:       "s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3",
            groupBy:     [],
          }),
          [eventId, activePayload.competitor_id, activeRound],
        );
        diveTotal = total.rows[0]?.pts != null ? Number(total.rows[0].pts) : null;
      }

    }
  }

  // Single query that produces BOTH the active diver's rank/total
  // and the top-8 leaderboard from one materialisation of
  // per_dive + totals. Before this hoist the score path ran two
  // near-identical CTEs per emit (every judge submit, every
  // active-diver change); for a packed evening session with
  // 14 divers, 6 rounds, 5 judges that's ~420 calc_event_dive_points
  // evaluations of duplicated CTE work per emit. Now we pay once.
  //
  // Wire shape preserved exactly: current_rank, field_size,
  // running_total (the active diver's row, returned as the
  // first/only `kind = 'rank'` row when activePayload is set) and
  // leaderboard (`kind = 'leaderboard'`, ordered DESC, capped at
  // top 8 by the SQL window). The $2 parameter is the active
  // competitor_id or NULL — passing NULL just yields zero `rank`
  // rows, which is exactly the "no active diver" case.
  const combinedRes = await pool.query(
    `WITH ${perDivePointsCte({
       select:      ["s.event_id", "s.competitor_id", "s.round_number"],
       pointsAlias: "pts",
     })},
     totals AS (
       SELECT competitor_id, SUM(pts)::numeric(8,2) AS total
         FROM per_dive GROUP BY competitor_id
     ),
     ranked AS (
       SELECT competitor_id, total,
              RANK() OVER (ORDER BY total DESC) AS rnk,
              COUNT(*) OVER () AS field
         FROM totals
     )
     SELECT 'rank'::text AS kind,
            r.total,
            r.rnk::int  AS rnk,
            r.field::int AS field,
            NULL::text  AS name,
            NULL::text  AS country_code,
            0           AS sort_total
       FROM ranked r
      WHERE $2::uuid IS NOT NULL
        AND r.competitor_id = $2
     UNION ALL
     SELECT 'leaderboard'::text AS kind,
            r.total,
            r.rnk::int  AS rnk,
            r.field::int AS field,
            u.full_name AS name,
            o.country_code,
            r.rnk       AS sort_total
       FROM ranked r
       JOIN users u ON u.id = r.competitor_id
       JOIN organisations o ON o.id = u.org_id
      WHERE r.rnk <= 8
      ORDER BY kind ASC, sort_total ASC, rnk ASC`,
    [eventId, activePayload?.competitor_id || null],
  );

  for (const row of combinedRes.rows) {
    if (row.kind === 'rank') {
      runningTotal = row.total != null ? Number(row.total) : null;
      currentRank  = row.rnk;
      fieldSize    = row.field;
    }
  }
  const leaderboard = combinedRes.rows
    .filter(r => r.kind === 'leaderboard')
    .slice(0, 8)
    .map((row) => ({
      // RANK() from the SQL above, not the array index — two
      // divers tied on total share a rank (1, 1, 3), which is
      // what venue boards are expected to show. Deriving it
      // from the index used to render ties as 1, 2.
      rank: Number(row.rnk),
      name: row.name,
      country_code: row.country_code || null,
      total: row.total != null ? Number(row.total) : null,
    }));

  return {
    schema_version: SCHEMA_VERSION,
    sequence: stamp ? nextSequence(eventId) : peekSequence(eventId),
    emitted_at: new Date().toISOString(),
    event_id: eventId,
    event: {
      id: event.id,
      name: event.name,
      height: event.height != null ? Number(event.height) : null,
      event_type: event.event_type,
      status: event.status,
      round: activeRound,
      total_rounds: event.total_rounds,
      on_hold: !!onHoldReason,
      on_hold_reason: onHoldReason || null,
    },
    active_diver: activeDiver,
    active_dive: activeDive,
    scores,
    dive_total: diveTotal,
    running_total: runningTotal,
    current_rank: currentRank,
    field_size: fieldSize,
    leaderboard,
  };
}

// Fan out the scoreboard state to the venue room. Wrapped in
// try/catch so a build error in one event can't break the score
// path or break other emits.
async function emitVenueState({ io, pool, eventId, activePayload, onHoldReason }) {
  if (!io || !pool || !eventId) return;
  // Skip the whole rebuild when no venue hardware is connected.
  // buildScoreboardState runs 3-5 queries (including the per-
  // (competitor, round) calc_event_dive_points leaderboard CTE)
  // and this function fires on EVERY score submission — paying
  // that on meets with no bridge in the room is pure waste. The
  // room name matches joinVenue in routes/socket.js; a bridge
  // always joins before its first snapshot (subscribe_venue), so
  // the bail can't starve a freshly-connected bridge. Callers
  // are fire-and-forget — none consume a return value.
  if (!io.sockets.adapter.rooms.get(`venue:${eventId}`)?.size) return;
  try {
    const state = await buildScoreboardState({ pool, eventId, activePayload, onHoldReason });
    if (!state) return;
    io.to(`venue:${eventId}`).emit('venue.scoreboard_state', state);
  } catch (err) {
    console.error('[venue-state] emit failed', err.message);
  }
}

// Test helper.
function resetSequenceForTest() {
  sequenceCounters.clear();
}

module.exports = {
  SCHEMA_VERSION,
  buildScoreboardState,
  emitVenueState,
  pruneSequenceForEvent,
  resetSequenceForTest,
};
