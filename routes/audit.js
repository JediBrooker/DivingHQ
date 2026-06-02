// Federation-wide audit log endpoints.
//
// The per-event score audit (/api/events/:id/score-audit) and the
// per-user role audit (/api/users/:id/role-audit) already exist in
// routes/score-correction.js + routes/users.js, but both are
// scoped to a single subject. Org admins / sysadmins running
// dispute investigations or doing periodic compliance review want
// a federation-wide cross-cutting view: "every score correction
// in the last week", "who's been granted org_admin recently".
//
// Endpoints (org-admin gated; sysadmin passes the same gate):
//
//   GET /api/audit/scores
//     Filters: event_id, competitor_id, judge_id, actor_id,
//              action (insert | update | delete), from, to,
//              q (substring search of reason), org_id (sysadmin
//              only — narrows across orgs), limit, offset
//
//   GET /api/audit/roles
//     Filters: user_id, actor_id, role, action (granted |
//              revoked), from, to, org_id (sysadmin only),
//              limit, offset
//
//   GET /api/audit/recent
//     Returns the most recent score + role rows interleaved so
//     the dashboard "Recent activity" tab can show a feed
//     without coordinating two separate fetches.
//
// All three return JSON arrays of rows enriched with the
// joined user / event / org names so the SPA doesn't need to
// secondary-fetch those.
//
// Mounted via:
//   app.use(require('./routes/audit')({ pool, requireOrgAdmin }))

const express = require("express");

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

