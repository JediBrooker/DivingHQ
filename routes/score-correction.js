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

module.exports = function createScoreCorrectionRouter({
  pool,
  io,
  scoreboardCache,
  requireOrgRole,
  requireEventManager,
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
    requireOrgRole(["org_admin", "meet_manager", "referee"]),
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
      const newScore = Number(score);
      if (Number.isNaN(newScore) || newScore < 0 || newScore > 10) {
        return res.status(400).json({ error: "Score must be between 0 and 10" });
      }
      if (((newScore * 2) % 1) !== 0) {
        return res.status(400).json({ error: "Score must be in 0.5 increments" });
      }
      try {
        const prior = await pool.query(
          "SELECT id, score, event_id, competitor_id, judge_id, round_number FROM scores WHERE id = $1",
          [req.params.id],
        );
        if (!prior.rows.length) {
          return res.status(404).json({ error: "Score not found" });
        }
        const existing = prior.rows[0];

        // Org guard: the score must belong to an event in the
        // caller's org. sysadmin can correct scores in any org.
        const ev = await pool.query(
          "SELECT org_id FROM events WHERE id = $1",
          [existing.event_id],
        );
        if (!ev.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        if (!req.user.is_system_admin && ev.rows[0].org_id !== req.user.org_id) {
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
          const ok = await pool.query(
            "SELECT 1 FROM event_managers WHERE event_id = $1 AND user_id = $2",
            [existing.event_id, req.user.id],
          );
          if (ok.rows.length === 0) {
            return res.status(403).json({
              error: "You are not a manager of this event",
            });
          }
        }

        const oldScore = Number(existing.score);
        if (oldScore === newScore) {
          return res.json({ ok: true, unchanged: true });
        }

        await pool.query("UPDATE scores SET score = $1 WHERE id = $2", [newScore, existing.id]);
        try {
          // The `reason` column was added in migration 018. Cap the
          // free-text length so a malicious / accidentally-pasted
          // multi-MB blob can't bloat the audit table.
          const trimmedReason = typeof reason === "string"
            ? reason.trim().slice(0, 500)
            : null;
          await pool.query(
            `INSERT INTO score_audit_log
               (score_id, event_id, competitor_id, judge_id, round_number,
                action, old_score, new_score, actor_user_id, ip_address,
                user_agent, reason)
             VALUES ($1,$2,$3,$4,$5,'update',$6,$7,$8,$9,$10,$11)`,
            [
              existing.id, existing.event_id, existing.competitor_id,
              existing.judge_id, existing.round_number,
              oldScore, newScore, req.user.id,
              req.ip, req.headers["user-agent"] || null,
              trimmedReason || null,
            ],
          );
        } catch (auditErr) {
          console.error("[Score Correction Audit Skipped]", auditErr.message);
        }

        // Flush the cached scoreboard payload so the next
        // re-pull rebuilds with the corrected score. Without this
        // the broadcast below tells viewers to re-fetch but the
        // first ~5s of those fetches would hit the stale cache.
        if (scoreboardCache) scoreboardCache.invalidate(existing.event_id);

        // Broadcast so live consumers re-pull standings. Spectators
        // viewing the recap or live scoreboard will see the
        // corrected total without a manual refresh.
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

        res.json({ ok: true, old_score: oldScore, new_score: newScore });
      } catch (err) {
        console.error("[Score Correction Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
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
