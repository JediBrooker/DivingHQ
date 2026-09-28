// Organisation + clubs routes.
//
//   GET    /api/orgs                    every org (sysadmin only)
//   GET    /api/orgs/active             public list for register-form
//   GET    /api/orgs/by-country/:code   public, the org(s) a signup in that country joins
//   GET    /api/orgs/needs-country      sysadmin, live orgs signups can't find by country
//   PUT    /api/orgs/:id/country        sysadmin sets an org's country
//   PUT    /api/orgs/:id/status         sysadmin approves / suspends
//                                       (emails + notifies the org's
//                                       own admin(s) of the decision)
//   GET    /api/orgs/:id/divers         per-org diver list (in-org auth)
//   GET    /api/orgs/:id/clubs          public club list for register form
//                                       (approved clubs only)
//   GET    /api/clubs                   admin clubs grid (member counts),
//                                       plus clubs waiting for approval
//                                       for the org admin / sysadmin
//   PUT    /api/clubs/:id               rename / re-code
//   DELETE /api/clubs/:id               cascade members to NULL
//   POST   /api/orgs/:id/clubs          create a club in an org
//   POST   /api/clubs/:id/approve       federation approves a new club
//   POST   /api/clubs/:id/reject        ...or turns it down (deletes it)
//   GET    /api/orgs/:id/club-settings  whether new clubs join automatically
//   PUT    /api/orgs/:id/club-settings  org admin / sysadmin changes that
//   GET    /api/clubs/:id/admins        club admins + the club's members
//   POST   /api/clubs/:id/admins        make a same-org user a club admin
//   DELETE /api/clubs/:id/admins/:userId  take it away again
//
// Mounted via:
//   app.use(require('./routes/orgs')({ … }))

const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");
const { ADMIN_ORG_ID } = require("../lib/admin-org");
const { countryByCode, countryFromStored } = require("../lib/countries");
const { removeAdmin, isOrgAdminOf } = require("../lib/admin-rows");
const clubApprovals = require("../lib/club-approvals");
const notices = require("../lib/notices");

