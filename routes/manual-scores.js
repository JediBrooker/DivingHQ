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
// Auth: org_admin, meet_manager, referee (same posture as score
// correction). The operator is acting on the judge's behalf, so the
// scores row records judge_id from the body so analytics + audit
// trails still attribute the value to the right panel member.
//
// Mounted via:
//   app.use(require('./routes/manual-scores')({ … }))

const express = require("express");
const createIdempotency = require("../lib/idempotency");

module.exports = function createManualScoresRouter({
  pool, io, scoreboardCache, requireOrgRole,
}) {
  if (!pool || !io) throw new Error("createManualScoresRouter requires { pool, io, … }");
  const router = express.Router();

  const { httpMiddleware: idem } = createIdempotency({ pool });

  router.post(
    "/api/scores/manual-entry",
    requireOrgRole(["org_admin", "meet_manager", "referee"]),
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
      const round = Number(round_number);
      if (!Number.isInteger(round) || round < 1) {
        return res.status(400).json({ error: "round_number must be a positive integer" });
      }
      const scoreVal = Number(score);
      if (!Number.isFinite(scoreVal) || scoreVal < 0 || scoreVal > 10) {
        return res.status(400).json({ error: "score must be between 0 and 10" });
      }
      if (((scoreVal * 2) % 1) !== 0) {
        return res.status(400).json({ error: "score must be in 0.5 increments" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Event must belong to the caller's org. Sysadmin can act
        // anywhere, same posture as routes/score-correction.js.
        const ev = await client.query(
          "SELECT id, org_id, name FROM events WHERE id = $1",
          [event_id],
        );
        if (!ev.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        if (!req.user.is_system_admin && ev.rows[0].org_id !== req.user.org_id) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Cannot enter scores for other organisations" });
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
          `SELECT id, score, score_source
           FROM scores
           WHERE event_id=$1 AND competitor_id=$2 AND round_number=$3 AND judge_id=$4
           FOR UPDATE`,
          [event_id, competitor_id, round, judge_id],
        );

        let scoreId, isInsert, oldScore;
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
        if (isInsert || oldScore !== scoreVal) {
          const trimmedReason = typeof reason === "string"
            ? reason.trim().slice(0, 500)
            : null;
          await client.query(
            `INSERT INTO score_audit_log
               (score_id, event_id, competitor_id, judge_id, round_number,
                action, old_score, new_score, actor_user_id, ip_address,
                user_agent, reason, actor_local_time, server_committed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
            [
              scoreId, event_id, competitor_id, judge_id, round,
              isInsert ? "insert" : "update",
              oldScore, scoreVal,
              req.user.id, req.ip,
              req.headers["user-agent"] || null,
              trimmedReason || "manual entry (P5 fallback)",
              actorLocalTime,
            ],
          );
        }

        await client.query("COMMIT");

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

        res.json({
          ok: true,
          score_id: scoreId,
          old_score: oldScore,
          new_score: scoreVal,
          source: "manual_entry",
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[Manual Score Entry]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  return router;
};
