// Event reserves routes: list + promote.
//
//   GET  /api/events/:id/reserves            list reserves + sidebars
//                                            (withdrawn primaries +
//                                            active primaries) for the
//                                            Control Room reserves
//                                            panel.
//   POST /api/events/:id/reserves/:competitorId/promote
//                                            flip is_reserve → false +
//                                            assign display_order. Body
//                                            may supply
//                                            `replaces_competitor_id` to
//                                            withdraw a primary and slot
//                                            the reserve via the WA
//                                            Article 4.1.8 / 4.1.10 /
//                                            4.1.12 reverse-rank shift.
//
// Mounted from routes/events/index.js via:
//   router.use(require('./reserves')({ pool, requireEventManager, push }))
//
// Outside-world deps:
//   • pool                : Postgres pool
//   • requireEventManager : auth gate (event_managers OR org_admin)
//   • push                : optional. When supplied, the just-promoted
//                           diver gets a "you've been promoted" push.
//                           Falls back to a silent skip otherwise.

const express = require("express");
const { recordAudit, auditFromReq } = require("../../lib/audit");

module.exports = function createReservesRoutes({ pool, requireEventManager, push }) {
  if (!pool || !requireEventManager) {
    throw new Error("createReservesRoutes requires { pool, requireEventManager }");
  }
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/events/:id/reserves: list reserves on an event with
  // their dive-list preview (round + dive_code/dd) so the Control
  // Room reserves panel can render rich rows + "promote" buttons.
  // Visible to event managers.
  // -------------------------------------------------------------
  router.get(
    "/api/events/:id/reserves",
    requireEventManager(),
    async (req, res) => {
      try {
        const r = await pool.query(
          `SELECT cdl.competitor_id,
                  cdl.reserve_position,
                  u.full_name,
                  cl.short_code AS club_code,
                  cl.name       AS club_name,
                  array_agg(json_build_object(
                    'round_number', cdl.round_number,
                    'dive_code',    d.dive_code,
                    'position',     d.position,
                    'dd',           d.dd,
                    'description',  d.description
                  ) ORDER BY cdl.round_number) AS dives
             FROM competitor_dive_lists cdl
             JOIN users u   ON u.id = cdl.competitor_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
             LEFT JOIN dive_directory d ON d.id = cdl.dive_id
            WHERE cdl.event_id = $1 AND cdl.is_reserve = TRUE
            GROUP BY cdl.competitor_id, cdl.reserve_position,
                     u.full_name, cl.short_code, cl.name
            ORDER BY cdl.reserve_position ASC NULLS LAST, u.full_name ASC`,
          [req.params.id],
        );

        // Also surface withdrawn primaries so the Control Room
        // can offer a "Replace [withdrawn diver] →" picker on
        // each reserve. Per WA Article 4.1.8 the reserve inherits
        // withdrawn divers start order.
        const w = await pool.query(
          `SELECT DISTINCT ON (cdl.competitor_id)
                  cdl.competitor_id,
                  u.full_name,
                  cl.short_code AS club_code,
                  cdl.withdrawn_at,
                  cdl.display_order
             FROM competitor_dive_lists cdl
             JOIN users u   ON u.id = cdl.competitor_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
            WHERE cdl.event_id = $1
              AND cdl.is_reserve = FALSE
              AND cdl.withdrawn_at IS NOT NULL
            ORDER BY cdl.competitor_id, cdl.round_number ASC`,
          [req.params.id],
        );

        // Active primaries: used by the Control Room to offer
        // "Replace …" against any active diver too (e.g. the
        // operator pre-emptively swaps before official Live
        // start, when the diver gives advance notice).
        const a = await pool.query(
          `SELECT DISTINCT ON (cdl.competitor_id)
                  cdl.competitor_id,
                  u.full_name,
                  cl.short_code AS club_code,
                  cdl.display_order
             FROM competitor_dive_lists cdl
             JOIN users u   ON u.id = cdl.competitor_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
            WHERE cdl.event_id = $1
              AND cdl.is_reserve = FALSE
              AND cdl.withdrawn_at IS NULL
            ORDER BY cdl.competitor_id, cdl.display_order ASC NULLS LAST`,
          [req.params.id],
        );

        res.json({
          reserves:  r.rows,
          withdrawn: w.rows,
          active:    a.rows,
        });
      } catch (err) {
        console.error("[Reserves List Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // Promote a reserve to active. Flips is_reserve=false on every
  // row for that competitor in the event, clears reserve_position,
  // assigns the next open display_order so they slot into the
  // back of the queue (for filling an empty slot in the
  // semi-final / final).
  //
  // Body (optional):
  //   replaces_competitor_id: when set, the operator is using
  //                            this reserve to replace a primary
  //                            who has withdrawn or is unable to
  //                            compete. Per WA Diving Articles
  //                            4.1.8 (semi) + 4.1.10 (subsequent
  //                            stages) + 4.1.12 (advancement),
  //                            BOTH semi-final and final use
  //                            reverse-rank start order. The
  //                            reserve has the WORST qualifying
  //                            rank in the new field, so they
  //                            take display_order=1 (dive
  //                            first). Every primary with
  //                            display_order strictly LESS than
  //                            the replaced diver's (i.e.,
  //                            qualified worse than the replaced
  //                            diver) shifts +1 to make room.
  //                            The replaced primary gets
  //                            withdrawn_at stamped + cleared
  //                            display_order. Highest-ranked
  //                            diver still dives last.
  router.post(
    "/api/events/:id/reserves/:competitorId/promote",
    requireEventManager(),
    async (req, res) => {
      const { id: eventId, competitorId } = req.params;
      const { replaces_competitor_id } = req.body || {};
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Verify the row exists + is currently a reserve.
        const r = await client.query(
          `SELECT 1 FROM competitor_dive_lists
             WHERE event_id = $1 AND competitor_id = $2 AND is_reserve = TRUE
             LIMIT 1`,
          [eventId, competitorId],
        );
        if (!r.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Reserve not found" });
        }
        // Replacement path, see block header comment for the
        // WA Article 4.1.8 / 4.1.10 / 4.1.12 derivation.
        let targetOrder = null;
        let replacedName = null;
        if (replaces_competitor_id) {
          const withdraw = await client.query(
            `SELECT MIN(display_order) AS dorder, MIN(u.full_name) AS name
               FROM competitor_dive_lists cdl
               JOIN users u ON u.id = cdl.competitor_id
              WHERE cdl.event_id = $1
                AND cdl.competitor_id = $2
                AND cdl.is_reserve = FALSE`,
            [eventId, replaces_competitor_id],
          );
          if (!withdraw.rows.length || withdraw.rows[0].dorder == null) {
            await client.query("ROLLBACK");
            return res.status(404).json({
              error: "Diver to replace not found in active roster",
            });
          }
          const replacedOrder = withdraw.rows[0].dorder;
          replacedName = withdraw.rows[0].name;
          // Withdraw the original diver: stamp withdrawn_at if
          // not already + clear display_order so they don't
          // appear in the active queue. Their dive_id rows stay
          // in place for the audit trail.
          await client.query(
            `UPDATE competitor_dive_lists
                SET withdrawn_at = COALESCE(withdrawn_at, NOW()),
                    display_order = NULL
              WHERE event_id = $1 AND competitor_id = $2`,
            [eventId, replaces_competitor_id],
          );
          // WA reverse-rank shift: reserve takes DO=1, every
          // primary qualified worse than the replaced diver
          // (display_order < replacedOrder under reverse-rank)
          // shifts +1 to make room.
          await client.query(
            `UPDATE competitor_dive_lists
                SET display_order = display_order + 1
              WHERE event_id = $1
                AND is_reserve = FALSE
                AND withdrawn_at IS NULL
                AND display_order IS NOT NULL
                AND display_order < $2`,
            [eventId, replacedOrder],
          );
          targetOrder = 1;
        } else {
          // No-replace path: slot at the back of the active
          // queue (kinda the fallback for filling an empty slot pre-Live).
          targetOrder = (await client.query(
            `SELECT COALESCE(MAX(display_order), 0) + 1 AS next
               FROM competitor_dive_lists
              WHERE event_id = $1 AND is_reserve = FALSE`,
            [eventId],
          )).rows[0].next;
        }

        await client.query(
          `UPDATE competitor_dive_lists
              SET is_reserve = FALSE,
                  reserve_position = NULL,
                  display_order = $3
            WHERE event_id = $1 AND competitor_id = $2`,
          [eventId, competitorId, targetOrder],
        );

        // Audit trail: replacements are evidentiary, the
        // operator may need to defend why a reserve dived
        // ahead of someone else later.
        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   eventId,
          entity_name: null,
          action:      replaces_competitor_id ? "reserve.replaced_diver" : "reserve.promoted",
          metadata: {
            reserve_competitor_id: competitorId,
            replaces_competitor_id: replaces_competitor_id || null,
            replaced_name: replacedName,
            display_order: targetOrder,
          },
        });

        await client.query("COMMIT");

        // Notify the just-promoted diver, heads up they were a
        // reserve a moment ago and now need to know they're
        // competing. Best-effort; if push isn't wired the row
        // just doesn't get sent.
        if (push && typeof push.sendNotification === "function") {
          try {
            const evRow = await pool.query(
              "SELECT name, dive_list_locks_at FROM events WHERE id = $1",
              [eventId],
            );
            const evName = evRow.rows[0]?.name || "the event";
            const lockAt = evRow.rows[0]?.dive_list_locks_at;
            const lockHint = lockAt
              ? ` Dive list locks at ${new Date(lockAt).toLocaleString()}.`
              : "";
            await push.sendNotification([competitorId], {
              category:  "reserve_promoted",
              title:     `You've been promoted into "${evName}"`,
              body:      replacedName
                ? `${replacedName} withdrew — you're now competing in their slot.${lockHint} Confirm or edit your dive list now.`
                : `You're now competing.${lockHint} Confirm or edit your dive list now.`,
              data:      {
                event_id: eventId,
                replaced_competitor_id: replaces_competitor_id || null,
                display_order: targetOrder,
                lock_at: lockAt ? new Date(lockAt).toISOString() : null,
              },
              action_url: `/competitor?event=${eventId}`,
            });
          } catch (notifErr) {
            console.error("[Promote Notification Skipped]", notifErr.message);
          }
        }

        res.json({
          promoted: true,
          display_order: targetOrder,
          replaced_competitor_id: replaces_competitor_id || null,
          replaced_name: replacedName,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Promote Reserve Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  return router;
};
