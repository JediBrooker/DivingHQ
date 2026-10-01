// The scores already stored for one dive, by judge seat.
//
// Three screens rebuild a dive from this after a reload or a reconnect,
// since a live score only ever reaches them as a score_received broadcast
// and a broadcast they weren't connected for is gone:
//
//   * the judge keypad, GET /api/events/:id/dive-scores (routes/event-staff.js)
//   * the spectator scoreboard, through get_active_diver's ack (routes/socket.js)
//   * the Control Room, GET /api/events/:id/dive-panel (routes/control-room.js),
//     which asks for judge ids too so its pool keys these the way it keys
//     a live score_received. Nobody else gets them: the spectator ack goes
//     to anonymous sockets.
//
// Kept in one place so they agree on what counts. A score a re-dive set
// aside (status 'redive') isn't in: that judge has to score again. The
// value is the one stored, so it's already held to any referee Failed or
// Cap call. Callers check the ids and who's asking; this only reads.

async function storedDiveScores(db, { eventId, competitorId, roundNumber }, { withJudgeIds = false } = {}) {
  const r = await db.query(
    `SELECT s.judge_id, ej.judge_number, s.score
       FROM scores s
       JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
      WHERE s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3
        AND s.status IS DISTINCT FROM 'redive'
      ORDER BY ej.judge_number`,
    [eventId, competitorId, roundNumber],
  );
  return r.rows.map((row) => (withJudgeIds
    ? { judge_id: row.judge_id, judge_number: Number(row.judge_number), score: Number(row.score) }
    : { judge_number: Number(row.judge_number), score: Number(row.score) }));
}

module.exports = { storedDiveScores };
