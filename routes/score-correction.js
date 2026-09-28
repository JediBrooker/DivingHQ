// Score correction (HTTP) + score audit log read.
//
// The live scoring path lives in the socket layer (submit_score
// in routes/socket.js); this module covers the HTTP-side workflow
// where a meet manager / referee amends a previously-submitted
// score after the dive completed (judge typo, scoring dispute
// resolution).
//
//   PUT /api/scores/:id              correct one score
//   GET /api/events/:id/score-audit  chronological audit trail
//
// Both flow through the same score_audit_log table the live
// submit path uses, so the audit chain stays unbroken across
// both code paths.
//
// PUT /api/scores/:id additionally:
//   * invalidates the cached scoreboard payload so the next
//     read rebuilds with the corrected score
//   * broadcasts a `score_corrected` socket event to the
//     event's room so live consumers re-pull standings
//
// Mounted via:
//   app.use(require('./routes/score-correction')({ … }))

const express = require("express");
const createIdempotency = require("../lib/idempotency");
const { announceRecords } = require("../lib/records");
const { scoreBodyError, insertScoreAudit } = require("../lib/score-audit");

module.exports = function createScoreCorrectionRouter({
  pool,
  io,
  scoreboardCache,
  requireOrgRole,
  requireEventManager,
  // Optional, migration 087. Without them this is the old role-only gate.
  requireRoleOrEventDelegate,
  isEventDelegate,
  // Optional; lib/records.js. A corrected score can move a record.
  recomputeRecordKeys,
}) {
  if (!pool || !io) throw new Error("createScoreCorrectionRouter requires { pool, io, … }");
  const router = express.Router();

  // Idempotency for the score-correction write. Outbox clients
  // include an X-Idempotency-Key (or body field) so a retry after
  // a network blip doesn't double-apply the correction. The
  // middleware also enforces the same payload on retry: a
  // second correction with the same key but different new_score
  // is a client bug (422). See lib/idempotency.js for the
  // owner-check + payload-hash gates.
  const { httpMiddleware } = createIdempotency({ pool });

  router.put(
    "/api/scores/:id",
    requireRoleOrEventDelegate
      ? requireRoleOrEventDelegate(["org_admin", "meet_manager", "referee"], async (req) => {
          if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) return null;
          const r = await pool.query("SELECT event_id FROM scores WHERE id = $1", [req.params.id]);
          return r.rows[0]?.event_id || null;
        })
      : requireOrgRole(["org_admin", "meet_manager", "referee"]),
    httpMiddleware("score_correction"),
    async (req, res) => {
      // Validate the score id shape before it reaches the query.
      // A non-UUID would otherwise surface as a Postgres "invalid
      // input syntax for type uuid" 500 instead of a clean 400
      // (matches the sibling conflicts.js guard).
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.id))) {
        return res.status(400).json({ error: "Invalid score id" });
      }
      const { score, reason } = req.body || {};
      const scoreErr = scoreBodyError(score, "Score");
      if (scoreErr) return res.status(400).json({ error: scoreErr });
      const newScore = Number(score);
      // Read, update and audit in one transaction, with the score row
      // locked, the same as every other score path: the audit row is
      // durable iff the score is. This used to UPDATE on the pool and
      // write the audit in a separate try that only logged a failure,
      // so a correction could stick with no audit record, and two
      // operators correcting the same score at once both logged the
      // same old_score.
      let existing, oldScore;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const prior = await client.query(
          `SELECT id, score, event_id, competitor_id, judge_id, round_number
             FROM scores WHERE id = $1 FOR UPDATE`,
          [req.params.id],
        );
        if (!prior.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Score not found" });
        }
        existing = prior.rows[0];

        // Org guard: the score must belong to an event in the
        // caller's org. sysadmin can correct scores in any org.
        const ev = await client.query(
          "SELECT org_id FROM events WHERE id = $1",
          [existing.event_id],
        );
        if (!ev.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        if (!req.user.is_system_admin && ev.rows[0].org_id !== req.user.org_id) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Cannot correct scores in other organisations" });
        }

        // Per-event authorisation: org_admin (or sysadmin) can
        // correct any event in the org; everyone else (meet_manager,
        // referee role) must be a registered manager of THIS event.
        // Without this check, anyone holding `referee` anywhere in
        // the org could rewrite scores on meets they aren't on.
        const isOrgAdmin = req.user.is_system_admin
          || (req.user.org_roles || []).includes("org_admin");
        if (!isOrgAdmin) {
          // Delegate = event_managers row, or admin of the club hosting
          // the meet. Falls back to the plain row check for old mounts.
          const ok = isEventDelegate
            ? await isEventDelegate(existing.event_id, req.user.id)
            : (await client.query(
                "SELECT 1 FROM event_managers WHERE event_id = $1 AND user_id = $2",
                [existing.event_id, req.user.id],
              )).rows.length > 0;
          if (!ok) {
            await client.query("ROLLBACK");
            return res.status(403).json({
              error: "You are not a manager of this event",
            });
          }
        }

        oldScore = Number(existing.score);
        if (oldScore === newScore) {
          await client.query("ROLLBACK");
          return res.json({ ok: true, unchanged: true });
        }

        await client.query("UPDATE scores SET score = $1 WHERE id = $2", [newScore, existing.id]);
        // The `reason` column was added in migration 018. Cap the
        // free-text length so a malicious / accidentally-pasted
        // multi-MB blob can't bloat the audit table.
        const trimmedReason = typeof reason === "string"
          ? reason.trim().slice(0, 500)
          : null;
        await insertScoreAudit(client, {
          scoreId: existing.id, eventId: existing.event_id,
          competitorId: existing.competitor_id, judgeId: existing.judge_id,
          round: existing.round_number, action: "update",
          oldScore, newScore,
          actorId: req.user.id, ip: req.ip, userAgent: req.headers["user-agent"] || null,
          reason: trimmedReason || null, committedNow: true,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[Score Correction Error]", err.message);
        return res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }

      // Everything below runs after COMMIT, so nobody is told about a
      // correction that didn't stick.
      //
      // Flush the cached scoreboard payload so the next re-pull
      // rebuilds with the corrected score. Without this the broadcast
      // below tells viewers to re-fetch but the first ~5s of those
      // fetches would hit the stale cache.
      if (scoreboardCache) scoreboardCache.invalidate(existing.event_id);

      // Broadcast so live consumers re-pull standings. Spectators
      // viewing the recap or live scoreboard will see the corrected
      // total without a manual refresh.
      io.to(`event:${existing.event_id}`).emit("score_corrected", {
        event_id: existing.event_id,
        competitor_id: existing.competitor_id,
        round_number: existing.round_number,
        score_id: existing.id,
        old_score: oldScore,
        new_score: newScore,
        reason: reason || null,
        actor_user_id: req.user.id,
      });

      // The dive's total moved, so its record books might have too:
      // lowered below a record it set, or raised past one. The
      // correction itself is in by now, so a failure here is logged,
      // not reported as a failed correction.
      if (recomputeRecordKeys) {
        try {
          await announceRecords({
            recomputeRecordKeys, io, scoreboardCache,
            eventId: existing.event_id, competitorId: existing.competitor_id, roundNumber: existing.round_number,
          });
        } catch (err) {
          console.error("[Score Correction] record replay failed", err.message);
        }
      }

      res.json({ ok: true, old_score: oldScore, new_score: newScore });
    },
  );

  // -------------------------------------------------------------
  // GET /api/events/:id/score-audit: chronological audit trail
  // for the event so disputes can be resolved with a complete
  // record of who submitted what. Capped at 1000 rows; older
  // history flows out via the daily purge_audit_logs job.
  // -------------------------------------------------------------
  router.get("/api/events/:id/score-audit", requireEventManager(), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT a.id, a.score_id, a.round_number, a.action,
                a.old_score, a.new_score,
                a.ip_address::text AS ip_address,
                a.user_agent, a.reason, a.created_at,
                a.competitor_id, comp.full_name AS competitor_name,
                a.judge_id,      jud.full_name  AS judge_name,
                ej.judge_number,
                a.actor_user_id, act.full_name  AS actor_name
         FROM score_audit_log a
         LEFT JOIN users comp ON comp.id = a.competitor_id
         LEFT JOIN users jud  ON jud.id  = a.judge_id
         LEFT JOIN users act  ON act.id  = a.actor_user_id
         LEFT JOIN event_judges ej
           ON ej.event_id = a.event_id AND ej.judge_id = a.judge_id
         WHERE a.event_id = $1
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1000`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Audit Log Error]", err.message);
      res.status(500).json({ error: "Failed to load audit log" });
    }
  });

  return router;
};
