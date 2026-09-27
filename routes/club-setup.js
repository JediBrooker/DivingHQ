// Club setup: what a club admin needs in their first week.
//
//   GET /api/clubs/:id/setup        the club's code, the parts of its invite
//                                   link, and enough counts for the dashboard's
//                                   "Get started" panel to tick itself off
//   PUT /api/clubs/:id/short-code   set or clear the club's short code
//
// Who can read: the club's own admins, the org's admins, the sysadmin.
// Who can set the code follows PUT /api/clubs/:id/region (routes/regions.js):
// under a federation the federation decides (it has the Clubs screen for
// that), where the clubs started the country themselves the club does.
//
// The short code matters more once represent_as defaults to 'club' for club
// meets, since it's what shows next to every diver. A club with no code
// falls back to the country, which is exactly the "why does everyone say
// AUS" moment we're trying to get founders past.

const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");
// Letters in any script, digits and dashes, up to eight. Shared with the
// approve dialog so a code can't pass one and fail the other.
const { CLUB_CODE_RE: CODE_RE } = require("../lib/club-approvals");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = function createClubSetupRouter({ pool, verifyToken }) {
  if (!pool || !verifyToken) throw new Error("createClubSetupRouter requires { pool, verifyToken }");
  const router = express.Router();

  const isOrgAdminOf = (user, orgId) =>
    !!user.is_system_admin
    || ((user.org_roles || []).includes("org_admin") && user.org_id === orgId);

  // The club, if the caller may see it; otherwise writes the 404/403 and
  // returns null. Outside the caller's org it's a 404, same as a club
  // that doesn't exist.
  async function loadClub(req, res) {
    if (!UUID_RE.test(String(req.params.id))) {
      res.status(404).json({ error: "Club not found" });
      return null;
    }
    const r = await pool.query(
      `SELECT c.id, c.org_id, c.name, c.short_code, c.status, o.country_code, o.claim_state,
              EXISTS (SELECT 1 FROM club_admins ca
                       WHERE ca.club_id = c.id AND ca.user_id = $2) AS caller_is_admin
         FROM clubs c JOIN organisations o ON o.id = c.org_id
        WHERE c.id = $1 AND ($3::boolean OR c.org_id = $4)`,
      [req.params.id, req.user.id, !!req.user.is_system_admin, req.user.org_id],
    );
    const club = r.rows[0];
    if (!club) {
      res.status(404).json({ error: "Club not found" });
      return null;
    }
    if (!club.caller_is_admin && !isOrgAdminOf(req.user, club.org_id)) {
      res.status(403).json({ error: "Forbidden" });
      return null;
    }
    // No setup for a club still waiting on its federation: its invite link
    // would lead to a club signup refuses, and the approve dialog is where
    // its code gets fixed (migration 096).
    if (club.status === "pending") {
      res.status(409).json({ error: "Approve or reject this club first", code: "club_pending" });
      return null;
    }
    club.canEditCode = isOrgAdminOf(req.user, club.org_id)
      || (club.claim_state === "unclaimed" && club.caller_is_admin);
    return club;
  }

  router.get("/api/clubs/:id/setup", verifyToken, async (req, res) => {
    try {
      const club = await loadClub(req, res);
      if (!club) return;
      const counts = await pool.query(
        `SELECT (SELECT count(*)::int FROM users
                  WHERE club_id = $1 AND deleted_at IS NULL) AS member_count,
                EXISTS (SELECT 1 FROM users
                         WHERE id = $2 AND club_id = $1) AS you_are_member,
                (SELECT count(*)::int FROM meets WHERE host_club_id = $1) AS meet_count`,
        [club.id, req.user.id],
      );
      res.json({
        id:             club.id,
        name:           club.name,
        short_code:     club.short_code,
        // The invite link is /register?country=<this>&club=<id>. Null for
        // an org with no country (the sysadmin's own), where there's no
        // signup to point anyone at.
        country_code:   club.country_code || null,
        claim_state:    club.claim_state,
        can_edit_code:  club.canEditCode,
        ...counts.rows[0],
      });
    } catch (err) {
      console.error("[Club Setup Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/clubs/:id/short-code", verifyToken, async (req, res) => {
    // Clearing is an explicit null or "", never a body that forgot the field.
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, "short_code")) {
      return res.status(400).json({ error: "short_code is required (null clears it)" });
    }
    const raw = req.body.short_code;
    if (raw !== null && typeof raw !== "string") {
      return res.status(400).json({ error: "short_code must be a string or null" });
    }
    // Upper case like country codes, so "syd" and "SYD" can't both exist.
    const code = typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase() : null;
    if (code && !CODE_RE.test(code)) {
      return res.status(400).json({ error: "Use up to 8 letters, numbers or dashes", code: "bad_short_code" });
    }
    try {
      const club = await loadClub(req, res);
      if (!club) return;
      if (!club.canEditCode) {
        return res.status(403).json({ error: "Your federation sets your club's code" });
      }
      if (code) {
        // Two clubs showing the same code would make the club label
        // useless, so a clash within the org is refused.
        const clash = await pool.query(
          "SELECT 1 FROM clubs WHERE org_id = $1 AND upper(short_code) = $2 AND id <> $3 LIMIT 1",
          [club.org_id, code, club.id],
        );
        if (clash.rows.length) {
          return res.status(409).json({ error: "Another club already uses that code", code: "short_code_taken" });
        }
      }
      await pool.query("UPDATE clubs SET short_code = $1 WHERE id = $2", [code, club.id]);
      if ((club.short_code || null) !== code) {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id: club.org_id, entity_type: "club", entity_id: club.id, entity_name: club.name,
          action: "club.code_changed", metadata: { from: club.short_code || null, to: code },
        });
      }
      res.json({ ok: true, short_code: code });
    } catch (err) {
      console.error("[Club Short Code Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
