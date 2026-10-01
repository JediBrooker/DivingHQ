// Manual-entry score path (P5 manual fallback mode).
//
// During an extended outage the operator can type each judge's score
// directly from the Control Room, reading the value off the judge's
// phone (it shows it as a giant number, see BigScoreDisplay in
// JudgeView). When the judge's device later reconnects and syncs its
// queued submit_score, routes/socket.js reconciles the two: same
// value silently confirms, a mismatch fires conflict_pending for the
// operator's review tray.
//
// See docs/offline-p1-design.md §Phase 5 + MANUAL-VS-SYNC-001 in
// docs/offline-inventory.md for the policy. The decision rule that
// came out of the design review: operator's manual entry WINS on
// mismatch. The judge's later digital sync gets audit-logged as a
// discarded duplicate (the operator overrode the row).
//
//   POST /api/scores/manual-entry
//   body: {
//     event_id, competitor_id, round_number, judge_id, score,
//     reason? (free-text for the audit row)
//   }
//
// Auth: whoever may change scores on the event, which is the host's meet
// managers (scoreAuthority in lib/middleware.js: the host club's, the
// host region's, or the org's for its own meets, never another level's).
// Same rule as score correction and conflict resolution. The operator is
// acting on the judge's behalf, so the scores row records judge_id from
// the body so analytics + audit trails still attribute the value to the
// right panel member.
//
// Mounted via:
//   app.use(require('./routes/manual-scores')({ … }))

const express = require("express");
const createIdempotency = require("../lib/idempotency");
const { announceRecords } = require("../lib/records");
const { scoreBodyError, insertScoreAudit, rescoreReason } = require("../lib/score-audit");
const { scoreAuthorityRefusal } = require("../lib/middleware");
const { isUuid } = require("../lib/uuid");

