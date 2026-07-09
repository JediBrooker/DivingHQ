// Dive directory: the World Aquatics dive catalog (~830 rows)
// loaded by init.sql, plus org-specific custom rows added through
// the SPA's Dive Directory page.
//
//   GET    /api/dive-directory          full catalog (core + custom)
//   POST   /api/dive-directory          add a custom row
//   PUT    /api/dive-directory/:id      update a custom row
//   DELETE /api/dive-directory/:id      delete a custom row
//
// Core rows (is_custom = false) are immutable through the API.
// Custom rows can only be edited/deleted by a user in the same
// org that originally created them. Both gates fall through to
// 403 / 404 so the API doesn't double as an enumeration tool.
//
// Mounted via:
//   app.use(require('./routes/dive-directory')({ pool, verifyToken }))

const express = require("express");

// Whitelist of dive_position enum values. Watch out, this has to
// match the dive_position enum in init.sql. A typo here would
// silently let the DB reject the insert with a less helpful error
// message.
const DIVE_POSITIONS = new Set(["A", "B", "C", "D"]);
// board_height enum (matches init.sql's board_height ENUM). Used
// to validate the height string before the cast. The height
// column on dive_directory itself is numeric(3,1), but events use
// the enum, so we keep the strings aligned.
const HEIGHT_LABELS = new Set(["0m", "1m", "3m", "5m", "7.5m", "10m"]);

// Convert a height string like "7.5m" / "10m" / "0m" to its
// numeric value (the dive_directory.height column is numeric).
function heightToNumber(s) {
  if (typeof s !== "string") return NaN;
  return parseFloat(s.replace(/m$/i, ""));
}

// Range guard for DD. World Aquatics tariffs sit between 1.0
// and ~4.8; coaches inventing poolside drills can use lower
// numbers (0.5 for a sit-dive isn't unreasonable). 0.1 floor is
// the minimum granularity calc_event_dive_points expects.
function isValidDD(dd) {
  const n = Number(dd);
  return Number.isFinite(n) && n >= 0.1 && n <= 9.9;
}

// dive_code is "<group><somersaults><twists?><flying?>", 2–6
// alphanumeric chars. Strict regex so a "FORWARD" or empty string
// can't bypass and end up as a label that the autocomplete won't
// match.
function isValidDiveCode(code) {
  return typeof code === "string" && /^[0-9A-Za-z]{2,6}$/.test(code);
}