module.exports = function createOrgsRouter({
  pool,
  push,
  email,               // lib/email, for club approval notices (sendNoticeEmail)
  verifyToken,
  requireSystemAdmin,
  requireMeetEditor,
  requireOrgAdmin,
  isInSameOrg,
  sendOrgDecisionEmail,
}) {
  if (!pool) throw new Error("createOrgsRouter requires { pool, … }");
  // Club decisions re-check the org match in lib/club-approvals, so a
  // router built without the org-admin gate still refuses the wrong people.
  const orgAdminGate = requireOrgAdmin || verifyToken;
  const router = express.Router();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // List active orgs, used by register form to populate the org picker
  // and by the /records page's country picker: continent so the
  // Continental tab can open on the right book, claim_state so a club
  // admin in a country nobody has claimed lands on their club's book.
  // The sysadmin's own Administration org is active too, so skip it or
  // strangers can sign up straight into it.
  router.get("/api/orgs/active", async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT id, name, country_code, slug, continent, claim_state FROM organisations WHERE status = 'active' AND id <> $1 ORDER BY name ASC",
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
  //
  // Same lookup resolveCountryOrg in routes/auth.js does, alpha-2 included,
  // so the form shows the org the server is actually going to pick.
  //
  // auto_approve_clubs tells the form whether a new club there waits for
  // the federation or joins straight away, so it can say which.
  router.get("/api/orgs/by-country/:code", async (req, res) => {
    const country = countryByCode(String(req.params.code || ""));
    if (!country) return res.json([]);
    try {
      const r = await pool.query(
        `SELECT id, name, country_code, claim_state, auto_approve_clubs
           FROM organisations
          WHERE country_code IN ($1, $2) AND status = 'active' AND id <> $3
          ORDER BY claim_state = 'unclaimed', name ASC`,
        [country.a3, country.a2, ADMIN_ORG_ID],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Orgs By Country Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Live orgs a signup can't reach by country: no country_code at all, or
  // one that isn't in lib/countries.json (a leftover 2-letter code, an IOC
  // code like GER, a typo). The sysadmin's User Manager lists them so they
  // can be given a real one. Pending orgs aren't here, their approval card
  // asks for the country itself.
  router.get("/api/orgs/needs-country", requireSystemAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, country_code, status, claim_state, created_at
           FROM organisations
          WHERE id <> $1 AND status <> 'pending'
          ORDER BY lower(name)`,
        [ADMIN_ORG_ID],
      );
      // country_code is char(3), so a 2-letter code comes back padded.
      const rows = r.rows
        .map((o) => ({ ...o, country_code: o.country_code ? o.country_code.trim() : null }))
        .filter((o) => !countryByCode(o.country_code));
      res.json(rows);
    } catch (err) {
      console.error("[Orgs Needs Country Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Give an org its country. Catalogue codes only: the point is that
  // /api/orgs/by-country can find it afterwards.
  router.put("/api/orgs/:id/country", requireSystemAdmin, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Org not found" });
    if (req.params.id === ADMIN_ORG_ID) {
      return res.status(400).json({ error: "The Administration org doesn't belong to a country" });
    }
    const raw = req.body?.country_code;
    const country = countryByCode(typeof raw === "string" ? raw.trim() : "");
    if (!country) {
      return res.status(400).json({ error: "Pick a country from the list", code: "country_unknown" });
    }
    try {
      const prior = await pool.query(
        "SELECT name, country_code, claim_state FROM organisations WHERE id = $1",
        [req.params.id],
      );
      if (!prior.rows.length) return res.status(404).json({ error: "Org not found" });
      // An unclaimed org IS its country's account (named after it, regions
      // copied from its catalogue), so moving it would just corrupt it.
      if (prior.rows[0].claim_state === "unclaimed") {
        return res.status(409).json({
          error: "This account was started by a country's clubs, so its country can't change",
          code: "unclaimed_country_fixed",
        });
      }
      const r = await pool.query(
        "UPDATE organisations SET country_code = $2 WHERE id = $1 RETURNING *",
        [req.params.id, country.a3],
      );
      const from = prior.rows[0].country_code ? prior.rows[0].country_code.trim() : null;
      if (from !== country.a3) {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id:      r.rows[0].id,
          entity_type: "org",
          entity_id:   r.rows[0].id,
          entity_name: r.rows[0].name,
          action:      "org.country_changed",
          metadata:    { from, to: country.a3 },
        });
      }
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Org Country Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/orgs/:id/status", requireSystemAdmin, async (req, res) => {
    const { status } = req.body || {};
    // Anything else would reach postgres as a bad enum value and come
    // back as a 500.
    if (!["pending", "active", "suspended"].includes(status)) {
      return res.status(400).json({ error: "status must be pending, active or suspended" });
    }
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Org not found" });
    try {
      // Read the previous status so the audit row has a
      // before/after pair. Sysadmins reviewing the audit later
      // want "approved a pending org" / "suspended a live org"
      // distinguishable at a glance.
      const prior = await pool.query(
        "SELECT status, country_code FROM organisations WHERE id = $1",
        [req.params.id],
      );
      if (!prior.rows.length) return res.status(404).json({ error: "Org not found" });
      const previousStatus = prior.rows[0].status;

      // Approving a federation that registered the old way. Two things
      // would leave the country split or unreachable, so both stop here.
      if (status === "active" && previousStatus === "pending") {
        const code = prior.rows[0].country_code ? prior.rows[0].country_code.trim() : "";
        if (!code) {
          return res.status(400).json({
            error: "Set this organisation's country before approving it. Signups find their federation by country, so nobody could join it.",
            code: "country_required",
          });
        }
        // Stored code, so 'WS' counts as Samoa here too: a pending row the
        // backfill hasn't reached must not slip past the check below.
        const country = countryFromStored(code);
        const clubsAccount = await pool.query(
          `SELECT name FROM organisations
            WHERE country_code IN ($1, $2) AND claim_state = 'unclaimed'
              AND status = 'active' AND id <> $3
            LIMIT 1`,
          [country ? country.a3 : code, country ? country.a2 : null, req.params.id],
        );
        if (clubsAccount.rows.length) {
          const where = clubsAccount.rows[0].name;
          return res.status(409).json({
            error: `Clubs have already started ${where}'s account on DivingHQ. Approving this would give ${where} two, `
              + "so deny it and have the federation claim that account from Register organisation instead.",
            code: "country_has_unclaimed_org",
          });
        }
      }

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
          // In-app as well, fire and forget. Every org_admin row counts
          // here, live or not, same as it always has.
          const org = r.rows[0];
          pool.query(
            `SELECT DISTINCT u.id
               FROM user_org_roles ur
               JOIN users u ON u.id = ur.user_id
              WHERE ur.org_id = $1 AND ur.role = 'org_admin'`,
            [org.id],
          )
            .then((admins) => notices.deliver({ push }, [{
              userIds: admins.rows.map((row) => row.id),
              category: "org_decision",
              title: status === "active"
                ? `${org.name} has been approved`
                : `${org.name} has been suspended`,
              body: status === "active"
                ? "A system admin approved your federation. You can start setting up meets."
                : "A system admin suspended your federation's access.",
              data:       { org_id: org.id, org_name: org.name, status },
              action_url: "/dashboard",
              email:      false,
            }], { tag: "Org Decision Notification Skipped" }))
            .catch((err) => console.error("[Org Decision Notification Skipped]", err.message));
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
  // form's club picker before the user has an account, and by the
  // club pickers on the profile and competitor screens. Approved clubs
  // only: one waiting on its federation hasn't been vetted, so its name
  // doesn't go out to the public and nobody can pick it yet.
  router.get("/api/orgs/:id/clubs", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, short_code, region_id
         FROM clubs WHERE org_id = $1 AND status = 'active'
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
  //
  // Clubs waiting for approval (status 'pending', migration 096) come
  // back too, but only to whoever decides them: the org admin and the
  // sysadmin. Meet managers never see them. Only once the founder has
  // verified their email, and only those rows carry the founder's
  // details, which the approval panel shows.
  router.get("/api/clubs", requireMeetEditor, async (req, res) => {
    try {
      const isSysAdmin = !!req.user.is_system_admin;
      const decides = isSysAdmin || (req.user.org_roles || []).includes("org_admin");
      const r = await pool.query(
        `SELECT cl.id, cl.name, cl.short_code, cl.created_at, cl.region_id, cl.status,
                cl.org_id, o.name AS org_name, o.country_code,
                CASE WHEN cl.status = 'pending' THEN COALESCE(cl.submitted_at, cl.created_at) END AS submitted_at,
                CASE WHEN cl.status = 'pending' THEN f.id END AS founder_id,
                CASE WHEN cl.status = 'pending' THEN f.full_name END AS founder_name,
                CASE WHEN cl.status = 'pending' THEN f.username END AS founder_username,
                CASE WHEN cl.status = 'pending' THEN f.email END AS founder_email,
                CASE WHEN cl.status = 'pending' THEN f.email_verified_at IS NOT NULL END AS founder_email_verified,
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
         -- Live members only. Self-delete keeps club_id on the tombstone,
         -- and counting those made an empty club look occupied here while
         -- club setup (which already filtered) said 0.
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS member_count
           FROM users WHERE club_id = cl.id AND deleted_at IS NULL
         ) stat ON true
         LEFT JOIN users f ON f.id = cl.created_by
         WHERE ($2::boolean OR cl.org_id = $1)
           AND (cl.status = 'active' OR ($3::boolean AND ${clubApprovals.visiblePendingSql("cl")}))
         ORDER BY o.name ASC, cl.name ASC`,
        [req.user.org_id, isSysAdmin, decides],
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
        "SELECT org_id, status FROM clubs WHERE id = $1",
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
      // The approve dialog is where a waiting club's details get fixed.
      if (target.rows[0].status === "pending") return pendingConflict(res);
      const code = clubApprovals.normaliseClubCode(short_code);
      const club = await clubApprovals.withTx(pool, async (client) => {
        // Only a code that's actually changing is checked, so a club that
        // already shares one from before the rule can still be renamed.
        const current = (await client.query(
          "SELECT short_code FROM clubs WHERE id = $1 FOR UPDATE", [req.params.id],
        )).rows[0]?.short_code || null;
        if (code && code !== (current || "").toUpperCase()) {
          await clubApprovals.assertCodeFree(client, target.rows[0].org_id, code, req.params.id);
        }
        const r = await client.query(
          `UPDATE clubs SET name = $1, short_code = $2
           WHERE id = $3
           RETURNING id, name, short_code`,
          [name.trim(), code, req.params.id],
        );
        return r.rows[0];
      });
      res.json(club);
    } catch (err) {
      approvalError(res, err, "[Update Club Error]");
    }
  });

  // Delete a club. users.club_id is ON DELETE SET NULL, so members
  // keep their accounts but become "no club" until reassigned. We
  // surface the affected member count in the response so the UI
  // can confirm what just happened. Pending requests to join it are
  // closed and their divers told.
  router.delete("/api/clubs/:id", requireMeetEditor, async (req, res) => {
    try {
      // Pull org_id + name in one read so the audit row has both
      // (post-delete the row is gone).
      const target = await pool.query(
        "SELECT id, org_id, name, short_code, status FROM clubs WHERE id = $1",
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
      // Deleting a waiting club would be a rejection nobody hears about.
      // Reject says why, can move the founder, and tells them.
      if (club.status === "pending") return pendingConflict(res);
      const { memberCount, closed } = await clubApprovals.withTx(pool, async (client) => {
        const memberCount = await client.query(
          "SELECT COUNT(*)::int AS n FROM users WHERE club_id = $1 AND deleted_at IS NULL",
          [club.id],
        );
        // club_change_requests.to_club_id is ON DELETE SET NULL, so a
        // pending "join this club" request used to turn into "leave your
        // club", and approving it later took the diver out of the club
        // they were in. Close them first, in the same transaction.
        const closed = (await client.query(
          `UPDATE club_change_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = now()
            WHERE to_club_id = $1 AND status = 'pending'
            RETURNING user_id`,
          [club.id, req.user.id],
        )).rows;
        await client.query("DELETE FROM clubs WHERE id = $1", [club.id]);
        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      club.org_id,
          entity_type: "club",
          entity_id:   club.id,
          entity_name: club.name,
          action:      "club.deleted",
          metadata: {
            short_code:         club.short_code,
            unassigned_members: memberCount.rows[0].n,
            requests_closed:    closed.length,
          },
        });
        return { memberCount, closed };
      });
      // After the commit, so a failed notice can't undo the delete.
      if (closed.length) {
        await notices.insertInApp(pool, closed.map((r) => r.user_id), {
          category: "club_change",
          title: "Your club change was declined",
          body: `${club.name} was removed from DivingHQ, so your request to join it was closed.`,
          action_url: "/profile",
          data: { club_id: club.id },
        }).catch((err) => console.error("[Delete Club Notify]", err.message));
      }
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
    const client = await pool.connect();
    try {
      const code = clubApprovals.normaliseClubCode(short_code);
      await client.query("BEGIN");
      await clubApprovals.assertCodeFree(client, req.params.id, code);
      const r = await client.query(
        `INSERT INTO clubs (org_id, name, short_code)
         VALUES ($1, $2, $3)
         RETURNING id, name, short_code`,
        [req.params.id, name.trim(), code],
      );
      await client.query("COMMIT");
      res.status(201).json(r.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      approvalError(res, err, "[Create Club Error]");
    } finally {
      client.release();
    }
  });

  // -------- Club approval (migration 096, lib/club-approvals.js) --------

  function pendingConflict(res) {
    return res.status(409).json({ error: "Approve or reject this club first", code: "club_pending" });
  }

  function approvalError(res, err, label) {
    if (err instanceof clubApprovals.ClubApprovalError) {
      return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    console.error(label, err.message);
    return res.status(500).json({ error: "Internal server error" });
  }

  // Body: { name?, short_code?, region_id?, make_founder_admin = true }.
  // Leaving a field out keeps what the founder gave; null clears the code
  // or the region.
  router.post("/api/clubs/:id/approve", orgAdminGate, async (req, res) => {
    const b = req.body || {};
    try {
      const out = await clubApprovals.approve(pool, {
        clubId: req.params.id,
        user: req.user,
        name: b.name,
        shortCode: b.short_code,
        regionId: b.region_id,
        makeFounderAdmin: b.make_founder_admin !== false,
        audit: auditFromReq(req),
      }, { push, email });
      res.json(out);
    } catch (err) {
      approvalError(res, err, "[Club Approve Error]");
    }
  });

  // Body: { reason?, move_members_to? }. Deletes the club; the founder
  // keeps their account, in the club named here or in none.
  router.post("/api/clubs/:id/reject", orgAdminGate, async (req, res) => {
    const b = req.body || {};
    try {
      const out = await clubApprovals.reject(pool, {
        clubId: req.params.id,
        user: req.user,
        reason: b.reason,
        moveMembersTo: b.move_members_to,
        audit: auditFromReq(req),
      }, { push, email });
      res.json(out);
    } catch (err) {
      approvalError(res, err, "[Club Reject Error]");
    }
  });

  router.get("/api/orgs/:id/club-settings", orgAdminGate, async (req, res) => {
    try {
      const org = await clubApprovals.getSettings(pool, req.params.id);
      if (!org) return res.status(404).json({ error: "Organisation not found" });
      if (!isOrgAdminOf(req.user, org.id)) return res.status(403).json({ error: "Forbidden" });
      res.json({ auto_approve_clubs: org.auto_approve_clubs, claim_state: org.claim_state });
    } catch (err) {
      approvalError(res, err, "[Club Settings Error]");
    }
  });

  router.put("/api/orgs/:id/club-settings", orgAdminGate, async (req, res) => {
    try {
      const out = await clubApprovals.setAutoApprove(pool, {
        orgId: req.params.id,
        user: req.user,
        value: req.body?.auto_approve_clubs,
        audit: auditFromReq(req),
      });
      res.json(out);
    } catch (err) {
      approvalError(res, err, "[Club Settings Error]");
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
  // They can't remove the last live one, a club with no admin has nobody
  // to run it but the sysadmin.

  async function loadClubForAdminGrant(req, res) {
    // A malformed id would reach postgres as a uuid cast error and come
    // back as a 500, so treat it as the missing club it is.
    if (!UUID_RE.test(req.params.id)) {
      res.status(404).json({ error: "Club not found" });
      return null;
    }
    const c = await pool.query(
      `SELECT c.id, c.org_id, c.name, c.status, o.claim_state, c.requested_region_id, c.region_requested_at,
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
    // The club's own admins, or its region's admins one level up.
    if (!isOrgAdminOf(req.user, club.org_id)) {
      if (!(club.claim_state === "unclaimed" && (club.caller_is_admin || club.caller_is_region_admin))) {
        res.status(403).json({ error: "Only your federation's admin can manage club admins" });
        return null;
      }
      club.viaClubAdmin = true;
    }
    // A waiting club gets its first admin by being approved, never before.
    // Checked after the permission so it's no way to find out who's waiting.
    if (club.status === "pending") {
      pendingConflict(res);
      return null;
    }
    return club;
  }

  router.get("/api/clubs/:id/admins", verifyToken, async (req, res) => {
    try {
      const club = await loadClubForAdminGrant(req, res);
      if (!club) return;
      // live and keep_one_live let My club grey out Remove on the last
      // live admin, instead of letting them click it and eat the 409.
      const admins = await pool.query(
        `SELECT u.id, u.full_name, u.username, ca.created_at,
                (u.suspended_at IS NULL) AS live
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
      // A claimed region the club has asked to join and is waiting on
      // (routes/regions.js), so My club can say so and offer to withdraw.
      const regionRequest = club.requested_region_id
        ? { region_id: club.requested_region_id, requested_at: club.region_requested_at }
        : null;
      res.json({
        admins: admins.rows, members: members.rows, region_request: regionRequest,
        // Whoever's asking is held to the one-live-admin rule, same test
        // the DELETE below hands to removeAdmin.
        keep_one_live: !!club.viaClubAdmin,
      });
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
      // Club and region admins can't take the club down to no live admin
      // (lib/admin-rows.js has why the count and the lock matter).
      const out = await removeAdmin(pool, {
        scope: "club",
        scopeId: club.id,
        userId: req.params.userId,
        keepOneLive: !!club.viaClubAdmin,
      });
      if (out.status === 404) return res.status(404).json({ error: "Not a club admin" });
      if (out.status === 409) {
        return res.status(409).json({ error: "A club needs at least one admin. Add someone else first." });
      }
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
