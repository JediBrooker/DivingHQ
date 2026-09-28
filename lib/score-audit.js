// What a valid score is, and how a score change gets written to
// score_audit_log, for every path that writes one: the judge's socket
// submit, the operator's manual entry, conflict resolution and the
// HTTP score correction. They each had their own copy of both, and
// AGENTS.md is firm that the HTTP and socket paths agree on the score
// rule or one of them becomes a back door.
//
// lib/middleware.js re-exports isValidScore from here, which is where the
// socket path gets it, so there's one copy of the rule.

// Only an actual number, or a string that spells one, counts as a score.
// Number() is far too forgiving on its own: null, "", "  ", false and []
// all come out as 0, which is a perfectly valid mark, so a keypad bug or
// a crafted payload sending score: null used to be stored as a 0.0.
function toScoreNumber(s) {
  if (typeof s === "number") return s;
  if (typeof s === "string" && s.trim() !== "") return Number(s);
  return NaN;
}

// 0 to 10 in half points. Anything that isn't a finite number (see
// toScoreNumber for what counts) is out.
function isValidScore(s) {
  const n = toScoreNumber(s);
  if (!Number.isFinite(n)) return false;
  if (n < 0 || n > 10) return false;
  return Math.round(n * 2) === n * 2;       // half-points only
}

// The 400 message for a score that came in a request body, or null if
// it's fine. Out of range and off the half-point grid get different
// messages, and `label` is the field name each route has always used in
// them ("score", "Score", "proposed_score"). A missing or non-numeric
// value gets the range message, same as it always has.
function scoreBodyError(value, label) {
  const n = toScoreNumber(value);
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
