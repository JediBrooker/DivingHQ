// Super-Final dive-off routes (Appendix 3 §6).
//
// A dive-off is a single-dive tie-breaker held at the end of H2H
// or SF when two divers are tied. Both divers pick a previously
// performed dive, and the higher score advances. Doesn't affect
// official scores. Stored in tiebreak_dive_offs (Phase 1 schema,
// init.sql ~line 572).
//
// Routes (all under /api/events/:id):
//   GET    /api/events/:id/dive-offs
//   POST   /api/events/:id/dive-offs
//   PATCH  /api/events/:id/dive-offs/:diveOffId
//
// Mounted from routes/events/index.js via:
//   router.use(require('./dive-offs')({ pool, requireEventManager }))
//
// Extracted out of the 4,320-line routes/events.js once the file
// crossed the "agent-grep cost real tokens" line. The block is
// self-contained, the only outside-world dependencies are `pool`
// (Postgres pool) and `requireEventManager` (auth gate).

const express = require("express");
const { recordAudit, auditFromReq } = require("../../lib/audit");
const { perDivePointsCte } = require("../../lib/scoring-sql");
const { scoreAuthorityRefusal } = require("../../lib/middleware");

// A dive-off's two scores and its winner are a result somebody types in,
// so they follow the host-org rule every other hand-entered score does
// (scoreAuthority in lib/middleware.js). Setting one up, picking the dives
// and the notes stay with the event's managers (requireEventManager).
const RESULT_FIELDS = ["score_a", "score_b", "winner_id"];

// Does this write set or change the result? On create any value counts; on
// an update only a value that differs from what's stored, so a manager
// fixing the notes on a settled dive-off isn't refused for re-sending the
// scores the form already had.
function touchesResult(body, existing = null) {
  return RESULT_FIELDS.some((k) => {
    if (!(k in (body || {}))) return false;
    const next = body[k] === "" ? null : body[k];
    if (!existing) return next != null;
    const prev = existing[k];
    if (k === "winner_id") return (next || null) !== (prev || null);
    if (next == null || prev == null) return (next == null) !== (prev == null);
    return Number(next) !== Number(prev);
  });
}

// AUDIT FIX (Strong-6): Appendix 3 §6 says each diver picks one of their
// previously performed dives for the dive-off. The schema only FKs
// dive_a_id / dive_b_id to dive_directory, with nothing scoping them to
// the event or the diver, so the routes check it: the dive has to be the
// diver's dive in one of their already-scored rounds of this event
// (same dive identity rule as scoring, the score row's dive wins over
// the list's). No dive chosen yet is fine. Returns the 400 message, or
// null. Runs on the caller's transaction client.
async function validateDiveOffChoice(client, eventId, competitorId, diveId, side) {
  if (diveId == null) return null;
  const prior = await client.query(
    `SELECT 1
       FROM scores s
       LEFT JOIN competitor_dive_lists cdl
         ON cdl.event_id = s.event_id
        AND cdl.competitor_id = s.competitor_id
        AND cdl.round_number = s.round_number
      WHERE s.event_id = $1
        AND s.competitor_id = $2
        AND COALESCE(s.dive_id, cdl.dive_id) = $3
      LIMIT 1`,
    [eventId, competitorId, diveId],
  );
  if (!prior.rows.length) {
    return `dive_${side}_id must be a dive the ${side} competitor has already performed in this stage (Appendix 3 §6)`;
  }
  return null;
}

