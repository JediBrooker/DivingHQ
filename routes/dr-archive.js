// DiveRecorder archive: public, read-only browse of the mined
// historical results in the dr_* tables (migration 059, populated by
// scripts/import-diverecorder.js). Powers the "Archive Explorer"
// view.
//
//   GET /api/dr-archive/meets            paginated/searchable meet list
//   GET /api/dr-archive/meets/:id        meet + its events
//   GET /api/dr-archive/events/:id       event + ranked results
//   GET /api/dr-archive/results/:id      one diver's full divesheet
//   GET /api/dr-archive/divers/search    find a diver + their results history
//
// All endpoints are anonymous-readable: the source data is already
// public, there are no real accounts behind it, and it carries no
// org. No auth gate, no org filtering. Reads route through the
// optional replica like routes/archive.js does. Mounted behind a
// read limiter in server.js.
//
// Mounted via:
//   app.use(limiter, require('./routes/dr-archive')({ pool, readPool }))

const express = require("express");
const { startImport, getImportStatus } = require("../lib/diverecorder-import-runner");

module.exports = function createDrArchiveRouter({ pool, readPool, requireSystemAdmin }) {
  if (!pool) throw new Error("createDrArchiveRouter requires { pool }");
  const reads = readPool || pool;
  const router = express.Router();

  // GET /api/dr-archive/stats: headline totals for the archive
  // (events + meets). Cheap COUNT(*)s, used by the public
  // Scoreboard header to surface "N archived" alongside the
  // live/completed operational counts.
  router.get("/api/dr-archive/stats", async (_req, res) => {
    try {
      const { rows } = await reads.query(
        `SELECT (SELECT COUNT(*) FROM dr_events)::int AS events,
                (SELECT COUNT(*) FROM dr_meets)::int  AS meets`,
      );
      res.json(rows[0] || { events: 0, meets: 0 });
    } catch (err) {
      console.error("[DrArchive stats]", err.message);
      res.status(500).json({ events: 0, meets: 0 });
    }
  });

  // GET /api/dr-archive/meets?q=&nat=&from=&to=&limit=&offset=
  // Filters: name search (q), country code (nat), and a meet-date
  // range (from/to, ISO yyyy-mm-dd). All optional and combinable.
  router.get("/api/dr-archive/meets", async (req, res) => {
    try {
      const q = (req.query.q || "").toString().trim();
      const nat = (req.query.nat || "").toString().trim().toUpperCase();
      const from = (req.query.from || "").toString().trim();
      const to = (req.query.to || "").toString().trim();
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const params = [];
      const conds = [];
      if (q) {
        params.push(`%${q}%`);
        conds.push(`m.name ILIKE $${params.length}`);
      }
      if (nat) {
        params.push(nat);
        conds.push(`m.country_code = $${params.length}`);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
        params.push(from);
        conds.push(`m.meet_date >= $${params.length}`);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        params.push(to);
        conds.push(`m.meet_date <= $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(limit, offset);
      const r = await reads.query(
        `SELECT m.id, m.name, to_char(m.meet_date,'YYYY-MM-DD') AS meet_date, m.source_mref,
                m.country_code, m.country_name,
                COALESCE(ec.event_count, 0)::int AS event_count
         FROM dr_meets m
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS event_count FROM dr_events e WHERE e.dr_meet_id = m.id
         ) ec ON true
         ${where}
         ORDER BY m.meet_date DESC NULLS LAST, m.name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[DR Archive meets]", err.message);
      res.status(500).json([]);
    }
  });

  // GET /api/dr-archive/meets-count?q=&nat=&from=&to=: total number
  // of meets matching the same filters as /meets. Lets the client
  // render numbered page links (total pages = ceil(count / pageSize)).
  // Hyphenated path so it never collides with /meets/:id.
  router.get("/api/dr-archive/meets-count", async (req, res) => {
    try {
      const q = (req.query.q || "").toString().trim();
      const nat = (req.query.nat || "").toString().trim().toUpperCase();
      const from = (req.query.from || "").toString().trim();
      const to = (req.query.to || "").toString().trim();
      const params = [];
      const conds = [];
      if (q) {
        params.push(`%${q}%`);
        conds.push(`m.name ILIKE $${params.length}`);
      }
      if (nat) {
        params.push(nat);
        conds.push(`m.country_code = $${params.length}`);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
        params.push(from);
        conds.push(`m.meet_date >= $${params.length}`);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        params.push(to);
        conds.push(`m.meet_date <= $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const r = await reads.query(
        `SELECT COUNT(*)::int AS total FROM dr_meets m ${where}`,
        params,
      );
      res.json({ total: r.rows[0]?.total ?? 0 });
    } catch (err) {
      console.error("[DR Archive meets-count]", err.message);
      res.status(500).json({ total: 0 });
    }
  });

  // GET /api/dr-archive/date-range: earliest + latest meet date in
  // the archive, as plain YYYY-MM-DD. Bounds the date range slider.
  router.get("/api/dr-archive/date-range", async (req, res) => {
    try {
      const r = await reads.query(
        `SELECT to_char(MIN(meet_date), 'YYYY-MM-DD') AS min_date,
                to_char(MAX(meet_date), 'YYYY-MM-DD') AS max_date
         FROM dr_meets WHERE meet_date IS NOT NULL`,
      );
      res.json(r.rows[0] || { min_date: null, max_date: null });
    } catch (err) {
      console.error("[DR Archive date-range]", err.message);
      res.status(500).json({ min_date: null, max_date: null });
    }
  });

  // GET /api/dr-archive/countries: distinct countries present in the
  // archive (with a meet count), for the filter dropdown.
  router.get("/api/dr-archive/countries", async (req, res) => {
    try {
      const r = await reads.query(
        `SELECT country_code, country_name, COUNT(*)::int AS meet_count
         FROM dr_meets
         WHERE country_code IS NOT NULL
         GROUP BY country_code, country_name
         ORDER BY country_name ASC`,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[DR Archive countries]", err.message);
      res.status(500).json([]);
    }
  });

  // GET /api/dr-archive/meets/:id: meet header + its events.
  router.get("/api/dr-archive/meets/:id", async (req, res) => {
    try {
      const meet = await reads.query(
        `SELECT id, name, to_char(meet_date,'YYYY-MM-DD') AS meet_date, source_mref FROM dr_meets WHERE id = $1`,
        [req.params.id],
      );
      if (!meet.rows.length) return res.status(404).json({ error: "not_found" });
      const events = await reads.query(
        `SELECT e.id, e.name, e.gender, e.height, e.phase, to_char(e.event_date,'YYYY-MM-DD') AS event_date,
                e.judge_count, COALESCE(rc.result_count, 0)::int AS result_count
         FROM dr_events e
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS result_count FROM dr_results r WHERE r.dr_event_id = e.id
         ) rc ON true
         WHERE e.dr_meet_id = $1
         ORDER BY e.source_eref ASC`,
        [req.params.id],
      );
      res.json({ meet: meet.rows[0], events: events.rows });
    } catch (err) {
      console.error("[DR Archive meet]", err.message);
      res.status(500).json({ error: "server_error" });
    }
  });

  // GET /api/dr-archive/events/:id: event header + ranked results.
  router.get("/api/dr-archive/events/:id", async (req, res) => {
    try {
      const ev = await reads.query(
        `SELECT e.id, e.name, e.gender, e.height, e.phase, to_char(e.event_date,'YYYY-MM-DD') AS event_date,
                e.judge_count, e.dr_meet_id, m.name AS meet_name, to_char(m.meet_date,'YYYY-MM-DD') AS meet_date
         FROM dr_events e JOIN dr_meets m ON m.id = e.dr_meet_id
         WHERE e.id = $1`,
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "not_found" });
      const results = await reads.query(
        `SELECT r.id, r.rank, r.total_score, d.name AS diver_name,
                d.club_name, d.birth_year
         FROM dr_results r JOIN dr_divers d ON d.id = r.dr_diver_id
         WHERE r.dr_event_id = $1
         ORDER BY r.rank ASC NULLS LAST, r.total_score DESC NULLS LAST`,
        [req.params.id],
      );
      res.json({ event: ev.rows[0], results: results.rows });
    } catch (err) {
      console.error("[DR Archive event]", err.message);
      res.status(500).json({ error: "server_error" });
    }
  });

  // GET /api/dr-archive/results/:id: one diver's full divesheet.
  router.get("/api/dr-archive/results/:id", async (req, res) => {
    try {
      const result = await reads.query(
        `SELECT r.id, r.rank, r.total_score, d.name AS diver_name,
                d.club_name, d.birth_year,
                e.id AS event_id, e.name AS event_name, to_char(e.event_date,'YYYY-MM-DD') AS event_date, e.judge_count,
                m.id AS meet_id, m.name AS meet_name
         FROM dr_results r
         JOIN dr_divers d ON d.id = r.dr_diver_id
         JOIN dr_events e ON e.id = r.dr_event_id
         JOIN dr_meets m ON m.id = e.dr_meet_id
         WHERE r.id = $1`,
        [req.params.id],
      );
      if (!result.rows.length) return res.status(404).json({ error: "not_found" });
      const dives = await reads.query(
        `SELECT round_number, dive_code, position, degree_of_difficulty,
                judge_scores, dive_points, running_total
         FROM dr_dives WHERE dr_result_id = $1 ORDER BY round_number ASC`,
        [req.params.id],
      );
      res.json({ result: result.rows[0], dives: dives.rows });
    } catch (err) {
      console.error("[DR Archive result]", err.message);
      res.status(500).json({ error: "server_error" });
    }
  });

  // GET /api/dr-archive/divers/search?q=: find a diver and list
  // every archived result for them, newest first.
  router.get("/api/dr-archive/divers/search", async (req, res) => {
    try {
      const q = (req.query.q || "").toString().trim();
      if (q.length < 2) return res.json([]);
      const r = await reads.query(
        `SELECT d.id, d.name, d.club_name, d.birth_year,
                COALESCE(rc.result_count, 0)::int AS result_count
         FROM dr_divers d
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS result_count FROM dr_results r WHERE r.dr_diver_id = d.id
         ) rc ON true
         WHERE d.name ILIKE $1
         ORDER BY d.name ASC
         LIMIT 50`,
        [`%${q}%`],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[DR Archive diver search]", err.message);
      res.status(500).json([]);
    }
  });

  // GET /api/dr-archive/divers/:id: a diver's cross-meet history.
  router.get("/api/dr-archive/divers/:id", async (req, res) => {
    try {
      const diver = await reads.query(
        `SELECT id, name, club_name, birth_year FROM dr_divers WHERE id = $1`,
        [req.params.id],
      );
      if (!diver.rows.length) return res.status(404).json({ error: "not_found" });
      const history = await reads.query(
        `SELECT r.id AS result_id, r.rank, r.total_score,
                e.id AS event_id, e.name AS event_name, to_char(e.event_date,'YYYY-MM-DD') AS event_date,
                m.id AS meet_id, m.name AS meet_name
         FROM dr_results r
         JOIN dr_events e ON e.id = r.dr_event_id
         JOIN dr_meets m ON m.id = e.dr_meet_id
         WHERE r.dr_diver_id = $1
         ORDER BY e.event_date DESC NULLS LAST, m.name ASC`,
        [req.params.id],
      );
      res.json({ diver: diver.rows[0], history: history.rows });
    } catch (err) {
      console.error("[DR Archive diver]", err.message);
      res.status(500).json({ error: "server_error" });
    }
  });

  // ----- Sysadmin-only: trigger / monitor a DiveRecorder import ----
  // Only wired up when the middleware is provided, heads up: tests
  // that mount the router without it just omit these routes.
  if (requireSystemAdmin) {
    // POST /api/dr-archive/admin/import: kick off an import in the
    // background and return immediately. Body: { onlyNew?, limit?, nat? }.
    // Defaults to onlyNew=true (fast incremental "pull new meets").
    router.post("/api/dr-archive/admin/import", requireSystemAdmin, (req, res) => {
      const body = req.body || {};
      const started = startImport(pool, {
        onlyNew: body.onlyNew !== false,
        limitMeets: body.limit ? Number(body.limit) : null,
        nat: typeof body.nat === "string" ? body.nat : null,
        trigger: `manual:${req.user.id}`,
      });
      if (!started.ok) return res.status(409).json({ error: "import_already_running", status: started.status });
      res.status(202).json({ ok: true, status: started.status });
    });

    // GET /api/dr-archive/admin/import/status: poll progress.
    router.get("/api/dr-archive/admin/import/status", requireSystemAdmin, (req, res) => {
      res.json(getImportStatus());
    });
  }

  return router;
};
