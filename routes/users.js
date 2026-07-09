// User & role management routes.
//
//   GET  /api/users                  list (org_admin within org;
//                                    sysadmin sees every org)
//   PUT  /api/users/:id/roles        replace user's role set
//                                    (atomically diffs + audits)
//   GET  /api/role-requests          pending requests
//   POST /api/role-requests/:id/review  approve / reject
//   PUT  /api/users/:id/club         self-clear OR admin-set club
//   GET  /api/users/:id/role-audit   per-user audit history
//   GET  /api/judges                 list judges in caller's org
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
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const { recordAudit, auditFromReq } = require("../lib/audit");

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
}) {
  if (!pool) throw new Error("createUsersRouter requires { pool, … }");
  const router = express.Router();
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

      // Best-effort audit writes, same pattern as the score audit
      // log: don't let an audit failure roll back the legitimate
      // role change (e.g. before the migration ran).
      try {
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
      } catch (auditErr) {
        console.error("[Role Audit Skipped]", auditErr.message);
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

  router.get("/api/role-requests", requireOrgAdmin, async (req, res) => {
    try {
      const isSysAdmin = !!req.user.is_system_admin;
      const r = await pool.query(
        `SELECT rr.id, rr.requested_role, rr.status, rr.note, rr.created_at,
                rr.org_id, o.name AS org_name, o.country_code,
                u.id AS user_id, u.username, u.full_name
         FROM role_requests rr
         JOIN users u ON rr.user_id = u.id
         JOIN organisations o ON rr.org_id = o.id
         WHERE rr.status = 'pending' AND ($2::boolean OR rr.org_id = $1)
         ORDER BY o.name ASC, rr.created_at ASC`,
        [req.user.org_id, isSysAdmin],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/role-requests/:id/review", requireOrgAdmin, async (req, res) => {
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
      const rqRes = await client.query(
        "SELECT * FROM role_requests WHERE id = $1 AND status = 'pending'",
        [req.params.id],
      );
      if (!rqRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Request not found" });
      }
      const rq = rqRes.rows[0];

      if (!req.user.is_system_admin && rq.org_id !== req.user.org_id) {
        await client.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "Cannot review requests in other organisations" });
      }

      await client.query(
        "UPDATE role_requests SET status=$1, reviewed_by=$2, reviewed_at=now() WHERE id=$3",
        [decision, req.user.id, req.params.id],
      );

      if (decision === "approved") {
        await client.query(
          "INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [rq.user_id, rq.org_id, rq.requested_role, req.user.id],
        );
        try {
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
        } catch (auditErr) {
          console.error("[Role Audit Skipped]", auditErr.message);
        }
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

  // Update a user's club. Two flows are allowed:
  //   * Self-edit can ONLY clear the club. A club matters for
  //     visibility scoping (rosters, coach links), so a malicious
  //     diver self-assigning into a rival club would be a tenancy
  //     gap. Switching club is org_admin-only.
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
      const orgRoles = req.user.org_roles || [];
      const isAdmin =
        req.user.is_system_admin ||
        (orgRoles.includes("org_admin") && targetOrgId === req.user.org_id);

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
          error: "Switching clubs requires an org admin. You can clear your club yourself.",
        });
      }

      // Only allow assigning a club that belongs to the target's
      // org; empty/null just clears it.
      if (club_id) {
        const club = await pool.query(
          "SELECT id FROM clubs WHERE id = $1 AND org_id = $2",
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
  // user row, wipes settings, push subscriptions, and role grants,
  // then stamps deleted_at = now(). What stays: full_name, org_id,
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

      // Count the side-effect deletes BEFORE we run them so the
      // audit-log metadata has accurate numbers. Cheap enough,
      // these are tiny per-user tables.
      const subCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1",
        [req.user.id],
      );
      const coachCount = await client.query(
        `SELECT COUNT(*)::int AS n FROM coach_diver_links
         WHERE coach_id = $1 OR diver_id = $1`,
        [req.user.id],
      );
      const roleReqCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM role_requests WHERE user_id = $1",
        [req.user.id],
      );
      const grantCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM user_org_roles WHERE user_id = $1",
        [req.user.id],
      );

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
            deleted_at               = NOW(),
            token_version            = token_version + 1,
            username                 = 'deleted-' || left(id::text, 8)
         WHERE id = $1`,
        [req.user.id],
      );

      // Cut every link to other people. push_subscriptions also
      // FK-cascades on user delete, but we don't hard-delete the
      // user row here, so wipe these manually. Same story for
      // coach links, role requests, and held grants.
      await client.query(
        "DELETE FROM push_subscriptions WHERE user_id = $1",
        [req.user.id],
      );
      await client.query(
        `DELETE FROM coach_diver_links
         WHERE coach_id = $1 OR diver_id = $1`,
        [req.user.id],
      );
      await client.query(
        "DELETE FROM role_requests WHERE user_id = $1",
        [req.user.id],
      );
      await client.query(
        "DELETE FROM user_org_roles WHERE user_id = $1",
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
          push_subscriptions_removed: subCount.rows[0].n,
          coach_links_removed:        coachCount.rows[0].n,
          role_requests_removed:      roleReqCount.rows[0].n,
          role_grants_removed:        grantCount.rows[0].n,
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
  // to un-tick the colliding candidate or contact an admin to
  // merge manually.
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
              "Contact your federation admin to merge manually.",
            old_user_id: oldId,
          });
        }

        // FK references to users.id that carry sporting-record
        // value. Grep `REFERENCES public.users` over init.sql +
        // migrations/* to keep this list current when new FKs land.
        // Tables NOT touched here are either ON DELETE CASCADE (row
        // goes away when we hard-delete below) or ON DELETE SET
        // NULL (they survive with a null pointer, which is the
        // right call for "who set this" metadata).
        //
        // Tables we explicitly migrate so the historical entry
        // reads under the new account:
        const moveDives = await client.query(
          `UPDATE competitor_dive_lists
              SET competitor_id = $2
            WHERE competitor_id = $1`,
          [oldId, me.id],
        );
        counts.dives += moveDives.rowCount || 0;

        await client.query(
          `UPDATE competitor_dive_lists
              SET partner_id = $2
            WHERE partner_id = $1`,
          [oldId, me.id],
        );

        const moveScoresComp = await client.query(
          `UPDATE scores SET competitor_id = $2 WHERE competitor_id = $1`,
          [oldId, me.id],
        );
        const moveScoresJudge = await client.query(
          `UPDATE scores SET judge_id = $2 WHERE judge_id = $1`,
          [oldId, me.id],
        );
        counts.scores += (moveScoresComp.rowCount || 0) +
                         (moveScoresJudge.rowCount || 0);

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
            dive_count_moved:   moveDives.rowCount || 0,
            score_count_moved: (moveScoresComp.rowCount || 0) +
                               (moveScoresJudge.rowCount || 0),
            panel_count_moved:  movePanels.rowCount || 0,
          },
        });
      }

      await client.query("COMMIT");
      res.json({ claimed, counts });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[User Claim Error]", err.message);
      res.status(500).json({ error: "Claim failed" });
    } finally {
      client.release();
    }
  });

  // Judges within the current user's org. Drop username, the judge
  // picker only needs id + full_name; username is the credential
  // identifier and the meet_manager gate isn't a high enough bar to
  // justify spraying it across every response.
  router.get("/api/judges", requireMeetEditor, async (req, res) => {
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
      const token = jwt.sign({ sub: req.params.id, type: "email_verify" }, JWT_SECRET, { expiresIn: "24h" });
      sendVerifyEmailEmail(req.params.id, token, { req }).catch(() => {});
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
      const target = await loadEditableTarget(req, res, "org_id, full_name, email, password, deleted_at");
      if (!target) return;
      if (target.deleted_at) return res.status(404).json({ error: "User not found" });
      if (!target.email) return res.status(400).json({ error: "This user has no email on file" });
      if (!JWT_SECRET || typeof sendPasswordResetEmail !== "function" || typeof hashFingerprint !== "function")
        return res.status(503).json({ error: "Email is not configured on this server" });
      const token = jwt.sign(
        { sub: req.params.id, type: "password_reset", fp: hashFingerprint(target.password) },
        JWT_SECRET, { expiresIn: "30m" });
      sendPasswordResetEmail(
        { id: req.params.id, full_name: target.full_name, email: target.email },
        token, { req }).catch(() => {});
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

  router.get("/api/guardians/my-dependents", verifyToken, async (req, res) => {
    try {
      const rows = (await pool.query(
        `SELECT g.id AS guardian_link_id, g.status,
                u.id, u.username, u.full_name, u.date_of_birth
           FROM guardians g
           JOIN users u ON u.id = g.dependent_user_id
          WHERE g.guardian_user_id = $1 AND g.status = 'approved'
          ORDER BY u.full_name`,
        [req.user.id],
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
        "SELECT * FROM guardians WHERE id = $1 AND status = 'pending'",
        [req.params.id],
      )).rows[0];
      if (!g) return res.status(404).json({ error: "Request not found" });
      if (!req.user.is_system_admin && g.org_id !== req.user.org_id) {
        return res.status(403).json({ error: "Cannot review requests in other organisations" });
      }
      await pool.query(
        "UPDATE guardians SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3",
        [decision, req.user.id, req.params.id],
      );
      res.json({ message: `Guardian request ${decision}` });
    } catch (err) {
      console.error("[Guardians]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/guardians/:id/revoke", verifyToken, async (req, res) => {
    try {
      const g = (await pool.query(
        "SELECT * FROM guardians WHERE id = $1 AND status = 'approved'",
        [req.params.id],
      )).rows[0];
      if (!g) return res.status(404).json({ error: "Guardian link not found" });
      const isGuardian = g.guardian_user_id === req.user.id;
      const isAdmin = req.user.is_system_admin || (
        req.user.org_id === g.org_id &&
        (req.user.org_roles || []).includes("org_admin")
      );
      if (!isGuardian && !isAdmin) return res.status(403).json({ error: "Forbidden" });
      await pool.query(
        "UPDATE guardians SET status = 'revoked', reviewed_by = $1, reviewed_at = now() WHERE id = $2",
        [req.user.id, req.params.id],
      );
      res.json({ message: "Guardian link revoked" });
    } catch (err) {
      console.error("[Guardians]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
