// Conflict-pending resolution endpoint.
//
// Companion to the `conflict_pending` socket event the P5
// reconciliation path emits when a judge's digital sync arrives
// with a different value than a prior manual entry for the same
// (event, competitor, round, judge) target. The audit row written
// at reconciliation time uses action='rejected_duplicate', with
// the manual value as old_score and the rejected judge value as
// new_score. That's the operator's conflict context.
//
// Decision flow:
//
//   keep_existing:   operator confirms the manual entry. No
//                    score change, just an audit-log row noting
//                    the explicit confirmation.
//   accept_proposed: operator overrides with the judge's value.
//                    body.proposed_score is required. scores.score
//                    gets updated, source flips to
//                    'manual_then_reconciled', audit-log records
//                    the change, score_corrected broadcasts so
//                    spectators see the new total.
//
// The `discard_both` path (DELETE the score row) isn't supported,
// since losing a score on a partial-panel breaks downstream trim
// calculations. If an operator wants to scrub a score they should
// use the withdraw flow on the diver, not a delete.
//
// Auth: whoever may change scores on the event, the same host-org rule
// as PUT /api/scores/:id and manual entry (scoreAuthority in
// lib/middleware.js): the host club's, the host region's, or for its own
// meets the org's admins and meet managers, never another level's.
// Sysadmin always passes. This used to take any referee, meet_manager or
// org_admin in the org who ran the event; the product decision on who
// changes scores narrowed that. Both decisions pick the score that
// stands, so both go through it.
//
// And there has to be a conflict to settle: the row is still a
// manual entry and a 'rejected_duplicate' audit row says a judge's
// sync disagreed with it. accept_proposed only takes that judge's
// value. Without these the endpoint rewrote any score in the org to
// whatever the body said, finished meets included.
//
// The :conflict_id path param is the scores.id row (it's what
// routes/socket.js emits as conflict_id in the conflict_pending
// event). That row is the canonical pointer to the disputed cell.

const express = require("express");
const { announceRecords } = require("../lib/records");
const { scoreBodyError, insertScoreAudit } = require("../lib/score-audit");
const { scoreAuthorityRefusal } = require("../lib/middleware");
const { isUuid } = require("../lib/uuid");

