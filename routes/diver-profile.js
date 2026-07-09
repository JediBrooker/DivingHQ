// Diver profile + analytics + dashboard preferences.
//
//   GET /api/divers/:id/profile     stats, personal bests, score
//                                   trend per meet (with placing
//                                   ranked against the full field)
//   GET /api/divers/:id/analytics   the 11 customisable widgets
//                                   the diver picks from
//   PUT /api/users/me/dashboard     persist the diver's widget
//                                   layout (validated whitelist)
//
// Profile + analytics are visible to any authenticated user. The
// data they expose is already public via the meet scoreboards and
// the archive (and cross-org comparison was the explicit feature
// request that drove that). dashboard_widgets is private though;
// canViewDiverPrivate gates that single field.
//
// All the heavy SQL CTEs (PER_DIVE, FULL_FIELD_RANKING) live in
// db/queries.js so a fix to the dive-points logic only has to
// land in one place; the analytics widgets each splice them in.
//
// Mounted via:
//   app.use(require('./routes/diver-profile')({ … }))

const express = require("express");
const { PER_DIVE: SHARED_PER_DIVE, FULL_FIELD_RANKING } =
  require("../db/queries");
const { perDiveSelect, perDivePointsCte } = require("../lib/scoring-sql");

// Catalog of widget IDs the diver can enable on their dashboard.
// Validated against the inbound array so a typo can't poison the
// store. Mirrors the frontend's WIDGET_CATALOG, so if you add one
// there, add it here too (flagged in AGENTS.md, worth
// double-checking).
const KNOWN_WIDGETS = new Set([
  "score_trend", "personal_bests", "recent_form", "placings",
  "height_breakdown", "round_stamina", "quality_mix", "dd_risk",
  "frequent_dives", "streak",
  // Added with the date-range filter pass:
  "compare_peers", "event_type_splits", "year_over_year",
]);

// Diver competitive profiles are now publicly readable: same
// data the meet scoreboards and event archives already expose to
// the open web. The handler still gates owner-private fields
// (dashboard_widgets) via canViewDiverPrivate. Anonymous spectators
// landing on /profile/<id> from a scoreboard link see the
// competitive history without being bounced to /login. (Originally
// gated to authenticated viewers, relaxed when the scoreboard's
// diver-name links became expected to work for unauth visitors.)
function canViewDiverProfile(/* viewer, diverRow */) {
  return true;
}

// True when the viewer can see diver-private fields (UI
// preferences, dashboard layout, etc.) on top of the public
// competitive history. Applied inline in the handler to redact
// `dashboard_widgets` for outside viewers.
function canViewDiverPrivate(viewer, diverRow) {
  if (!viewer) return false;
  if (viewer.is_system_admin) return true;
  if (viewer.id === diverRow.id) return true;
  if (viewer.org_id !== diverRow.org_id) return false;
  const roles = viewer.org_roles || [];
  return roles.includes("org_admin") || roles.includes("meet_manager") || roles.includes("coach");
}

