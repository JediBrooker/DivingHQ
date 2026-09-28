// Saved event templates for the Meet Manager's create form.
//
//   GET    /api/event-templates       this org's templates, by name
//   POST   /api/event-templates       upsert by (org_id, name)
//   DELETE /api/event-templates/:id   remove one
//
// A manager saves the create form's settings once ("WA U16 Women 3m") and
// applies them to later events with a click. config is the form state as
// jsonb, so new event fields don't need a migration here (table from
// migration 013).
//
// These handlers lived in server.js and got lost when the events routes
// moved out to their own file (b63a883). The Manager kept calling them,
// so the saved-templates strip was always empty and Save / Delete failed
// with a 404. This puts them back as they were: org editors only, scoped
// to the caller's own org, with the usual sysadmin bypass on delete.
//
// Mounted via:
//   app.use(require('./routes/event-templates')({ pool, requireMeetEditor }))

const express = require("express");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A template is a handful of form fields. Anything this size is a mistake
// (or somebody stuffing the table), not a template.
const MAX_CONFIG_BYTES = 64 * 1024;

module.exports = function createEventTemplatesRouter({ pool, requireMeetEditor }) {
  if (!pool || !requireMeetEditor) {
    throw new Error("createEventTemplatesRouter requires { pool, requireMeetEditor }");
  }
  const router = express.Router();

  router.get("/api/event-templates", requireMeetEditor, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, config, created_at, updated_at
           FROM event_templates
          WHERE org_id = $1
          ORDER BY name ASC`,
        [req.user.org_id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Event Templates List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/event-templates", requireMeetEditor, async (req, res) => {
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
      // Saving under an existing name overwrites it, so a manager can
      // keep refining one template without collecting copies.
      const r = await pool.query(
        `INSERT INTO event_templates (org_id, name, config, created_by, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (org_id, name)
         DO UPDATE SET config = EXCLUDED.config, updated_at = now()
         RETURNING id, name, config, created_at, updated_at`,
        [req.user.org_id, trimmed, json, req.user.id],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Event Template Save Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/event-templates/:id", requireMeetEditor, async (req, res) => {
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(404).json({ error: "Template not found" });
    }
    try {
      const r = await pool.query(
        `DELETE FROM event_templates
          WHERE id = $1 AND ($2::boolean OR org_id = $3)
          RETURNING id`,
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
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