module.exports = function createConflictsRouter({
  pool, io, scoreboardCache,
  verifyToken,
  scoreAuthority,               // lib/middleware.js, required
  recomputeRecordKeys,          // optional; lib/records.js
}) {
  if (!pool || !verifyToken || !scoreAuthority) {
    throw new Error("createConflictsRouter requires { pool, verifyToken, scoreAuthority }");
  }
  const router = express.Router();

  router.post(
    "/api/conflicts/:conflict_id/resolve",
    // Signed in; the handler asks the host rule once it has the score
    // row (the conflict id is that row's id, its event decides).
    verifyToken,
    async (req, res) => {
      const { conflict_id } = req.params;
      const decision = req.body?.decision;
      const proposedScore = req.body?.proposed_score;
      const reason = typeof req.body?.reason === "string"
        ? req.body.reason.trim().slice(0, 500)
        : null;

      // UUID validation. The submit_score reconciliation emits the
      // scores.id as conflict_id, which is a UUID (any version), so
      // we accept the broader pattern here, not just v4.
      if (!isUuid(conflict_id)) {
        return res.status(400).json({ error: "conflict_id must be a UUID" });
      }

      const validDecisions = ["keep_existing", "accept_proposed"];
      if (!validDecisions.includes(decision)) {
        return res.status(400).json({
          error: `decision must be one of ${validDecisions.join(", ")}`,
          note: "discard_both is not supported — use the withdraw flow if a score should be removed entirely",
        });
      }

      if (decision === "accept_proposed") {
        const scoreErr = scoreBodyError(proposedScore, "proposed_score");
        if (scoreErr) return res.status(400).json({ error: scoreErr });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const r = await client.query(
          `SELECT s.id, s.score, s.score_source, s.event_id, s.competitor_id,
                  s.judge_id, s.round_number, e.org_id, e.name AS event_name
           FROM scores s
           JOIN events e ON e.id = s.event_id
           WHERE s.id = $1
           FOR UPDATE`,
          [conflict_id],
        );
        if (!r.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Score not found" });
        }
        const row = r.rows[0];

        // Same rule as a correction: the host's meet managers settle it,
        // and nobody outside the event's org ever passes.
        const authority = await scoreAuthority(client, row.event_id, req.user);
        if (!authority.allowed) {
          await client.query("ROLLBACK");
          return res.status(403).json(scoreAuthorityRefusal(authority.host));
        }

        // Is there actually a conflict on this row? The latest rejected
        // sync carries the judge's value. score_id has no index of its
        // own on the audit log (every score writes a row there), so the
        // event_id is what lets this ride idx_score_audit_event_created
        // instead of scanning the whole table.
        const rejected = row.score_source === "manual_entry"
          ? (await client.query(
              `SELECT new_score FROM score_audit_log
                WHERE event_id = $2 AND score_id = $1 AND action = 'rejected_duplicate'
                ORDER BY created_at DESC, id DESC LIMIT 1`,
              [row.id, row.event_id],
            )).rows[0]
          : null;
        if (!rejected) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "There's no open conflict on this score" });
        }
        if (decision === "accept_proposed" && Number(proposedScore) !== Number(rejected.new_score)) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "proposed_score has to be the judge's synced value",
            judge_score: Number(rejected.new_score),
          });
        }

        const oldScore = Number(row.score);

        if (decision === "keep_existing") {
          // No score change here. We audit a confirm row so future
          // readers can see the operator explicitly stood by the
          // manual entry. score_source flips to
          // 'manual_then_reconciled' if it was still 'manual_entry',
          // since the conflict is closed and the value's been adjudicated.
          await client.query(
            `UPDATE scores SET score_source = 'manual_then_reconciled' WHERE id = $1`,
            [row.id],
          );
          await insertScoreAudit(client, {
            scoreId: row.id, eventId: row.event_id, competitorId: row.competitor_id,
            judgeId: row.judge_id, round: row.round_number,
            action: "reconcile_manual", oldScore, newScore: oldScore,
            actorId: req.user.id, ip: req.ip, userAgent: req.headers["user-agent"] || null,
            reason: reason || "operator confirmed manual entry (conflict resolved)",
            committedNow: true,
          });

          await client.query("COMMIT");

          // No score change → no need to invalidate scoreboard
          // cache or broadcast score_corrected. The audit
          // history is the only side effect.
          return res.json({
            ok: true,
            decision,
            score_id: row.id,
            score: oldScore,
          });
        }

        // accept_proposed: overwrite + audit + broadcast.
        // The status stays what it was. A clash only ever comes from a
        // row that wasn't set aside (submit_score takes a judge's mark
        // over a set-aside row as the new dive's), so a row that's
        // 'redive' now had its dive thrown out after the clash. The
        // judge's value is settled for that dive, and the row waits for
        // their mark on the new one like the rest of the panel.
        const newScore = Number(proposedScore);
        await client.query(
          `UPDATE scores
             SET score = $2,
                 score_source = 'manual_then_reconciled'
           WHERE id = $1`,
          [row.id, newScore],
        );

        await insertScoreAudit(client, {
          scoreId: row.id, eventId: row.event_id, competitorId: row.competitor_id,
          judgeId: row.judge_id, round: row.round_number,
          action: "update", oldScore, newScore,
          actorId: req.user.id, ip: req.ip, userAgent: req.headers["user-agent"] || null,
          reason: reason || "operator accepted judge's digital sync value over manual entry",
          committedNow: true,
        });

        await client.query("COMMIT");

        // Spectators + Control Room need to see the corrected
        // total. Same posture as score-correction.
        if (scoreboardCache) scoreboardCache.invalidate(row.event_id);
        if (io) {
          io.to(`event:${row.event_id}`).emit("score_corrected", {
            event_id: row.event_id,
            competitor_id: row.competitor_id,
            round_number: row.round_number,
            score_id: row.id,
            old_score: oldScore,
            new_score: newScore,
            reason: reason || "conflict resolved",
            actor_user_id: req.user.id,
          });
        }

        // Taking the judge's value moves the dive's total, so replay
        // its record books. Not awaited: this request still holds its
        // own connection, and the replay takes another.
        if (recomputeRecordKeys) {
          announceRecords({
            recomputeRecordKeys, io, scoreboardCache,
            eventId: row.event_id, competitorId: row.competitor_id, roundNumber: row.round_number,
          });
        }

        res.json({
          ok: true,
          decision,
          score_id: row.id,
          old_score: oldScore,
          new_score: newScore,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[Conflict Resolve]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  return router;
};
