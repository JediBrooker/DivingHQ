// User & role management routes.
//
//   GET  /api/users                  list (org_admin within org;
//                                    sysadmin sees every org)
//   PUT  /api/users/:id/roles        replace user's role set
//                                    (atomically diffs + audits)
//   GET  /api/role-requests          pending requests
//   GET  /api/role-requests/mine     what I can ask for + my requests
//   POST /api/role-requests          ask for a role after signup
//   POST /api/role-requests/:id/review  approve / reject
//   PUT  /api/users/:id/club         self-clear OR admin-set club
//   GET  /api/users/:id/role-audit   per-user audit history
//   GET  /api/judges                 list judges in caller's org
//
//   Account lifecycle (migrations 053, 058):
//   POST /api/users/me/delete        self-delete (password re-auth)
//   POST /api/users/me/claim-candidates  deleted accounts that could be mine
//   POST /api/users/me/claim         re-link them to this account
//   PUT  /api/users/:id/profile      org admin edits name, DOB, etc.
//   POST /api/users/:id/suspend      ...and suspends
//   POST /api/users/:id/reactivate   ...and lifts it
//   POST /api/users/:id/resend-verification  re-send the verify link
//   POST /api/users/:id/reset-password       send a reset link
//
//   Guardians (migration 083):
//   GET  /api/guardians/my-dependents   (?include_pending=1 for the page)
//   GET  /api/guardians/search       find someone in my org to link to
//   POST /api/guardians/request
//   GET  /api/guardian-requests      org admin's queue
//   POST /api/guardian-requests/:id/review
//   POST /api/guardians/:id/revoke   end a link, or withdraw a request
//
// Both writes that change a user's privilege set call
// bumpTokenVersion inside the same transaction, so a rollback rolls
// back the bump too: the freshly-revoked role takes effect on the
// user's next request without waiting for their JWT to expire
// (Migration 021).
//
// Mounted via:
//   app.use(require('./routes/users')({ … }))

const express = require("express");
const roleRequests = require("../lib/role-requests");
const claimsLib = require("../lib/claims");
const bcrypt  = require("bcrypt");
const createAuthLinks = require("../lib/auth-links");
const { recordAudit, auditFromReq } = require("../lib/audit");
const { supportContact } = require("../lib/support");
const { ADMIN_ORG_ID } = require("../lib/admin-org");
const { isOrgAdminOf } = require("../lib/admin-rows");

// Enum values from init.sql's CREATE TYPE org_role. system_admin is
// intentionally NOT in this set, it's a column on users, not a role
// assignable here. Keeping this in sync with init.sql is flagged in
// AGENTS.md.
const VALID_ORG_ROLES = new Set([
  "org_admin", "meet_manager", "referee",
  "judge", "diver", "coach", "spectator",
]);

// Pass-through middleware for when the caller doesn't wire a
// bulkWriteLimiter (test harnesses, mostly). Keeps the per-route
// chain syntax identical either way.
const NOOP = (_req, _res, next) => next();

