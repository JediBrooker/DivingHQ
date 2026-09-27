// Organisation + clubs routes.
//
//   GET    /api/orgs                    every org (sysadmin only)
//   GET    /api/orgs/active             public list for register-form
//   GET    /api/orgs/by-country/:code   public, the org(s) a signup in that country joins
//   PUT    /api/orgs/:id/status         sysadmin approves / suspends
//                                       (emails + notifies the org's
//                                       own admin(s) of the decision)
//   GET    /api/orgs/:id/divers         per-org diver list (in-org auth)
//   GET    /api/orgs/:id/clubs          public club list for register form
//   GET    /api/clubs                   admin clubs grid (member counts)
//   PUT    /api/clubs/:id               rename / re-code
//   DELETE /api/clubs/:id               cascade members to NULL
//   POST   /api/orgs/:id/clubs          create a club in an org
//   GET    /api/clubs/:id/admins        club admins + the club's members
//   POST   /api/clubs/:id/admins        make a same-org user a club admin
//   DELETE /api/clubs/:id/admins/:userId  take it away again
//
// Mounted via:
//   app.use(require('./routes/orgs')({ … }))

const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");
const { ADMIN_ORG_ID } = require("../lib/admin-org");

module.exports = function createOrgsRouter({
  pool,
  push,
  verifyToken,
  requireSystemAdmin,
  requireMeetEditor,
  isInSameOrg,
  sendOrgDecisionEmail,
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

  // List active orgs, used by register form to populate the org picker.
  // The sysadmin's own Administration org is active too, so skip it or
  // strangers can sign up straight into it.
  router.get("/api/orgs/active", async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT id, name, country_code, slug FROM organisations WHERE status = 'active' AND id <> $1 ORDER BY name ASC",
        [ADMIN_ORG_ID],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Orgs Active Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // What a registrant in this country would join. Usually zero rows (they
  // start the country account) or one (the federation, or the unclaimed
  // account an earlier club started). More than one only happens where
  // several federations already share a country code, and then the form
  // asks them to pick.
  router.get("/api/orgs/by-country/:code", async (req, res) => {
    const code = String(req.params.code || "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return res.json([]);
    try {
      const r = await pool.query(
        `SELECT id, name, country_code, claim_state
           FROM organisations
          WHERE country_code = $1 AND status = 'active' AND id <> $2
          ORDER BY claim_state = 'unclaimed', name ASC`,
        [code, ADMIN_ORG_ID],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Orgs By Country Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/orgs/:id/status", requireSystemAdmin, async (req, res) => {
    const { status } = req.body || {};
    try {
      // Read the previous status so the audit row has a
      // before/after pair. Sysadmins reviewing the audit later
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
          // org_id is the org being modified, since the actor is
          // a sysadmin with no org binding of their own for this
          // action.
          org_id:      r.rows[0].id,
          entity_type: "org",
          entity_id:   r.rows[0].id,
          entity_name: r.rows[0].name,
          action:      "org.status_changed",
          metadata: { from: previousStatus, to: status },
        });

        // Tell the org's own admin(s) the outcome — mirrors how
        // role-request decisions already email the requester.
        // Only 'active'/'suspended' are decisions a founding admin
        // is waiting on; a status flip to anything else (there
        // isn't one today, but the enum could grow) has nothing
        // sensible to say here.
        if (status === "active" || status === "suspended") {
          if (typeof sendOrgDecisionEmail === "function") {
            sendOrgDecisionEmail(r.rows[0].id, status).catch(() => {});
          }
          if (push && typeof push.sendNotification === "function") {
            (async () => {
              try {
                const admins = await pool.query(
                  `SELECT DISTINCT u.id
                     FROM user_org_roles ur
                     JOIN users u ON u.id = ur.user_id
                    WHERE ur.org_id = $1 AND ur.role = 'org_admin'`,
                  [r.rows[0].id],
                );
                const adminIds = admins.rows.map((row) => row.id);
                if (adminIds.length) {
                  await push.sendNotification(adminIds, {
                    category: "org_decision",
                    title: status === "active"
                      ? `${r.rows[0].name} has been approved`
                      : `${r.rows[0].name} has been suspended`,
                    body: status === "active"
                      ? "A system admin approved your federation. You can start setting up meets."
                      : "A system admin suspended your federation's access.",
                    data:       { org_id: r.rows[0].id, org_name: r.rows[0].name, status },
                    action_url: "/dashboard",
                  });
                }
              } catch (notifErr) {
                console.error("[Org Decision Notification Skipped]", notifErr.message);
              }
            })();
          }
        }
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
      // Drop u.username from the projection. The synchro-partner
      // picker (the sole legitimate consumer) only needs id +
      // full_name. Gotcha: username is the credential identifier,
      // so leaking it via a
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
  // diver-specific, e.g. the fines desk, which can fine any member. Same
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
  // Clubs in an organisation. Public, used by the registration
  // form's club picker before the user has an account.
  router.get("/api/orgs/:id/clubs", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, short_code, region_id
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
  // see only thier own org's. Each row carries a live member count
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
  // meet_manager (or system_admin) only, keeps spam off the table.
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

  // -------- Club admins --------
  //
  // club_admins (migration 067) is what requireClubAdmin /
  // requireClubAdminOnly check for classes, club payouts and club-paid
  // fees, but until now nothing outside the tests ever wrote a row, so a
  // club had no way to get an admin. The federation's org_admin hands the
  // role out here. Meet managers can see the Clubs screen but don't get
  // this, it's a trust decision about who runs a club's money.
  //
  // In a country with no federation yet (claim_state 'unclaimed') there's
  // no org_admin to ask, so a club's own admins (or its region's admins)
  // manage who admins the club.
  // They can't remove the last one, a club with no admin has nobody to
  // run it but the sysadmin.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async function loadClubForAdminGrant(req, res) {
    // A malformed id would reach postgres as a uuid cast error and come
    // back as a 500, so treat it as the missing club it is.
    if (!UUID_RE.test(req.params.id)) {
      res.status(404).json({ error: "Club not found" });
      return null;
    }
    const c = await pool.query(
      `SELECT c.id, c.org_id, c.name, o.claim_state,
              EXISTS (SELECT 1 FROM club_admins ca
                       WHERE ca.club_id = c.id AND ca.user_id = $2) AS caller_is_admin,
              EXISTS (SELECT 1 FROM region_admins ra
                       WHERE ra.region_id = c.region_id AND ra.user_id = $2) AS caller_is_region_admin
         FROM clubs c JOIN organisations o ON o.id = c.org_id
        WHERE c.id = $1`,
      [req.params.id, req.user.id],
    );
    if (!c.rows.length) {
      res.status(404).json({ error: "Club not found" });
      return null;
    }
    const club = c.rows[0];
    if (req.user.is_system_admin) return club;
    const isOrgAdmin = (req.user.org_roles || []).includes("org_admin");
    if (isOrgAdmin && club.org_id === req.user.org_id) return club;
    // The club's own admins, or its region's admins one level up.
    if (club.claim_state === "unclaimed" && (club.caller_is_admin || club.caller_is_region_admin)) {
      club.viaClubAdmin = true;
      return club;
    }
    res.status(403).json({ error: "Only your federation's admin can manage club admins" });
    return null;
  }

  router.get("/api/clubs/:id/admins", verifyToken, async (req, res) => {
    try {
      const club = await loadClubForAdminGrant(req, res);
      if (!club) return;
      const admins = await pool.query(
        `SELECT u.id, u.full_name, u.username, ca.created_at
           FROM club_admins ca
           JOIN users u ON u.id = ca.user_id
          WHERE ca.club_id = $1 AND u.deleted_at IS NULL
          ORDER BY lower(u.full_name)`,
        [club.id],
      );
      // The members come along so the picker doesn't need its own
      // endpoint. Someone outside the club can still be granted via the
      // API, the UI just starts from the obvious people.
      const members = await pool.query(
        `SELECT id, full_name, username
           FROM users
          WHERE club_id = $1 AND deleted_at IS NULL
          ORDER BY lower(full_name)`,
        [club.id],
      );
      res.json({ admins: admins.rows, members: members.rows });
    } catch (err) {
      console.error("[Club Admins List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/clubs/:id/admins", verifyToken, async (req, res) => {
    const userId = req.body?.user_id;
    if (typeof userId !== "string" || !UUID_RE.test(userId))
      return res.status(400).json({ error: "user_id is required" });
    try {
      const club = await loadClubForAdminGrant(req, res);
      if (!club) return;
      // Cross-org grant would be an IDOR, same rule as judges/managers.
      if (!(await isInSameOrg(pool, club.org_id, userId, "users"))) {
        return res.status(400).json({ error: "That user isn't in this club's organisation" });
      }
      // A club admin promotes their own members, not strangers from
      // another club in the country.
      if (club.viaClubAdmin) {
        const m = await pool.query("SELECT 1 FROM users WHERE id = $1 AND club_id = $2", [userId, club.id]);
        if (!m.rows.length) return res.status(400).json({ error: "Only members of this club can be its admins" });
      }
      const ins = await pool.query(
        `INSERT INTO club_admins (club_id, user_id, org_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (club_id, user_id) DO NOTHING
         RETURNING id`,
        [club.id, userId, club.org_id],
      );
      if (ins.rows.length) {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id:      club.org_id,
          entity_type: "club",
          entity_id:   club.id,
          entity_name: club.name,
          action:      "club.admin_added",
          metadata:    { user_id: userId },
        });
      }
      res.status(ins.rows.length ? 201 : 200).json({ ok: true });
    } catch (err) {
      console.error("[Club Admin Grant Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/clubs/:id/admins/:userId", verifyToken, async (req, res) => {
    try {
      const club = await loadClubForAdminGrant(req, res);
      if (!club) return;
      if (!UUID_RE.test(req.params.userId))
        return res.status(404).json({ error: "Not a club admin" });
      if (club.viaClubAdmin) {
        const n = await pool.query("SELECT count(*)::int AS n FROM club_admins WHERE club_id = $1", [club.id]);
        if (n.rows[0].n <= 1) {
          return res.status(409).json({ error: "A club needs at least one admin. Add someone else first." });
        }
      }
      const del = await pool.query(
        "DELETE FROM club_admins WHERE club_id = $1 AND user_id = $2 RETURNING id",
        [club.id, req.params.userId],
      );
      if (!del.rows.length) return res.status(404).json({ error: "Not a club admin" });
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id:      club.org_id,
        entity_type: "club",
        entity_id:   club.id,
        entity_name: club.name,
        action:      "club.admin_removed",
        metadata:    { user_id: req.params.userId },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Club Admin Revoke Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
