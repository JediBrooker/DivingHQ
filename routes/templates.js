// Per-diver dive-list templates. Each user can save a named
// list of dives keyed to a board height; CompetitorView's
// "Save as template" / "Load template" UI maps to these.
//
//   GET    /api/templates       list this user's templates
//   POST   /api/templates       upsert by (user_id, name)
//   DELETE /api/templates/:id   remove
//
// All three are scoped to the calling user, no org context, no
// cross-user reads. Storage is jsonb so the dive array stays
// schema-flexible (round_number, dive_code, position, optional
// height; future fields land without a migration).
//
// Mounted via:
//   app.use(require('./routes/templates')({ pool, verifyToken }))

const express = require("express");

module.exports = function createTemplatesRouter({ pool, verifyToken }) {
  if (!pool) throw new Error("createTemplatesRouter requires { pool, verifyToken }");
  const router = express.Router();

  router.get("/api/templates", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, height, dives, created_at, updated_at
         FROM dive_list_templates
         WHERE user_id = $1
         ORDER BY updated_at DESC`,
        [req.user.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Templates List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.post("/api/templates", verifyToken, async (req, res) => {
    const { name, height, dives } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Template name is required" });
    }
    if (!Array.isArray(dives)) {
      return res.status(400).json({ error: "dives must be an array" });
    }
    try {
      const r = await pool.query(
        `INSERT INTO dive_list_templates (user_id, name, height, dives, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (user_id, name)
         DO UPDATE SET
           height     = EXCLUDED.height,
           dives      = EXCLUDED.dives,
           updated_at = now()
         RETURNING id, name, height, dives, created_at, updated_at`,
        [req.user.id, name.trim(), height || null, JSON.stringify(dives)],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Template Save Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/templates/:id", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        "DELETE FROM dive_list_templates WHERE id = $1 AND user_id = $2 RETURNING id",
        [req.params.id, req.user.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Template not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Template Delete Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