module.exports = function createAuditRouter({ pool, requireOrgAdmin }) {
  if (!pool || !requireOrgAdmin) {
    throw new Error("createAuditRouter requires { pool, requireOrgAdmin }");
  }
  const router = express.Router();

  // Guard ?from / ?to so a non-timestamp value returns a clean 400
  // instead of bubbling a Postgres "invalid input syntax" 500. The
  // values feed `created_at >= $N` / `<= $N` as bound params, so this
  // is robustness, not an injection fix.
  function validAuditDates(req, res) {
    for (const k of ["from", "to"]) {
      const v = req.query[k];
      if (v != null && v !== "" && Number.isNaN(Date.parse(v))) {
        res.status(400).json({ error: `${k} must be a valid date/timestamp` });
        return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------
  // GET /api/audit/scores — federation-wide score audit
  // ---------------------------------------------------------------
  router.get("/api/audit/scores", requireOrgAdmin, async (req, res) => {
    if (!validAuditDates(req, res)) return;
    const isSysAdmin = !!req.user.is_system_admin;
    // Build a parameterised WHERE incrementally so a request
    // with no filters falls back to "everything in this org".
    const where = [];
    const params = [];
    function add(sql, value) {
      params.push(value);
      where.push(sql.replace("$$", `$${params.length}`));
    }

    // Org scope. Org admins are pinned to their org; sysadmins
    // can pass `?org_id=` to narrow but otherwise see all orgs.
    if (!isSysAdmin) {
      add("e.org_id = $$", req.user.org_id);
    } else if (req.query.org_id) {
      add("e.org_id = $$", req.query.org_id);
    }

    if (req.query.event_id)      add("a.event_id = $$",      req.query.event_id);
    if (req.query.competitor_id) add("a.competitor_id = $$", req.query.competitor_id);
    if (req.query.judge_id)      add("a.judge_id = $$",      req.query.judge_id);
    if (req.query.actor_id)      add("a.actor_user_id = $$", req.query.actor_id);
    if (req.query.action) {
      const allowed = new Set(["insert", "update", "delete"]);
      if (allowed.has(req.query.action)) {
        add("a.action = $$::score_audit_action", req.query.action);
      }
    }
    if (req.query.from) add("a.created_at >= $$", req.query.from);
    if (req.query.to)   add("a.created_at <= $$", req.query.to);
    if (req.query.q && req.query.q.trim()) {
      // ILIKE substring match on reason — most common operator
      // workflow is "find every correction that mentioned 'video'".
      add("a.reason ILIKE $$", `%${req.query.q.trim()}%`);
    }

    const limit  = clampInt(req.query.limit,  DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(req.query.offset, 0,             0, 1_000_000);
    params.push(limit, offset);

    const sql =
      `SELECT a.id, a.score_id, a.event_id, a.round_number, a.action::text AS action,
              a.old_score, a.new_score,
              a.ip_address::text AS ip_address,
              a.user_agent, a.reason, a.created_at,
              a.competitor_id, comp.full_name AS competitor_name,
              a.judge_id,      jud.full_name  AS judge_name,
              ej.judge_number,
              a.actor_user_id, act.full_name  AS actor_name,
              e.name AS event_name,
              e.org_id, o.name AS org_name, o.country_code
       FROM score_audit_log a
       -- LEFT JOIN: migration 035 made score_audit_log.event_id
       -- nullable so audit rows survive event deletion. INNER
       -- JOIN here would silently drop them, undoing the whole
       -- point of the migration. Org-scope filter on e.org_id
       -- below correctly excludes orphans for non-sysadmin
       -- callers; sysadmin sees them surface.
       LEFT JOIN events e   ON e.id = a.event_id
       LEFT JOIN organisations o ON o.id = e.org_id
       LEFT JOIN users comp ON comp.id = a.competitor_id
       LEFT JOIN users jud  ON jud.id  = a.judge_id
       LEFT JOIN users act  ON act.id  = a.actor_user_id
       LEFT JOIN event_judges ej
         ON ej.event_id = a.event_id AND ej.judge_id = a.judge_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;

    try {
      const r = await pool.query(sql, params);
      res.json(r.rows);
    } catch (err) {
      console.error("[Audit Scores Error]", err.message);
      res.status(500).json({ error: "Failed to load score audit" });
    }
  });

  // ---------------------------------------------------------------
  // GET /api/audit/roles — federation-wide role audit
  // ---------------------------------------------------------------
  router.get("/api/audit/roles", requireOrgAdmin, async (req, res) => {
    if (!validAuditDates(req, res)) return;
    const isSysAdmin = !!req.user.is_system_admin;
    const where = [];
    const params = [];
    function add(sql, value) {
      params.push(value);
      where.push(sql.replace("$$", `$${params.length}`));
    }

    if (!isSysAdmin) {
      add("a.org_id = $$", req.user.org_id);
    } else if (req.query.org_id) {
      add("a.org_id = $$", req.query.org_id);
    }

    if (req.query.user_id)  add("a.user_id = $$",  req.query.user_id);
    if (req.query.actor_id) add("a.actor_id = $$", req.query.actor_id);
    if (req.query.role)     add("a.role = $$::org_role", req.query.role);
    if (req.query.action) {
      const allowed = new Set(["granted", "revoked"]);
      if (allowed.has(req.query.action)) {
        add("a.action = $$::role_audit_action", req.query.action);
      }
    }
    if (req.query.from) add("a.created_at >= $$", req.query.from);
    if (req.query.to)   add("a.created_at <= $$", req.query.to);

    const limit  = clampInt(req.query.limit,  DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(req.query.offset, 0,             0, 1_000_000);
    params.push(limit, offset);

    const sql =
      `SELECT a.id, a.user_id, a.org_id, a.role::text AS role,
              a.action::text AS action,
              a.note, a.created_at,
              a.actor_id,
              target.full_name AS target_name,
              target.username  AS target_username,
              actor.full_name  AS actor_name,
              actor.username   AS actor_username,
              o.name AS org_name, o.country_code
       FROM role_audit_log a
       -- LEFT JOIN per migration 035: org_id became nullable.
       LEFT JOIN organisations o ON o.id = a.org_id
       LEFT JOIN users target ON target.id = a.user_id
       LEFT JOIN users actor  ON actor.id  = a.actor_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;

    try {
      const r = await pool.query(sql, params);
      res.json(r.rows);
    } catch (err) {
      console.error("[Audit Roles Error]", err.message);
      res.status(500).json({ error: "Failed to load role audit" });
    }
  });

  // ---------------------------------------------------------------
  // GET /api/audit/activity — generic audit_log feed (event
  // create/delete/status, org status, club/team delete,
  // late-entry, withdraw/reinstate, workflow reset).
  // ---------------------------------------------------------------
  router.get("/api/audit/activity", requireOrgAdmin, async (req, res) => {
    const isSysAdmin = !!req.user.is_system_admin;
    const where = [];
    const params = [];
    function add(sql, value) {
      params.push(value);
      where.push(sql.replace("$$", `$${params.length}`));
    }

    if (!isSysAdmin) {
      add("a.org_id = $$", req.user.org_id);
    } else if (req.query.org_id) {
      add("a.org_id = $$", req.query.org_id);
    }

    if (req.query.entity_type) add("a.entity_type = $$", req.query.entity_type);
    if (req.query.entity_id)   add("a.entity_id = $$",   req.query.entity_id);
    if (req.query.actor_id)    add("a.actor_id = $$",    req.query.actor_id);
    if (req.query.action) {
      // action is freeform; allow exact match only (ILIKE'd
      // wildcard search invites accidental scans).
      add("a.action = $$", req.query.action);
    }
    if (req.query.action_prefix) {
      // 'event.' / 'roster.' / 'org.' / 'club.' — lets the SPA
      // filter by domain in one tab.
      add("a.action LIKE $$ || '%'", req.query.action_prefix);
    }
    if (req.query.from) add("a.created_at >= $$", req.query.from);
    if (req.query.to)   add("a.created_at <= $$", req.query.to);

    const limit  = clampInt(req.query.limit,  DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(req.query.offset, 0,             0, 1_000_000);
    params.push(limit, offset);

    const sql =
      `SELECT a.id, a.entity_type, a.entity_id, a.entity_name,
              a.action, a.metadata, a.note, a.created_at,
              a.org_id, o.name AS org_name, o.country_code,
              a.actor_id, act.full_name AS actor_name,
              a.ip_address::text AS ip_address, a.user_agent
       FROM audit_log a
       LEFT JOIN organisations o ON o.id = a.org_id
       LEFT JOIN users act       ON act.id = a.actor_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;

    try {
      const r = await pool.query(sql, params);
      res.json(r.rows);
    } catch (err) {
      console.error("[Audit Activity Error]", err.message);
      res.status(500).json({ error: "Failed to load activity audit" });
    }
  });

  // ---------------------------------------------------------------
  // GET /api/audit/export.csv?kind=scores|roles|activity
  // Streaming full-history export. Bypasses the 1000-row cap on
  // the regular endpoints — useful for legal disputes /
  // compliance reviews that need every audit row in a date
  // window. Rows stream as CSV directly to the response so we
  // don't have to load thousands into memory at once.
  // ---------------------------------------------------------------
  router.get("/api/audit/export.csv", requireOrgAdmin, async (req, res) => {
    const kind = ["scores", "roles", "activity"].includes(req.query.kind)
      ? req.query.kind
      : "scores";
    const isSysAdmin = !!req.user.is_system_admin;
    const orgScope = !isSysAdmin ? req.user.org_id : (req.query.org_id || null);
    const from = req.query.from || null;
    const to   = req.query.to   || null;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=audit_${kind}_${new Date().toISOString().slice(0, 10)}.csv`,
    );

    function csvCell(v) {
      if (v == null) return "";
      let s = String(v);
      // Spreadsheet formula-injection guard. Cells starting with
      // = + - @ \t \r are evaluated as formulas by Excel /
      // Google Sheets. Prepend a single quote to force literal
      // text. See routes/pdf.js for the matching helper.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      s = s.replace(/"/g, '""');
      return `"${s}"`;
    }

    try {
      if (kind === "scores") {
        res.write(
          "time,action,event,org,round,competitor,judge,old_score,new_score,actor,reason,ip\n",
        );
        const r = await pool.query(
          `SELECT a.created_at, a.action::text AS action,
                  e.name AS event_name, o.name AS org_name,
                  a.round_number, comp.full_name AS competitor_name,
                  jud.full_name AS judge_name,
                  a.old_score, a.new_score,
                  act.full_name AS actor_name, a.reason,
                  a.ip_address::text AS ip_address
           FROM score_audit_log a
           -- LEFT JOIN per migration 035: event_id is now nullable.
           LEFT JOIN events e ON e.id = a.event_id
           LEFT JOIN organisations o ON o.id = e.org_id
           LEFT JOIN users comp ON comp.id = a.competitor_id
           LEFT JOIN users jud  ON jud.id  = a.judge_id
           LEFT JOIN users act  ON act.id  = a.actor_user_id
           WHERE ($1::uuid IS NULL OR e.org_id = $1::uuid)
             AND ($2::timestamptz IS NULL OR a.created_at >= $2::timestamptz)
             AND ($3::timestamptz IS NULL OR a.created_at <= $3::timestamptz)
           ORDER BY a.created_at DESC`,
          [orgScope, from, to],
        );
        for (const row of r.rows) {
          res.write(
            [row.created_at, row.action, row.event_name, row.org_name,
              row.round_number, row.competitor_name, row.judge_name,
              row.old_score, row.new_score, row.actor_name, row.reason,
              row.ip_address].map(csvCell).join(",") + "\n",
          );
        }
      } else if (kind === "roles") {
        res.write("time,action,role,target,target_username,org,actor,note\n");
        const r = await pool.query(
          `SELECT a.created_at, a.action::text AS action, a.role::text AS role,
                  target.full_name AS target_name, target.username AS target_username,
                  o.name AS org_name, actor.full_name AS actor_name, a.note
           FROM role_audit_log a
           -- LEFT JOIN per migration 035: org_id is now nullable.
           LEFT JOIN organisations o ON o.id = a.org_id
           LEFT JOIN users target ON target.id = a.user_id
           LEFT JOIN users actor  ON actor.id  = a.actor_id
           WHERE ($1::uuid IS NULL OR a.org_id = $1::uuid)
             AND ($2::timestamptz IS NULL OR a.created_at >= $2::timestamptz)
             AND ($3::timestamptz IS NULL OR a.created_at <= $3::timestamptz)
           ORDER BY a.created_at DESC`,
          [orgScope, from, to],
        );
        for (const row of r.rows) {
          res.write(
            [row.created_at, row.action, row.role, row.target_name,
              row.target_username, row.org_name, row.actor_name, row.note]
              .map(csvCell).join(",") + "\n",
          );
        }
      } else {
        // activity
        res.write("time,action,entity_type,entity_name,org,actor,note,metadata\n");
        const r = await pool.query(
          `SELECT a.created_at, a.action, a.entity_type, a.entity_name,
                  o.name AS org_name, actor.full_name AS actor_name,
                  a.note, a.metadata
           FROM audit_log a
           LEFT JOIN organisations o ON o.id = a.org_id
           LEFT JOIN users actor     ON actor.id = a.actor_id
           WHERE ($1::uuid IS NULL OR a.org_id = $1::uuid)
             AND ($2::timestamptz IS NULL OR a.created_at >= $2::timestamptz)
             AND ($3::timestamptz IS NULL OR a.created_at <= $3::timestamptz)
           ORDER BY a.created_at DESC`,
          [orgScope, from, to],
        );
        for (const row of r.rows) {
          res.write(
            [row.created_at, row.action, row.entity_type, row.entity_name,
              row.org_name, row.actor_name, row.note,
              row.metadata ? JSON.stringify(row.metadata) : ""]
              .map(csvCell).join(",") + "\n",
          );
        }
      }
      res.end();
    } catch (err) {
      console.error("[Audit Export Error]", err.message);
      // If we've already started writing, just end the stream.
      // Otherwise return JSON.
      if (res.headersSent) res.end();
      else res.status(500).json({ error: "Failed to export audit log" });
    }
  });

  // ---------------------------------------------------------------
  // GET /api/audit/recent — interleaved feed for the dashboard tab
  // ---------------------------------------------------------------
  router.get("/api/audit/recent", requireOrgAdmin, async (req, res) => {
    const isSysAdmin = !!req.user.is_system_admin;
    const orgScope = !isSysAdmin ? req.user.org_id : (req.query.org_id || null);
    const days = clampInt(req.query.days, 7, 1, 90);
    const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

    try {
      // Two queries → merge in JS rather than a SQL UNION because
      // the row shapes are different and the SPA wants discriminated
      // entries (`kind: 'score' | 'role'`) for tab-filter rendering.
      const since = new Date(Date.now() - days * 86_400_000).toISOString();

      const scoreSql =
        `SELECT a.id, a.created_at, a.action::text AS action,
                a.competitor_id, comp.full_name AS competitor_name,
                a.judge_id, jud.full_name AS judge_name,
                a.actor_user_id, act.full_name AS actor_name,
                a.event_id, e.name AS event_name,
                a.round_number, a.old_score, a.new_score, a.reason,
                e.org_id, o.name AS org_name
         FROM score_audit_log a
         -- LEFT JOIN per migration 035: event_id is now nullable.
         LEFT JOIN events e   ON e.id = a.event_id
         LEFT JOIN organisations o ON o.id = e.org_id
         LEFT JOIN users comp ON comp.id = a.competitor_id
         LEFT JOIN users jud  ON jud.id  = a.judge_id
         LEFT JOIN users act  ON act.id  = a.actor_user_id
         WHERE a.created_at >= $1
           AND ($2::uuid IS NULL OR e.org_id = $2::uuid)
         ORDER BY a.created_at DESC
         LIMIT $3`;

      const roleSql =
        `SELECT a.id, a.created_at, a.action::text AS action,
                a.user_id, target.full_name AS target_name,
                a.actor_id, actor.full_name AS actor_name,
                a.role::text AS role, a.note,
                a.org_id, o.name AS org_name
         FROM role_audit_log a
         JOIN organisations o ON o.id = a.org_id
         LEFT JOIN users target ON target.id = a.user_id
         LEFT JOIN users actor  ON actor.id  = a.actor_id
         WHERE a.created_at >= $1
           AND ($2::uuid IS NULL OR a.org_id = $2::uuid)
         ORDER BY a.created_at DESC
         LIMIT $3`;

      const activitySql =
        `SELECT a.id, a.created_at, a.action,
                a.entity_type, a.entity_id, a.entity_name,
                a.metadata, a.note,
                a.actor_id, actor.full_name AS actor_name,
                a.org_id, o.name AS org_name
         FROM audit_log a
         LEFT JOIN organisations o ON o.id = a.org_id
         LEFT JOIN users actor     ON actor.id = a.actor_id
         WHERE a.created_at >= $1
           AND ($2::uuid IS NULL OR a.org_id = $2::uuid)
         ORDER BY a.created_at DESC
         LIMIT $3`;

      const [scoresR, rolesR, activityR] = await Promise.all([
        pool.query(scoreSql,    [since, orgScope, limit]),
        pool.query(roleSql,     [since, orgScope, limit]),
        pool.query(activitySql, [since, orgScope, limit]),
      ]);

      const merged = [
        ...scoresR.rows  .map(r => ({ kind: "score",    ...r })),
        ...rolesR.rows   .map(r => ({ kind: "role",     ...r })),
        ...activityR.rows.map(r => ({ kind: "activity", ...r })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
       .slice(0, limit);

      res.json(merged);
    } catch (err) {
      console.error("[Audit Recent Error]", err.message);
      res.status(500).json({ error: "Failed to load recent audit" });
    }
  });

  return router;
};

// ---- helpers ----------------------------------------------------

function clampInt(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