module.exports = function createManualScoresRouter({
  pool, io, scoreboardCache,
  verifyToken,
  // lib/middleware.js. Required: there's no role-only fallback, a mount
  // without it would let any meet manager in the org type scores in.
  scoreAuthority,
  checkAndApplyRecords,         // optional; lib/records.js
  recomputeRecordKeys,          // optional; lib/records.js
}) {
  if (!pool || !io || !verifyToken || !scoreAuthority) {
    throw new Error("createManualScoresRouter requires { pool, io, verifyToken, scoreAuthority, … }");
  }
  const router = express.Router();

  const { httpMiddleware: idem } = createIdempotency({ pool });

  router.post(
    "/api/scores/manual-entry",
    // Signed in is all the route asks. Who may type a score in depends
    // on the event's host, which the handler checks once it has the event.
    verifyToken,
    idem("score_manual_entry"),
    async (req, res) => {
      const {
        event_id, competitor_id, round_number, judge_id, score, reason,
      } = req.body || {};
      const actorLocalTime = req.body?.actor_local_time || null;

      // Basic input checks. Score has to fit the same 0.0-10.0 /
      // 0.5-step constraint the scores table enforces.
      if (!event_id || !competitor_id || !judge_id) {
        return res.status(400).json({ error: "event_id, competitor_id, judge_id all required" });
      }
      if (![event_id, competitor_id, judge_id].every(isUuid)) {
        return res.status(400).json({ error: "event_id, competitor_id and judge_id must be UUIDs" });
      }
      const round = Number(round_number);
      if (!Number.isInteger(round) || round < 1) {
        return res.status(400).json({ error: "round_number must be a positive integer" });
      }
      const scoreErr = scoreBodyError(score, "score");
      if (scoreErr) return res.status(400).json({ error: scoreErr });
      const scoreVal = Number(score);

      const client = await pool.connect();
      // Released early once the score commits (see the records check
      // below), so the finally block has to know not to do it twice.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        client.release();
      };
      try {
        await client.query("BEGIN");

        // Only the host's meet managers type scores in (sysadmin can act
        // anywhere). That also keeps out every other org, the rule never
        // reaches past the event's own.
        const authority = await scoreAuthority(client, event_id, req.user);
        if (!authority.found) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        if (!authority.allowed) {
          await client.query("ROLLBACK");
          return res.status(403).json(scoreAuthorityRefusal(authority.host));
        }

        // Judge has to be on the panel. Without this gate a typo in
        // the body could attribute a score to a user who never sat
        // the event.
        const panel = await client.query(
          "SELECT 1 FROM event_judges WHERE event_id = $1 AND judge_id = $2",
          [event_id, judge_id],
        );
        if (!panel.rows.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "That user is not on this event's judging panel",
          });
        }

        // dive_id is resolved server-side from the dive list so an
        // out-of-date Control Room can't smuggle in the wrong dive's
        // DD. Same posture as routes/socket.js submit_score.
        const dv = await client.query(
          `SELECT dive_id FROM competitor_dive_lists
           WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [event_id, competitor_id, round],
        );
        const resolvedDiveId = dv.rows[0]?.dive_id ?? null;

        // Look up an existing row first. Three cases govern what happens:
        //   * no row              → INSERT with score_source='manual_entry'
        //   * source='manual_entry' → UPDATE (operator typo fix)
        //   * source='judge_direct' → 409 (judge got there first;
        //                                  the operator should use the
        //                                  score-correction path instead)
        const prior = await client.query(
          `SELECT id, score, score_source, status
           FROM scores
           WHERE event_id=$1 AND competitor_id=$2 AND round_number=$3 AND judge_id=$4
           FOR UPDATE`,
          [event_id, competitor_id, round, judge_id],
        );

        let scoreId, isInsert, oldScore;
        // Set aside by a referee redive: typing the mark back in is a
        // change even when it's the same value (see submit_score).
        const wasRedive = prior.rows[0]?.status === "redive";
        if (!prior.rows.length) {
          isInsert = true;
          oldScore = null;
          const ins = await client.query(
            `INSERT INTO scores
               (event_id, competitor_id, judge_id, dive_id, round_number,
                score, score_source, actor_local_time)
             VALUES ($1, $2, $3, $4, $5, $6, 'manual_entry', $7)
             RETURNING id`,
            [event_id, competitor_id, judge_id, resolvedDiveId, round,
             scoreVal, actorLocalTime],
          );
          scoreId = ins.rows[0].id;
        } else {
          const existing = prior.rows[0];
          oldScore = Number(existing.score);
          isInsert = false;
          if (existing.score_source === "judge_direct") {
            await client.query("ROLLBACK");
            return res.status(409).json({
              error: "Judge has already submitted a score for this round. Use the score-correction flow to amend.",
              existing_score: oldScore,
              existing_source: existing.score_source,
            });
          }
          // Operator is fixing their own typo on a manual_entry row.
          // Heads up: reset score_source back to 'manual_entry' even
          // if it had already been reconciled, since a fresh manual
          // entry on a reconciled row is effectively a re-override.
          await client.query(
            `UPDATE scores
                SET score = $2,
                    score_source = 'manual_entry',
                    actor_local_time = $3,
                    status = 'active'
              WHERE id = $1`,
            [existing.id, scoreVal, actorLocalTime],
          );
          scoreId = existing.id;
        }

        // Audit row mirrors the live submit_score audit shape.
        // actor_user_id is the OPERATOR (not the judge whose row this
        // is) so the audit log clearly reads "operator X typed this
        // score on judge Y's behalf at 14:32".
        if (isInsert || oldScore !== scoreVal || wasRedive) {
          const trimmedReason = typeof reason === "string"
            ? reason.trim().slice(0, 500)
            : null;
          await insertScoreAudit(client, {
            scoreId, eventId: event_id, competitorId: competitor_id, judgeId: judge_id, round,
            action: isInsert ? "insert" : "update",
            oldScore, newScore: scoreVal,
            actorId: req.user.id, ip: req.ip, userAgent: req.headers["user-agent"] || null,
            reason: rescoreReason({ wasRedive, note: trimmedReason || "manual entry (P5 fallback)" }),
            actorLocalTime, committedNow: true,
          });
        }

        await client.query("COMMIT");
        // Hand the connection back now. The records check below takes
        // its own from the same pool, and holding this one while it
        // waits is how a burst of manual entries could end up with
        // every connection held by a request waiting for another.
        release();

        // Invalidate the scoreboard cache and broadcast like
        // submit_score does, so spectators see the new score
        // appear right away.
        if (scoreboardCache) scoreboardCache.invalidate(event_id);
        io.to(`event:${event_id}`).emit("score_received", {
          event_id,
          competitor_id,
          round_number: round,
          judge_id,
          score: scoreVal,
          score_source: "manual_entry",
        });

        // The operator typing the last judge's score in completes the
        // dive just like that judge's own submit would have, so it can
        // set a record too. Before this, a meet run on manual entry
        // through an outage never set a single one.
        // A typo fix on a score that was already there can lower the
        // dive, so that replays its books rather than only raising them.
        if (checkAndApplyRecords) {
          await announceRecords({
            checkAndApplyRecords,
            recomputeRecordKeys: isInsert ? null : recomputeRecordKeys,
            io, scoreboardCache,
            eventId: event_id, competitorId: competitor_id, roundNumber: round,
          });
        }

        res.json({
          ok: true,
          score_id: scoreId,
          old_score: oldScore,
          new_score: scoreVal,
          source: "manual_entry",
        });
      } catch (err) {
        if (!released) await client.query("ROLLBACK").catch(() => {});
        console.error("[Manual Score Entry]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        release();
      }
    },
  );

  return router;
};
