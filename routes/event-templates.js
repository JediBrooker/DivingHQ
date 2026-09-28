// Saved event templates for the Meet Manager's create form.
//
//   GET    /api/event-templates            the scope's templates, by name
//   POST   /api/event-templates            upsert by name within the scope
//   DELETE /api/event-templates/:id        remove one from the scope
//
// A manager saves the create form's settings once ("WA U16 Women 3m") and
// applies them to later events with a click. config is the form state as
// jsonb, so new event fields don't need a migration here (table from
// migration 013).
//
// WHOSE TEMPLATES
// ---------------
// A template belongs to the organisation that made it, and only that
// organisation's people use it (migration 104). Not hierarchical: a
// federation doesn't see its clubs' templates, a region doesn't see its
// clubs', and a club doesn't see either of theirs. Every verb works in
// one scope, picked with the query string:
//
//   (nothing)         the caller's org: org_admin or meet_manager
//   ?club_id=<id>     that club: its club admins
//   ?region_id=<id>   that region: its region admins
//
// Admin seats are checked with the same SQL the delegate helpers in
// lib/middleware.js use (the holder has to still be in the club's or the
// region's org). An org role doesn't open a club's scope, and a club seat
// doesn't open the org's. The sysadmin can work in any scope and delete
// any template by id.
//
// A club or region row stores org_id NULL (see the migration for why),
// so the org scope's WHERE org_id = $1 can't pick up a club's templates
// even by accident.
//
// Mounted via:
//   app.use(require('./routes/event-templates')({ pool, verifyToken, requireTotpForPrivilegedRoles }))

const express = require("express");
const { isUuid } = require("../lib/uuid");
const { CLUB_SEAT_SQL, REGION_SEAT_SQL } = require("../lib/middleware");
const { t } = require("../lib/server-i18n");

// A template is a handful of form fields. Anything this size is a mistake
// (or somebody stuffing the table), not a template.
const MAX_CONFIG_BYTES = 64 * 1024;

// The roles that work in the org's own templates, same as requireMeetEditor.
const ORG_TEMPLATE_ROLES = ["org_admin", "meet_manager"];

// Per scope: the owner column, and the ON CONFLICT target that matches its
// unique key. The club and region keys are partial indexes, so the
// predicate has to be spelled out for Postgres to infer them. Column names
// only ever come from this table, never from the request.
const SCOPES = {
  org:    { col: "org_id",    conflict: "(org_id, name)" },
  club:   { col: "club_id",   conflict: "(club_id, name) WHERE club_id IS NOT NULL" },
  region: { col: "region_id", conflict: "(region_id, name) WHERE region_id IS NOT NULL" },
};

const COLUMNS = "id, name, config, club_id, region_id, created_at, updated_at";

module.exports = function createEventTemplatesRouter({ pool, verifyToken, requireTotpForPrivilegedRoles }) {
  if (!pool || !verifyToken || !requireTotpForPrivilegedRoles) {
    throw new Error("createEventTemplatesRouter requires { pool, verifyToken, requireTotpForPrivilegedRoles }");
  }
  const router = express.Router();
  const gate = [verifyToken, requireTotpForPrivilegedRoles];

  const present = (v) => v !== undefined && v !== "";

  // Which scope this request is in, and may the caller work there?
  // Resolves { kind, id }, or null once it has answered the request.
  async function resolveScope(req, res) {
    const { club_id: clubId, region_id: regionId } = req.query;
    const sysadmin = !!req.user.is_system_admin;

    if (present(clubId) && present(regionId)) {
      res.status(400).json({ error: "Pick a club or a region, not both" });
      return null;
    }

    if (present(clubId)) {
      if (!isUuid(clubId)) {
        res.status(400).json({ error: "club_id must be a valid id" });
        return null;
      }
      const r = await pool.query(
        `SELECT c.status, EXISTS (${CLUB_SEAT_SQL}) AS seat FROM clubs c WHERE c.id = $1`,
        [clubId, req.user.id],
      );
      const club = r.rows[0];
      // Somebody else's club and one that doesn't exist look the same
      // from outside. Only the sysadmin gets told which it was.
      if (!sysadmin && !club?.seat) {
        res.status(403).json({ error: t(req, "errors.forbidden") });
        return null;
      }
      if (!club) {
        res.status(404).json({ error: "Club not found" });
        return null;
      }
      // A club still waiting on its federation isn't anybody's to run yet
      // (migration 096), so it doesn't get templates either.
      if (club.status === "pending") {
        res.status(409).json({
          error: "This club is still waiting for its federation to approve it",
          code: "club_pending",
        });
        return null;
      }
      return { kind: "club", id: clubId };
    }

    if (present(regionId)) {
      if (!isUuid(regionId)) {
        res.status(400).json({ error: "region_id must be a valid id" });
        return null;
      }
      const r = await pool.query(
        `SELECT EXISTS (${REGION_SEAT_SQL}) AS seat FROM regions rg WHERE rg.id = $1`,
        [regionId, req.user.id],
      );
      const region = r.rows[0];
      if (!sysadmin && !region?.seat) {
        res.status(403).json({ error: t(req, "errors.forbidden") });
        return null;
      }
      if (!region) {
        res.status(404).json({ error: "Region not found" });
        return null;
      }
      return { kind: "region", id: regionId };
    }

    const roles = req.user.org_roles || [];
    if (!sysadmin && !ORG_TEMPLATE_ROLES.some((role) => roles.includes(role))) {
      res.status(403).json({ error: t(req, "errors.forbidden") });
      return null;
    }
    return { kind: "org", id: req.user.org_id };
  }

  router.get("/api/event-templates", gate, async (req, res) => {
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { col } = SCOPES[scope.kind];
      const r = await pool.query(
        `SELECT ${COLUMNS}
           FROM event_templates
          WHERE ${col} = $1
          ORDER BY name ASC`,
        [scope.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Event Templates List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/event-templates", gate, async (req, res) => {
    const { name, config } = req.body || {};
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return res.status(400).json({ error: "Template name is required" });
    if (trimmed.length > 255) return res.status(400).json({ error: "Template name is too long" });
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return res.status(400).json({ error: "config must be an object" });
    }
    const json = JSON.stringify(config);
    if (Buffer.byteLength(json) > MAX_CONFIG_BYTES) {
      return res.status(400).json({ error: "config is too large" });
    }
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { col, conflict } = SCOPES[scope.kind];
      // Saving under an existing name overwrites it, so a manager can
      // keep refining one template without collecting copies. Only
      // within the owner though: the same name at another club, or at
      // the federation, is somebody else's template.
      const r = await pool.query(
        `INSERT INTO event_templates (${col}, name, config, created_by, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT ${conflict}
         DO UPDATE SET config = EXCLUDED.config, updated_at = now()
         RETURNING ${COLUMNS}`,
        [scope.id, trimmed, json, req.user.id],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Event Template Save Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/event-templates/:id", gate, async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "Template not found" });
    }
    try {
      const scope = await resolveScope(req, res);
      if (!scope) return;
      const { col } = SCOPES[scope.kind];
      // Outside the scope it's a 404, same as a template that isn't
      // there, so nobody learns another owner's ids from the answer.
      const r = await pool.query(
        `DELETE FROM event_templates
          WHERE id = $1 AND ($2::boolean OR ${col} = $3)
          RETURNING id`,
        [req.params.id, !!req.user.is_system_admin, scope.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Template not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Event Template Delete Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
