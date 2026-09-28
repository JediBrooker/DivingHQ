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
//     In a country with no federation (claim_state 'unclaimed') there's
//     no org_admin, so the admins of the club being joined approve it
//     instead (or of that club's region, one level up). Otherwise
//     anyone who signed up Independent, or left their club, could never
//     get into one: PUT /api/users/:id/club is org-admin only for
//     setting a club. The person asks, so nobody gets signed up to a
//     club without saying so.
//   org_transfer (cross-org): three-way handshake, source admin +
//     target admin + diver, in any order, finalises once all three
//     are in. Updates users.org_id/club_id atomically and audits it.
// =============================================================
const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");
const notices = require("../lib/notices");
const { isOrgAdminOf, liveAdminIds, liveOrgAdminIds, orgAdminHold, lastOrgAdminRefusal } = require("../lib/admin-rows");
const { isUuid, requireUuidParam } = require("../lib/uuid");

module.exports = function createClubChangesRouter({ pool, verifyToken, bumpTokenVersion }) {
  if (!pool) throw new Error("createClubChangesRouter requires { pool }");
  const router = express.Router();
  router.param("id", requireUuidParam);

  // Can this club (or region) admin decide this request? Only a within-org
  // move into a club they run, in an org with no federation to ask, and
  // never their own: a region admin asking to join one of the region's
  // clubs waits for that club's admins like anyone else.
  async function isJoinReviewer(db, userId, r) {
    if (r.kind !== "club_change" || !r.to_club_id || r.from_org_id !== r.to_org_id) return false;
    if (r.user_id === userId) return false;
    const q = await db.query(
      `SELECT 1 FROM clubs c JOIN organisations o ON o.id = c.org_id
        WHERE c.id = $1 AND o.id = $2 AND o.claim_state = 'unclaimed'
          AND (EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $3)
               OR EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = c.region_id AND ra.user_id = $3))`,
      [r.to_club_id, r.to_org_id, userId],
    );
    return q.rows.length > 0;
  }

  // Who to tell about a new join request where there's no federation:
  // the club's live admins, or its region's if the club has none.
  async function joinReviewerIds(db, clubId) {
    const clubAdmins = await liveAdminIds(db, "club", clubId);
    if (clubAdmins.length) return clubAdmins;
    const region = await db.query(
      `SELECT ra.user_id FROM clubs c
         JOIN region_admins ra ON ra.region_id = c.region_id
         JOIN users u ON u.id = ra.user_id
        WHERE c.id = $1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
      [clubId],
    );
    return region.rows.map((r) => r.user_id);
  }

  // Best-effort inbox notification, never aborts the parent tx.
  // 'club_change' is the outcome (approved, declined, a link closed) and
  // files under Operations in the inbox; 'club_join_request' is someone
  // waiting on the reader to decide, and lands under Action required.
  //
  // Most calls run on the request's transaction client, and there a
  // try/catch alone isn't enough: one failed INSERT aborts the whole
  // transaction, and the COMMIT after it quietly rolls back instead. A
  // transfer used to report "approved" while nothing had moved. Hence the
  // savepoint. insertInApp cuts the title to fit notifications.title as
  // well, since a club's name on its own can be longer than that.
  async function notify(db, userIds, { category = "club_change", ...note }) {
    if (!userIds.length) return;
    const inTx = db !== pool;
    try {
      if (inTx) await db.query("SAVEPOINT club_change_notify");
      await notices.insertInApp(db, userIds, { category, ...note });
      if (inTx) await db.query("RELEASE SAVEPOINT club_change_notify");
    } catch (err) {
      if (inTx) await db.query("ROLLBACK TO SAVEPOINT club_change_notify");
      console.error("[club-change] notify failed:", err.message);
    }
  }

  // Apply the change if every required approval is in. Returns true
  // when it finalised. Caller holds the transaction client.
  // Guardian authority is scoped to one federation: guardians.org_id, and
  // routes/payments.js validates the link against the caller's org before
  // it will read or pay anything on a dependent's behalf. So a transfer
  // has to close the links the mover leaves behind, in either role. A
  // parent whose child moves federations has no standing in the new one
  // until they ask for it there and an admin approves; leaving the row
  // approved-but-pinned-to-the-old-org left the child sitting in the
  // parent's "Paying for" picker while every action against them failed.
  //
  // Returns the ids of whoever lost a link, so they can be told.
  async function revokeGuardianLinks(client, userId, reviewedBy) {
    const gone = await client.query(
      `UPDATE guardians
          SET status = 'revoked', reviewed_by = $2, reviewed_at = now()
        WHERE (guardian_user_id = $1 OR dependent_user_id = $1)
          AND status IN ('pending', 'approved')
        RETURNING id, guardian_user_id, dependent_user_id`,
      [userId, reviewedBy],
    );
    return gone.rows;
  }

  // Admin seats belong to the org they were handed out in. The checks
  // that honour them (isEventDelegate, requireClubAdmin, the claim votes)
  // match a seat against the club's or event's org, and both of those are
  // still the old one, so someone who transferred away kept running their
  // old club's meets from the new federation. Club and region seats in
  // any other org go, and so do their event manager seats there.
  // A club_change within one org leaves them alone: running a club has
  // never depended on being a member of it.
  async function dropSeatsLeftBehind(client, userId, toOrgId) {
    const clubs = await client.query(
      `DELETE FROM club_admins ca USING clubs c
        WHERE c.id = ca.club_id AND ca.user_id = $1 AND ca.org_id <> $2
        RETURNING ca.club_id AS id, c.name, ca.org_id`,
      [userId, toOrgId],
    );
    const regions = await client.query(
      `DELETE FROM region_admins ra USING regions rg
        WHERE rg.id = ra.region_id AND ra.user_id = $1 AND ra.org_id <> $2
        RETURNING ra.region_id AS id, rg.name, ra.org_id`,
      [userId, toOrgId],
    );
    const events = await client.query(
      `DELETE FROM event_managers em USING events e
        WHERE e.id = em.event_id AND em.user_id = $1 AND e.org_id <> $2
        RETURNING em.event_id AS id, e.name`,
      [userId, toOrgId],
    );
    return { clubs: clubs.rows, regions: regions.rows, events: events.rows };
  }

  // Whoever's still running a club or region the mover just left. If
  // nobody is, its federation's admins, or DivingHQ where there isn't one,
  // so a club with no admin doesn't just sit there unnoticed.
  async function whoIsLeft(client, scope, row) {
    const left = await liveAdminIds(client, scope, row.id);
    if (left.length) return { ids: left, orphaned: false };
    const orgAdmins = await liveOrgAdminIds(client, row.org_id);
    if (orgAdmins.length) return { ids: orgAdmins, orphaned: true };
    const sys = (await client.query(
      "SELECT id FROM users WHERE is_system_admin AND deleted_at IS NULL AND suspended_at IS NULL",
    )).rows.map((x) => x.id);
    return { ids: sys, orphaned: true };
  }

  // finalizeIfReady throws one of these to refuse a move outright. The
  // route's catch has already rolled back, it just answers with the body.
  function refusal(status, body) {
    const err = new Error(body.error);
    err.status = status;
    err.refusal = body;
    return err;
  }

  async function finalizeIfReady(client, r, req) {
    const ready =
      r.kind === "club_change"
        ? !!r.source_approved_at
        : !!r.source_approved_at && !!r.target_approved_at && !!r.diver_confirmed_at;
    if (!ready) return false;

    let revokedLinks = [];
    let seats = { clubs: [], regions: [], events: [] };
    let droppedRoles = [];
    let closedRoleRequests = 0;

    if (r.kind === "org_transfer") {
      // Moving out takes every role in the old org with it, so the last
      // live org admin of a federation can't go until someone else runs
      // it. Whichever approval or confirmation lands last gets the 409 and
      // the request stays pending. The sysadmin can still move them.
      if (!req.user.is_system_admin) {
        const cur = (await client.query("SELECT org_id FROM users WHERE id = $1", [r.user_id])).rows[0];
        const hold = cur ? await orgAdminHold(client, cur.org_id, r.user_id) : null;
        if (hold) throw refusal(409, lastOrgAdminRefusal(hold, { self: r.user_id === req.user.id }));
      }
      await client.query(
        "UPDATE users SET org_id = $1, club_id = $2 WHERE id = $3",
        [r.to_org_id, r.to_club_id || null, r.user_id],
      );
      seats = await dropSeatsLeftBehind(client, r.user_id, r.to_org_id);
      // Their token still carries the old org and its roles until it
      // expires, so make them sign in again.
      if (typeof bumpTokenVersion === "function") await bumpTokenVersion(client, r.user_id);
      // Roles are kept per org and the token reads the ones in
      // users.org_id, so rows left in the old org weren't history, they
      // were grants waiting to switch back on. A former org_admin who
      // later moved home came back an admin without anyone granting it.
      // So everything held outside the new org goes. Anything beyond
      // diver/spectator they already hold in the new org is left over
      // from an earlier stay there (nobody can grant roles to a
      // non-member), so that goes too. Every one is audited as revoked.
      droppedRoles = (await client.query(
        `DELETE FROM user_org_roles
          WHERE user_id = $1 AND (org_id <> $2 OR role NOT IN ('diver', 'spectator'))
          RETURNING org_id, role::text AS role`,
        [r.user_id, r.to_org_id],
      )).rows;
      for (const d of droppedRoles) {
        await client.query(
          `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id, note)
           VALUES ($1, $2, $3, 'revoked', $4, 'transferred to another federation')`,
          [r.user_id, d.org_id, d.role, req.user.id],
        );
      }
      // A role request still waiting back in the old org would put one of
      // those rows straight back the day an admin there approved it. They
      // go with the move, same as the roles.
      closedRoleRequests = (await client.query(
        `UPDATE role_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = now()
          WHERE user_id = $1 AND status = 'pending' AND org_id <> $3`,
        [r.user_id, req.user.id, r.to_org_id],
      )).rowCount;
      // Carry the diver role into the receiving org so they show up
      // on its roster.
      await client.query(
        `INSERT INTO user_org_roles (user_id, org_id, role, granted_by)
         VALUES ($1, $2, 'diver', $3) ON CONFLICT DO NOTHING`,
        [r.user_id, r.to_org_id, req.user.id],
      );
      revokedLinks = await revokeGuardianLinks(client, r.user_id, req.user.id);
    } else {
      // Pinned to the org the request was made in, so a request that
      // outlived an org transfer can't drop someone into a club of the
      // org they left.
      await client.query("UPDATE users SET club_id = $1 WHERE id = $2 AND org_id = $3", [
        r.to_club_id || null,
        r.user_id,
        r.to_org_id,
      ]);
    }

    await client.query(
      `UPDATE club_change_requests
         SET status='approved', reviewed_by=$1, reviewed_at=now()
       WHERE id=$2 AND status='pending'`,
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
        revoked_guardian_links: revokedLinks.length,
        ...(r.kind === "org_transfer" ? {
          removed: {
            roles: droppedRoles.map((d) => ({ org_id: d.org_id, role: d.role })),
            role_requests: closedRoleRequests,
            club_admins: seats.clubs.map((c) => c.id),
            region_admins: seats.regions.map((g) => g.id),
            event_managers: seats.events.map((e) => e.id),
          },
        } : {}),
      },
      note: r.note || null,
    });

    await notify(client, [r.user_id], {
      title: r.kind === "org_transfer" ? "Your transfer was approved" : "Your club change was approved",
      body: "The change has been applied to your profile.",
      action_url: "/profile",
      data: { request_id: r.id, kind: r.kind },
    });

    for (const [scope, list] of [["club", seats.clubs], ["region", seats.regions]]) {
      for (const row of list) {
        const { ids, orphaned } = await whoIsLeft(client, scope, row);
        // The mover can still hold org_admin in the org they left.
        await notify(client, ids.filter((id) => id !== r.user_id), {
          title: orphaned ? `${row.name} has no admin now` : `${row.name} has one admin fewer`,
          body: `${fullName || "One of its admins"} transferred to another federation, so they no longer run ${row.name}.`
            + (orphaned ? " Appoint a new admin so someone can run its meets." : ""),
          action_url: orphaned ? "/clubs" : (scope === "club" ? "/club" : "/region"),
          data: { request_id: r.id, kind: r.kind, [`${scope}_id`]: row.id },
        });
      }
    }

    // Tell the other half of every link we just closed. The mover already
    // got their own notification above, so skip them.
    for (const link of revokedLinks) {
      const other = link.guardian_user_id === r.user_id
        ? link.dependent_user_id
        : link.guardian_user_id;
      if (other === r.user_id) continue;
      await notify(client, [other], {
        title: "A guardian link was ended",
        body: `${fullName || "Someone you were linked to"} transferred to another federation, so the link between you was closed. You can request it again in the new federation.`,
        action_url: "/guardians",
        data: { request_id: r.id, kind: r.kind, guardian_link_id: link.id },
      });
    }
    return true;
  }

  // --- CREATE -------------------------------------------------
  router.post("/api/club-change-requests", verifyToken, async (req, res) => {
    const { user_id, to_club_id, to_org_id, note } = req.body || {};
    for (const [name, v] of [["user_id", user_id], ["to_club_id", to_club_id], ["to_org_id", to_org_id]]) {
      if (v != null && v !== "" && !isUuid(v)) return res.status(400).json({ error: `${name} must be an id` });
    }
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
      if (!isSelf && !isOrgAdminOf(req.user, u.org_id)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Not allowed to request a change for this diver" });
      }

      // Validate the destination club belongs to the destination org,
      // and has been approved: nobody can ask their way into a club that's
      // still waiting on its federation (migration 096).
      if (to_club_id) {
        const c = await client.query(
          "SELECT id FROM clubs WHERE id = $1 AND org_id = $2 AND status = 'active'",
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
      // Leaving your club needs nobody's say-so: PUT /api/users/:id/club
      // already lets a diver clear their own. Filed as a request it sat
      // waiting, and where there's no federation nobody but the sysadmin
      // could decide it (club admins only review joins), while it blocked
      // every later request to join a club. So it applies straight away.
      const selfLeave = isSelf && kind === "club_change" && !to_club_id;
      const diverConfirmed = isSelf ? "now()" : "NULL";
      const sourceApproved = selfLeave || (!isSelf && isOrgAdminOf(req.user, u.org_id)) ? "now()" : "NULL";
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

      // Org admins see a pending club change in their inbox GET. Where
      // there's no federation, the club being joined is who decides, so
      // tell its admins directly. Looked up inside the transaction,
      // sent after it, so a notification hiccup can't undo the request.
      let tellIds = [];
      if (!finalised && kind === "club_change" && r.to_club_id) {
        const unclaimed = await client.query(
          "SELECT 1 FROM organisations WHERE id = $1 AND claim_state = 'unclaimed'", [toOrg],
        );
        if (unclaimed.rows.length) {
          tellIds = (await joinReviewerIds(client, r.to_club_id)).filter((id) => id !== targetId);
        }
      }
      await client.query("COMMIT");
      await notify(pool, tellIds, {
        category: "club_join_request",
        title: `${u.full_name} wants to join your club`,
        body: "Approve or decline it on your club page.",
        action_url: "/club",
        data: { request_id: r.id, kind: r.kind },
      });
      res.status(201).json({ ...r, finalised });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.refusal) return res.status(err.status).json(err.refusal);
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
             -- Club and region admins where there's no federation: pending
             -- requests to join a club they run (isJoinReviewer, as a filter).
             OR (cr.status = 'pending' AND cr.kind = 'club_change'
                 AND cr.from_org_id = cr.to_org_id AND to_.claim_state = 'unclaimed'
                 AND (EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = cr.to_club_id AND ca.user_id = $1)
                      OR EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = tc.region_id AND ra.user_id = $1)))
          ORDER BY cr.created_at DESC`,
        [req.user.id, isAdmin, req.user.is_system_admin ? null : req.user.org_id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[club-change list]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Lock the request for the rest of the transaction. Two admins (or an
  // admin and the diver cancelling) used to both read it as pending and
  // both win, so a move could be applied while the row ended up
  // 'rejected' and the diver heard both outcomes. The second one now
  // waits on this lock, then finds it decided. Answers the 404 or 409
  // itself and returns null when the caller should stop.
  async function lockPending(client, id, res) {
    const r = (await client.query(
      "SELECT * FROM club_change_requests WHERE id = $1 FOR UPDATE",
      [id],
    )).rows[0];
    if (r && r.status === "pending") return r;
    await client.query("ROLLBACK");
    if (!r) res.status(404).json({ error: "Request not found" });
    else res.status(409).json({ error: "This request has already been decided", code: "already_decided" });
    return null;
  }

  // --- REVIEW (org admin approves / rejects) ------------------
  router.post("/api/club-change-requests/:id/review", verifyToken, async (req, res) => {
    const { decision } = req.body || {};
    if (!["approved", "rejected"].includes(decision))
      return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await lockPending(client, req.params.id, res);
      if (!r) return;

      // A club (or region) admin approving someone into their club counts
      // as the one approval a club_change needs.
      const canSource = isOrgAdminOf(req.user, r.from_org_id)
        || await isJoinReviewer(client, req.user.id, r);
      const canTarget = isOrgAdminOf(req.user, r.to_org_id);
      if (!canSource && !canTarget) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Not an admin of either organisation in this request" });
      }
      if (decision === "approved") {
        const who = (await client.query("SELECT org_id, deleted_at FROM users WHERE id = $1", [r.user_id])).rows[0];
        // Self-delete closes open requests now, but one left from before
        // that would move the tombstone to another federation (granting it
        // 'diver' there) and out of reach of claim-candidates.
        if (!who || who.deleted_at) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "That account has been deleted", code: "account_deleted" });
        }
        if (r.kind === "club_change" && who.org_id !== r.to_org_id) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "That person has moved to another organisation" });
        }
      }

      if (decision === "rejected") {
        await client.query(
          "UPDATE club_change_requests SET status='rejected', reviewed_by=$1, reviewed_at=now() WHERE id=$2 AND status='pending'",
          [req.user.id, r.id],
        );
        await notify(client, [r.user_id], {
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
      if (err.refusal) return res.status(err.status).json(err.refusal);
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
      const r = await lockPending(client, req.params.id, res);
      if (!r) return;
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
      if (err.refusal) return res.status(err.status).json(err.refusal);
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
        "SELECT * FROM club_change_requests WHERE id=$1",
        [req.params.id])).rows[0];
      if (!r) return res.status(404).json({ error: "Request not found" });
      const allowed = r.user_id === req.user.id || isOrgAdminOf(req.user, r.from_org_id) || isOrgAdminOf(req.user, r.to_org_id);
      if (!allowed) return res.status(403).json({ error: "Not allowed to cancel this request" });
      // Guarded on status, so a cancel that lands while an approval holds
      // the row waits for it and then touches nothing, rather than marking
      // a move that already happened as rejected.
      const done = await pool.query(
        "UPDATE club_change_requests SET status='rejected', reviewed_by=$1, reviewed_at=now(), note=COALESCE(note,'') WHERE id=$2 AND status='pending'",
        [req.user.id, r.id]);
      if (!done.rowCount) {
        return res.status(409).json({ error: "This request has already been decided", code: "already_decided" });
      }
      res.json({ status: "cancelled" });
    } catch (err) {
      console.error("[club-change cancel]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
