// Cross-org diver search + browse routes, pulled out of server.js
// to keep the monolith from growing further. The Compare page is
// the primary consumer:
//   GET /api/divers/search  : typeahead, used by autocomplete inputs
//   GET /api/divers         : paginated list with filters (browse modal)
//   GET /api/orgs/all       : lightweight org list for filter dropdowns
//
// All three require a valid JWT (any role, including spectator) but
// no org-scope check, since the diver's full name, org and club are
// already public via the meet scoreboards and the archive.
//
// SECURITY (Migration 021): we deliberately drop `username` from
// these payloads. Username is the credential identifier used by
// /api/auth/login, so leaking it cross-org turns this into a
// credential-stuffing input. The Compare UI only ever uses
// (full_name, club_code) as the human label.

const express = require("express");

module.exports = function createDiverSearchRouter({ pool, verifyToken }) {
  const router = express.Router();

  // Cross-org diver autocomplete. Min 2 chars, ≤20 results, ranks
  // prefix matches above contains-anywhere. Parameterised, so no SQL
  // injection surface even though the LIKE pattern is built from
  // user input (it's bound, not interpolated).
  router.get("/api/divers/search", verifyToken, async (req, res) => {
    const q = (req.query.q || "").trim();
    if (q.length < 2) return res.json([]);
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name,
                o.id AS org_id, o.name AS org_name, o.country_code,
                cl.id AS club_id, cl.name AS club_name, cl.short_code AS club_code
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
         JOIN organisations o  ON o.id = u.org_id
         LEFT JOIN clubs cl    ON cl.id = u.club_id
         WHERE u.full_name ILIKE $1
           AND u.deleted_at IS NULL
         ORDER BY
           /* prefix match wins over contains-anywhere */
           CASE WHEN u.full_name ILIKE $2 THEN 0 ELSE 1 END,
           u.full_name ASC
         LIMIT 20`,
        [`%${q}%`, `${q}%`],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Diver Search Error]", err.message);
      res.status(500).json([]);
    }
  });

  // Browse-all paginated diver list; limit clamped to [1, 100].
  router.get("/api/divers", verifyToken, async (req, res) => {
    const q           = (req.query.q || "").trim();
    const orgId       = req.query.org_id || null;
    const clubId      = req.query.club_id || null;
    const countryCode = (req.query.country_code || "").trim().toUpperCase() || null;
    const limit       = Math.min(Math.max(Number(req.query.limit)  || 50, 1), 100);
    const offset      = Math.max(Number(req.query.offset) || 0, 0);
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name,
                o.id AS org_id, o.name AS org_name, o.country_code,
                cl.id AS club_id, cl.name AS club_name, cl.short_code AS club_code,
                COUNT(*) OVER ()::int AS total_count
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
         JOIN organisations o  ON o.id = u.org_id
         LEFT JOIN clubs cl    ON cl.id = u.club_id
         WHERE ($1::text IS NULL OR u.full_name ILIKE $1)
           AND ($2::uuid IS NULL OR u.org_id  = $2::uuid)
           AND ($3::uuid IS NULL OR u.club_id = $3::uuid)
           AND ($4::text IS NULL OR o.country_code = $4::text)
           AND u.deleted_at IS NULL
         ORDER BY u.full_name ASC
         LIMIT $5 OFFSET $6`,
        [
          q ? `%${q}%` : null,
          orgId,
          clubId,
          countryCode,
          limit,
          offset,
        ],
      );
      const total = r.rows[0]?.total_count ?? 0;
      res.json({
        total,
        limit,
        offset,
        rows: r.rows.map(({ total_count, ...rest }) => rest),
      });
    } catch (err) {
      console.error("[Diver Browse Error]", err.message);
      res.status(500).json({ total: 0, limit, offset, rows: [] });
    }
  });

  // Lightweight org listing for the browse-all filter dropdowns,
  // nothing fancy.
  router.get("/api/orgs/all", verifyToken, async (_req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, country_code
         FROM organisations
         WHERE status = 'active'
         ORDER BY name ASC`,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Orgs List Error]", err.message);
      res.status(500).json([]);
    }
  });

  return router;
};