module.exports = function createUsersRouter({
  pool,
  verifyToken,
  requireOrgAdmin,
  requireMeetEditor,
  bumpTokenVersion,
  sendRoleDecisionEmail,
  bulkWriteLimiter,
  // Migration 058: org-admin profile edit + account lifecycle.
  sendVerifyEmailEmail,
  sendPasswordResetEmail,
  hashFingerprint,
  JWT_SECRET,
  requireMeetOrClubEditor,   // optional, migration 087
  // Signed-in role requests: who to tell, and the dashboard pulse.
  // Both optional so older test mounts keep working.
  sendNewRoleRequestEmail,
  io,
}) {
  if (!pool) throw new Error("createUsersRouter requires { pool, … }");
  const router = express.Router();
  // Same links the self-service flows in routes/auth.js send. The routes
  // below 503 before minting when JWT_SECRET isn't wired in.
  const { mintVerifyToken, mintResetToken } = createAuthLinks(JWT_SECRET);
  const writeLimiter = bulkWriteLimiter || NOOP;

  router.get("/api/users", requireOrgAdmin, async (req, res) => {
    try {
      // System admins see every user across every org, org_admins
      // only see their own. Org name + country code come back too
      // so the system-admin UI can group/filter by org.
      //
      // r.role is the org_role enum. node-postgres only auto-parses
      // arrays of built-in types, so we cast each role to text to
      // get a real string[] back instead of a raw "{judge,...}"
      // string the frontend would silently mishandle.
      const isSysAdmin = !!req.user.is_system_admin;
      const r = await pool.query(
        `SELECT u.id, u.username, u.full_name, u.is_system_admin,
                u.email, u.email_verified_at,
                u.date_of_birth, u.gender, u.nationality, u.suspended_at,
                u.org_id,  o.name AS org_name,  o.country_code, o.slug AS org_slug,
                u.club_id, c.name AS club_name, c.short_code AS club_code,
                COALESCE(
                  ARRAY_AGG(r.role::text ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL),
                  ARRAY[]::text[]
                ) AS org_roles
         FROM users u
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs c ON c.id = u.club_id
         LEFT JOIN user_org_roles r ON u.id = r.user_id AND r.org_id = u.org_id
         WHERE ($2::boolean OR u.org_id = $1)
           AND u.deleted_at IS NULL
         GROUP BY u.id, u.username, u.full_name, u.is_system_admin,
                  u.org_id, o.name, o.country_code, o.slug,
                  u.club_id, c.name, c.short_code
         ORDER BY o.name ASC, u.full_name ASC`,
        [req.user.org_id, isSysAdmin],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Users List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/users/:id/roles", requireOrgAdmin, async (req, res) => {
    const { roles } = req.body || {};
    // Validate up front: roles has to be an array of strings, and
    // every element a known org_role. Skip this and a malformed body
    // (string, object, role typo) cascades into a 500 from the
    // INSERT enum cast, which is bad UX and hands an attacker a
    // clean signal they hit a real endpoint.
    if (!Array.isArray(roles)) {
      return res.status(400).json({ error: "roles must be an array of role strings" });
    }
    const invalid = roles.filter((r) => typeof r !== "string" || !VALID_ORG_ROLES.has(r));
    if (invalid.length) {
      return res.status(400).json({
        error: `Invalid role(s): ${invalid.join(", ")}. ` +
               `Valid: ${[...VALID_ORG_ROLES].join(", ")}.`,
      });
    }
    const client = await pool.connect();
    try {
      // Apply roles in the target user's own org, not the caller's.
      // For org_admins these match by definition (there's a check
      // below); for system_admins editing users across orgs, this
      // is what makes the cross-org case work.
      const target = await client.query(
        "SELECT org_id FROM users WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "User not found" });
      const targetOrgId = target.rows[0].org_id;

      if (!req.user.is_system_admin && targetOrgId !== req.user.org_id) {
        return res
          .status(403)
          .json({ error: "Cannot modify users in other organisations" });
      }

      await client.query("BEGIN");

      // Diff against what's already there so the audit log only
      // records the actual grant / revoke events, not the full
      // delete + insert.
      const existing = await client.query(
        "SELECT role::text FROM user_org_roles WHERE user_id = $1 AND org_id = $2",
        [req.params.id, targetOrgId],
      );
      const before = new Set(existing.rows.map((row) => row.role));
      const after = new Set(roles);
      const granted = roles.filter((r) => !before.has(r));
      const revoked = [...before].filter((r) => !after.has(r));

      await client.query(
        "DELETE FROM user_org_roles WHERE user_id = $1 AND org_id = $2",
        [req.params.id, targetOrgId],
      );
      for (const role of roles) {
        await client.query(
          "INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1,$2,$3,$4)",
          [req.params.id, targetOrgId, role, req.user.id],
        );
      }

      // In the same transaction as the change. A failed insert aborts
      // it either way (Postgres won't run another statement after one
      // fails), so the change and its audit rows land together or not at
      // all.
      for (const role of granted) {
        await client.query(
          `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id)
           VALUES ($1, $2, $3, 'granted', $4)`,
          [req.params.id, targetOrgId, role, req.user.id],
        );
      }
      for (const role of revoked) {
        await client.query(
          `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id)
           VALUES ($1, $2, $3, 'revoked', $4)`,
          [req.params.id, targetOrgId, role, req.user.id],
        );
      }

      // Invalidate the target user's existing JWTs (Migration 021).
      // Granting or revoking either one changes the privilege set,
      // so whatever token is currently circulating is no longer
      // accurate. The helper bumps users.token_version and clears
      // the in-memory cache; the next request from any of their
      // devices forces a fresh login.
      if (granted.length > 0 || revoked.length > 0) {
        await bumpTokenVersion(client, req.params.id);
      }

      await client.query("COMMIT");
      res.json({ message: "Roles updated" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Role Update Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // Org admins review everything in their org, as before. Club and
  // region admins in a country with no federation yet review their own
  // members' everyday role requests (lib/role-requests.js has the rules). Both
  // get through this gate; each handler then scopes to what they may see.
  const isOrgAdminUser = (user) =>
    !!user.is_system_admin || (user.org_roles || []).includes("org_admin");
  const requireRequestReviewer = [
    (req, res, next) => verifyToken(req, res, async () => {
      if (isOrgAdminUser(req.user)) return next();
      try {
        const r = await pool.query(
          `SELECT 1 FROM club_admins WHERE user_id = $1
           UNION ALL SELECT 1 FROM region_admins WHERE user_id = $1 LIMIT 1`,
          [req.user.id],
        );
        if (r.rows.length) return next();
      } catch (err) {
        console.error("[requireRequestReviewer]", err.message);
        return res.status(500).json({ error: "Internal server error" });
      }
      res.status(403).json({ error: "Forbidden" });
    }),
    // requireOrgAdmin's second half is the 2FA gate; keep it.
    ...(Array.isArray(requireOrgAdmin) ? requireOrgAdmin.slice(1) : []),
  ];

  router.get("/api/role-requests", requireRequestReviewer, async (req, res) => {
    try {
      const rows = isOrgAdminUser(req.user)
        ? await roleRequests.listForOrgAdmin(pool, req.user)
        : await roleRequests.listForDelegate(pool, req.user.id);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/role-requests/:id/review", requireRequestReviewer, async (req, res) => {
    const { decision } = req.body || {}; // 'approved' | 'rejected'
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Match by id only, then verify the caller can act on this
      // request once we know which org it belongs to. Granting the
      // role uses rq.org_id, not the caller's org_id, so system
      // admins approving cross-org requests work too.
      //
      // FOR UPDATE, because two admins (or one double click) deciding
      // the same request both used to read it as pending and both win:
      // the role got granted while the row ended up 'rejected', and the
      // requester got both emails. Now the second one waits here, then
      // sees the first decision and gets a 409.
      const rqRes = await client.query(
        "SELECT * FROM role_requests WHERE id = $1 FOR UPDATE",
        [req.params.id],
      );
      if (!rqRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Request not found" });
      }
      const rq = rqRes.rows[0];
      if (rq.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This request has already been decided", code: "already_decided" });
      }

      if (!req.user.is_system_admin && rq.org_id !== req.user.org_id) {
        await client.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "Cannot review requests in other organisations" });
      }
      if (!isOrgAdminUser(req.user) && !(await roleRequests.delegateCanReview(client, req.user.id, rq))) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Only your own club members' requests" });
      }

      await client.query(
        "UPDATE role_requests SET status=$1, reviewed_by=$2, reviewed_at=now() WHERE id=$3 AND status='pending'",
        [decision, req.user.id, rq.id],
      );

      if (decision === "approved") {
        await client.query(
          "INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [rq.user_id, rq.org_id, rq.requested_role, req.user.id],
        );
        await client.query(
          `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id, note)
           VALUES ($1, $2, $3, 'granted', $4, $5)`,
          [
            rq.user_id,
            rq.org_id,
            rq.requested_role,
            req.user.id,
            "approved from role request",
          ],
        );
        // Bump token_version so the freshly-granted role takes
        // effect on the user's next request without waiting for
        // their current JWT to expire.
        await bumpTokenVersion(client, rq.user_id);
      }

      await client.query("COMMIT");
      sendRoleDecisionEmail(rq.user_id, decision, rq.requested_role);
      res.json({ message: `Request ${decision}` });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Review Request Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // Asking for a role after signup.
  //
  // Signup was the only place a role request could start, so a diver
  // who later wanted to judge, or a coach who signed up as a spectator,
  // had nowhere to go but the sysadmin. These two let a signed-in user
  // see what they can ask for and ask. Routing is exactly signup's:
  // lib/role-requests.js decides who reviews, and the same email goes
  // out. One pending request per role (migration 097 enforces it too).
  // -------------------------------------------------------------
  const RECENT_DECLINE_HOURS = 24;

  async function requestContext(userId) {
    const r = await pool.query(
      `SELECT u.org_id, o.claim_state,
              COALESCE(ARRAY(SELECT r.role::text FROM user_org_roles r
                              WHERE r.user_id = u.id AND r.org_id = u.org_id), ARRAY[]::text[]) AS held
         FROM users u JOIN organisations o ON o.id = u.org_id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    // The Administration org is platform staff, nothing to ask for there.
    const requestable = row.org_id === ADMIN_ORG_ID ? [] : roleRequests.requestableRoles(row.claim_state);
    return { orgId: row.org_id, claimState: row.claim_state, held: row.held, requestable };
  }

  router.get("/api/role-requests/mine", verifyToken, async (req, res) => {
    try {
      const ctx = await requestContext(req.user.id);
      if (!ctx) return res.status(404).json({ error: "User not found" });
      const mine = await pool.query(
        `SELECT id, requested_role::text AS requested_role, status::text AS status,
                note, created_at, reviewed_at
           FROM role_requests
          WHERE user_id = $1 AND org_id = $2
          ORDER BY created_at DESC
          LIMIT 20`,
        [req.user.id, ctx.orgId],
      );
      res.json({
        claim_state: ctx.claimState,
        requestable: ctx.requestable,
        held: ctx.held,
        requests: mine.rows,
      });
    } catch (err) {
      console.error("[My Role Requests Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/role-requests", writeLimiter, verifyToken, async (req, res) => {
    const { role, note } = req.body || {};
    const cleanNote = typeof note === "string"
      ? note.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 500) || null
      : null;
    try {
      const ctx = await requestContext(req.user.id);
      if (!ctx) return res.status(404).json({ error: "User not found" });
      if (typeof role !== "string" || !ctx.requestable.includes(role)) {
        return res.status(400).json({ error: "That role can't be requested here", code: "role_not_requestable" });
      }
      if (ctx.held.includes(role)) {
        return res.status(409).json({ error: "You already have that role", code: "already_held" });
      }
      // Someone told no yesterday gets a day before asking again, so a
      // club admin's inbox can't be flooded by one person re-asking.
      const recent = await pool.query(
        `SELECT 1 FROM role_requests
          WHERE user_id = $1 AND org_id = $2 AND requested_role = $3 AND status = 'rejected'
            AND reviewed_at > now() - make_interval(hours => $4::int)
          LIMIT 1`,
        [req.user.id, ctx.orgId, role, RECENT_DECLINE_HOURS],
      );
      if (recent.rows.length) {
        return res.status(409).json({
          error: "That request was declined recently. You can ask again tomorrow.",
          code: "recently_declined",
        });
      }
      let created;
      try {
        created = (await pool.query(
          `INSERT INTO role_requests (user_id, org_id, requested_role, note)
           VALUES ($1, $2, $3, $4)
           RETURNING id, requested_role::text AS requested_role, status::text AS status, note, created_at`,
          [req.user.id, ctx.orgId, role, cleanNote],
        )).rows[0];
      } catch (err) {
        // role_requests_one_pending (migration 097): already waiting.
        if (err.code === "23505") {
          return res.status(409).json({ error: "You've already asked for that role", code: "already_pending" });
        }
        throw err;
      }
      // Same pulse signup sends, so a reviewer's open dashboard refetches.
      if (io && typeof io.emit === "function") {
        try { io.emit("role_request_created", { org_id: ctx.orgId, requested_role: role }); } catch { /* best effort */ }
      }
      if (typeof sendNewRoleRequestEmail === "function") {
        sendNewRoleRequestEmail(req.user.id, ctx.orgId, role, cleanNote).catch(() => {});
      }
      res.status(201).json(created);
    } catch (err) {
      console.error("[Create Role Request Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update a user's club. Two flows are allowed:
  //   * Self-edit can ONLY clear the club. A club matters for
  //     visibility scoping (rosters, coach links), so a malicious
  //     diver self-assigning into a rival club would be a tenancy
  //     gap. Joining one goes through /api/club-change-requests,
  //     approved by the org admin or, with no federation, by the
  //     club's own admins (routes/club-changes.js).
  //   * Admin (org_admin in target's org / system_admin) can set or
  //     clear any user's club to one in the target's own org.
  router.put("/api/users/:id/club", verifyToken, async (req, res) => {
    const targetId = req.params.id;
    const { club_id } = req.body || {};
    try {
      const target = await pool.query(
        "SELECT org_id FROM users WHERE id = $1",
        [targetId],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "User not found" });
      const targetOrgId = target.rows[0].org_id;

      const isSelf = req.user.id === targetId;
      const isAdmin = isOrgAdminOf(req.user, targetOrgId);

      if (!isSelf && !isAdmin) {
        return res
          .status(403)
          .json({ error: "Cannot change another user's club" });
      }
      // Migration 021: tighten self-edit. Diver can drop their club
      // (say they left it) but can't move into a different one
      // without an admin signing off, otherwise a roster of "Club
      // Foo divers" could get polluted by anyone in the org.
      if (isSelf && !isAdmin && club_id) {
        return res.status(403).json({
          error: "Joining or switching clubs needs approval: send a club change request (Change Club on your profile). You can clear your club yourself.",
        });
      }

      // Only allow assigning a club that belongs to the target's
      // org, and that its federation has approved (a waiting one gets
      // members by being approved, or reject-and-move); empty/null just
      // clears it.
      if (club_id) {
        const club = await pool.query(
          "SELECT id FROM clubs WHERE id = $1 AND org_id = $2 AND status = 'active'",
          [club_id, targetOrgId],
        );
        if (!club.rows.length)
          return res
            .status(400)
            .json({ error: "Club not in your organisation" });
      }

      // Grab the previous club for the audit trail.
      const prev = await pool.query(
        "SELECT u.full_name, u.club_id, c.name AS club_name FROM users u LEFT JOIN clubs c ON c.id = u.club_id WHERE u.id = $1",
        [targetId],
      );
      await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [
        club_id || null,
        targetId,
      ]);
      // Only audit when an admin moves someone (not a self-clear),
      // so the org Audit Log shows who reassigned which diver's club.
      if (!isSelf || isAdmin) {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id: targetOrgId,
          entity_type: "user",
          entity_id: targetId,
          entity_name: prev.rows[0]?.full_name || null,
          action: "user.club_changed",
          metadata: { from_club_id: prev.rows[0]?.club_id || null, to_club_id: club_id || null, direct: true },
        });
      }
      res.json({ message: "Club updated" });
    } catch (err) {
      console.error("[Update Club Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Per-user role audit history. Visible to org_admin within the
  // user's own org, or system_admin across all orgs.
  router.get("/api/users/:id/role-audit", requireOrgAdmin, async (req, res) => {
    try {
      const target = await pool.query(
        "SELECT org_id FROM users WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "User not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot view users in other organisations" });
      }

      const r = await pool.query(
        `SELECT a.id,
                a.role::text   AS role,
                a.action::text AS action,
                a.note,
                a.created_at,
                a.actor_id,
                actor.full_name AS actor_name,
                actor.username  AS actor_username
         FROM role_audit_log a
         LEFT JOIN users actor ON actor.id = a.actor_id
         WHERE a.user_id = $1
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 200`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Role Audit Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/users/me/delete  (Migration 053)
  //
  // Self-service account deletion. Strips every PII column from the
  // user row, wipes settings, push subscriptions, role grants and
  // club / region admin rows, withdraws any claim still being decided
  // and closes any open club change, then stamps deleted_at = now(). What stays: full_name, org_id,
  // club_id, so the user's name remains on the dives they actually
  // competed in (sporting record). See docs/privacy-policy.md §7
  // for the user-facing contract.
  //
  // Body: { password }. We re-verify the current password so a
  // hijacked session can't silently destroy the account, same
  // pattern as the self-service password / email change paths.
  // Rate-limited via bulkWriteLimiter to slow down brute-forcing
  // the password gate.
  //
  // The transaction also bumps token_version, so every
  // currently-issued JWT for this user gets invalidated within the
  // 30s cache TTL, even before the deleted_at gates fire in
  // verifyToken.
  // -------------------------------------------------------------
  router.post("/api/users/me/delete", writeLimiter, verifyToken, async (req, res) => {
    const { password } = req.body || {};
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Password is required" });
    }
    const client = await pool.connect();
    try {
      // Pull the user row first, we need org_id (for the audit row)
      // and password (for the re-auth gate). This read happens
      // OUTSIDE the BEGIN block so a wrong-password early return
      // doesn't open and immediately roll back an empty transaction
      // on every brute-force probe.
      const u = await client.query(
        `SELECT id, password, org_id, deleted_at, full_name
         FROM users WHERE id = $1`,
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user || user.deleted_at != null) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!user.password) {
        // No password hash on the row: that user signed up
        // pre-bcrypt, or had their password column wiped already.
        // Treat it as an auth failure rather than letting them
        // delete without proving identity.
        return res.status(401).json({ error: "Password incorrect" });
      }
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) {
        return res.status(401).json({ error: "Password incorrect" });
      }

      await client.query("BEGIN");

      // The big-redact UPDATE. Keep full_name, org_id, club_id
      // intact, they anchor the historical sporting record and the
      // claim-on-return flow. Rewrite username so a future sign-up
      // choosing the same handle isn't blocked by the UNIQUE
      // constraint; password / email / public_slug go to NULL so
      // duplicate-email checks and the public profile route lose
      // their hooks. The token_version bump invalidates every
      // outstanding JWT immediately.
      // public_slug is NOT NULL in the schema (init.sql line ~191),
      // so we can't just NULL it. To make /diver/<old_slug> 404
      // cleanly we swap in a deterministic placeholder that is NOT
      // a 32-hex string: the public-profile regex check
      // (`/^[0-9a-f]{32}$/i`) rejects it before the DB round-trip,
      // so the slug ends up effectively unreachable.
      await client.query(
        `UPDATE users SET
            password                 = NULL,
            email                    = NULL,
            public_slug              = 'deleted-' || left(id::text, 8),
            totp_secret              = NULL,
            totp_enabled_at          = NULL,
            totp_recovery_codes      = NULL,
            pending_email            = NULL,
            pending_email_token_hash = NULL,
            pending_email_expires_at = NULL,
            locale                   = NULL,
            dashboard_widgets        = NULL,
            judge_dashboard_widgets  = NULL,
            date_of_birth            = NULL,
            gender                   = NULL,
            nationality              = NULL,
            deleted_at               = NOW(),
            token_version            = token_version + 1,
            username                 = 'deleted-' || left(id::text, 8)
         WHERE id = $1`,
        [req.user.id],
      );

      // Cut every link to other people. push_subscriptions also
      // FK-cascades on user delete, but we don't hard-delete the
      // user row here, so wipe these manually. Same story for
      // coach links, role requests, and held grants. Their rowCounts
      // are what the audit row below reports.
      const subRows = await client.query(
        "DELETE FROM push_subscriptions WHERE user_id = $1",
        [req.user.id],
      );
      const coachRows = await client.query(
        `DELETE FROM coach_diver_links
         WHERE coach_id = $1 OR diver_id = $1`,
        [req.user.id],
      );
      const roleReqRows = await client.query(
        "DELETE FROM role_requests WHERE user_id = $1",
        [req.user.id],
      );
      const grantRows = await client.query(
        "DELETE FROM user_org_roles WHERE user_id = $1",
        [req.user.id],
      );
      // Club and region admin rows carry authority now (club-first,
      // migrations 087/088), and a claim of theirs still open could be
      // approved onto this tombstone. Same transaction, so none of it
      // outlives the account.
      const claimsWithdrawn = await claimsLib.withdrawForDeletedUser(client, req.user.id);
      const clubAdminRows = await client.query(
        "DELETE FROM club_admins WHERE user_id = $1", [req.user.id],
      );
      const regionAdminRows = await client.query(
        "DELETE FROM region_admins WHERE user_id = $1", [req.user.id],
      );
      // A join or transfer request still open sat in admins' queues under
      // the kept name, and approving a transfer moved the tombstone into
      // another federation, where claim-candidates can't find it. It goes
      // with the account.
      const clubRequestRows = await client.query(
        `UPDATE club_change_requests SET status = 'rejected', reviewed_by = $1, reviewed_at = now()
          WHERE user_id = $1 AND status = 'pending'`,
        [req.user.id],
      );
      // Guardian links (parent pays for a child) are a link to another
      // person as well. Revoked rather than deleted, the same way a club
      // transfer ends them (routes/club-changes.js), so payment history
      // that points at the link still makes sense.
      await client.query(
        `UPDATE guardians SET status = 'revoked', reviewed_by = $1, reviewed_at = now()
          WHERE (guardian_user_id = $1 OR dependent_user_id = $1)
            AND status IN ('pending', 'approved')`,
        [req.user.id],
      );

      // Audit. Best-effort, recordAudit swallows its own errors.
      // metadata carries summary counts but never any PII, the
      // user's full_name is intentionally left out.
      await recordAudit(client, {
        ...auditFromReq(req),
        org_id: user.org_id,
        entity_type: "user",
        entity_id: user.id,
        entity_name: null,
        action: "user.self_delete",
        metadata: {
          push_subscriptions_removed: subRows.rowCount,
          coach_links_removed:        coachRows.rowCount,
          role_requests_removed:      roleReqRows.rowCount,
          role_grants_removed:        grantRows.rowCount,
          club_admin_rows_removed:    clubAdminRows.rowCount,
          region_admin_rows_removed:  regionAdminRows.rowCount,
          club_requests_closed:       clubRequestRows.rowCount,
          claims_withdrawn:           claimsWithdrawn,
        },
      });

      // Drop the token-version cache entry so the 30s in-process
      // cache can't admit a request from a stale JWT after the
      // commit. This runs inside the still-open transaction so a
      // rollback here also rolls back the version bump above.
      if (typeof bumpTokenVersion === "function") {
        // bumpTokenVersion increments AGAIN, that's intentional:
        // the UPDATE above already bumped it, and this second bump
        // makes sure the in-process cache.delete() actually runs.
        // Total increment of 2 is harmless, nothing depends on the
        // version being monotonic by exactly 1.
        await bumpTokenVersion(client, req.user.id);
      }

      await client.query("COMMIT");
      res.json({ deleted: true });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[User Self-Delete Error]", err.message);
      res.status(500).json({ error: "Account deletion failed" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // POST /api/users/me/claim-candidates  (Migration 053)
  //
  // Reunite-on-return: returns the deleted-user rows in the
  // caller's org that share their full_name (case-insensitive).
  // The caller picks which (if any) are theirs and POSTs to
  // /api/users/me/claim to re-link them.
  //
  // Cross-org candidates are NOT returned. A diver who's moved
  // federations between accounts gets the manual-admin escalation
  // route described in the privacy policy; auto-suggesting a
  // candidate from another org would surface a name + event
  // history pair to anyone who could guess the org boundary.
  //
  // GET would be acceptable here too, we treat it as POST so a
  // future variant that takes a body (say an explicit name override
  // for a married-name change) doesn't have to break the URL shape.
  // -------------------------------------------------------------
  router.post("/api/users/me/claim-candidates", verifyToken, async (req, res) => {
    try {
      // Fetch the current user's identity. We can't trust the JWT
      // alone (it doesn't carry full_name), and we need org_id from
      // the row anyway for the scoping clause.
      const meRes = await pool.query(
        `SELECT id, full_name, org_id, deleted_at
         FROM users WHERE id = $1`,
        [req.user.id],
      );
      const me = meRes.rows[0];
      if (!me || me.deleted_at != null) {
        return res.status(404).json({ error: "User not found" });
      }
      // Look up every deleted user in the same org with the
      // same full_name. The partial index on
      // (org_id, lower(full_name)) WHERE deleted_at IS NOT NULL
      // makes this a constant-time check even on a federation
      // with millions of historical rows.
      const r = await pool.query(
        `SELECT
            u.id,
            u.full_name,
            u.club_id,
            cl.name        AS club_name,
            cl.short_code  AS club_code,
            u.created_at,
            u.deleted_at,
            (SELECT COUNT(*)::int FROM competitor_dive_lists
             WHERE competitor_id = u.id) AS dive_count,
            (SELECT COUNT(DISTINCT event_id)::int FROM event_judges
             WHERE judge_id = u.id) AS panel_count,
            (SELECT COALESCE(
                      array_agg(DISTINCT e.name ORDER BY e.name),
                      ARRAY[]::text[]
                    )
               FROM events e
               WHERE e.id IN (
                 SELECT s.event_id FROM scores s
                 WHERE s.competitor_id = u.id OR s.judge_id = u.id
               )
            ) AS event_names
         FROM users u
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.org_id = $1
           AND u.deleted_at IS NOT NULL
           AND lower(u.full_name) = lower($2)
         ORDER BY u.deleted_at DESC NULLS LAST
         LIMIT 20`,
        [me.org_id, me.full_name],
      );
      res.json({ candidates: r.rows });
    } catch (err) {
      console.error("[Claim Candidates Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/users/me/claim  (Migration 053)
  //
  // Body: { old_user_ids: [uuid, …], password }
  //
  // Re-link every users.id FK reference from each old_user_id over
  // to the caller. Same-org, deleted-only, verified per candidate
  // inside the transaction so a half-valid request can't claim
  // some-but-not-others.
  //
  // The competitor_dive_lists UNIQUE (event_id, competitor_id,
  // round_number) constraint creates a merge conflict surface: if
  // the new account already has an entry for (event, round) that
  // the old account also entered, we can't silently merge them,
  // they're distinct entries by design. We abort the whole
  // transaction with 409 in that case; the caller decides whether
  // to un-tick the colliding candidate or ask support to merge by
  // hand (nobody in the org can, it's a database job).
  //
  // Password re-auth: claim irreversibly attaches PII to an
  // account, so the same hijacked-session defence we use on
  // delete applies here too.
  // -------------------------------------------------------------
  router.post("/api/users/me/claim", writeLimiter, verifyToken, async (req, res) => {
    const { old_user_ids, password } = req.body || {};
    if (!Array.isArray(old_user_ids) || old_user_ids.length === 0) {
      return res.status(400).json({ error: "old_user_ids must be a non-empty array" });
    }
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Password is required" });
    }
    // Cap the batch so a runaway client (or a malicious one) cant
    // ask us to merge thousands of rows in one transaction.
    if (old_user_ids.length > 50) {
      return res.status(400).json({ error: "Too many candidates in one request (max 50)" });
    }
    const client = await pool.connect();
    try {
      const meRes = await client.query(
        `SELECT id, password, org_id, full_name, deleted_at
         FROM users WHERE id = $1`,
        [req.user.id],
      );
      const me = meRes.rows[0];
      if (!me || me.deleted_at != null || !me.password) {
        return res.status(404).json({ error: "User not found" });
      }
      const ok = await bcrypt.compare(password, me.password);
      if (!ok) {
        return res.status(401).json({ error: "Password incorrect" });
      }

      await client.query("BEGIN");

      const claimed = [];
      const counts = { dives: 0, scores: 0, panels: 0, audits: 0 };

      for (const oldId of old_user_ids) {
        // Validate same-org, deleted-only. Anything else is a 404
        // (not a 403) so we don't leak whether the id exists in a
        // different org.
        const oldRes = await client.query(
          `SELECT id, org_id, full_name, deleted_at
           FROM users WHERE id = $1`,
          [oldId],
        );
        const old = oldRes.rows[0];
        if (!old || old.deleted_at == null || old.org_id !== me.org_id) {
          // Idempotent: an already-claimed (hard-deleted) row
          // returns 404 instead of 500. We just continue past it
          // so a partial batch can still succeed for the others.
          continue;
        }

        // Conflict detection: if the new account already has a
        // dive list for the same (event, round) as the old account,
        // we can't merge them. Abort early, the caller can un-tick
        // the colliding candidate and retry.
        const conflict = await client.query(
          `SELECT 1
           FROM competitor_dive_lists a
           JOIN competitor_dive_lists b
             ON a.event_id = b.event_id AND a.round_number = b.round_number
           WHERE a.competitor_id = $1 AND b.competitor_id = $2
           LIMIT 1`,
          [oldId, me.id],
        );
        if (conflict.rows.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error:
              "Cannot merge: the old account and your current account both have entries for the same event and round. " +
              `Untick that one, or contact ${supportContact()} to merge them by hand.`,
            old_user_id: oldId,
          });
        }

        // FK references to users.id that carry sporting-record
        // value (the record books among them, further down). Grep
        // `REFERENCES public.users` over init.sql + migrations/* to
        // keep this list current when new FKs land.
        // Tables NOT touched here are either ON DELETE CASCADE (row
        // goes away when we hard-delete below) or ON DELETE SET
        // NULL (they survive with a null pointer, which is the
        // right call for "who set this" metadata).
        //
        // Tables we explicitly migrate so the historical entry
        // reads under the new account:
        // Dive list rows and the competitor's scores move in ONE statement.
        // scores has a foreign key onto competitor_dive_lists(event_id,
        // competitor_id, round_number) with no ON UPDATE, so moving either
        // side on its own orphans the other and the claim died with a 500
        // for anyone who'd ever been scored. Within one statement the
        // check runs once both have moved.
        const moved = (await client.query(
          `WITH dives AS (
             UPDATE competitor_dive_lists SET competitor_id = $2 WHERE competitor_id = $1 RETURNING 1
           ), comp AS (
             UPDATE scores SET competitor_id = $2 WHERE competitor_id = $1 RETURNING 1
           )
           SELECT (SELECT count(*) FROM dives)::int AS dives, (SELECT count(*) FROM comp)::int AS scores`,
          [oldId, me.id],
        )).rows[0];
        counts.dives += moved.dives;

        // Changing partner_id normally re-snapshots the partner's club
        // and region (cdl_snapshot_rep, migration 095), since it usually
        // means a different person. Here it's the same diver under another
        // account, so keep what they were entered as, the way the
        // competitor_id move above does. Local to this transaction.
        await client.query("SELECT set_config('divinghq.keep_rep_snapshot', 'on', true)");
        await client.query(
          `UPDATE competitor_dive_lists
              SET partner_id = $2
            WHERE partner_id = $1`,
          [oldId, me.id],
        );

        const moveScoresJudge = await client.query(
          `UPDATE scores SET judge_id = $2 WHERE judge_id = $1`,
          [oldId, me.id],
        );
        counts.scores += moved.scores + (moveScoresJudge.rowCount || 0);

        const movePanels = await client.query(
          `UPDATE event_judges SET judge_id = $2 WHERE judge_id = $1`,
          [oldId, me.id],
        );
        counts.panels += movePanels.rowCount || 0;

        // score_audit_log carries competitor_id + judge_id +
        // actor_user_id, all ON DELETE SET NULL. Move them to the
        // new owner so the audit trail keeps showing the same name.
        await client.query(
          `UPDATE score_audit_log SET competitor_id = $2 WHERE competitor_id = $1`,
          [oldId, me.id],
        );
        await client.query(
          `UPDATE score_audit_log SET judge_id = $2 WHERE judge_id = $1`,
          [oldId, me.id],
        );
        await client.query(
          `UPDATE score_audit_log SET actor_user_id = $2 WHERE actor_user_id = $1`,
          [oldId, me.id],
        );
        counts.audits += 1;

        // Event attendance is ON DELETE CASCADE on the user FK, so
        // move it to preserve the history rather than losing it
        // when we delete the shell row below.
        await client.query(
          `UPDATE event_attendance SET competitor_id = $2 WHERE competitor_id = $1`,
          [oldId, me.id],
        );

        // Tie-break dive-offs: competitor_a_id / competitor_b_id are
        // NOT NULL ON DELETE CASCADE, so the shell-row delete below
        // would otherwise wipe out the dive-off record (which this
        // block's comment always claimed to preserve). Re-point both
        // sides AND winner_id in ONE UPDATE: the
        // tiebreak_winner_is_competitor CHECK (winner_id has to
        // equal a or b) is evaluated per-statement, so migrating
        // winner_id in a separate query would transiently violate it.
        await client.query(
          `UPDATE tiebreak_dive_offs
              SET competitor_a_id = CASE WHEN competitor_a_id = $1 THEN $2 ELSE competitor_a_id END,
                  competitor_b_id = CASE WHEN competitor_b_id = $1 THEN $2 ELSE competitor_b_id END,
                  winner_id       = CASE WHEN winner_id       = $1 THEN $2 ELSE winner_id END
            WHERE competitor_a_id = $1 OR competitor_b_id = $1 OR winner_id = $1`,
          [oldId, me.id],
        );

        // Record books. records_personal.user_id and holder_id on the
        // club, region and federation books are ON DELETE CASCADE, so the
        // delete below used to wipe every record the old account held,
        // leaving that dive's book empty (the mark it had replaced sits in
        // history, nothing puts it back). Move them. A personal best can
        // collide with one the new account already has for the same dive:
        // the better one stays (the earlier on a tie) and the other goes
        // to history, same as a beaten record.
        const pbClash = (await client.query(
          `SELECT o.id AS old_row, n.id AS new_row,
                  (o.score > n.score OR (o.score = n.score AND o.set_at <= n.set_at)) AS old_wins
             FROM records_personal o
             JOIN records_personal n
               ON n.user_id = $2 AND n.gender = o.gender AND n.height = o.height
              AND n.dive_code = o.dive_code AND n.position = o.position
            WHERE o.user_id = $1`,
          [oldId, me.id],
        )).rows;
        for (const c of pbClash) {
          const loser = c.old_wins ? c.new_row : c.old_row;
          await client.query(
            `INSERT INTO records_personal_history
               (user_id, gender, height, dive_code, position, score, prev_score, event_id, set_at)
             SELECT $2, gender, height, dive_code, position, score, prev_score, event_id, set_at
               FROM records_personal WHERE id = $1`,
            [loser, me.id],
          );
          await client.query("DELETE FROM records_personal WHERE id = $1", [loser]);
        }
        const moveRecords = await client.query(
          "UPDATE records_personal SET user_id = $2 WHERE user_id = $1", [oldId, me.id],
        );
        let recordsMoved = moveRecords.rowCount || 0;
        for (const tbl of ["records_club", "records_region", "records_federation", "records_continental"]) {
          const held = await client.query(`UPDATE ${tbl} SET holder_id = $2 WHERE holder_id = $1`, [oldId, me.id]);
          recordsMoved += held.rowCount || 0;
        }
        // History has no FKs, so nothing's lost there; this is only so the
        // earlier holders still read under the diver's name.
        await client.query("UPDATE records_personal_history SET user_id = $2 WHERE user_id = $1", [oldId, me.id]);
        for (const tbl of ["records_club_history", "records_region_history", "records_federation_history", "records_continental_history"]) {
          await client.query(`UPDATE ${tbl} SET holder_id = $2 WHERE holder_id = $1`, [oldId, me.id]);
        }

        // Money, teams and memberships. payments.payer_user_id is ON
        // DELETE RESTRICT, so an old account that had ever paid for
        // anything made the delete below throw and the whole claim came
        // back a 500, forever. The rest cascade: team places,
        // memberships, accreditations, fines still owed, entry charges
        // and class enrolments all vanished with the shell row. They're
        // this person's record as much as their dives are, so they move.
        // A team the new account is already on keeps that row, and the
        // old duplicate goes with the delete.
        await client.query(
          `UPDATE payments
              SET payer_user_id   = CASE WHEN payer_user_id   = $1 THEN $2 ELSE payer_user_id END,
                  subject_user_id = CASE WHEN subject_user_id = $1 THEN $2 ELSE subject_user_id END,
                  liable_user_id  = CASE WHEN liable_user_id  = $1 THEN $2 ELSE liable_user_id END
            WHERE payer_user_id = $1 OR subject_user_id = $1 OR liable_user_id = $1`,
          [oldId, me.id],
        );
        await client.query(
          `UPDATE team_members t SET user_id = $2
            WHERE t.user_id = $1
              AND NOT EXISTS (SELECT 1 FROM team_members n WHERE n.team_id = t.team_id AND n.user_id = $2)`,
          [oldId, me.id],
        );
        await client.query("UPDATE memberships SET user_id = $2 WHERE user_id = $1", [oldId, me.id]);
        await client.query("UPDATE official_accreditations SET user_id = $2 WHERE user_id = $1", [oldId, me.id]);
        await client.query("UPDATE fines SET liable_user_id = $2 WHERE liable_user_id = $1", [oldId, me.id]);
        await client.query("UPDATE entry_charges SET entrant_user_id = $2 WHERE entrant_user_id = $1", [oldId, me.id]);
        await client.query("UPDATE class_enrolments SET diver_user_id = $2 WHERE diver_user_id = $1", [oldId, me.id]);

        // The shell row is now disconnected from every
        // sporting-record FK we care about, safe to hard-delete.
        // Everything that ON DELETE CASCADEs from here (e.g.
        // user_org_roles, already wiped at self-delete time) is
        // intentional. Anything left referencing oldId via ON
        // DELETE SET NULL (audit_log.actor_id etc.) becomes NULL,
        // which matches the privacy policy: "Audit log entries are
        // kept for dispute and integrity reasons, then purged on
        // the normal 30-day rotation".
        await client.query("DELETE FROM users WHERE id = $1 AND deleted_at IS NOT NULL", [oldId]);

        claimed.push(oldId);

        // Per-claim audit row so an admin can trace exactly which
        // historical id got re-linked to whom.
        await recordAudit(client, {
          ...auditFromReq(req),
          org_id: me.org_id,
          entity_type: "user",
          entity_id: me.id,
          entity_name: null,
          action: "user.claimed_past_account",
          metadata: {
            old_user_id:        oldId,
            dive_count_moved:   moved.dives,
            score_count_moved:  moved.scores + (moveScoresJudge.rowCount || 0),
            panel_count_moved:  movePanels.rowCount || 0,
            record_count_moved: recordsMoved,
          },
        });
      }

      await client.query("COMMIT");
      res.json({ claimed, counts });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[User Claim Error]", err.message);
      // Both accounts holding the same live thing (one paid entry per
      // event, one live enrolment per class, and so on), or a reference
      // to the old account nothing above moves. Either way it's a merge
      // for a person to look at, not a server fault.
      if (err.code === "23505" || err.code === "23503") {
        return res.status(409).json({
          error: `Cannot merge these accounts automatically: they overlap in ${err.table || "a record"}. `
            + `Untick that one, or contact ${supportContact()} to merge them by hand.`,
          code: "claim_conflict",
        });
      }
      res.status(500).json({ error: "Claim failed" });
    } finally {
      client.release();
    }
  });

  // Judges within the current user's org. Drop username, the judge
  // picker only needs id + full_name; username is the credential
  // identifier and the meet_manager gate isn't a high enough bar to
  // justify spraying it across every response.
  // Club admins pick judges for their own club's meets too, and it's
  // only names of people already holding the judge role in the org.
  router.get("/api/judges", requireMeetOrClubEditor || requireMeetEditor, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name
         FROM users u
         JOIN user_org_roles r ON u.id = r.user_id
         WHERE r.org_id = $1 AND r.role = 'judge'
           AND u.deleted_at IS NULL
         ORDER BY u.full_name ASC`,
        [req.user.org_id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================================
  // ORG-ADMIN PROFILE EDIT + ACCOUNT LIFECYCLE  (migration 058)
  // =============================================================

  // Guard: caller has to be sysadmin or an org_admin of the target's
  // own org. Returns the target row (org_id + a few fields), or
  // null after sending the right error response.
  async function loadEditableTarget(req, res, cols = "org_id, full_name") {
    const t = await pool.query(
      `SELECT ${cols} FROM users WHERE id = $1`, [req.params.id]);
    if (!t.rows.length) { res.status(404).json({ error: "User not found" }); return null; }
    const target = t.rows[0];
    if (!req.user.is_system_admin && target.org_id !== req.user.org_id) {
      res.status(403).json({ error: "Cannot manage a user in another organisation" });
      return null;
    }
    return target;
  }

  // Edit a diver's personal / competition details.
  router.put("/api/users/:id/profile", requireOrgAdmin, async (req, res) => {
    const { full_name, date_of_birth, gender, nationality } = req.body || {};
    try {
      const target = await loadEditableTarget(req, res, "org_id, full_name");
      if (!target) return;
      const sets = [], vals = []; let i = 1;
      if (full_name !== undefined) {
        const fn = String(full_name || "").trim();
        if (!fn || fn.length > 100)
          return res.status(400).json({ error: "Name must be 1–100 characters" });
        sets.push(`full_name = $${i++}`); vals.push(fn);
      }
      if (date_of_birth !== undefined) {
        const dob = date_of_birth || null;
        if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob))
          return res.status(400).json({ error: "Date of birth must be YYYY-MM-DD" });
        sets.push(`date_of_birth = $${i++}`); vals.push(dob);
      }
      if (gender !== undefined) {
        sets.push(`gender = $${i++}`); vals.push(gender ? String(gender).slice(0, 20) : null);
      }
      if (nationality !== undefined) {
        const nat = nationality ? String(nationality).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) : null;
        if (nat && nat.length !== 3)
          return res.status(400).json({ error: "Nationality must be a 3-letter country code" });
        sets.push(`nationality = $${i++}`); vals.push(nat);
      }
      if (!sets.length) return res.status(400).json({ error: "No fields to update" });
      vals.push(req.params.id);
      await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: target.org_id, entity_type: "user",
        entity_id: req.params.id, entity_name: full_name || target.full_name,
        action: "user.profile_updated",
        metadata: { full_name, date_of_birth, gender, nationality },
      });
      res.json({ message: "Profile updated" });
    } catch (err) {
      console.error("[Profile Update]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Suspend an account, blocks login (auth.js gate) until reactivated.
  router.post("/api/users/:id/suspend", requireOrgAdmin, async (req, res) => {
    try {
      const target = await loadEditableTarget(req, res, "org_id, full_name, is_system_admin");
      if (!target) return;
      if (target.is_system_admin)
        return res.status(403).json({ error: "Cannot suspend a system administrator" });
      if (req.params.id === req.user.id)
        return res.status(400).json({ error: "You can't suspend your own account" });
      await pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [req.params.id]);
      // bumpTokenVersion(db, userId): pass the pool as the first arg.
      // Heads up, a single-arg call lands the id in `db`, leaves
      // userId undefined, and the helper's `if (!userId) return;`
      // guard turns it into a silent no-op, which previously left
      // the suspended user's existing JWT valid for up to
      // JWT_EXPIRY. Bumping here revokes every session properly.
      if (typeof bumpTokenVersion === "function") await bumpTokenVersion(pool, req.params.id);
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: target.org_id, entity_type: "user",
        entity_id: req.params.id, entity_name: target.full_name, action: "user.suspended",
      });
      res.json({ message: "Account suspended" });
    } catch (err) {
      console.error("[Suspend]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Lift a suspension.
  router.post("/api/users/:id/reactivate", requireOrgAdmin, async (req, res) => {
    try {
      const target = await loadEditableTarget(req, res, "org_id, full_name");
      if (!target) return;
      await pool.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [req.params.id]);
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: target.org_id, entity_type: "user",
        entity_id: req.params.id, entity_name: target.full_name, action: "user.reactivated",
      });
      res.json({ message: "Account reactivated" });
    } catch (err) {
      console.error("[Reactivate]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Re-send the email-verification link (reuses the register-flow JWT).
  router.post("/api/users/:id/resend-verification", writeLimiter, requireOrgAdmin, async (req, res) => {
    try {
      const target = await loadEditableTarget(req, res, "org_id, full_name, email, email_verified_at, deleted_at");
      if (!target) return;
      if (target.deleted_at) return res.status(404).json({ error: "User not found" });
      if (!target.email) return res.status(400).json({ error: "This user has no email on file" });
      if (target.email_verified_at) return res.status(400).json({ error: "This email is already verified" });
      if (!JWT_SECRET || typeof sendVerifyEmailEmail !== "function")
        return res.status(503).json({ error: "Email is not configured on this server" });
      // No { req }: that's the admin's browser language. With no options
      // the mail goes out in the member's own saved locale.
      sendVerifyEmailEmail(req.params.id, mintVerifyToken(req.params.id), {}).catch(() => {});
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: target.org_id, entity_type: "user",
        entity_id: req.params.id, entity_name: target.full_name, action: "user.verification_resent",
      });
      res.json({ message: "Verification email sent" });
    } catch (err) {
      console.error("[Resend Verification]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Send the user a password-reset link (reuses the forgot-password JWT).
  router.post("/api/users/:id/reset-password", writeLimiter, requireOrgAdmin, async (req, res) => {
    try {
      const target = await loadEditableTarget(req, res, "org_id, full_name, email, password, deleted_at, locale");
      if (!target) return;
      if (target.deleted_at) return res.status(404).json({ error: "User not found" });
      if (!target.email) return res.status(400).json({ error: "This user has no email on file" });
      if (!JWT_SECRET || typeof sendPasswordResetEmail !== "function" || typeof hashFingerprint !== "function")
        return res.status(503).json({ error: "Email is not configured on this server" });
      const token = mintResetToken(req.params.id, hashFingerprint(target.password));
      // The member's language, not the admin's (which is what { req } gave).
      sendPasswordResetEmail(
        { id: req.params.id, full_name: target.full_name, email: target.email },
        token, { locale: target.locale || undefined }).catch(() => {});
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: target.org_id, entity_type: "user",
        entity_id: req.params.id, entity_name: target.full_name, action: "user.password_reset_sent",
      });
      res.json({ message: "Password reset email sent" });
    } catch (err) {
      console.error("[Admin Reset Password]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===============================================================
  // GUARDIAN / DEPENDENT RELATIONSHIPS (Migration 083)
  //
  // A parent or guardian can link to a minor's account so they can
  // pay entry fees, memberships, etc. on the minor's behalf. Links
  // are org-scoped and need org_admin approval.
  // ===============================================================

  // ?include_pending=1 adds the links still waiting for an admin, for the
  // Dependents page, so a parent can see their request went in (and
  // withdraw it). The "Paying for" picker calls it without, and only ever
  // gets approved links.
  router.get("/api/guardians/my-dependents", verifyToken, async (req, res) => {
    const statuses = req.query.include_pending === "1" ? ["approved", "pending"] : ["approved"];
    try {
      // Scoped to the caller's own federation. A guardian link belongs to
      // one org (guardians.org_id) and routes/payments.js won't act on a
      // dependent outside it, so listing one the caller can do nothing for
      // just parks a dead entry in their "Paying for" picker. An org
      // transfer now revokes the link outright (routes/club-changes.js);
      // this filter is the belt to that pair of braces.
      const rows = (await pool.query(
        `SELECT g.id AS guardian_link_id, g.status,
                u.id, u.username, u.full_name, u.date_of_birth
           FROM guardians g
           JOIN users u ON u.id = g.dependent_user_id
          WHERE g.guardian_user_id = $1
            AND g.org_id = $2
            AND g.status = ANY($3::text[])
          ORDER BY g.status = 'pending', u.full_name`,
        [req.user.id, req.user.org_id, statuses],
      )).rows;
      res.json(rows);
    } catch (err) {
      console.error("[Guardians]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Finding the child to link to. The Dependents page used GET /api/users,
  // which is the org admin's member list: a parent got a 403, and an admin
  // got every member of the org (emails and birthdays too) on each
  // keystroke with the search ignored. This is only what a link request
  // can be made for, people in the caller's own federation, and only the
  // name and club come back, the same as the diver search already shows
  // anyone. It doesn't filter to minors on purpose: that would make it a
  // "which members are children" lookup. The request itself checks age.
  router.get("/api/guardians/search", verifyToken, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    if (q.length < 2) return res.json([]);
    // LIKE wildcards in a name are literal here.
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    try {
      const rows = (await pool.query(
        `SELECT u.id, u.full_name, c.name AS club_name
           FROM users u
           LEFT JOIN clubs c ON c.id = u.club_id AND c.status = 'active'
          WHERE u.org_id = $1 AND u.id <> $2 AND u.deleted_at IS NULL
            AND u.full_name ILIKE $3
          ORDER BY u.full_name
          LIMIT 20`,
        [req.user.org_id, req.user.id, pattern],
      )).rows;
      res.json(rows);
    } catch (err) {
      console.error("[Guardians]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/guardians/request", verifyToken, async (req, res) => {
    const { dependent_user_id } = req.body || {};
    if (!dependent_user_id) return res.status(400).json({ error: "dependent_user_id is required" });
    if (dependent_user_id === req.user.id) return res.status(400).json({ error: "Cannot link to yourself" });
    try {
      const dep = (await pool.query(
        "SELECT id, org_id, date_of_birth, full_name FROM users WHERE id = $1",
        [dependent_user_id],
      )).rows[0];
      if (!dep) return res.status(404).json({ error: "User not found" });
      if (dep.org_id !== req.user.org_id) {
        return res.status(400).json({ error: "Guardian and dependent must be in the same organisation" });
      }
      if (!dep.date_of_birth) {
        return res.status(400).json({ error: "Dependent's date of birth must be set before linking" });
      }
      const age = Math.floor((Date.now() - new Date(dep.date_of_birth).getTime()) / (365.25 * 86400000));
      if (age >= 18) {
        return res.status(400).json({ error: "Dependent must be under 18" });
      }
      await pool.query(
        `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id)
         VALUES ($1, $2, $3)`,
        [req.user.org_id, req.user.id, dependent_user_id],
      );
      res.status(201).json({ message: "Request submitted for admin approval" });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "A pending or approved link already exists" });
      console.error("[Guardians]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/guardian-requests", requireOrgAdmin, async (req, res) => {
    try {
      const isSysAdmin = !!req.user.is_system_admin;
      const rows = (await pool.query(
        `SELECT g.id, g.status, g.requested_at, g.org_id,
                gu.id AS guardian_id, gu.full_name AS guardian_name, gu.username AS guardian_username,
                du.id AS dependent_id, du.full_name AS dependent_name, du.username AS dependent_username,
                du.date_of_birth AS dependent_dob
           FROM guardians g
           JOIN users gu ON gu.id = g.guardian_user_id
           JOIN users du ON du.id = g.dependent_user_id
          WHERE g.status = 'pending' AND ($2::boolean OR g.org_id = $1)
          ORDER BY g.requested_at ASC`,
        [req.user.org_id, isSysAdmin],
      )).rows;
      res.json(rows);
    } catch (err) {
      console.error("[Guardians]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/guardian-requests/:id/review", requireOrgAdmin, async (req, res) => {
    const { decision } = req.body || {};
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    }
    try {
      const g = (await pool.query(
        "SELECT * FROM guardians WHERE id = $1",
        [req.params.id],
      )).rows[0];
      if (!g) return res.status(404).json({ error: "Request not found" });
      if (!req.user.is_system_admin && g.org_id !== req.user.org_id) {
        return res.status(403).json({ error: "Cannot review requests in other organisations" });
      }
      // Only a link that's still pending changes, so an approve racing a
      // reject (or a revoke) can't overwrite a decision already made.
      const done = await pool.query(
        `UPDATE guardians SET status = $1, reviewed_by = $2, reviewed_at = now()
          WHERE id = $3 AND status = 'pending' RETURNING id`,
        [decision, req.user.id, g.id],
      );
      if (!done.rowCount) {
        return res.status(409).json({ error: "This request has already been decided", code: "already_decided" });
      }
      res.json({ message: `Guardian request ${decision}` });
    } catch (err) {
      console.error("[Guardians]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Ends an approved link, or withdraws one still waiting for an admin
  // (without that, a request made by mistake sat there for good and asking
  // again was a 409).
  router.post("/api/guardians/:id/revoke", verifyToken, async (req, res) => {
    try {
      const g = (await pool.query(
        "SELECT * FROM guardians WHERE id = $1 AND status IN ('approved', 'pending')",
        [req.params.id],
      )).rows[0];
      if (!g) return res.status(404).json({ error: "Guardian link not found" });
      const isGuardian = g.guardian_user_id === req.user.id;
      const isAdmin = isOrgAdminOf(req.user, g.org_id);
      if (!isGuardian && !isAdmin) return res.status(403).json({ error: "Forbidden" });
      await pool.query(
        `UPDATE guardians SET status = 'revoked', reviewed_by = $1, reviewed_at = now()
          WHERE id = $2 AND status IN ('approved', 'pending')`,
        [req.user.id, g.id],
      );
      res.json({ message: "Guardian link revoked" });
    } catch (err) {
      console.error("[Guardians]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