module.exports = function createDiveDirectoryRouter({ pool, verifyToken, requireOrgRole }) {
  if (!pool) throw new Error("createDiveDirectoryRouter requires { pool, verifyToken }");
  const router = express.Router();

  // Write access (POST / PUT / DELETE) is restricted to roles
  // that have a legitimate reason to maintain a dive list:
  //   - org_admin     ("org manager" in the product copy)
  //   - meet_manager
  //   - referee
  //   - judge
  //   - coach
  // System admins bypass via requireOrgRole's built-in
  // is_system_admin shortcut. FYI divers, spectators, etc. can
  // read the catalog but not modify it.
  //
  // requireOrgRole is optional in the factory signature so the
  // existing test setups that mount this router with the smaller
  // dependency set don't crash; falls back to the bare
  // verifyToken (read-only equivalent) which still rejects the
  // anonymous case but doesn't enforce the role list.
  const STAFF_ROLES = ["org_admin", "meet_manager", "referee", "judge", "coach"];
  const requireStaff = requireOrgRole
    ? requireOrgRole(STAFF_ROLES)
    : verifyToken;

  // -----------------------------------------------------------
  // GET /api/dive-directory: full catalog. is_custom + created_by
  // + created_org_id surface so the SPA can show edit/delete
  // controls for the rows the current org owns.
  // -----------------------------------------------------------
  router.get("/api/dive-directory", verifyToken, async (req, res) => {
    try {
      // in_use surfaces "this dive has been filed on a roster or
      // scored in a meet" so the SPA can lock its row from edits /
      // deletion. The two EXISTS subqueries short-circuit so this
      // doesn't materially slow the catalog read on large
      // databases. Core rows commonly hit this on day one of any
      // active org; custom rows are independently tracked so a
      // newly added drill stays editable until it's picked up by
      // a diver's list.
      const r = await pool.query(
        `SELECT dd.id, dd.dive_code, dd.height, dd.position, dd.dd,
                dd.description,
                dd.is_custom, dd.created_by, dd.created_org_id, dd.created_at,
                (EXISTS (SELECT 1 FROM competitor_dive_lists cdl WHERE cdl.dive_id = dd.id)
                 OR EXISTS (SELECT 1 FROM scores s              WHERE s.dive_id   = dd.id))
                  AS in_use
         FROM dive_directory dd
         ORDER BY dd.is_custom ASC, dd.dive_code ASC, dd.height ASC`,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Dive Directory Error]", err.message);
      res.status(500).json([]);
    }
  });

  // Shared pre-flight: refuse mutations on a dive that's already
  // been used in an event. Editing the code / DD / position would
  // retroactively rewrite a published scoreboard or the event
  // archive, which the user explicitly wants locked. Returns null
  // when the dive is free to mutate, or a {status, body} pair
  // ready to send when it isn't. Both PUT and DELETE call this.
  async function rejectIfInUse(diveId) {
    const used = await pool.query(
      `SELECT 1
       WHERE EXISTS (SELECT 1 FROM competitor_dive_lists WHERE dive_id = $1)
          OR EXISTS (SELECT 1 FROM scores WHERE dive_id = $1)
       LIMIT 1`,
      [diveId],
    );
    if (used.rows.length) {
      return {
        status: 409,
        body: {
          error:
            "This dive has already been filed on a roster or scored in a meet, " +
            "so it's locked to keep the scoreboard archive intact. " +
            "Add a new variant instead of changing this one.",
        },
      };
    }
    return null;
  }

  // -----------------------------------------------------------
  // POST /api/dive-directory: add a custom row. Body:
  //   { dive_code, height, position, dd, description? }
  // height accepts the enum string ("3m") and converts to numeric
  // for the dive_directory.height column.
  // -----------------------------------------------------------
  router.post("/api/dive-directory", requireStaff, async (req, res) => {
    if (!req.user?.org_id && !req.user?.is_system_admin) {
      return res.status(403).json({ error: "An org membership is required to add custom dives" });
    }
    const { dive_code, height, position, dd, description } = req.body || {};
    if (!isValidDiveCode(dive_code)) {
      return res.status(400).json({ error: "dive_code must be 2–6 alphanumeric characters" });
    }
    if (!HEIGHT_LABELS.has(String(height))) {
      return res.status(400).json({ error: "height must be one of 0m / 1m / 3m / 5m / 7.5m / 10m" });
    }
    if (!DIVE_POSITIONS.has(String(position))) {
      return res.status(400).json({ error: "position must be A / B / C / D" });
    }
    if (!isValidDD(dd)) {
      return res.status(400).json({ error: "dd must be a number between 0.1 and 9.9" });
    }
    const desc = typeof description === "string"
      ? description.trim().slice(0, 280)
      : null;
    try {
      // Pre-flight dedup check on the full 4-key (dive_code,
      // position, height, dd). Catches the case the user explicitly
      // asked us to refuse ("this exact dive already exists") and
      // produces a more readable 409 than the generic
      // unique_violation that would otherwise trip from the
      // (dive_code, height, position) index. We also flag whether
      // the existing match is core or custom so the operator knows
      // why they're being told no.
      const heightNum = heightToNumber(height);
      const dup = await pool.query(
        `SELECT id, is_custom
         FROM dive_directory
         WHERE dive_code = $1
           AND position  = $2
           AND height    = $3
           AND dd        = $4
         LIMIT 1`,
        [dive_code, position, heightNum, Number(dd)],
      );
      if (dup.rows.length) {
        const existing = dup.rows[0];
        return res.status(409).json({
          error:
            `${existing.is_custom ? "A custom" : "A core"} dive ${dive_code}${position} ` +
            `at ${height} with DD ${Number(dd).toFixed(1)} already exists` +
            (existing.is_custom ? "." : " — use the catalog entry instead of recreating it."),
          existing_id: existing.id,
        });
      }

      const r = await pool.query(
        `INSERT INTO dive_directory
           (dive_code, height, position, dd, description,
            is_custom, created_by, created_org_id)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7)
         RETURNING id, dive_code, height, position, dd, description,
                   is_custom, created_by, created_org_id, created_at`,
        [
          dive_code,
          heightNum,
          position,
          Number(dd),
          desc,
          req.user.id || null,
          req.user.org_id || null,
        ],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      // 23505 = unique_violation on (code, height, position, dd).
      // Migration 026 widened the unique key to include DD, so a
      // custom variant at a different DD is allowed; this branch
      // now only fires on an exact 4-key duplicate that races past
      // the pre-flight above (two parallel POSTs in the same
      // millisecond).
      if (err.code === "23505") {
        return res.status(409).json({
          error:
            `A dive ${dive_code}${position} at ${height} with DD ${Number(dd).toFixed(1)} ` +
            `already exists.`,
        });
      }
      console.error("[Dive Directory Insert Error]", err.message);
      res.status(500).json({ error: "Failed to add custom dive" });
    }
  });

  // -----------------------------------------------------------
  // PUT /api/dive-directory/:id: update an existing custom row.
  // Core rows (is_custom = false) refuse since they're the
  // protected World Aquatics catalog. Cross-org edits also refuse
  // so an org can't tamper with another's drill list.
  // -----------------------------------------------------------
  router.put("/api/dive-directory/:id", requireStaff, async (req, res) => {
    const id = req.params.id;
    const { dive_code, height, position, dd, description } = req.body || {};
    if (dive_code != null && !isValidDiveCode(dive_code)) {
      return res.status(400).json({ error: "dive_code must be 2–6 alphanumeric characters" });
    }
    if (height != null && !HEIGHT_LABELS.has(String(height))) {
      return res.status(400).json({ error: "height must be one of 0m / 1m / 3m / 5m / 7.5m / 10m" });
    }
    if (position != null && !DIVE_POSITIONS.has(String(position))) {
      return res.status(400).json({ error: "position must be A / B / C / D" });
    }
    if (dd != null && !isValidDD(dd)) {
      return res.status(400).json({ error: "dd must be a number between 0.1 and 9.9" });
    }
    try {
      // Single round-trip: gate AND update, returning rows iff
      // both the row exists and the gate passes. NULL row → 404
      // path; gate fail → 403 path. Pull current field values too
      // so the dedup pre-flight below knows the post-update key
      // (the patch is partial, so unchanged fields keep their old
      // value via COALESCE in the UPDATE).
      const owner = await pool.query(
        `SELECT is_custom, created_org_id, dive_code, height, position, dd
         FROM dive_directory WHERE id = $1`,
        [id],
      );
      if (!owner.rows.length) return res.status(404).json({ error: "Dive not found" });
      if (!owner.rows[0].is_custom) {
        return res.status(403).json({ error: "Core dives cannot be edited" });
      }
      if (
        !req.user.is_system_admin
        && owner.rows[0].created_org_id !== req.user.org_id
      ) {
        return res.status(403).json({ error: "Custom dive belongs to another org" });
      }

      // Lock-on-use: editing a dive that's already been filed or
      // scored would rewrite history. Refuse before we touch any
      // fields. The UI hides the Edit button on in-use rows too,
      // but a hand-crafted curl would still hit this gate.
      const lockResult = await rejectIfInUse(id);
      if (lockResult) return res.status(lockResult.status).json(lockResult.body);

      // Project the post-patch state and dedup against any OTHER
      // row matching all 4 keys. Excludes the row being edited so
      // a no-op save (touch description only) doesn't reject
      // itself. Mirrors the POST pre-flight so the same friendly
      // 409 surfaces from either path.
      const newCode   = dive_code ?? owner.rows[0].dive_code;
      const newPos    = position  ?? owner.rows[0].position;
      const newHeight = height != null ? heightToNumber(height) : owner.rows[0].height;
      const newDD     = dd != null ? Number(dd) : Number(owner.rows[0].dd);
      const dup = await pool.query(
        `SELECT id, is_custom
         FROM dive_directory
         WHERE dive_code = $1
           AND position  = $2
           AND height    = $3
           AND dd        = $4
           AND id <> $5
         LIMIT 1`,
        [newCode, newPos, newHeight, newDD, id],
      );
      if (dup.rows.length) {
        const existing = dup.rows[0];
        return res.status(409).json({
          error:
            `${existing.is_custom ? "A custom" : "A core"} dive ${newCode}${newPos} ` +
            `at ${newHeight}m with DD ${newDD.toFixed(1)} already exists` +
            (existing.is_custom ? "." : " — use the catalog entry instead."),
          existing_id: existing.id,
        });
      }

      const desc = typeof description === "string"
        ? description.trim().slice(0, 280)
        : description;
      const r = await pool.query(
        `UPDATE dive_directory SET
           dive_code   = COALESCE($1, dive_code),
           height      = COALESCE($2, height),
           position    = COALESCE($3, position),
           dd          = COALESCE($4, dd),
           description = COALESCE($5, description)
         WHERE id = $6
         RETURNING id, dive_code, height, position, dd, description,
                   is_custom, created_by, created_org_id, created_at`,
        [
          dive_code ?? null,
          height != null ? heightToNumber(height) : null,
          position ?? null,
          dd != null ? Number(dd) : null,
          desc ?? null,
          id,
        ],
      );
      res.json(r.rows[0]);
    } catch (err) {
      // Same race fall-through as the POST handler, only fires
      // when an exact 4-key duplicate slips past the pre-flight.
      if (err.code === "23505") {
        return res.status(409).json({
          error: "A dive with that code + height + position + DD already exists.",
        });
      }
      console.error("[Dive Directory Update Error]", err.message);
      res.status(500).json({ error: "Failed to update custom dive" });
    }
  });

  // -----------------------------------------------------------
  // DELETE /api/dive-directory/:id: remove a custom row. Core
  // rows refuse. Cross-org refuses. Rows that have ever been
  // filed on a roster or scored in a meet refuse via the
  // rejectIfInUse pre-flight so the scoreboard archive cant be
  // retroactively orphaned.
  // -----------------------------------------------------------
  router.delete("/api/dive-directory/:id", requireStaff, async (req, res) => {
    const id = req.params.id;
    try {
      const owner = await pool.query(
        `SELECT is_custom, created_org_id FROM dive_directory WHERE id = $1`,
        [id],
      );
      if (!owner.rows.length) return res.status(404).json({ error: "Dive not found" });
      if (!owner.rows[0].is_custom) {
        return res.status(403).json({ error: "Core dives cannot be deleted" });
      }
      if (
        !req.user.is_system_admin
        && owner.rows[0].created_org_id !== req.user.org_id
      ) {
        return res.status(403).json({ error: "Custom dive belongs to another org" });
      }

      // Lock-on-use. Same gate as PUT: a dive referenced by
      // competitor_dive_lists or scores is part of a meet record
      // and can't be quietly deleted. The 23503 fallback in the
      // catch block stays as a belt-and-braces against a race,
      // just in case.
      const lockResult = await rejectIfInUse(id);
      if (lockResult) return res.status(lockResult.status).json(lockResult.body);

      await pool.query("DELETE FROM dive_directory WHERE id = $1", [id]);
      res.status(204).end();
    } catch (err) {
      // 23503 = foreign_key_violation. The pre-flight above
      // catches the normal "in use" case; this branch only fires
      // on a race where a roster row was inserted between the
      // pre-flight and the DELETE.
      if (err.code === "23503") {
        return res.status(409).json({
          error:
            "This dive is referenced by a meet record. " +
            "It can't be deleted without breaking the scoreboard archive.",
        });
      }
      console.error("[Dive Directory Delete Error]", err.message);
      res.status(500).json({ error: "Failed to delete custom dive" });
    }
  });

  return router;
};
