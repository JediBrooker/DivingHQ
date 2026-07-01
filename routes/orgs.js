// Organisation + clubs routes.
//
//   GET    /api/orgs                    every org (sysadmin only)
//   GET    /api/orgs/active             public list for register-form
//   PUT    /api/orgs/:id/status         sysadmin approves / suspends
//   GET    /api/orgs/:id/divers         per-org diver list (in-org auth)
//   GET    /api/orgs/:id/clubs          public club list for register form
//   GET    /api/clubs                   admin clubs grid (member counts)
//   PUT    /api/clubs/:id               rename / re-code
//   DELETE /api/clubs/:id               cascade members to NULL
//   POST   /api/orgs/:id/clubs          create a club in an org
//
// Mounted via:
//   app.use(require('./routes/orgs')({ … }))

const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");

module.exports = function createOrgsRouter({
  pool,
  verifyToken,
  requireSystemAdmin,
  requireMeetEditor,
}) {
  if (!pool) throw new Error("createOrgsRouter requires { pool, … }");
  const router = express.Router();

  // -------- Orgs --------
  router.get("/api/orgs", requireSystemAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT * FROM organisations ORDER BY created_at DESC",
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Orgs List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // List active orgs — used by register form to populate the org picker.
  router.get("/api/orgs/active", async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT id, name, country_code, slug FROM organisations WHERE status = 'active' ORDER BY name ASC",
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Orgs Active Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/orgs/:id/status", requireSystemAdmin, async (req, res) => {
    const { status } = req.body || {};
    try {
      // Read the previous status so the audit row has a
      // before/after pair — sysadmins reviewing the audit later
      // want "approved a pending org" / "suspended a live org"
      // distinguishable at a glance.
      const prior = await pool.query(
        "SELECT status FROM organisations WHERE id = $1",
        [req.params.id],
      );
      const previousStatus = prior.rows[0]?.status;

      const r = await pool.query(
        "UPDATE organisations SET status = $1 WHERE id = $2 RETURNING *",
        [status, req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Org not found" });

      if (previousStatus !== status) {
        await recordAudit(pool, {
          ...auditFromReq(req),
          // org_id is the org being modified — the actor is a
          // sysadmin who has no own org binding for this action.
          org_id:      r.rows[0].id,
          entity_type: "org",
          entity_id:   r.rows[0].id,
          entity_name: r.rows[0].name,
          action:      "org.status_changed",
          metadata: { from: previousStatus, to: status },
        });
      }

      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Org Status Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------- Per-org diver listing --------
  // Authenticated, in-org only (sysadmin sees any). Used by the
  // CompetitorView synchro partner picker.
  router.get("/api/orgs/:id/divers", verifyToken, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot list divers in other organisations" });
    }
    try {
      // Drop u.username from the projection — the synchro-partner
      // picker (the sole legitimate consumer) uses id + full_name.
      // Username is the credential identifier, so leaking it via a
      // verifyToken-only endpoint would let any signed-in user
      // (including a freshly-registered spectator) enumerate the
      // org's username space and feed a credential-stuffing run
      // against /api/auth/login.
      const r = await pool.query(
        `SELECT u.id, u.full_name, cl.name AS club_name, cl.short_code AS club_code
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.org_id = $1
           AND u.deleted_at IS NULL
         ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Org Divers Error]", err.message);
      res.status(500).json([]);
    }
  });

  // All members of the org (id + name only), for pickers that aren't
  // diver-specific — e.g. the fines desk, which can fine any member. Same
  // credential-safe projection as /divers (no username).
  router.get("/api/orgs/:id/members", verifyToken, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res.status(403).json({ error: "Cannot list members in other organisations" });
    }
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name
           FROM users u
          WHERE u.org_id = $1 AND u.deleted_at IS NULL
          ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Org Members Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------- Clubs --------
  // Clubs in an organisation. Public — used by the registration
  // form's club picker before the user has an account.
  router.get("/api/orgs/:id/clubs", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, short_code
         FROM clubs WHERE org_id = $1
         ORDER BY name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Org Clubs Error]", err.message);
      res.status(500).json([]);
    }
  });

  // Listing for the dedicated Clubs management screen. System
  // admins see every club across all orgs; org_admin / meet_manager
  // see only their own org's. Each row carries a live member count
  // so admins can spot empty clubs.
  router.get("/api/clubs", requireMeetEditor, async (req, res) => {
    try {
      const isSysAdmin = !!req.user.is_system_admin;
      const r = await pool.query(
        `SELECT cl.id, cl.name, cl.short_code, cl.created_at,
                cl.org_id, o.name AS org_name, o.country_code,
                COALESCE(stat.member_count, 0)::int AS member_count,
                EXISTS (
                  SELECT 1 FROM club_affiliations ca
                   WHERE ca.club_id = cl.id AND ca.kind = 'affiliation'
                     AND ca.status = 'active' AND ca.period_end > CURRENT_DATE
                ) AS affiliation_active,
                EXISTS (
                  SELECT 1 FROM club_affiliations ca
                   WHERE ca.club_id = cl.id AND ca.kind = 'accreditation'
                     AND ca.status = 'active' AND ca.period_end > CURRENT_DATE
                ) AS accreditation_active
         FROM clubs cl
         JOIN organisations o ON o.id = cl.org_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS member_count
           FROM users WHERE club_id = cl.id
         ) stat ON true
         WHERE ($2::boolean OR cl.org_id = $1)
         ORDER BY o.name ASC, cl.name ASC`,
        [req.user.org_id, isSysAdmin],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Clubs List Error]", err.message);
      res.status(500).json([]);
    }
  });

  // Rename / re-code a club. Same scope rules as create.
  router.put("/api/clubs/:id", requireMeetEditor, async (req, res) => {
    const { name, short_code } = req.body || {};
    if (!name || !name.trim())
      return res.status(400).json({ error: "Club name is required" });
    try {
      const target = await pool.query(
        "SELECT org_id FROM clubs WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Club not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot edit clubs in other organisations" });
      }
      const r = await pool.query(
        `UPDATE clubs SET name = $1, short_code = $2
         WHERE id = $3
         RETURNING id, name, short_code`,
        [name.trim(), short_code?.trim() || null, req.params.id],
      );
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Update Club Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete a club. users.club_id is ON DELETE SET NULL, so members
  // keep their accounts but become "no club" until reassigned. We
  // surface the affected member count in the response so the UI
  // can confirm what just happened.
  router.delete("/api/clubs/:id", requireMeetEditor, async (req, res) => {
    try {
      // Pull org_id + name in one read so the audit row has both
      // (post-delete the row is gone).
      const target = await pool.query(
        "SELECT id, org_id, name, short_code FROM clubs WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Club not found" });
      const club = target.rows[0];
      if (
        !req.user.is_system_admin &&
        club.org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot delete clubs in other organisations" });
      }
      const memberCount = await pool.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE club_id = $1",
        [req.params.id],
      );
      await pool.query("DELETE FROM clubs WHERE id = $1", [req.params.id]);
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id:      club.org_id,
        entity_type: "club",
        entity_id:   club.id,
        entity_name: club.name,
        action:      "club.deleted",
        metadata: {
          short_code:         club.short_code,
          unassigned_members: memberCount.rows[0].n,
        },
      });
      res.json({
        message: "Club deleted",
        unassigned_members: memberCount.rows[0].n,
      });
    } catch (err) {
      console.error("[Delete Club Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create a club in an organisation. Authenticated org_admin or
  // meet_manager (or system_admin) only — keeps spam off the table.
  // During registration, /api/auth/register has its own path that
  // can create a club for the new user without prior auth.
  router.post("/api/orgs/:id/clubs", requireMeetEditor, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot create clubs in other organisations" });
    }
    const { name, short_code } = req.body || {};
    if (!name || !name.trim())
      return res.status(400).json({ error: "Club name is required" });
    try {
      const r = await pool.query(
        `INSERT INTO clubs (org_id, name, short_code)
         VALUES ($1, $2, $3)
         RETURNING id, name, short_code`,
        [req.params.id, name.trim(), short_code?.trim() || null],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Create Club Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
