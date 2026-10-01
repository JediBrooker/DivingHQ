// The scores already stored for one dive, by judge seat.
//
// Two screens rebuild a dive from this after a reload or a reconnect,
// since a live score only ever reaches them as a score_received broadcast
// and a broadcast they weren't connected for is gone:
//
//   * the judge keypad, GET /api/events/:id/dive-scores (routes/event-staff.js)
//   * the spectator scoreboard, through get_active_diver's ack (routes/socket.js)
//
// Kept in one place so they agree on what counts. A score a re-dive set
// aside (status 'redive') isn't in: that judge has to score again. The
// value is the one stored, so it's already held to any referee Failed or
// Cap call. Callers check the ids and who's asking; this only reads.

async function storedDiveScores(db, { eventId, competitorId, roundNumber }) {
  const r = await db.query(
    `SELECT ej.judge_number, s.score
       FROM scores s
       JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
      WHERE s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3
        AND s.status IS DISTINCT FROM 'redive'
      ORDER BY ej.judge_number`,
    [eventId, competitorId, roundNumber],
  );
  return r.rows.map((row) => ({ judge_number: Number(row.judge_number), score: Number(row.score) }));
}

module.exports = { storedDiveScores };
