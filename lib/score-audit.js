// What a valid score is, and how a score change gets written to
// score_audit_log, for every path that writes one: the judge's socket
// submit, the operator's manual entry, conflict resolution and the
// HTTP score correction. They each had their own copy of both, and
// AGENTS.md is firm that the HTTP and socket paths agree on the score
// rule or one of them becomes a back door.
//
// lib/middleware.js's isValidScore is this one, re-exported, and the
// socket path uses it directly.

// A score off the wire as a number, or NaN. Only a real number or a
// plain decimal string counts: Number() turns null, '', false and []
// into 0 and true into 1, so {score: null} used to pass as a valid 0
// and silently zero a judge's award.
function scoreNumber(s) {
  if (typeof s === "number") return s;
  if (typeof s === "string" && /^\s*\d+(\.\d+)?\s*$/.test(s)) return Number(s);
  return NaN;
}

// 0 to 10 in half points.
function isValidScore(s) {
  const n = scoreNumber(s);
  if (!Number.isFinite(n)) return false;
  if (n < 0 || n > 10) return false;
  return Math.round(n * 2) === n * 2;       // half-points only
}

// The 400 message for a score that came in a request body, or null if
// it's fine. Out of range and off the half-point grid get different
// messages, and `label` is the field name each route has always used in
// them ("score", "Score", "proposed_score").
function scoreBodyError(value, label) {
  const n = scoreNumber(value);
  if (!Number.isFinite(n) || n < 0 || n > 10) return `${label} must be between 0 and 10`;
  if (!isValidScore(n)) return `${label} must be in 0.5 increments`;
  return null;
}

// One score_audit_log row. Fields a caller leaves out are written as
// NULL, which is what leaving the column out of the INSERT did (none of
// them has a default). server_committed_at is only stamped when
// `committedNow` is set: the score correction path has never written
// it, and this doesn't quietly start.
function insertScoreAudit(db, {
  scoreId, eventId, competitorId, judgeId, round, action,
  oldScore = null, newScore = null, actorId = null, ip = null, userAgent = null,
  reason = null, actorLocalTime = null, committedNow = false,
}) {
  return db.query(
    `INSERT INTO score_audit_log
       (score_id, event_id, competitor_id, judge_id, round_number,
        action, old_score, new_score, actor_user_id, ip_address, user_agent,
        reason, actor_local_time, server_committed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             CASE WHEN $14::boolean THEN now() END)`,
    [
      scoreId, eventId, competitorId, judgeId, round,
      action, oldScore, newScore, actorId, ip, userAgent,
      reason, actorLocalTime, committedNow,
    ],
  );
}

module.exports = { isValidScore, scoreBodyError, insertScoreAudit };