module.exports = function createDiveOffsRoutes({ pool, requireEventManager, scoreAuthority }) {
  if (!pool || !requireEventManager) {
    throw new Error("createDiveOffsRoutes requires { pool, requireEventManager }");
  }
  const router = express.Router();

  // Refuses (and rolls back) when the caller can't record a result on this
  // event. Mounted without scoreAuthority it refuses everyone: failing
  // open here would hand dive-off results back to any event manager.
  async function refuseResultWrite(client, res, eventId, user) {
    const authority = scoreAuthority
      ? await scoreAuthority(client, eventId, user)
      : { allowed: false, host: null };
    if (authority.allowed) return false;
    await client.query("ROLLBACK");
    res.status(403).json(scoreAuthorityRefusal(authority.host));
    return true;
  }

  // GET /api/events/:id/dive-offs: the list. Public readable,
  // since the official record needs to be transparent.
  router.get(
    "/api/events/:id/dive-offs",
    async (req, res) => {
      try {
        const r = await pool.query(
          `SELECT t.id, t.event_id,
                  t.competitor_a_id, t.competitor_b_id,
                  t.dive_a_id, t.dive_b_id,
                  t.score_a, t.score_b,
                  t.winner_id, t.notes,
                  t.created_at, t.resolved_at,
                  ua.full_name AS competitor_a_name,
                  ub.full_name AS competitor_b_name,
                  uw.full_name AS winner_name,
                  da.dive_code AS dive_a_code,
                  da.position  AS dive_a_position,
                  da.dd        AS dive_a_dd,
                  db.dive_code AS dive_b_code,
                  db.position  AS dive_b_position,
                  db.dd        AS dive_b_dd
             FROM tiebreak_dive_offs t
             LEFT JOIN users ua ON ua.id = t.competitor_a_id
             LEFT JOIN users ub ON ub.id = t.competitor_b_id
             LEFT JOIN users uw ON uw.id = t.winner_id
             LEFT JOIN dive_directory da ON da.id = t.dive_a_id
             LEFT JOIN dive_directory db ON db.id = t.dive_b_id
            WHERE t.event_id = $1
            ORDER BY t.created_at ASC`,
          [req.params.id],
        );
        res.json({ dive_offs: r.rows });
      } catch (err) {
        console.error("[Dive-offs List Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // POST /api/events/:id/dive-offs: referee creates a tie-break
  // record. Both divers must be on the event roster and (per
  // spec) tied at the end of the parent stage's standings. But
  // since the standings query is fluid (a corrective re-score
  // could break the tie after the dive-off was set up), we accept
  // a `confirm_tied:true` flag in the body to say "I, the
  // operator, attest these two are tied / need a dive-off".
  //
  // Body:
  //   competitor_a_id, competitor_b_id  (required)
  //   dive_a_id, dive_b_id              (optional)
  //   score_a, score_b                  (optional)
  //   winner_id                         (optional)
  //   notes                             (optional)
  //   confirm_tied                      (optional; required iff
  //                                      both totals differ at
  //                                      query time)
  //
  // Auth: event manager (event_managers row OR org_admin), and the
  // host-org score rule too when the body carries scores or a winner.
  router.post(
    "/api/events/:id/dive-offs",
    requireEventManager(),
    async (req, res) => {
      const eventId = req.params.id;
      const {
        competitor_a_id, competitor_b_id,
        dive_a_id, dive_b_id,
        score_a, score_b,
        winner_id, notes,
        confirm_tied, // operator override when totals don't match
      } = req.body || {};
      if (!competitor_a_id || !competitor_b_id) {
        return res.status(400).json({ error: "competitor_a_id + competitor_b_id required" });
      }
      if (competitor_a_id === competitor_b_id) {
        return res.status(400).json({ error: "competitor_a_id and competitor_b_id must differ" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const evRes = await client.query(
          "SELECT id, event_format FROM events WHERE id = $1",
          [eventId],
        );
        if (!evRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        const fmt = evRes.rows[0].event_format;
        if (!["super_final_h2h", "super_final_semi"].includes(fmt)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Dive-offs are only valid for super_final_h2h or super_final_semi events (Appendix 3 §6 — no dive-off after the Final)",
          });
        }
        if (touchesResult(req.body) && await refuseResultWrite(client, res, eventId, req.user)) return;

        // Verify both competitors are on the event roster, AND
        // (for H2H) in the same pair / (for SF) the same group.
        // Cross-group dive-offs aren't permitted: a dive-off is
        // a tie-break within the same pool that's competing for
        // a single advancement slot.
        const rosterRes = await client.query(
          `SELECT competitor_id, group_number, MIN(display_order) AS display_order
             FROM competitor_dive_lists
            WHERE event_id = $1
              AND competitor_id = ANY($2::uuid[])
            GROUP BY competitor_id, group_number`,
          [eventId, [competitor_a_id, competitor_b_id]],
        );
        if (rosterRes.rows.length !== 2) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Both competitors must be on the event roster",
          });
        }
        const rowA = rosterRes.rows.find((r) => r.competitor_id === competitor_a_id);
        const rowB = rosterRes.rows.find((r) => r.competitor_id === competitor_b_id);
        if (rowA.group_number !== rowB.group_number) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Dive-off competitors must be in the same group (cross-group dive-offs aren't valid)",
          });
        }
        if (fmt === "super_final_h2h") {
          // Same pair check: pair index in our seed scheme is
          // floor((display_order - groupBase) / 2). G1 base=1,
          // G2 base=7.
          const groupBase = rowA.group_number === 1 ? 1 : 7;
          const pairA = Math.floor((rowA.display_order - groupBase) / 2);
          const pairB = Math.floor((rowB.display_order - groupBase) / 2);
          if (pairA !== pairB) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              error: "H2H dive-off competitors must be from the same pair",
            });
          }
        }

        // Tied check unless confirm_tied=true.
        if (!confirm_tied) {
          // Sanity check: compute current totals.
          const tot = await client.query(
            `WITH ${perDivePointsCte({
               // Grouping stays per-(competitor, round), one UDF
               // call per dive, though only competitor_id gets
               // projected.
               select:  ["s.competitor_id"],
               groupBy: ["s.competitor_id", "s.round_number"],
               where:   "s.event_id = $1 AND s.competitor_id = ANY($2::uuid[])",
             })}
             SELECT competitor_id, COALESCE(SUM(dive_points), 0) AS total
               FROM per_dive
              GROUP BY competitor_id`,
            [eventId, [competitor_a_id, competitor_b_id]],
          );
          const tA = Number(tot.rows.find((r) => r.competitor_id === competitor_a_id)?.total || 0);
          const tB = Number(tot.rows.find((r) => r.competitor_id === competitor_b_id)?.total || 0);
          if (tA !== tB) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              error: "Competitors aren't tied at this stage (totals differ); pass confirm_tied:true to override",
            });
          }
        }

        if (winner_id != null
            && winner_id !== competitor_a_id
            && winner_id !== competitor_b_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "winner_id must be one of the two competitors",
          });
        }

        // Both chosen dives (optional at create) have to be ones the
        // diver already performed here, see validateDiveOffChoice.
        const errA = await validateDiveOffChoice(client, eventId, competitor_a_id, dive_a_id, "a");
        if (errA) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: errA });
        }
        const errB = await validateDiveOffChoice(client, eventId, competitor_b_id, dive_b_id, "b");
        if (errB) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: errB });
        }

        const ins = await client.query(
          `INSERT INTO tiebreak_dive_offs
              (event_id, competitor_a_id, competitor_b_id,
               dive_a_id, dive_b_id, score_a, score_b,
               winner_id, notes, resolved_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
          [
            eventId,
            competitor_a_id,
            competitor_b_id,
            dive_a_id || null,
            dive_b_id || null,
            score_a == null ? null : Number(score_a),
            score_b == null ? null : Number(score_b),
            winner_id || null,
            notes || null,
            winner_id ? new Date() : null,
          ],
        );
        const row = ins.rows[0];

        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   eventId,
          entity_name: null,
          action:      winner_id ? "event.dive_off_resolved" : "event.dive_off_created",
          metadata: {
            dive_off_id:     row.id,
            competitor_a_id, competitor_b_id,
            dive_a_id:       row.dive_a_id,
            dive_b_id:       row.dive_b_id,
            score_a:         row.score_a,
            score_b:         row.score_b,
            winner_id:       row.winner_id,
            notes:           row.notes,
          },
        });

        await client.query("COMMIT");
        res.status(201).json({ dive_off: row });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Dive-off Create Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // PATCH /api/events/:id/dive-offs/:diveOffId: update or resolve.
  // Setting winner_id (non-null) auto-stamps resolved_at if it's
  // not already provided. Audits 'event.dive_off_resolved'. Changing
  // a score or the winner needs the host-org score rule as well.
  router.patch(
    "/api/events/:id/dive-offs/:diveOffId",
    requireEventManager(),
    async (req, res) => {
      const { id: eventId, diveOffId } = req.params;
      const allowed = ["dive_a_id", "dive_b_id", "score_a", "score_b", "winner_id", "notes", "resolved_at"];
      const updates = {};
      for (const k of allowed) {
        if (k in (req.body || {})) updates[k] = req.body[k];
      }
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: "No updatable fields in body" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const exRes = await client.query(
          "SELECT * FROM tiebreak_dive_offs WHERE id = $1 AND event_id = $2",
          [diveOffId, eventId],
        );
        if (!exRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Dive-off not found" });
        }
        const existing = exRes.rows[0];
        if (touchesResult(updates, existing) && await refuseResultWrite(client, res, eventId, req.user)) return;

        if (updates.winner_id != null
            && updates.winner_id !== existing.competitor_a_id
            && updates.winner_id !== existing.competitor_b_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "winner_id must be one of the two competitors",
          });
        }

        // dive_a_id / dive_b_id, when set via PATCH, go through the
        // same Appendix 3 §6 check as at create.
        if ("dive_a_id" in updates) {
          const errA = await validateDiveOffChoice(client, eventId, existing.competitor_a_id, updates.dive_a_id, "a");
          if (errA) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: errA });
          }
        }
        if ("dive_b_id" in updates) {
          const errB = await validateDiveOffChoice(client, eventId, existing.competitor_b_id, updates.dive_b_id, "b");
          if (errB) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: errB });
          }
        }

        // Auto-stamp resolved_at when winner_id is being set and
        // the caller didn't pass an explicit resolved_at.
        if (updates.winner_id && !("resolved_at" in updates)) {
          updates.resolved_at = new Date().toISOString();
        }

        const setSql = Object.keys(updates)
          .map((k, i) => `${k} = $${i + 3}`)
          .join(", ");
        const params = [diveOffId, eventId, ...Object.values(updates)];
        const upd = await client.query(
          `UPDATE tiebreak_dive_offs SET ${setSql}
             WHERE id = $1 AND event_id = $2
             RETURNING *`,
          params,
        );

        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   eventId,
          entity_name: null,
          action:      updates.winner_id ? "event.dive_off_resolved" : "event.dive_off_updated",
          metadata: {
            dive_off_id: diveOffId,
            updates,
          },
        });

        await client.query("COMMIT");
        res.json({ dive_off: upd.rows[0] });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Dive-off Update Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  return router;
};
