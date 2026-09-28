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
// Auth: referee, meet_manager, or org_admin (per DEC-05 in
// docs/offline-inventory.md). Sysadmin always passes via
// requireOrgRole. Past the role gate it's the same rule as
// PUT /api/scores/:id: an org admin can settle any event in the org,
// anyone else has to run this event (isEventDelegate).
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

module.exports = function createConflictsRouter({
  pool, io, scoreboardCache, requireOrgRole,
  recomputeRecordKeys,          // optional; lib/records.js
  requireRoleOrEventDelegate,   // optional, migration 087
  isEventDelegate,              // optional; falls back to the event_managers row
}) {
  if (!pool) throw new Error("createConflictsRouter requires { pool, requireOrgRole }");
  const router = express.Router();

  router.post(
    "/api/conflicts/:conflict_id/resolve",
    // The conflict id is the score row's id; its event decides whether
    // a delegate (e.g. the host club's admin) gets in without the role.
    requireRoleOrEventDelegate
      ? requireRoleOrEventDelegate(["referee", "meet_manager", "org_admin"], async (req) => {
          if (!/^[0-9a-f-]{36}$/i.test(String(req.params.conflict_id))) return null;
          const r = await pool.query("SELECT event_id FROM scores WHERE id = $1", [req.params.conflict_id]);
          return r.rows[0]?.event_id || null;
        })
      : requireOrgRole(["referee", "meet_manager", "org_admin"]),
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
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conflict_id)) {
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

        // Org guard, heads up: the operator must own the event's org
        // (sysadmin always passes).
        if (!req.user.is_system_admin && row.org_id !== req.user.org_id) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Cannot resolve conflicts in other organisations" });
        }

        // Per-event check, mirrored from score-correction.js.
        const isOrgAdmin = req.user.is_system_admin
          || (req.user.org_roles || []).includes("org_admin");
        if (!isOrgAdmin) {
          const runsEvent = isEventDelegate
            ? await isEventDelegate(row.event_id, req.user.id)
            : (await client.query(
                "SELECT 1 FROM event_managers WHERE event_id = $1 AND user_id = $2",
                [row.event_id, req.user.id],
              )).rows.length > 0;
          if (!runsEvent) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: "You are not a manager of this event" });
          }
        }

        // Is there actually a conflict on this row? The latest rejected
        // sync carries the judge's value.
        const rejected = row.score_source === "manual_entry"
          ? (await client.query(
              `SELECT new_score FROM score_audit_log
                WHERE score_id = $1 AND action = 'rejected_duplicate'
                ORDER BY created_at DESC, id DESC LIMIT 1`,
              [row.id],
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
        const newScore = Number(proposedScore);
        await client.query(
          `UPDATE scores
             SET score = $2,
                 score_source = 'manual_then_reconciled',
                 status = 'active'
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
