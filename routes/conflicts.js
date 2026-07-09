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
// requireOrgRole.
//
// The :conflict_id path param is the scores.id row (it's what
// routes/socket.js emits as conflict_id in the conflict_pending
// event). That row is the canonical pointer to the disputed cell.

const express = require("express");
const { recordAudit } = require("../lib/audit");

module.exports = function createConflictsRouter({ pool, io, scoreboardCache, requireOrgRole }) {
  if (!pool) throw new Error("createConflictsRouter requires { pool, requireOrgRole }");
  const router = express.Router();

  router.post(
    "/api/conflicts/:conflict_id/resolve",
    requireOrgRole(["referee", "meet_manager", "org_admin"]),
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
        const n = Number(proposedScore);
        if (!Number.isFinite(n) || n < 0 || n > 10) {
          return res.status(400).json({ error: "proposed_score must be between 0 and 10" });
        }
        if (((n * 2) % 1) !== 0) {
          return res.status(400).json({ error: "proposed_score must be in 0.5 increments" });
        }
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
          await client.query(
            `INSERT INTO score_audit_log
               (score_id, event_id, competitor_id, judge_id, round_number,
                action, old_score, new_score, actor_user_id, ip_address,
                user_agent, reason, server_committed_at)
             VALUES ($1,$2,$3,$4,$5,'reconcile_manual',$6,$7,$8,$9,$10,$11,NOW())`,
            [
              row.id, row.event_id, row.competitor_id, row.judge_id, row.round_number,
              oldScore, oldScore,
              req.user.id, req.ip,
              req.headers["user-agent"] || null,
              reason || "operator confirmed manual entry (conflict resolved)",
            ],
          );

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

        await client.query(
          `INSERT INTO score_audit_log
             (score_id, event_id, competitor_id, judge_id, round_number,
              action, old_score, new_score, actor_user_id, ip_address,
              user_agent, reason, server_committed_at)
           VALUES ($1,$2,$3,$4,$5,'update',$6,$7,$8,$9,$10,$11,NOW())`,
          [
            row.id, row.event_id, row.competitor_id, row.judge_id, row.round_number,
            oldScore, newScore,
            req.user.id, req.ip,
            req.headers["user-agent"] || null,
            reason || "operator accepted judge's digital sync value over manual entry",
          ],
        );

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
