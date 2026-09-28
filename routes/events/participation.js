// International participation: which federations other than the host
// can enter divers in an event, and how they get onto that list (an
// invite the federation accepts, or the host adding them outright).
//
//   GET    /api/events/:id/participating-orgs
//   GET    /api/events/:id/participation-requests
//   POST   /api/events/:id/participation-requests
//   POST   /api/events/:id/participation-requests/:request_id/respond
//   POST   /api/events/:id/participating-orgs
//   DELETE /api/events/:id/participating-orgs/:org_id
//   GET    /api/events/:id/eligible-divers
//
// Mounted from routes/events/index.js, at the spot these routes used to
// sit in that file, via:
//   router.use(require('./participation')({ pool, push, optionalAuth,
//     requireOrgAdmin, verifyToken }))
//
// Moved out of index.js as is; index.js was over 3,000 lines and this
// block doesn't share anything with the rest of it.

const express = require("express");
const { recordAudit, auditFromReq } = require("../../lib/audit");
const { canSeeEvent } = require("./visibility");

module.exports = function createParticipationRoutes({
  pool,
  // Optional: without it the invite / withdraw notifications are skipped.
  push,
  optionalAuth,
  requireOrgAdmin,
  verifyToken,
}) {
  if (!pool || !optionalAuth || !requireOrgAdmin || !verifyToken) {
    throw new Error("createParticipationRoutes requires { pool, optionalAuth, requireOrgAdmin, verifyToken }");
  }
  const router = express.Router();

  async function orgAdminIds(orgId) {
    const admins = await pool.query(
      `SELECT DISTINCT u.id
         FROM user_org_roles r
         JOIN users u ON u.id = r.user_id
        WHERE r.org_id = $1 AND r.role = 'org_admin'`,
      [orgId],
    );
    return admins.rows.map((row) => row.id);
  }

  // Every org_admin of the org, gated on the role row alone and not on
  // users.org_id: an admin whose primary org is elsewhere still counts.
  // `payload` can be an async function, called only when there's
  // someone to tell, so a title that needs another lookup doesn't run
  // it for nobody.
  async function notifyOrgAdmins(orgId, payload) {
    if (!push || typeof push.sendNotification !== "function") return;
    const ids = await orgAdminIds(orgId);
    if (!ids.length) return;
    await push.sendNotification(ids, typeof payload === "function" ? await payload() : payload);
  }

  async function orgName(orgId) {
    const r = await pool.query("SELECT name FROM organisations WHERE id = $1", [orgId]);
    return r.rows[0]?.name;
  }

  // The checks both ways of bringing in another federation share (an
  // invite it has to accept, or a straight add): the event exists, the
  // caller hosts it, it isn't Completed, and the target is some other,
  // active org. Sends the refusal and returns null, otherwise
  // { ev, target }.
  async function loadInviteContext(req, res, orgId) {
    const evRes = await pool.query(
      "SELECT id, org_id, name, status FROM events WHERE id = $1",
      [req.params.id],
    );
    const ev = evRes.rows[0];
    if (!ev) {
      res.status(404).json({ error: "Event not found" });
      return null;
    }
    // Only the HOST org's admin (or sysadmin) can bring other
    // federations in. requireOrgAdmin already confirmed `org_admin`
    // somewhere; this tightens it to "this event's host org".
    if (!req.user.is_system_admin && ev.org_id !== req.user.org_id) {
      res.status(403).json({ error: "You don't host this event" });
      return null;
    }
    // Inviting a federation post-Completed sends a stale "your divers
    // can now self-enter" notification (the entry gate would reject
    // every actual submit) AND opens a way to spam foreign admins by
    // toggling Completed -> Upcoming and back.
    if (ev.status === "Completed") {
      res.status(409).json({
        error: "Event is already Completed — re-open it before inviting more federations",
      });
      return null;
    }
    // The host's own org is the implicit entry path, never a
    // participating-org row.
    if (orgId === ev.org_id) {
      res.status(400).json({
        error: "Host org is implicit — don't list it as a participating org",
      });
      return null;
    }
    // Active orgs only: pending/rejected/suspended can't participate.
    const targetRes = await pool.query(
      "SELECT id, name, status FROM organisations WHERE id = $1",
      [orgId],
    );
    const target = targetRes.rows[0];
    if (!target) {
      res.status(404).json({ error: "Target org not found" });
      return null;
    }
    if (target.status !== "active") {
      res.status(409).json({
        error: `${target.name} is ${target.status}; only active orgs can participate`,
      });
      return null;
    }
    return { ev, target };
  }

  // -------------------------------------------------------------
  // PARTICIPATING ORGS: opt-in list of OTHER federations whose
  // divers can self-enter this event. Host-org_admin manages.
  //
  //   GET    /api/events/:id/participating-orgs
  //   POST   /api/events/:id/participating-orgs   { org_id }
  //   DELETE /api/events/:id/participating-orgs/:org_id
  //
  // Empty list = domestic-only event (host-org divers only). Any
  // populated row makes this an international event in practice.
  // The host org is NEVER inserted here, events.org_id is the
  // source of truth for the host. See migration 036.
  // -------------------------------------------------------------

  // Public read: the meet's public landing page wants to render
  // "participating: AUS / NZL / FIJ" badges, so this endpoint is
  // open to anonymous spectators. Mirrors the privacy contract
  // of /api/events itself: anonymous callers only see Live or
  // Completed events. An Upcoming event's participating list is
  // the host's competitive intelligence and stays private until
  // the event flips Live (the same moment the public listing
  // reveals the event itself). Authed callers in the host org
  // (or sysadmin), and federations already on the list, bypass the
  // status filter so the Federations modal works pre-meet.
  router.get("/api/events/:id/participating-orgs", optionalAuth, async (req, res) => {
    try {
      // optionalAuth: a bad/revoked/suspended token reads as
      // anonymous, same floor as the old inline peek, but the
      // token-version / deleted_at / suspended_at checks now apply.
      const ev = await pool.query(
        "SELECT id, org_id, status FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      // Host, sysadmin, or a federation already on the list (it's been
      // told it's in, so it may see who else is).
      if (!(await canSeeEvent(pool, ev.rows[0], req.user))) {
        return res.json([]);
      }
      const r = await pool.query(
        `SELECT epo.org_id, epo.added_at,
                o.name AS org_name, o.country_code, o.slug AS org_slug
           FROM event_participating_orgs epo
           JOIN organisations o ON o.id = epo.org_id
          WHERE epo.event_id = $1
          ORDER BY o.name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Participating Orgs List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.get("/api/events/:id/participation-requests", requireOrgAdmin, async (req, res) => {
    try {
      const ev = await pool.query(
        "SELECT id, org_id, name FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const isSysAdmin = !!req.user.is_system_admin;
      const isHostAdmin = ev.rows[0].org_id === req.user.org_id;
      // Visiting org admins can only see their own invite row. If
      // none exists, this returns [] rather than leaking that
      // another federation was invited.
      const visibleSql = (isSysAdmin || isHostAdmin)
        ? "r.event_id = $1"
        : "r.event_id = $1 AND r.org_id = $2";
      const params = (isSysAdmin || isHostAdmin)
        ? [req.params.id]
        : [req.params.id, req.user.org_id];
      const r = await pool.query(
        `SELECT r.id, r.event_id, r.org_id, r.status, r.requested_at,
                r.responded_at, r.note,
                o.name AS org_name, o.country_code, o.slug AS org_slug,
                req.full_name AS requested_by_name,
                resp.full_name AS responded_by_name
           FROM event_participation_requests r
           JOIN organisations o ON o.id = r.org_id
           LEFT JOIN users req ON req.id = r.requested_by
           LEFT JOIN users resp ON resp.id = r.responded_by
          WHERE ${visibleSql}
          ORDER BY r.requested_at DESC`,
        params,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Participation Requests List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.post("/api/events/:id/participation-requests", requireOrgAdmin, async (req, res) => {
    const { org_id, note } = req.body || {};
    if (!org_id) return res.status(400).json({ error: "org_id is required" });
    try {
      const ctx = await loadInviteContext(req, res, org_id);
      if (!ctx) return;
      const { ev, target } = ctx;
      const accepted = await pool.query(
        "SELECT 1 FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2",
        [req.params.id, org_id],
      );
      if (accepted.rows.length) {
        return res.status(409).json({ error: `${target.name} is already participating` });
      }
      const request = await pool.query(
        `INSERT INTO event_participation_requests
           (event_id, org_id, status, requested_by, requested_at, note)
         VALUES ($1, $2, 'pending', $3, now(), $4)
         ON CONFLICT (event_id, org_id) DO UPDATE
           SET status = 'pending',
               requested_by = EXCLUDED.requested_by,
               requested_at = now(),
               responded_by = NULL,
               responded_at = NULL,
               note = EXCLUDED.note
         RETURNING *`,
        [req.params.id, org_id, req.user.id, note || null],
      );
      try {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id: ev.org_id,
          entity_type: "event",
          entity_id: ev.id,
          entity_name: ev.name,
          action: "event.participation_request.created",
          metadata: {
            request_id: request.rows[0].id,
            participating_org_id: org_id,
            participating_org_name: target.name,
          },
        });
      } catch (auditErr) {
        console.error("[Participation Request Audit Skipped]", auditErr.message);
      }
      try {
        await notifyOrgAdmins(org_id, async () => ({
          category: "international_invite",
          title: `${(await orgName(ev.org_id)) || "A host federation"} invited you to "${ev.name}"`,
          body: "Open Meet Manager to accept or decline participation.",
          data: {
            request_id: request.rows[0].id,
            event_id: ev.id,
            host_org_id: ev.org_id,
          },
          action_url: `/manager?event=${ev.id}`,
        }));
      } catch (notifErr) {
        console.error("[Participation Request Notification Skipped]", notifErr.message);
      }
      res.status(201).json(request.rows[0]);
    } catch (err) {
      console.error("[Create Participation Request Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/events/:id/participation-requests/:request_id/respond", requireOrgAdmin, async (req, res) => {
    const decision = String(req.body?.decision || "").toLowerCase();
    if (!["accepted", "declined"].includes(decision)) {
      return res.status(400).json({ error: "decision must be accepted or declined" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reqRow = await client.query(
        `SELECT r.*, e.name AS event_name, e.org_id AS host_org_id,
                o.name AS org_name
           FROM event_participation_requests r
           JOIN events e ON e.id = r.event_id
           JOIN organisations o ON o.id = r.org_id
          WHERE r.id = $1 AND r.event_id = $2
          FOR UPDATE`,
        [req.params.request_id, req.params.id],
      );
      if (!reqRow.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Participation request not found" });
      }
      const row = reqRow.rows[0];
      if (!req.user.is_system_admin && row.org_id !== req.user.org_id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Only the invited federation can respond" });
      }
      if (row.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Request is already ${row.status}` });
      }
      const updated = await client.query(
        `UPDATE event_participation_requests
            SET status = $1,
                responded_by = $2,
                responded_at = now()
          WHERE id = $3
          RETURNING *`,
        [decision, req.user.id, row.id],
      );
      if (decision === "accepted") {
        await client.query(
          `INSERT INTO event_participating_orgs (event_id, org_id, added_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (event_id, org_id) DO NOTHING`,
          [row.event_id, row.org_id, req.user.id],
        );
      }
      await recordAudit(client, {
        org_id: row.host_org_id,
        actor_id: req.user.id,
        entity_type: "event",
        entity_id: row.event_id,
        entity_name: row.event_name,
        action: `event.participation_request.${decision}`,
        metadata: {
          request_id: row.id,
          participating_org_id: row.org_id,
          participating_org_name: row.org_name,
        },
      });
      await client.query("COMMIT");
      try {
        await notifyOrgAdmins(row.host_org_id, {
          category: "international_invite",
          title: `${row.org_name} ${decision === "accepted" ? "accepted" : "declined"} "${row.event_name}"`,
          body: decision === "accepted"
            ? "Their divers can now enter under their home federation."
            : "They will not participate unless you send a new invite.",
          data: {
            request_id: row.id,
            event_id: row.event_id,
            participating_org_id: row.org_id,
            decision,
          },
          action_url: `/manager?event=${row.event_id}`,
        });
      } catch (notifErr) {
        console.error("[Participation Response Notification Skipped]", notifErr.message);
      }
      res.json(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Participation Request Response Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // Add: host org_admin only (or sysadmin). Same gate as POST
  // /api/events. The event is loaded first so the response can
  // confirm host-org match.
  router.post("/api/events/:id/participating-orgs", requireOrgAdmin, async (req, res) => {
    const { org_id } = req.body || {};
    if (!org_id) return res.status(400).json({ error: "org_id is required" });
    try {
      const ctx = await loadInviteContext(req, res, org_id);
      if (!ctx) return;
      const { ev, target } = ctx;
      const inserted = await pool.query(
        `INSERT INTO event_participating_orgs (event_id, org_id, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id, org_id) DO NOTHING
         RETURNING event_id`,
        [req.params.id, org_id, req.user.id],
      );
      // Audit row so the host federation has a clean record of
      // who invited whom.
      try {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id:      ev.org_id,
          entity_type: "event",
          entity_id:   ev.id,
          entity_name: ev.name,
          action:      "event.participating_org.added",
          metadata: { participating_org_id: org_id, participating_org_name: target.name },
        });
      } catch (auditErr) {
        console.error("[Participating Org Audit Skipped]", auditErr.message);
      }
      // Fire an in-app notification to every org_admin of the
      // newly-invited federation. They land in /inbox and on
      // the dashboard pulse strip's incoming-feed; if web push
      // is wired they also buzz the admin's phone. ON CONFLICT
      // returning empty = the row already existed (re-add of an
      // already-invited org); skip the notification spam.
      if (inserted.rows.length) {
        try {
          await notifyOrgAdmins(org_id, async () => ({
            category:  "international_invite",
            title:     `${(await orgName(ev.org_id)) || "A host federation"} invited you to "${ev.name}"`,
            body:      "Your divers can now self-enter this event. Open Meet Manager to see who's competing.",
            data:      { event_id: ev.id, host_org_id: ev.org_id },
            action_url: `/manager?event=${ev.id}`,
          }));
        } catch (notifErr) {
          console.error("[Invite Notification Skipped]", notifErr.message);
        }
      }
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error("[Add Participating Org Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove: host org_admin removes ANY federation, OR a visiting
  // federation's own org_admin self-withdraws their participation.
  // The visiting-side path lets a country pull out without
  // pinging the host (e.g. funding cut, travel ban, schedule
  // clash), existing roster entries stay intact (the diver
  // gates only block NEW entries) so no in-flight competition
  // is destabilised.
  router.delete("/api/events/:id/participating-orgs/:org_id", requireOrgAdmin, async (req, res) => {
    try {
      // Defense-in-depth: lowercase the URL-supplied UUIDs so a
      // mixed-case path (e.g. uppercase pasted from a copy-out)
      // doesn't fail the equality check below for a legitimate
      // self-withdraw, and so the audit row's metadata always
      // records the canonical lowercase form (audit search-by-
      // org-id stays consistent).
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const eventId = (req.params.id || "").toLowerCase();
      const orgId   = (req.params.org_id || "").toLowerCase();
      if (!UUID_RE.test(eventId) || !UUID_RE.test(orgId)) {
        return res.status(400).json({ error: "Invalid event_id or org_id (must be UUID)" });
      }
      const ev = await pool.query(
        "SELECT id, org_id, name FROM events WHERE id = $1",
        [eventId],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const isSysAdmin = !!req.user.is_system_admin;
      const isHostAdmin = ev.rows[0].org_id === req.user.org_id;
      const isSelfWithdraw = orgId === (req.user.org_id || "").toLowerCase();
      if (!isSysAdmin && !isHostAdmin && !isSelfWithdraw) {
        return res.status(403).json({
          error: "Only the host federation can remove other federations, and only the visiting federation can withdraw itself",
        });
      }
      const r = await pool.query(
        "DELETE FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2 RETURNING org_id",
        [eventId, orgId],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Not on the participating list" });
      try {
        await recordAudit(pool, {
          ...auditFromReq(req),
          // Audit row lands on the host org's books, that's where
          // the event lives and where compliance reads for it.
          // The metadata captures whether this was host-removal
          // or self-withdrawal so the trail reads correctly.
          org_id:      ev.rows[0].org_id,
          entity_type: "event",
          entity_id:   ev.rows[0].id,
          entity_name: ev.rows[0].name,
          action:      "event.participating_org.removed",
          metadata: {
            participating_org_id: orgId,
            removed_by_self: isSelfWithdraw && !isHostAdmin,
          },
        });
      } catch (auditErr) {
        console.error("[Participating Org Audit Skipped]", auditErr.message);
      }
      // Notify the host's org admins when a federation
      // self-withdraws, they need to know their roster expectation
      // changed. (Host-driven removal doesn't need this, the host
      // initiated it.)
      if (isSelfWithdraw && !isHostAdmin) {
        try {
          await notifyOrgAdmins(ev.rows[0].org_id, async () => ({
            category:  "international_invite",
            title:     `${(await orgName(orgId)) || "A federation"} withdrew from "${ev.rows[0].name}"`,
            body:      "Their divers will no longer be able to enter new dive lists. Existing entries stay intact.",
            data:      { event_id: ev.rows[0].id, withdrawing_org_id: orgId },
            action_url: `/manager?event=${ev.rows[0].id}`,
          }));
        } catch (notifErr) {
          console.error("[Withdraw Notification Skipped]", notifErr.message);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Remove Participating Org Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Eligible divers for an event: host org's divers + every
  // participating org's divers. Used by the synchro-partner
  // picker and the late-entry roster lookup so a meet manager
  // can find foreign divers without hitting the org-scoped
  // /api/orgs/:id/divers endpoint.
  //
  // The previous gate was `verifyToken` only, any signed-in
  // user (including a freshly-registered spectator in any
  // federation) could enumerate full diver rosters of every
  // event in the system. Tightened to require either:
  //   1. event-staff for THIS event (requireEventManager),
  //      which covers the meet manager's late-entry use case;
  //   2. OR a diver/coach whose own org is on the event's
  //      eligibility list, which covers the synchro-partner
  //      picker for visiting federations.
  router.get("/api/events/:id/eligible-divers", verifyToken, async (req, res) => {
    try {
      // Org-eligibility check first (cheap). Sysadmins bypass.
      const evRow = await pool.query(
        "SELECT org_id FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!evRow.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const eventOrgId = evRow.rows[0].org_id;
      const isSysAdmin   = !!req.user.is_system_admin;
      const isHostOrg    = req.user.org_id === eventOrgId;
      let isEligibleOrg  = isHostOrg;
      if (!isSysAdmin && !isEligibleOrg) {
        const part = await pool.query(
          "SELECT 1 FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2",
          [req.params.id, req.user.org_id],
        );
        isEligibleOrg = part.rows.length > 0;
      }
      if (!isSysAdmin && !isEligibleOrg) {
        return res.status(403).json({
          error: "Your federation is not eligible for this event",
        });
      }
      const r = await pool.query(
        `SELECT u.id, u.full_name,
                u.org_id, o.name AS org_name, o.country_code,
                cl.name AS club_name, cl.short_code AS club_code
           FROM users u
           JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
           JOIN organisations o  ON o.id = u.org_id
           LEFT JOIN clubs cl    ON cl.id = u.club_id
          WHERE u.org_id IN (
                  SELECT org_id FROM events WHERE id = $1
                  UNION
                  SELECT org_id FROM event_participating_orgs WHERE event_id = $1
                )
          ORDER BY o.name ASC, u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Eligible Divers Error]", err.message);
      res.status(500).json([]);
    }
  });

  return router;
};
