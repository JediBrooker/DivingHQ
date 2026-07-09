// =============================================================
// CLUB CHANGE REQUESTS + CROSS-ORG TRANSFERS  (migration 057)
//
//   POST /api/club-change-requests            create a request
//   GET  /api/club-change-requests            my requests + admin inbox
//   POST /api/club-change-requests/:id/review approve / reject (org admin)
//   POST /api/club-change-requests/:id/confirm diver confirms a transfer
//   POST /api/club-change-requests/:id/cancel  withdraw a pending request
//
// Flows (see migration 057):
//   club_change (within-org): diver asks, one org_admin approves.
//   org_transfer (cross-org): three-way handshake, source admin +
//     target admin + diver, in any order, finalises once all three
//     are in. Updates users.org_id/club_id atomically and audits it.
// =============================================================
const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");

module.exports = function createClubChangesRouter({ pool, verifyToken }) {
  if (!pool) throw new Error("createClubChangesRouter requires { pool }");
  const router = express.Router();

  const isOrgAdminOf = (req, orgId) =>
    !!req.user.is_system_admin ||
    ((req.user.org_roles || []).includes("org_admin") &&
      req.user.org_id === orgId);

  // Best-effort inbox notification, never aborts the parent tx.
  async function notify(db, userId, { title, body, action_url, data }) {
    try {
      await db.query(
        `INSERT INTO notifications (user_id, category, title, body, data, action_url, status)
         VALUES ($1, 'club_change', $2, $3, $4::jsonb, $5, 'sent')`,
        [userId, title, body || null, data ? JSON.stringify(data) : "{}", action_url || null],
      );
    } catch (err) {
      console.error("[club-change] notify failed:", err.message);
    }
  }

  // Apply the change if every required approval is in. Returns true
  // when it finalised. Caller holds the transaction client.
  async function finalizeIfReady(client, r, req) {
    const ready =
      r.kind === "club_change"
        ? !!r.source_approved_at
        : !!r.source_approved_at && !!r.target_approved_at && !!r.diver_confirmed_at;
    if (!ready) return false;

    if (r.kind === "org_transfer") {
      await client.query(
        "UPDATE users SET org_id = $1, club_id = $2 WHERE id = $3",
        [r.to_org_id, r.to_club_id || null, r.user_id],
      );
      // Carry the diver role into the receiving org so they show up
      // on its roster; leave any historical roles behind in the old
      // org.
      await client.query(
        `INSERT INTO user_org_roles (user_id, org_id, role, granted_by)
         VALUES ($1, $2, 'diver', $3) ON CONFLICT DO NOTHING`,
        [r.user_id, r.to_org_id, req.user.id],
      );
    } else {
      await client.query("UPDATE users SET club_id = $1 WHERE id = $2", [
        r.to_club_id || null,
        r.user_id,
      ]);
    }

    await client.query(
      `UPDATE club_change_requests
         SET status='approved', reviewed_by=$1, reviewed_at=now()
       WHERE id=$2`,
      [req.user.id, r.id],
    );

    const nameRes = await client.query(
      "SELECT full_name FROM users WHERE id = $1",
      [r.user_id],
    );
    const fullName = nameRes.rows[0]?.full_name || null;

    await recordAudit(client, {
      ...auditFromReq(req),
      org_id: r.to_org_id,
      entity_type: "user",
      entity_id: r.user_id,
      entity_name: fullName,
      action: r.kind === "org_transfer" ? "user.org_transferred" : "user.club_changed",
      metadata: {
        kind: r.kind,
        from_org_id: r.from_org_id,
        to_org_id: r.to_org_id,
        from_club_id: r.from_club_id,
        to_club_id: r.to_club_id,
      },
      note: r.note || null,
    });

    await notify(client, r.user_id, {
      title: r.kind === "org_transfer" ? "Your transfer was approved" : "Your club change was approved",
      body: "The change has been applied to your profile.",
      action_url: "/profile",
      data: { request_id: r.id, kind: r.kind },
    });
    return true;
  }

  // --- CREATE -------------------------------------------------
  router.post("/api/club-change-requests", verifyToken, async (req, res) => {
    const { user_id, to_club_id, to_org_id, note } = req.body || {};
    const targetId = user_id || req.user.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const uRes = await client.query(
        "SELECT id, full_name, org_id, club_id FROM users WHERE id = $1",
        [targetId],
      );
      if (!uRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "User not found" });
      }
      const u = uRes.rows[0];
      const toOrg = to_org_id || u.org_id;
      const kind = toOrg === u.org_id ? "club_change" : "org_transfer";

      // Permission: the diver themselves, or an org_admin of the
      // diver's CURRENT org (the side that releases them).
      const isSelf = req.user.id === targetId;
      if (!isSelf && !isOrgAdminOf(req, u.org_id)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Not allowed to request a change for this diver" });
      }

      // Validate the destination club belongs to the destination org.
      if (to_club_id) {
        const c = await client.query(
          "SELECT id FROM clubs WHERE id = $1 AND org_id = $2",
          [to_club_id, toOrg],
        );
        if (!c.rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Club does not belong to the destination organisation" });
        }
      }
      // No-op guard.
      if (toOrg === u.org_id && (to_club_id || null) === (u.club_id || null)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "That is already the diver's club" });
      }

      // Seed handshake stamps based on who initiated.
      const diverConfirmed = isSelf ? "now()" : "NULL";
      const sourceApproved = !isSelf && isOrgAdminOf(req, u.org_id) ? "now()" : "NULL";
      const sourceApprovedBy = sourceApproved === "now()" ? req.user.id : null;

      let insRes;
      try {
        insRes = await client.query(
          `INSERT INTO club_change_requests
             (user_id, kind, from_org_id, from_club_id, to_org_id, to_club_id,
              requested_by, note,
              diver_confirmed_at, source_approved_at, source_approved_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                   ${diverConfirmed}, ${sourceApproved}, $9)
           RETURNING *`,
          [targetId, kind, u.org_id, u.club_id, toOrg, to_club_id || null,
           req.user.id, note || null, sourceApprovedBy],
        );
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.code === "23505")
          return res.status(409).json({ error: "This diver already has an open request" });
        throw err;
      }
      const r = insRes.rows[0];

      // A within-org club change initiated by an org admin is already
      // fully approved → apply immediately.
      const finalised = await finalizeIfReady(client, r, req);

      // Notify the relevant approvers if still pending.
      if (!finalised) {
        if (kind === "club_change") {
          // diver asked, ping the org admins of their org via audit.
          // inbox is the admin's GET; no direct per-admin row here.
        }
      }
      await client.query("COMMIT");
      res.status(201).json({ ...r, finalised });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[club-change create]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // --- LIST (my requests + admin inbox) -----------------------
  router.get("/api/club-change-requests", verifyToken, async (req, res) => {
    try {
      // Diver sees their own; an org admin also sees requests that
      // touch their org (releases OR intakes). Sysadmin sees everything.
      const isAdmin = (req.user.org_roles || []).includes("org_admin") || req.user.is_system_admin;
      const r = await pool.query(
        `SELECT cr.*,
                u.full_name AS diver_name, u.username AS diver_username,
                fo.name AS from_org_name, fc.name AS from_club_name,
                to_.name AS to_org_name,  tc.name AS to_club_name
           FROM club_change_requests cr
           JOIN users u           ON u.id  = cr.user_id
           LEFT JOIN organisations fo ON fo.id = cr.from_org_id
           LEFT JOIN organisations to_ ON to_.id = cr.to_org_id
           LEFT JOIN clubs fc      ON fc.id = cr.from_club_id
           LEFT JOIN clubs tc      ON tc.id = cr.to_club_id
          WHERE cr.user_id = $1
             OR ($2::boolean AND ($3::uuid IS NULL OR cr.from_org_id = $3 OR cr.to_org_id = $3))
          ORDER BY cr.created_at DESC`,
        [req.user.id, isAdmin, req.user.is_system_admin ? null : req.user.org_id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[club-change list]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  async function loadPending(client, id) {
    const r = await client.query(
      "SELECT * FROM club_change_requests WHERE id = $1 AND status = 'pending'",
      [id],
    );
    return r.rows[0] || null;
  }

  // --- REVIEW (org admin approves / rejects) ------------------
  router.post("/api/club-change-requests/:id/review", verifyToken, async (req, res) => {
    const { decision } = req.body || {};
    if (!["approved", "rejected"].includes(decision))
      return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await loadPending(client, req.params.id);
      if (!r) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Request not found" }); }

      const canSource = isOrgAdminOf(req, r.from_org_id);
      const canTarget = isOrgAdminOf(req, r.to_org_id);
      if (!canSource && !canTarget) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Not an admin of either organisation in this request" });
      }

      if (decision === "rejected") {
        await client.query(
          "UPDATE club_change_requests SET status='rejected', reviewed_by=$1, reviewed_at=now() WHERE id=$2",
          [req.user.id, r.id],
        );
        await notify(client, r.user_id, {
          title: "Your club change was declined",
          body: "An administrator declined the request.",
          action_url: "/profile",
          data: { request_id: r.id },
        });
        await client.query("COMMIT");
        return res.json({ status: "rejected" });
      }

      // Approve: stamp the side the caller administers.
      if (r.kind === "club_change") {
        await client.query(
          "UPDATE club_change_requests SET source_approved_at=now(), source_approved_by=$1 WHERE id=$2",
          [req.user.id, r.id],
        );
      } else {
        if (canSource && !r.source_approved_at)
          await client.query(
            "UPDATE club_change_requests SET source_approved_at=now(), source_approved_by=$1 WHERE id=$2",
            [req.user.id, r.id]);
        if (canTarget && !r.target_approved_at)
          await client.query(
            "UPDATE club_change_requests SET target_approved_at=now(), target_approved_by=$1 WHERE id=$2",
            [req.user.id, r.id]);
      }
      const fresh = (await client.query("SELECT * FROM club_change_requests WHERE id=$1", [r.id])).rows[0];
      const finalised = await finalizeIfReady(client, fresh, req);
      await client.query("COMMIT");
      res.json({ status: finalised ? "approved" : "pending", finalised });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[club-change review]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // --- CONFIRM (diver consents to a transfer) -----------------
  router.post("/api/club-change-requests/:id/confirm", verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await loadPending(client, req.params.id);
      if (!r) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Request not found" }); }
      if (r.user_id !== req.user.id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Only the diver can confirm their own transfer" });
      }
      await client.query("UPDATE club_change_requests SET diver_confirmed_at=now() WHERE id=$1", [r.id]);
      const fresh = (await client.query("SELECT * FROM club_change_requests WHERE id=$1", [r.id])).rows[0];
      const finalised = await finalizeIfReady(client, fresh, req);
      await client.query("COMMIT");
      res.json({ status: finalised ? "approved" : "pending", finalised });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[club-change confirm]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // --- CANCEL (withdraw a pending request) --------------------
  router.post("/api/club-change-requests/:id/cancel", verifyToken, async (req, res) => {
    try {
      const r = (await pool.query(
        "SELECT * FROM club_change_requests WHERE id=$1 AND status='pending'",
        [req.params.id])).rows[0];
      if (!r) return res.status(404).json({ error: "Request not found" });
      const allowed = r.user_id === req.user.id || isOrgAdminOf(req, r.from_org_id) || isOrgAdminOf(req, r.to_org_id);
      if (!allowed) return res.status(403).json({ error: "Not allowed to cancel this request" });
      await pool.query(
        "UPDATE club_change_requests SET status='rejected', reviewed_by=$1, reviewed_at=now(), note=COALESCE(note,'') WHERE id=$2",
        [req.user.id, r.id]);
      res.json({ status: "cancelled" });
    } catch (err) {
      console.error("[club-change cancel]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
