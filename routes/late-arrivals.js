// Late-arrival review queue for meet managers and referees.
//
// Companion to lib/deadline-gate.js (DEC-04). When a competitor
// or coach submits a dive list AFTER the entry deadline but
// CLAIMS (via actor_local_time) they submitted BEFORE, the gate
// accepts the write and stamps `late_arrival_flag = true` +
// `late_arrival_decision = 'pending'` on the row. This router
// exposes those rows to the operator's review tray and accepts
// approve/deny decisions.
//
//   GET  /api/late-arrivals?event_id=…   list flagged rows
//   POST /api/late-arrivals/:id/decide   approve or deny
//
// Auth: org_admin, meet_manager, or referee. Sysadmin gets in
// via requireOrgRole.
//
// Mounted in server.js between templates and competitor (same
// region as routes/conflicts.js).

const express = require("express");
const { recordAudit } = require("../lib/audit");

module.exports = function createLateArrivalsRouter({ pool, requireOrgRole }) {
  if (!pool) throw new Error("createLateArrivalsRouter requires { pool, requireOrgRole }");
  const router = express.Router();

  const requireReviewer = requireOrgRole([
    "referee", "meet_manager", "org_admin",
  ]);

  // GET /api/late-arrivals
  //
  // Optional event_id query param scopes the list to one event.
  // Leave it off and you get every pending late-arrival row in
  // the caller's org. Sysadmin sees across orgs.
  router.get("/api/late-arrivals", requireReviewer, async (req, res) => {
    try {
      const eventId = req.query.event_id || null;
      const isSysAdmin = !!req.user.is_system_admin;
      const orgId = isSysAdmin ? null : req.user.org_id;

      // Joins competitor + event so the tray can render names and
      // deadline context without a second round trip.
      const r = await pool.query(
        `SELECT cdl.id,
                cdl.event_id,
                cdl.competitor_id,
                cdl.partner_id,
                cdl.round_number,
                cdl.dive_id,
                cdl.actor_local_time,
                cdl.created_at,
                cdl.late_arrival_decision,
                u.full_name        AS competitor_name,
                e.name             AS event_name,
                e.entries_close_at,
                e.org_id           AS event_org_id,
                d.dive_code, d.position, d.dd
           FROM competitor_dive_lists cdl
           JOIN events e ON e.id = cdl.event_id
           JOIN users  u ON u.id = cdl.competitor_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
          WHERE cdl.late_arrival_flag = true
            AND cdl.late_arrival_decision = 'pending'
            AND ($1::uuid IS NULL OR cdl.event_id = $1)
            AND ($2::uuid IS NULL OR e.org_id     = $2)
          ORDER BY cdl.created_at DESC
          LIMIT 200`,
        [eventId, orgId],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Late-arrivals list]", err.message);
      res.status(500).json({ error: "Failed to load late-arrival queue" });
    }
  });

  // POST /api/late-arrivals/:id/decide
  // body: { decision: 'allowed' | 'denied', note?: string }
  //
  // 'allowed' keeps the row; the diver competes as if the
  // submission landed on time. 'denied' rolls the row back,
  // basically a soft-withdraw via withdrawn_at = NOW(). The row
  // stays put for forensic visibility (audit log captures who
  // decided what and when).
  router.post(
    "/api/late-arrivals/:id/decide",
    requireReviewer,
    async (req, res) => {
      const { id } = req.params;
      const decision = req.body?.decision;
      const note = typeof req.body?.note === "string"
        ? req.body.note.trim().slice(0, 500)
        : null;

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: "id must be a UUID" });
      }
      if (!["allowed", "denied"].includes(decision)) {
        return res.status(400).json({
          error: "decision must be 'allowed' or 'denied'",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Look up the row and scope-check it belongs to the caller's org.
        const r = await client.query(
          `SELECT cdl.id, cdl.event_id, cdl.competitor_id, cdl.round_number,
                  cdl.late_arrival_flag, cdl.late_arrival_decision,
                  e.org_id AS event_org_id, e.name AS event_name,
                  u.full_name AS competitor_name
             FROM competitor_dive_lists cdl
             JOIN events e ON e.id = cdl.event_id
             JOIN users  u ON u.id = cdl.competitor_id
            WHERE cdl.id = $1
            FOR UPDATE`,
          [id],
        );
        if (!r.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Late-arrival row not found" });
        }
        const row = r.rows[0];
        if (!row.late_arrival_flag) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Row is not flagged for late-arrival review" });
        }
        if (row.late_arrival_decision && row.late_arrival_decision !== "pending") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Row already ${row.late_arrival_decision}`,
            decision: row.late_arrival_decision,
          });
        }
        if (!req.user.is_system_admin && row.event_org_id !== req.user.org_id) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Not your org's event" });
        }

        // Stamp the decision. For 'denied' we also soft-withdraw
        // so the diver doesn't compete on that round, the row
        // stays for audit but withdrawn_at carries the operational
        // truth.
        await client.query(
          `UPDATE competitor_dive_lists
             SET late_arrival_decision    = $2,
                 late_arrival_decided_by  = $3,
                 late_arrival_decided_at  = NOW(),
                 withdrawn_at = CASE WHEN $2 = 'denied' THEN NOW() ELSE withdrawn_at END
           WHERE id = $1`,
          [id, decision, req.user.id],
        );

        await recordAudit(client, {
          org_id: row.event_org_id,
          actor_id: req.user.id,
          action: `late_arrival.${decision}`,
          entity_type: "competitor_dive_list",
          entity_id: id,
          metadata: {
            event_id: row.event_id,
            event_name: row.event_name,
            competitor_id: row.competitor_id,
            competitor_name: row.competitor_name,
            round_number: row.round_number,
            note,
          },
        });

        await client.query("COMMIT");
        res.json({
          ok: true,
          decision,
          row_id: id,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[Late-arrival decide]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  return router;
};