module.exports = function createDiverProfileRouter({
  pool,
  readPool,
  verifyToken,
  optionalAuth,
  parseDateRange,
}) {
  if (!pool) throw new Error("createDiverProfileRouter requires { pool, … }");
  // Public-read endpoints (profile + analytics) decode the token if
  // one is sent so we still see req.user for owner-only branches
  // (e.g. dashboard_widgets), but anonymous requests are accepted.
  // Falls back to verifyToken if the host hasn't been updated yet,
  // belt-and-braces during the rollout.
  const maybeAuth = optionalAuth || verifyToken;
  // Profile + analytics are heavy historical reads: per_dive
  // CTEs across the whole scores table, FULL_FIELD_RANKING
  // window functions. Route through the optional read replica
  // so analytics dashboards don't compete with live-scoring
  // writes for primary connections. Slight replication lag is
  // fine here, nobody clicks "show me my stats" in the same
  // second they submit a dive list.
  const reads = readPool || pool;
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/divers/:id/profile: stats, PBs, per-meet trend
  // -------------------------------------------------------------
  router.get("/api/divers/:id/profile", maybeAuth, async (req, res) => {
    try {
      let dateRange;
      try { dateRange = parseDateRange(req.query); }
      catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
      const { from: fromDate, to: toDate } = dateRange;

      const diverRes = await reads.query(
        `SELECT u.id, u.full_name, u.org_id, o.name AS org_name, o.country_code,
                u.club_id, cl.name AS club_name, cl.short_code AS club_code,
                u.dashboard_widgets
         FROM users u
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.id = $1
           AND u.deleted_at IS NULL`,
        [req.params.id],
      );
      if (!diverRes.rows.length)
        return res.status(404).json({ error: "Diver not found" });
      const diver = diverRes.rows[0];

      if (!canViewDiverProfile(req.user, diver))
        return res.status(403).json({ error: "Not permitted to view this profile" });

      // Date-range filter pushed into every aggregate. $2/$3 are nullable;
      // when null the AND clause is a no-op so unfiltered callers still work.
      const DATE_FILTER = `
        AND ($2::date IS NULL OR e.created_at >= $2::date)
        AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')`;

      // Top-level stats: total events, total dives, average DD,
      // best single dive total.
      const stats = await reads.query(
        `WITH ${perDivePointsCte({
           name:        "dive_totals",
           select:      ["s.event_id", "s.round_number"],
           pointsAlias: "dive_total",
           selectExtra: ["MAX(d.dd) AS dd"],
           where: `s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE
           ${DATE_FILTER}`,
         })}
         SELECT
           COUNT(DISTINCT event_id)::int AS total_meets,
           COUNT(*)::int                 AS total_dives,
           AVG(dd)::numeric(4,2)         AS avg_dd,
           MAX(dive_total)::numeric(6,2) AS best_single_dive
         FROM dive_totals`,
        [req.params.id, fromDate, toDate],
      );

      // Personal best per (dive code + position + height), under
      // World Aquatics trim + DD rules. The canonical chain LEFT
      // JOINs cdl + dive_directory. A withdrawn-then-deleted
      // competitor_dive_lists row would otherwise drop the diver's
      // historical scores from PB calculations. Dive-by-dive scope:
      // d.dd is a grouping column, so it feeds the UDF directly
      // (no MAX() wrapper).
      const pb = await reads.query(
        `WITH ${perDivePointsCte({
           name: "dive_totals",
           select: [
             "s.event_id", "s.round_number",
             "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
           ],
           dd:          "d.dd",
           pointsAlias: "dive_total",
           where: `s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE
             AND d.id IS NOT NULL
           ${DATE_FILTER}`,
         })},
         ranked AS (
           SELECT dt.*, e.name AS event_name, e.created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY dt.dive_code, dt.position, dt.height
                    ORDER BY dt.dive_total DESC, e.created_at DESC
                  ) AS rn
           FROM dive_totals dt
           JOIN events e ON e.id = dt.event_id
         )
         SELECT dive_code, position, height, dd, description,
                dive_total AS best_total,
                event_name, event_id, created_at,
                (SELECT COUNT(*) FROM dive_totals dt2
                  WHERE dt2.dive_code = ranked.dive_code
                    AND dt2.position = ranked.position
                    AND dt2.height   = ranked.height) AS attempts
         FROM ranked
         WHERE rn = 1
         ORDER BY dive_code ASC, position ASC`,
        [req.params.id, fromDate, toDate],
      );

      // Score trend: per-event total + final placing, oldest first
      // so a chart can plot it as a line.
      const trend = await reads.query(
        `WITH diver_events AS (
           SELECT DISTINCT s.event_id
           FROM scores s
           JOIN events e ON e.id = s.event_id
           WHERE s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE
           ${DATE_FILTER}
         ),
         ${perDivePointsCte({
           select: ["s.event_id", "s.competitor_id", "s.round_number"],
           where: `s.event_id IN (SELECT event_id FROM diver_events)
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
         })},
         all_event_totals AS (
           SELECT event_id, competitor_id, SUM(dive_points) AS total
           FROM per_dive
           GROUP BY event_id, competitor_id
         ),
         ranked AS (
           SELECT *, RANK() OVER (PARTITION BY event_id ORDER BY total DESC) AS rnk
           FROM all_event_totals
         )
         SELECT e.id AS event_id, e.name AS event_name, e.height,
                e.gender, e.status, e.created_at,
                e.event_type::text AS event_type,
                ranked.total::numeric(8,2) AS total_score,
                ranked.rnk::int AS final_rank,
                partner.full_name AS partner_name,
                tm.name AS team_name
         FROM ranked
         JOIN events e ON e.id = ranked.event_id
         LEFT JOIN LATERAL (
           SELECT DISTINCT cdl.partner_id
           FROM competitor_dive_lists cdl
           WHERE cdl.event_id = e.id
             AND cdl.competitor_id = $1
             AND cdl.partner_id IS NOT NULL
           LIMIT 1
         ) p ON true
         LEFT JOIN users partner ON partner.id = p.partner_id
         LEFT JOIN LATERAL (
           SELECT DISTINCT cdl.team_id
           FROM competitor_dive_lists cdl
           WHERE cdl.event_id = e.id
             AND cdl.competitor_id = $1
             AND cdl.team_id IS NOT NULL
           LIMIT 1
         ) tlink ON e.event_type = 'team'
         LEFT JOIN teams tm ON tm.id = tlink.team_id
         WHERE ranked.competitor_id = $1
         ORDER BY e.created_at ASC`,
        [req.params.id, fromDate, toDate],
      );

      res.json({
        diver: {
          id: diver.id,
          full_name: diver.full_name,
          org_id: diver.org_id,
          org_name: diver.org_name,
          country_code: diver.country_code,
          club_id: diver.club_id,
          club_name: diver.club_name,
          club_code: diver.club_code,
        },
        stats: stats.rows[0] || {
          total_meets: 0,
          total_dives: 0,
          avg_dd: null,
          best_single_dive: null,
        },
        personal_bests: pb.rows,
        score_trend: trend.rows,
        // Only return the diver's saved dashboard layout to viewers
        // who own it (or sit above them in the same org). To outside
        // viewers its irrelevant noise that also leaks a UI
        // preference, so we omit the key entirely.
        ...(canViewDiverPrivate(req.user, diver)
          ? {
              dashboard_widgets: diver.dashboard_widgets ||
                ["score_trend", "personal_bests", "recent_form", "placings"],
            }
          : {}),
      });
    } catch (err) {
      console.error("[Diver Profile Error]", err.message);
      res.status(500).json({ error: "Failed to load diver profile" });
    }
  });

  // -------------------------------------------------------------
  // GET /api/divers/:id/analytics: 11 widget rollups in parallel
  // -------------------------------------------------------------
  router.get("/api/divers/:id/analytics", maybeAuth, async (req, res) => {
    try {
      let dateRange;
      try { dateRange = parseDateRange(req.query); }
      catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
      const { from: fromDate, to: toDate } = dateRange;

      const diverRes = await reads.query(
        "SELECT id, org_id FROM users WHERE id = $1 AND deleted_at IS NULL",
        [req.params.id],
      );
      if (!diverRes.rows.length) {
        return res.status(404).json({ error: "Diver not found" });
      }
      if (!canViewDiverProfile(req.user, diverRes.rows[0])) {
        return res.status(403).json({ error: "Not permitted to view this profile" });
      }
      const id = req.params.id;
      const orgId = diverRes.rows[0].org_id;

      // PER_DIVE shared CTE; FULL_FIELD_RANKING (recent_form,
      // placings, streak, year_over_year) ranks against every
      // competitor in the diver's events, then filters to the
      // diver. Otherwise rank always = 1 because the CTE was
      // pre-filtered to one diver.
      const PER_DIVE = SHARED_PER_DIVE;

      // Wrap each rollup so one bad query doesn't take down the
      // whole payload, kinda defensive but worth it. Anything that
      // throws is logged with its label and returns []; the
      // response then renders empty for that widget and the rest
      // of the dashboard still works.
      const runQuery = async (label, sql, params) => {
        try {
          const r = await reads.query(sql, params);
          return r.rows;
        } catch (err) {
          console.error(`[Analytics ${label}]`, err.message);
          return [];
        }
      };

      const queries = await Promise.all([
        runQuery("recent_form",
          `WITH ${FULL_FIELD_RANKING}
           SELECT e.id AS event_id, e.name AS event_name, e.created_at,
                  r.total, r.rank,
                  /* field_size precomputed inside FULL_FIELD_RANKING.ranked.
                     The outer WHERE clause filters to one diver, so a
                     window in this SELECT would see only one row. */
                  r.field_size
           FROM ranked r
           JOIN events e ON e.id = r.event_id
           WHERE r.competitor_id = $1
           ORDER BY e.created_at DESC
           LIMIT 5`,
          [id, fromDate, toDate],
        ),

        runQuery("placings",
          `WITH ${FULL_FIELD_RANKING}
           SELECT
             COUNT(*) FILTER (WHERE rank = 1)::int AS gold,
             COUNT(*) FILTER (WHERE rank = 2)::int AS silver,
             COUNT(*) FILTER (WHERE rank = 3)::int AS bronze,
             COUNT(*) FILTER (WHERE rank BETWEEN 4 AND 8)::int  AS finalist,
             COUNT(*) FILTER (WHERE rank > 8)::int              AS further,
             COUNT(*)::int                                      AS total_meets
           FROM ranked WHERE competitor_id = $1`,
          [id, fromDate, toDate],
        ),

        runQuery("height_breakdown",
          `WITH per_dive AS (${PER_DIVE})
           SELECT height,
                  COUNT(*)::int                    AS dive_count,
                  AVG(dive_total)::numeric(6,2)    AS avg_score,
                  MAX(dive_total)::numeric(6,2)    AS best_score
           FROM per_dive
           WHERE competitor_id = $1 AND height IS NOT NULL
           GROUP BY height
           ORDER BY height ASC`,
          [id, fromDate, toDate],
        ),

        runQuery("round_stamina",
          `WITH per_dive AS (${PER_DIVE})
           SELECT round_number,
                  COUNT(*)::int                  AS dive_count,
                  AVG(dive_total)::numeric(6,2)  AS avg_score
           FROM per_dive
           WHERE competitor_id = $1
           GROUP BY round_number
           ORDER BY round_number ASC`,
          [id, fromDate, toDate],
        ),

        runQuery("quality_mix",
          `SELECT
             COUNT(*) FILTER (WHERE s.score = 0)::int                       AS failed,
             COUNT(*) FILTER (WHERE s.score > 0   AND s.score <= 2.0)::int AS very_deficient,
             COUNT(*) FILTER (WHERE s.score > 2.0 AND s.score <= 4.5)::int AS deficient,
             COUNT(*) FILTER (WHERE s.score > 4.5 AND s.score <= 6.5)::int AS satisfactory,
             COUNT(*) FILTER (WHERE s.score > 6.5 AND s.score <= 8.0)::int AS good,
             COUNT(*) FILTER (WHERE s.score > 8.0 AND s.score <= 9.5)::int AS very_good,
             COUNT(*) FILTER (WHERE s.score > 9.5)::int                     AS excellent,
             COUNT(*)::int                                                  AS total
           FROM scores s
           JOIN events e ON e.id = s.event_id
           WHERE s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE
             AND ($2::date IS NULL OR e.created_at >= $2::date)
             AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')`,
          [id, fromDate, toDate],
        ),

        runQuery("dd_risk",
          `WITH per_dive AS (${PER_DIVE})
           SELECT
             AVG(dd)::numeric(4,2)         AS avg_dd,
             MAX(dd)::numeric(4,2)         AS max_dd,
             AVG(dive_total)::numeric(6,2) AS avg_score,
             AVG(dive_total) FILTER (WHERE dd >= (SELECT MAX(dd) - 0.3 FROM per_dive WHERE competitor_id = $1))::numeric(6,2)
                                           AS avg_score_at_highest_dd,
             COUNT(*) FILTER (WHERE dd >= (SELECT MAX(dd) - 0.3 FROM per_dive WHERE competitor_id = $1))::int
                                           AS attempts_at_highest_dd
           FROM per_dive
           WHERE competitor_id = $1 AND dd IS NOT NULL`,
          [id, fromDate, toDate],
        ),

        runQuery("frequent_dives",
          `WITH per_dive AS (${PER_DIVE})
           SELECT dive_code, position, height,
                  COUNT(*)::int                    AS attempts,
                  AVG(dive_total)::numeric(6,2)    AS avg_score,
                  MAX(dive_total)::numeric(6,2)    AS best_score
           FROM per_dive
           WHERE competitor_id = $1 AND dive_code IS NOT NULL
           GROUP BY dive_code, position, height
           ORDER BY attempts DESC, avg_score DESC
           LIMIT 5`,
          [id, fromDate, toDate],
        ),

        runQuery("streak",
          `WITH ${FULL_FIELD_RANKING},
           streak_rows AS (
             SELECT r.event_id, r.rank, e.created_at
             FROM ranked r JOIN events e ON e.id = r.event_id
             WHERE r.competitor_id = $1
           )
           SELECT event_id, rank, created_at
           FROM streak_rows
           ORDER BY created_at DESC`,
          [id, fromDate, toDate],
        ),

        runQuery("compare_peers",
          `WITH me_dives AS (${PER_DIVE}),
           ${perDivePointsCte({
             name:        "peer_dives",
             select:      ["s.event_id", "s.competitor_id", "s.round_number", "d.dd"],
             pointsAlias: "dive_total",
             extraJoins:  ["JOIN users u ON u.id = s.competitor_id"],
             where: `u.org_id = $4
               AND s.competitor_id <> $1
               AND COALESCE(e.is_rehearsal, FALSE) = FALSE
               AND ($2::date IS NULL OR e.created_at >= $2::date)
               AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')`,
           })}
           SELECT
             (SELECT AVG(dd)::numeric(4,2)         FROM me_dives)   AS my_avg_dd,
             (SELECT AVG(dd)::numeric(4,2)         FROM peer_dives) AS peer_avg_dd,
             (SELECT MAX(dd)::numeric(4,2)         FROM me_dives)   AS my_max_dd,
             (SELECT MAX(dd)::numeric(4,2)         FROM peer_dives) AS peer_max_dd,
             (SELECT AVG(dive_total)::numeric(6,2) FROM me_dives)   AS my_avg_score,
             (SELECT AVG(dive_total)::numeric(6,2) FROM peer_dives) AS peer_avg_score,
             (SELECT COUNT(*)::int                 FROM me_dives)   AS my_dives,
             (SELECT COUNT(*)::int                 FROM peer_dives) AS peer_dives`,
          [id, fromDate, toDate, orgId],
        ),

        runQuery("event_type_splits",
          `WITH per_dive AS (${PER_DIVE}),
           event_totals AS (
             SELECT event_id, competitor_id, event_type,
                    SUM(dive_total) AS total
             FROM per_dive
             GROUP BY event_id, competitor_id, event_type
           ),
           dive_stats AS (
             SELECT event_type,
                    COUNT(*)::int                  AS dives,
                    AVG(dive_total)::numeric(6,2)  AS avg_dive_score,
                    MAX(dive_total)::numeric(6,2)  AS best_single_dive
             FROM per_dive
             GROUP BY event_type
           ),
           meet_stats AS (
             SELECT event_type,
                    COUNT(*)::int                  AS meets,
                    AVG(total)::numeric(8,2)       AS avg_meet_total,
                    MAX(total)::numeric(8,2)       AS best_meet_total
             FROM event_totals
             GROUP BY event_type
           )
           SELECT m.event_type,
                  m.meets, d.dives,
                  d.avg_dive_score, d.best_single_dive,
                  m.avg_meet_total, m.best_meet_total
           FROM meet_stats m
           LEFT JOIN dive_stats d USING (event_type)
           ORDER BY m.meets DESC`,
          [id, fromDate, toDate],
        ),

        runQuery("year_over_year",
          `WITH ${FULL_FIELD_RANKING},
           my_events AS (
             SELECT r.event_id, r.total, r.rank, e.created_at
             FROM ranked r
             JOIN events e ON e.id = r.event_id
             WHERE r.competitor_id = $1
           )
           SELECT EXTRACT(YEAR FROM created_at)::int    AS year,
                  COUNT(DISTINCT event_id)::int         AS meets,
                  AVG(total)::numeric(8,2)              AS avg_meet_total,
                  MAX(total)::numeric(8,2)              AS best_meet_total,
                  COUNT(*) FILTER (WHERE rank = 1)::int  AS wins,
                  COUNT(*) FILTER (WHERE rank <= 3)::int AS podiums
           FROM my_events
           GROUP BY EXTRACT(YEAR FROM created_at)
           ORDER BY year DESC`,
          [id, fromDate, toDate],
        ),
      ]);

      const [recent, placings, heights, rounds, quality, ddRisk, frequent, streak,
             comparePeers, eventTypeSplits, yearOverYear] = queries;

      // Recent Form expansion: for each meet returned, fetch
      // every dive the diver did with the per-judge raw scores so
      // the click-to-expand panel can render the trim algorithm
      // (dropped scores rendered with strike-through).
      if (recent.length) {
        const eventIds = recent.map((r) => r.event_id);
        const diveDetails = await runQuery("recent_form_dives",
          `${perDiveSelect({
            select: [
              "s.event_id", "s.round_number",
              "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
              "e.number_of_judges", "e.event_type::text AS event_type",
            ],
            pointsAlias: "dive_total",
            selectExtra: [
              `json_agg(
                    json_build_object(
                      'judge_number', ej.judge_number,
                      'score',        s.score
                    ) ORDER BY ej.judge_number
                  ) AS judges`,
            ],
            where: `s.competitor_id = $1
             AND s.event_id = ANY($2::uuid[])
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
            groupBy: [
              "s.event_id", "s.round_number",
              "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
            ],
          })}
           ORDER BY s.round_number ASC`,
          [id, eventIds],
        );
        const byEvent = new Map();
        for (const row of diveDetails) {
          const arr = byEvent.get(row.event_id) || [];
          arr.push(row);
          byEvent.set(row.event_id, arr);
        }
        for (const r of recent) {
          r.dives = byEvent.get(r.event_id) || [];
        }
      }

      // Streak post-processing: count consecutive top-3 from the
      // most recent meet backwards.
      let streakLen = 0;
      let streakKind = null;
      for (const row of streak) {
        const r = Number(row.rank);
        if (r === 1) {
          if (streakKind === "podium" || streakKind === "win" || streakKind === null) {
            streakKind = streakKind === "podium" ? "podium" : "win";
            streakLen++;
          } else break;
        } else if (r <= 3) {
          if (streakKind === null || streakKind === "podium") {
            streakKind = "podium";
            streakLen++;
          } else if (streakKind === "win") {
            // Win streak broken; switch to podium streak count
            streakKind = "podium";
            streakLen++;
          } else break;
        } else break;
      }

      res.json({
        recent_form: recent,
        placings: placings[0] || {
          gold: 0, silver: 0, bronze: 0,
          finalist: 0, further: 0, total_meets: 0,
        },
        height_breakdown: heights,
        round_stamina: rounds,
        quality_mix: quality[0] || {
          failed: 0, very_deficient: 0, deficient: 0, satisfactory: 0,
          good: 0, very_good: 0, excellent: 0, total: 0,
        },
        dd_risk: ddRisk[0] || {
          avg_dd: null, max_dd: null, avg_score: null,
          avg_score_at_highest_dd: null, attempts_at_highest_dd: 0,
        },
        frequent_dives: frequent,
        streak: { kind: streakKind, length: streakLen },
        compare_peers: comparePeers[0] || {
          my_avg_dd: null, peer_avg_dd: null,
          my_max_dd: null, peer_max_dd: null,
          my_avg_score: null, peer_avg_score: null,
          my_dives: 0, peer_dives: 0,
        },
        event_type_splits: eventTypeSplits,
        year_over_year: yearOverYear,
        filter: { from_date: fromDate, to_date: toDate },
      });
    } catch (err) {
      console.error("[Diver Analytics Error]", err.message);
      res.status(500).json({ error: "Failed to load analytics" });
    }
  });

  // -------------------------------------------------------------
  // PUT /api/users/me/dashboard: persist widget layout. Validated
  // against the known catalog so a typo can't poison the store.
  // -------------------------------------------------------------
  router.put("/api/users/me/dashboard", verifyToken, async (req, res) => {
    const { widgets } = req.body || {};
    if (!Array.isArray(widgets)) {
      return res.status(400).json({ error: "widgets must be an array of widget IDs" });
    }
    // Filter out unknown / duplicate IDs so storage stays clean.
    const cleaned = [];
    const seen = new Set();
    for (const w of widgets) {
      if (typeof w !== "string") continue;
      if (!KNOWN_WIDGETS.has(w)) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      cleaned.push(w);
    }
    try {
      const r = await pool.query(
        `UPDATE users SET dashboard_widgets = $1::jsonb
         WHERE id = $2
         RETURNING dashboard_widgets`,
        [JSON.stringify(cleaned), req.user.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "User not found" });
      res.json({ ok: true, widgets: r.rows[0].dashboard_widgets });
    } catch (err) {
      console.error("[Dashboard Save Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
