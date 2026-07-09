// Coach "your diver is up next" push fan-out.
//
// Wired into the set_active_diver socket handler (routes/socket.js).
// On every active-diver change we look ahead N=dives_ahead slots in
// the current dive_order; for every squad member who lands in that
// window we send their coach(es) a push notification via lib/push.js.
//
// Dedupe: in-memory, per-process. We track the last active
// (competitor_id, round_number) we processed per event; if the new
// active matches the last processed one in BOTH dimensions (e.g. the
// operator re-emits state for the same diver in the same round) we
// skip it. Heads up: the old dedupe key was competitor_id only, which
// meant when a diver came up again in round 2 the early-return fired
// and no coach pushes went out for ANY squad member behind them in
// the queue. The round-number suffix fixes that.
//
// On event completion we drop the per-event entry via
// pruneCompletedEvent so the map doesn't accumulate stale state.
// A process restart still clears it too, as a fallback.
//
// Push delivery is fire-and-forget, the helper never throws so a
// push failure can't break the score path. Errors just get logged.

const lastProcessedActive = new Map(); // event_id → "competitor_id|round_number"

async function maybeNotifyCoachesOfNextDivers(deps, eventId, activePayload) {
  const { pool, push } = deps;
  if (!pool || !push) return;
  if (!eventId || !activePayload) return;

  const activeCompetitorId = activePayload.competitor_id;
  const activeRound = Number(activePayload.round_number);
  if (!activeCompetitorId || !Number.isInteger(activeRound)) return;

  // Dedupe: same (active diver, round) as last fire? Skip it. Round
  // is part of the key so the same diver showing up again in a later
  // round still triggers a fresh fan-out for the the squad members
  // queued behind them.
  const dedupeKey = `${activeCompetitorId}|${activeRound}`;
  if (lastProcessedActive.get(eventId) === dedupeKey) return;
  lastProcessedActive.set(eventId, dedupeKey);

  try {
    // 1. Find the active diver's display_order in this round.
    const activeRow = await pool.query(
      `SELECT display_order FROM competitor_dive_lists
        WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
          AND withdrawn_at IS NULL`,
      [eventId, activeCompetitorId, activeRound],
    );
    if (!activeRow.rows.length || activeRow.rows[0].display_order == null) return;
    const activeOrder = activeRow.rows[0].display_order;

    // 2. Find squad members (anyone with at least one coach link)
    //    whose next dive is N slots ahead of the active diver in
    //    this event, where N is the coach's `dives_ahead` setting
    //    (default 2). We compute the join inline so a coach with
    //    multiple linked divers all in flight gets one alert per
    //    diver (each push is per-diver-per-coach).
    //
    //    "dives_until" computed the same way as /api/coach/up-next:
    //      same round, ahead of active → display_order - active_order
    //      later round → (slots_in_round - active_order)
    //                    + (round_number - active_round - 1) * slots_in_round
    //                    + display_order
    const candidates = await pool.query(
      `WITH slots_in_round AS (
         SELECT COUNT(*)::int AS n
           FROM competitor_dive_lists
          WHERE event_id = $1 AND round_number = $2 AND withdrawn_at IS NULL
       ),
       linked AS (
         SELECT link.coach_id, link.diver_id,
                COALESCE(cap.dives_ahead, 2)  AS dives_ahead,
                COALESCE(cap.enabled, true)   AS enabled
           FROM coach_diver_links link
           LEFT JOIN coach_alert_preferences cap ON cap.coach_id = link.coach_id
       ),
       upcoming AS (
         SELECT cdl.competitor_id, cdl.round_number, cdl.display_order,
                d.dive_code, d.position
           FROM competitor_dive_lists cdl
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
          WHERE cdl.event_id = $1
            AND cdl.withdrawn_at IS NULL
            AND cdl.competitor_id IN (SELECT diver_id FROM linked)
            AND (
              (cdl.round_number = $2 AND cdl.display_order > $3)
              OR cdl.round_number > $2
            )
       ),
       with_eta AS (
         SELECT u.*,
                CASE
                  WHEN u.round_number = $2
                    THEN u.display_order - $3
                  ELSE
                    ((SELECT n FROM slots_in_round) - $3)
                    + (u.round_number - $2 - 1) * (SELECT n FROM slots_in_round)
                    + u.display_order
                END AS dives_until
           FROM upcoming u
       )
       SELECT u.competitor_id, u.round_number, u.dive_code, u.position,
              u.dives_until,
              l.coach_id, l.dives_ahead,
              c.full_name AS coach_name,
              d.full_name AS diver_name,
              od.country_code,
              e.name      AS event_name
         FROM with_eta u
         JOIN linked l ON l.diver_id = u.competitor_id
         JOIN users c  ON c.id = l.coach_id
         JOIN users d  ON d.id = u.competitor_id
         JOIN organisations od ON od.id = d.org_id
         JOIN events e ON e.id = $1
        WHERE l.enabled
          AND u.dives_until = l.dives_ahead`,
      [eventId, activeRound, activeOrder],
    );

    if (!candidates.rows.length) return;

    // 3. Per (coach, diver) pair, send a push. We do one call per
    //    row so each coach gets one notification per diver. A coach
    //    with three divers all simultaneously in the up-next window
    //    gets three notifications, which is correct, they need to
    //    know about each diver.
    for (const row of candidates.rows) {
      const title = `${row.diver_name} is up in ${row.dives_until}`;
      const codeBit = row.dive_code ? ` (${row.dive_code}${row.position || ''})` : '';
      const body = `${row.event_name} · Round ${row.round_number}${codeBit}`;
      try {
        await push.sendNotification([row.coach_id], {
          category: 'coach.diver_up_next',
          title,
          body,
          data: {
            coach_id: row.coach_id,
            diver_id: row.competitor_id,
            event_id: eventId,
            round_number: row.round_number,
            dives_until: row.dives_until,
          },
          action_url: `/coach`,
          ttl_seconds: 180, // 3 min, past that the dive's already happened
        });
      } catch (err) {
        console.error('[coach-alerts] send failed', err.message);
      }
    }
  } catch (err) {
    console.error('[coach-alerts] fan-out failed', err.message);
  }
}

// Test helper, clears the dedupe map. Called from test setup.
function resetDedupeForTest() {
  lastProcessedActive.clear();
}

// Drop the per-event dedupe entry when an event finishes. Called
// from routes/events when status flips to Completed so the map
// doesn't grow unbounded across a long-running process. Safe to
// call with an unknown event id (no-op).
function pruneCompletedEvent(eventId) {
  if (!eventId) return;
  lastProcessedActive.delete(eventId);
}

module.exports = { maybeNotifyCoachesOfNextDivers, resetDedupeForTest, pruneCompletedEvent };
