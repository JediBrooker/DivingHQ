// Judge Analysis, the analytics endpoint for the JudgeProfileView.
//
//   GET /api/judges/:id/profile     header stats + recent meets
//   GET /api/judges/:id/analytics   the customisable widget rollups
//   GET /api/judges/directory       public directory (paginated browse)
//   GET /api/judges/search          public typeahead (≥2 chars)
//   PUT /api/users/me/judge-dashboard
//                                   persist the judge's widget layout
//                                   (owner-only, the only mutating
//                                   endpoint here)
//
// The numeric reference for every "how is this judge tracking?"
// metric is the **panel-kept mean**, the arithmetic mean of the
// scores that survived the World Aquatics trim for that dive
// (PART FOUR, Article 13 trim rules). That's the same kept set the
// dive-points formula uses, so a judge's deviation from it is the
// same signal an WA judges' assessor would compute by hand.
//
// References (PART FOUR of the World Aquatics Competition Regulations,
// in force as of February 2026):
//   * 7.9    : Awards and scoring of dives by Judges (judges
//              award between 0 and 10 in 0.5 increments, simultaneously,
//              without communicating).
//   * 8.4.9  : Referee may remove a Judge whose judgement is
//              regarded as unsatisfactory; the Referee writes a
//              report to the Jury of Appeal explaining the basis.
//              Self-service deviation analytics give a judge their
//              own evidence trail before that point.
//   * 10     : General criteria for judging dives (technique,
//              grace, execution, completion of starting position,
//              approach, take-off, flight, entry).
//
// Permissions
// -----------
// Judge profiles + analytics are PUBLIC by design, the same
// transparency stance the existing diver profile takes (every
// score this analytics rollup aggregates is already visible on
// the public scoreboard, archived meet pages, and PDF score
// sheets; pre-aggregating per-judge just makes patterns visible
// instead of leaving them buried in 300 rows of per-dive HTML).
// Public visibility is the explicit feature: a spectator looking
// at a meet can click through to the panel and check whether a
// judge's calls trend with their country / club / etc.
//
// What stays private
//   * `judge_dashboard_widgets`: UI preference. Returned only to
//     the owner and to same-org admins/managers/referees who can
//     plausibly customise on the judge's behalf. Outside viewers
//     don't see the field at all (it's redacted, not zero'd).
//   * The PUT endpoint: owner only.
//
// The endpoints accept a `?from_date=&to_date=` filter so a
// viewer can scope a window (e.g. the last competition season),
// same parsing helper the diver-profile router uses.

const express = require("express");
const { JUDGE_PER_DIVE } = require("../db/queries");

// Catalog of widget IDs the judge can enable on their dashboard.
// Mirrors the frontend JUDGE_WIDGET_CATALOG. Validated against
// inbound arrays so a typo can't poison the store. If you add one
// on the frontend, add it here too.
const KNOWN_WIDGETS = new Set([
  "bias_summary",
  "deviation_distribution",
  "agreement_rate",
  "drop_rate",
  "height_breakdown",
  "group_breakdown",
  "country_breakdown",
  "club_breakdown",
  "diver_breakdown",
  "round_breakdown",
  "dd_breakdown",
  "recent_meets",
  "score_trend",
  "panel_compare",
  "panel_deviation",
]);

// True when the viewer is allowed to see judge-private fields
// (UI preferences, etc.) on top of the public analytics. Owners
// and same-org administrative roles see them; the public doesn't.
function canViewJudgePrivate(viewer, judgeRow) {
  if (!viewer) return false;
  if (viewer.is_system_admin) return true;
  if (viewer.id === judgeRow.id) return true;
  if (viewer.org_id !== judgeRow.org_id) return false;
  const roles = viewer.org_roles || [];
  return (
    roles.includes("org_admin") ||
    roles.includes("meet_manager") ||
    roles.includes("referee")
  );
}

// -------------------------------------------------------------
// JUDGE_ANALYTICS_BUNDLE: the 13 date-free analytics widgets in a
// single statement that materialises JUDGE_PER_DIVE exactly once
// and fans every widget out of it as a jsonb column.
//
// Why one query: the per-widget version re-materialised the
// JUDGE_PER_DIVE CTE (scores ⨝ events ⟕ dive_directory + the panel
// LATERAL) once PER widget, 16 evaluations of the same expensive
// per-dive panel math per request. `per_dive AS MATERIALIZED`
// computes it once; the 13 sub-selects then scan that in-memory
// result. (The 3 date-bearing widgets, recent_meets, score_trend,
// panel_deviation_per_event, stay native since their timestamp/date
// columns serialise differently through jsonb, so folding them in
// would change the wire shape. Net: 16 → 4 materialisations.)
//
// Byte-identical output: node-postgres returns `numeric` as a
// STRING ("0.500", scale preserved). Raw jsonb would coerce it to a
// JS number and drop trailing zeros, so every numeric is cast
// ::text, meaning the value the client receives is unchanged.
// Integer columns (::int) and uuid/text columns stay as-is (jsonb
// and the native driver agree on those). The equivalence is
// regression-guarded by test/judge-analytics.integration.test.js.
//
// Each sub-select below is its pre-consolidation widget query
// verbatim, reading FROM the shared per_dive instead of a private
// CTE copy. ORDER BY is applied inside each jsonb_agg so array order
// matches the old per-widget ORDER BY exactly.
const JUDGE_ANALYTICS_BUNDLE = `
  WITH per_dive AS MATERIALIZED (${JUDGE_PER_DIVE})
  SELECT
    -- bias_summary (one-row headline)
    (SELECT to_jsonb(t) FROM (
       SELECT
         COUNT(*) FILTER (
           WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
         )::int                                                       AS sample_size,
         ((AVG(my_score - panel_kept_mean)
            FILTER (WHERE event_type <> 'synchro_pair'))::numeric(5,3))::text
                                                                      AS mean_signed_deviation,
         ((AVG(ABS(my_score - panel_kept_mean))
            FILTER (WHERE event_type <> 'synchro_pair'))::numeric(5,3))::text
                                                                      AS mean_abs_deviation,
         ((STDDEV_SAMP(my_score - panel_kept_mean)
            FILTER (WHERE event_type <> 'synchro_pair'))::numeric(5,3))::text
                                                                      AS stddev_deviation
       FROM per_dive
     ) t)                                                            AS bias_summary,

    -- deviation_distribution (signed-deviation histogram)
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_object('bucket', bucket, 'count', count) ORDER BY ord
            ), '[]'::jsonb)
     FROM (
       SELECT bucket, COUNT(*)::int AS count,
              CASE bucket
                WHEN '<= -1.5' THEN 1 WHEN '-1.0' THEN 2 WHEN '-0.5' THEN 3
                WHEN '0.0' THEN 4 WHEN '+0.5' THEN 5 WHEN '+1.0' THEN 6
                WHEN '>= +1.5' THEN 7 END AS ord
       FROM (
         SELECT CASE
                  WHEN (my_score - panel_kept_mean) <= -1.5 THEN '<= -1.5'
                  WHEN (my_score - panel_kept_mean) <= -1.0 THEN '-1.0'
                  WHEN (my_score - panel_kept_mean) <= -0.5 THEN '-0.5'
                  WHEN (my_score - panel_kept_mean) <  0.5  THEN '0.0'
                  WHEN (my_score - panel_kept_mean) <  1.0  THEN '+0.5'
                  WHEN (my_score - panel_kept_mean) <  1.5  THEN '+1.0'
                  ELSE '>= +1.5'
                END AS bucket
         FROM per_dive
         WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
       ) b
       GROUP BY bucket
     ) t)                                                            AS deviation_distribution,

    -- agreement_rate (within ±0.5 / ±1.0 of the kept-mean)
    (SELECT to_jsonb(t) FROM (
       SELECT
         COUNT(*)::int                                               AS total,
         COUNT(*) FILTER (WHERE ABS(delta) <= 0.5)::int              AS within_half,
         COUNT(*) FILTER (WHERE ABS(delta) <= 1.0)::int              AS within_one,
         ((COUNT(*) FILTER (WHERE ABS(delta) <= 0.5)::numeric
           / NULLIF(COUNT(*),0))::numeric(4,3))::text                AS within_half_rate,
         ((COUNT(*) FILTER (WHERE ABS(delta) <= 1.0)::numeric
           / NULLIF(COUNT(*),0))::numeric(4,3))::text                AS within_one_rate
       FROM (
         SELECT my_score - panel_kept_mean AS delta
         FROM per_dive
         WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
       ) comparable
     ) t)                                                            AS agreement_rate,

    -- drop_rate (how often trimmed + hi/lo split)
    (SELECT to_jsonb(t) FROM (
       SELECT
         COUNT(*) FILTER (WHERE is_dropped IS NOT NULL)::int         AS sample_size,
         COUNT(*) FILTER (WHERE is_dropped IS TRUE)::int             AS dropped,
         COUNT(*) FILTER (WHERE is_dropped_high IS TRUE)::int        AS dropped_high,
         COUNT(*) FILTER (WHERE is_dropped_low IS TRUE)::int         AS dropped_low,
         ((COUNT(*) FILTER (WHERE is_dropped IS TRUE)::numeric
           / NULLIF(COUNT(*) FILTER (WHERE is_dropped IS NOT NULL),0)
          )::numeric(4,3))::text                                     AS drop_rate,
         ((COUNT(*) FILTER (WHERE is_dropped_high IS TRUE)::numeric
           / NULLIF(COUNT(*) FILTER (WHERE is_dropped IS NOT NULL),0)
          )::numeric(4,3))::text                                     AS drop_high_rate,
         ((COUNT(*) FILTER (WHERE is_dropped_low IS TRUE)::numeric
           / NULLIF(COUNT(*) FILTER (WHERE is_dropped IS NOT NULL),0)
          )::numeric(4,3))::text                                     AS drop_low_rate
       FROM per_dive
     ) t)                                                            AS drop_rate,

    -- height_breakdown (deviation per board height)
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'height', height_txt, 'dives', dives,
                'signed_deviation', signed_deviation, 'abs_deviation', abs_deviation,
                'my_avg', my_avg, 'panel_avg', panel_avg
              ) ORDER BY height_num ASC), '[]'::jsonb)
     FROM (
       SELECT dive_height AS height_num, dive_height::text AS height_txt,
              COUNT(*)::int                                          AS dives,
              (AVG(my_score - panel_kept_mean)::numeric(5,3))::text  AS signed_deviation,
              (AVG(ABS(my_score - panel_kept_mean))::numeric(5,3))::text AS abs_deviation,
              (AVG(my_score)::numeric(4,2))::text                    AS my_avg,
              (AVG(panel_kept_mean)::numeric(4,2))::text             AS panel_avg
       FROM per_dive
       WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
         AND dive_height IS NOT NULL
       GROUP BY dive_height
     ) t)                                                            AS height_breakdown,

    -- group_breakdown (deviation per dive group 1..6)
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'dive_group', dive_group, 'dives', dives,
                'signed_deviation', signed_deviation, 'abs_deviation', abs_deviation,
                'my_avg', my_avg, 'panel_avg', panel_avg
              ) ORDER BY dive_group ASC), '[]'::jsonb)
     FROM (
       SELECT dive_group,
              COUNT(*)::int                                          AS dives,
              (AVG(my_score - panel_kept_mean)::numeric(5,3))::text  AS signed_deviation,
              (AVG(ABS(my_score - panel_kept_mean))::numeric(5,3))::text AS abs_deviation,
              (AVG(my_score)::numeric(4,2))::text                    AS my_avg,
              (AVG(panel_kept_mean)::numeric(4,2))::text             AS panel_avg
       FROM per_dive
       WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
         AND dive_group IS NOT NULL
       GROUP BY dive_group
     ) t)                                                            AS group_breakdown,

    -- country_breakdown (top 12 by |deviation|, HAVING >= 3)
    -- The pre-consolidation query ordered by ABS(signed) DESC,
    -- COUNT DESC with no further tiebreaker, leaving exact ties (and
    -- therefore the cut at 12) unordered/plan-dependent. A stable
    -- final key (the group identity) is appended so the rank, the
    -- cut, and the row order are deterministic. The frontend treats
    -- the list as a set of ranked rows, so pinning tie order is safe.
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'country_code', country_code, 'dives', dives,
                'signed_deviation', signed_deviation, 'abs_deviation', abs_deviation
              ) ORDER BY rn), '[]'::jsonb)
     FROM (
       SELECT diver_country_code AS country_code,
              COUNT(*)::int                                          AS dives,
              (AVG(my_score - panel_kept_mean)::numeric(5,3))::text  AS signed_deviation,
              (AVG(ABS(my_score - panel_kept_mean))::numeric(5,3))::text AS abs_deviation,
              row_number() OVER (
                ORDER BY ABS(AVG(my_score - panel_kept_mean)) DESC NULLS LAST,
                         COUNT(*) DESC, diver_country_code ASC
              ) AS rn
       FROM per_dive
       WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
         AND diver_country_code IS NOT NULL
       GROUP BY diver_country_code
       HAVING COUNT(*) >= 3
     ) t
     WHERE rn <= 12)                                                 AS country_breakdown,

    -- club_breakdown (top 12 by |deviation|, HAVING >= 3)
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'club_id', club_id, 'club_code', club_code, 'dives', dives,
                'signed_deviation', signed_deviation, 'abs_deviation', abs_deviation
              ) ORDER BY rn), '[]'::jsonb)
     FROM (
       SELECT diver_club_id AS club_id, diver_club_code AS club_code,
              COUNT(*)::int                                          AS dives,
              (AVG(my_score - panel_kept_mean)::numeric(5,3))::text  AS signed_deviation,
              (AVG(ABS(my_score - panel_kept_mean))::numeric(5,3))::text AS abs_deviation,
              row_number() OVER (
                ORDER BY ABS(AVG(my_score - panel_kept_mean)) DESC NULLS LAST,
                         COUNT(*) DESC, diver_club_id ASC
              ) AS rn
       FROM per_dive
       WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
         AND diver_club_id IS NOT NULL
       GROUP BY diver_club_id, diver_club_code
       HAVING COUNT(*) >= 3
     ) t
     WHERE rn <= 12)                                                 AS club_breakdown,

    -- diver_breakdown (top 12 by |deviation|, HAVING >= 3)
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'diver_id', diver_id, 'diver_name', diver_name,
                'country_code', country_code, 'dives', dives,
                'signed_deviation', signed_deviation, 'abs_deviation', abs_deviation
              ) ORDER BY rn), '[]'::jsonb)
     FROM (
       SELECT competitor_id AS diver_id, diver_name,
              diver_country_code AS country_code,
              COUNT(*)::int                                          AS dives,
              (AVG(my_score - panel_kept_mean)::numeric(5,3))::text  AS signed_deviation,
              (AVG(ABS(my_score - panel_kept_mean))::numeric(5,3))::text AS abs_deviation,
              row_number() OVER (
                ORDER BY ABS(AVG(my_score - panel_kept_mean)) DESC NULLS LAST,
                         COUNT(*) DESC, competitor_id ASC
              ) AS rn
       FROM per_dive
       WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
         AND competitor_id IS NOT NULL
       GROUP BY competitor_id, diver_name, diver_country_code
       HAVING COUNT(*) >= 3
     ) t
     WHERE rn <= 12)                                                 AS diver_breakdown,

    -- round_breakdown (deviation per round_number)
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'round_number', round_number, 'dives', dives,
                'signed_deviation', signed_deviation, 'abs_deviation', abs_deviation
              ) ORDER BY round_number ASC), '[]'::jsonb)
     FROM (
       SELECT round_number,
              COUNT(*)::int                                          AS dives,
              (AVG(my_score - panel_kept_mean)::numeric(5,3))::text  AS signed_deviation,
              (AVG(ABS(my_score - panel_kept_mean))::numeric(5,3))::text AS abs_deviation
       FROM per_dive
       WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
       GROUP BY round_number
     ) t)                                                            AS round_breakdown,

    -- dd_breakdown (deviation per DD bucket)
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'dd_bucket', dd_bucket, 'dives', dives,
                'signed_deviation', signed_deviation, 'abs_deviation', abs_deviation
              ) ORDER BY ord), '[]'::jsonb)
     FROM (
       SELECT dd_bucket,
              COUNT(*)::int                                          AS dives,
              (AVG(my_score - panel_kept_mean)::numeric(5,3))::text  AS signed_deviation,
              (AVG(ABS(my_score - panel_kept_mean))::numeric(5,3))::text AS abs_deviation,
              CASE dd_bucket
                WHEN 'easy (<2.0)' THEN 1 WHEN 'medium (2.0-2.5)' THEN 2
                WHEN 'hard (2.6-3.1)' THEN 3 WHEN 'very hard (3.2+)' THEN 4 END AS ord
       FROM (
         SELECT
           CASE
             WHEN dd <  2.0 THEN 'easy (<2.0)'
             WHEN dd <  2.6 THEN 'medium (2.0-2.5)'
             WHEN dd <  3.2 THEN 'hard (2.6-3.1)'
             ELSE                'very hard (3.2+)'
           END AS dd_bucket,
           my_score, panel_kept_mean
         FROM per_dive
         WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
           AND dd IS NOT NULL
       ) bucketed
       GROUP BY dd_bucket
     ) t)                                                            AS dd_breakdown,

    -- panel_compare (this judge vs panel kept-mean, two-bar)
    (SELECT to_jsonb(t) FROM (
       SELECT
         COUNT(*)::int                                               AS dives,
         (AVG(my_score)::numeric(4,2))::text                         AS my_avg,
         (AVG(panel_kept_mean)::numeric(4,2))::text                  AS panel_avg,
         (MIN(my_score)::numeric(3,1))::text                         AS my_min,
         (MAX(my_score)::numeric(3,1))::text                         AS my_max,
         (MIN(panel_kept_mean)::numeric(4,2))::text                  AS panel_min,
         (MAX(panel_kept_mean)::numeric(4,2))::text                  AS panel_max
       FROM per_dive
       WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
     ) t)                                                            AS panel_compare,

    -- panel_deviation_summary (differ-from-panel: loose + tight)
    (SELECT to_jsonb(t) FROM (
       SELECT
         COUNT(*)::int                                               AS total,
         COUNT(*) FILTER (
           WHERE my_score < kept_low OR my_score > kept_high
         )::int                                                      AS differ_loose,
         COUNT(*) FILTER (
           WHERE ABS(my_score - panel_kept_mean) >= 1.0
         )::int                                                      AS differ_tight,
         ((COUNT(*) FILTER (WHERE my_score < kept_low OR my_score > kept_high)::numeric
           / NULLIF(COUNT(*), 0))::numeric(4,3))::text               AS loose_rate,
         ((COUNT(*) FILTER (WHERE ABS(my_score - panel_kept_mean) >= 1.0)::numeric
           / NULLIF(COUNT(*), 0))::numeric(4,3))::text               AS tight_rate
       FROM (
         SELECT my_score, panel_kept_mean,
                panel_scores[(drop_count + 1)]                             AS kept_low,
                panel_scores[(array_length(panel_scores, 1) - drop_count)] AS kept_high
         FROM per_dive
         JOIN LATERAL (
           SELECT CASE
             WHEN panel_size = 5  THEN 1
             WHEN panel_size = 7  THEN 2
             WHEN panel_size = 9  THEN 2
             WHEN panel_size = 11 THEN 3
             ELSE 0
           END AS drop_count
         ) dc ON TRUE
         WHERE event_type <> 'synchro_pair' AND panel_kept_mean IS NOT NULL
       ) kept_bounds
     ) t)                                                            AS panel_deviation_summary
`;

module.exports = function createJudgeAnalyticsRouter({
  pool,
  readPool,
  verifyToken,
  optionalAuth,
  parseDateRange,
}) {
  if (!pool) throw new Error("createJudgeAnalyticsRouter requires { pool, … }");
  // Public-read endpoints (profile + analytics + directory) decode
  // the token if one is sent so we still see req.user for owner-
  // only branches (e.g. dashboard_widgets), but anonymous requests
  // are accepted. Falls back to verifyToken if the host hasn't
  // been updated yet, belt-and-braces during the rollout.
  const maybeAuth = optionalAuth || verifyToken;
  // Profile + analytics are heavy historical reads; route through
  // the optional read replica when available.
  const reads = readPool || pool;
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/judges/:id/profile: header stats + dashboard prefs
  // Public, anyone can read the analytics; owner / same-org
  // admins also get `dashboard_widgets` for the customise modal.
  // -------------------------------------------------------------
  router.get("/api/judges/:id/profile", maybeAuth, async (req, res) => {
    try {
      let dateRange;
      try { dateRange = parseDateRange(req.query); }
      catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
      const { from: fromDate, to: toDate } = dateRange;

      const judgeRes = await reads.query(
        `SELECT u.id, u.full_name, u.org_id, u.judge_dashboard_widgets,
                o.name AS org_name, o.country_code,
                u.club_id, cl.name AS club_name, cl.short_code AS club_code
         FROM users u
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.id = $1
           AND u.deleted_at IS NULL`,
        [req.params.id],
      );
      if (!judgeRes.rows.length) {
        return res.status(404).json({ error: "Judge not found" });
      }
      const judge = judgeRes.rows[0];
      // Profiles are public, no permission gate here. Owner-only
      // fields are redacted further down.

      // Header stats: total events officiated, total dives scored,
      // overall mean signed deviation, mean absolute deviation, drop
      // rate (and high/low split).
      const stats = await reads.query(
        `WITH per_dive AS (${JUDGE_PER_DIVE})
         SELECT
           COUNT(DISTINCT event_id)::int                         AS events_officiated,
           COUNT(*)::int                                         AS total_scores,
           COUNT(*) FILTER (
             WHERE event_type <> 'synchro_pair'
               AND panel_kept_mean IS NOT NULL
           )::int                                                AS comparable_scores,
           AVG(my_score - panel_kept_mean)
             FILTER (WHERE event_type <> 'synchro_pair')::numeric(5,3)
                                                                 AS mean_signed_deviation,
           AVG(ABS(my_score - panel_kept_mean))
             FILTER (WHERE event_type <> 'synchro_pair')::numeric(5,3)
                                                                 AS mean_abs_deviation,
           (
             COUNT(*) FILTER (WHERE is_dropped IS TRUE)::numeric
             /
             NULLIF(COUNT(*) FILTER (WHERE is_dropped IS NOT NULL), 0)
           )::numeric(4,3)                                       AS drop_rate,
           (
             COUNT(*) FILTER (WHERE is_dropped_high IS TRUE)::numeric
             /
             NULLIF(COUNT(*) FILTER (WHERE is_dropped IS NOT NULL), 0)
           )::numeric(4,3)                                       AS drop_high_rate,
           (
             COUNT(*) FILTER (WHERE is_dropped_low IS TRUE)::numeric
             /
             NULLIF(COUNT(*) FILTER (WHERE is_dropped IS NOT NULL), 0)
           )::numeric(4,3)                                       AS drop_low_rate
         FROM per_dive`,
        [req.params.id, fromDate, toDate],
      );

      res.json({
        judge: {
          id: judge.id,
          full_name: judge.full_name,
          org_id: judge.org_id,
          org_name: judge.org_name,
          country_code: judge.country_code,
          club_id: judge.club_id,
          club_name: judge.club_name,
          club_code: judge.club_code,
        },
        stats: stats.rows[0] || {
          events_officiated: 0,
          total_scores: 0,
          comparable_scores: 0,
          mean_signed_deviation: null,
          mean_abs_deviation: null,
          drop_rate: null,
          drop_high_rate: null,
          drop_low_rate: null,
        },
        // Only owner / same-org admins see the dashboard layout;
        // everyone else gets the public analytics without the UI
        // preference. Outside viewers don't see the field at all
        // (redacted, not zero'd) so there's nothing to leak.
        ...(canViewJudgePrivate(req.user, judge)
          ? {
              dashboard_widgets:
                judge.judge_dashboard_widgets ||
                ["bias_summary", "deviation_distribution", "height_breakdown", "recent_meets"],
            }
          : {}),
      });
    } catch (err) {
      console.error("[Judge Profile Error]", err.message);
      res.status(500).json({ error: "Failed to load judge profile" });
    }
  });

  // -------------------------------------------------------------
  // GET /api/judges/:id/analytics: widget rollups in parallel
  // Public, same transparency stance as the diver profile.
  // -------------------------------------------------------------
  router.get("/api/judges/:id/analytics", maybeAuth, async (req, res) => {
    try {
      let dateRange;
      try { dateRange = parseDateRange(req.query); }
      catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
      const { from: fromDate, to: toDate } = dateRange;

      const judgeRes = await reads.query(
        "SELECT id, org_id FROM users WHERE id = $1 AND deleted_at IS NULL",
        [req.params.id],
      );
      if (!judgeRes.rows.length) {
        return res.status(404).json({ error: "Judge not found" });
      }
      // Public endpoint, no permission gate.

      const id = req.params.id;

      // Wrap each rollup so one bad query doesn't take down the
      // whole payload, just in case. Anything that throws gets logged
      // and returns []; the response then renders empty for that
      // widget, and the rest of the dashboard still works.
      const runQuery = async (label, sql, params) => {
        try {
          const r = await reads.query(sql, params);
          return r.rows;
        } catch (err) {
          console.error(`[Judge Analytics ${label}]`, err.message);
          return [];
        }
      };

      const baseParams = [id, fromDate, toDate];

      // The non-date widgets used to run as 16 separate queries in
      // bounded batches; they now share ONE per_dive materialisation
      // (JUDGE_ANALYTICS_BUNDLE, above). runBatched still runs the
      // 3 remaining native (date-bearing) widgets, without holding
      // more than a batch's worth of pool slots at once.
      const runBatched = async (tasks, batchSize = 4) => {
        const results = [];
        for (let i = 0; i < tasks.length; i += batchSize) {
          const batch = tasks.slice(i, i + batchSize);
          results.push(...(await Promise.all(batch.map((t) => t()))));
        }
        return results;
      };

      // The 13 date-free widgets share one per_dive materialisation.
      // On error the bundle degrades to empty widgets (mirroring the
      // old per-widget try/catch) so a bundle failure still serves
      // the 3 native widgets below instead of 500-ing the whole page.
      const EMPTY_BUNDLE = {
        bias_summary: null, deviation_distribution: [], agreement_rate: null,
        drop_rate: null, height_breakdown: [], group_breakdown: [],
        country_breakdown: [], club_breakdown: [], diver_breakdown: [],
        round_breakdown: [], dd_breakdown: [], panel_compare: null,
        panel_deviation_summary: null,
      };
      let bundle = EMPTY_BUNDLE;
      try {
        const r = await reads.query(JUDGE_ANALYTICS_BUNDLE, baseParams);
        if (r.rows.length) bundle = r.rows[0];
      } catch (err) {
        console.error("[Judge Analytics bundle]", err.message);
      }

      // The 3 date-bearing widgets stay native (unchanged SQL), their
      // timestamp/date columns serialise differently through jsonb, so
      // folding them into the bundle would change the wire shape.
      const [recent_meets, score_trend, panel_deviation_per_event] =
        await runBatched([
          // ---- recent_meets: last 10 events officiated, with mean
          // signed deviation + dive count + drop rate per event.
          () => runQuery("recent_meets",
            `WITH per_dive AS (${JUDGE_PER_DIVE})
             SELECT
               p.event_id,
               e.name AS event_name,
               e.created_at,
               COUNT(*)::int                                              AS dives,
               AVG(p.my_score - p.panel_kept_mean)::numeric(5,3)          AS signed_deviation,
               AVG(ABS(p.my_score - p.panel_kept_mean))::numeric(5,3)     AS abs_deviation,
               (COUNT(*) FILTER (WHERE p.is_dropped IS TRUE)::numeric
                / NULLIF(COUNT(*) FILTER (WHERE p.is_dropped IS NOT NULL),0)
               )::numeric(4,3)                                            AS drop_rate
             FROM per_dive p
             JOIN events e ON e.id = p.event_id
             WHERE p.event_type <> 'synchro_pair'
               AND p.panel_kept_mean IS NOT NULL
             GROUP BY p.event_id, e.name, e.created_at
             ORDER BY e.created_at DESC
             LIMIT 10`,
            baseParams,
          ),
          // ---- score_trend: weekly mean signed deviation, oldest
          // first. Shows drift or steadiness over time.
          () => runQuery("score_trend",
            `WITH per_dive AS (${JUDGE_PER_DIVE})
             SELECT
               date_trunc('week', created_at)::date AS week,
               COUNT(*)::int                                              AS dives,
               AVG(my_score - panel_kept_mean)::numeric(5,3)              AS signed_deviation
             FROM per_dive
             WHERE event_type <> 'synchro_pair'
               AND panel_kept_mean IS NOT NULL
             GROUP BY date_trunc('week', created_at)
             ORDER BY date_trunc('week', created_at) ASC
             LIMIT 52`,
            baseParams,
          ),
          // ---- panel_deviation_per_event: the differ-tight rate
          // aggregated per event; most-recent first, cap 10.
          () => runQuery("panel_deviation_per_event",
            `WITH per_dive AS (${JUDGE_PER_DIVE}),
             per_event AS (
               SELECT pd.event_id, e.name AS event_name, e.created_at,
                      COUNT(*)::int AS dives,
                      COUNT(*) FILTER (
                        WHERE ABS(pd.my_score - pd.panel_kept_mean) >= 1.0
                      )::int AS differ_tight,
                      (
                        COUNT(*) FILTER (WHERE ABS(pd.my_score - pd.panel_kept_mean) >= 1.0)::numeric
                        / NULLIF(COUNT(*), 0)
                      )::numeric(4,3) AS tight_rate,
                      AVG(pd.my_score - pd.panel_kept_mean)::numeric(5,3) AS signed_deviation
                 FROM per_dive pd
                 JOIN events e ON e.id = pd.event_id
                WHERE pd.event_type <> 'synchro_pair' AND pd.panel_kept_mean IS NOT NULL
                GROUP BY pd.event_id, e.name, e.created_at
             )
             SELECT *
               FROM per_event
              ORDER BY created_at DESC
              LIMIT 10`,
            baseParams,
          ),
        ]);

      res.json({
        bias_summary:           bundle.bias_summary,
        deviation_distribution: bundle.deviation_distribution,
        agreement_rate:         bundle.agreement_rate,
        drop_rate:              bundle.drop_rate,
        height_breakdown:       bundle.height_breakdown,
        group_breakdown:        bundle.group_breakdown,
        country_breakdown:      bundle.country_breakdown,
        club_breakdown:         bundle.club_breakdown,
        diver_breakdown:        bundle.diver_breakdown,
        round_breakdown:        bundle.round_breakdown,
        dd_breakdown:           bundle.dd_breakdown,
        recent_meets,
        score_trend,
        panel_compare:          bundle.panel_compare,
        panel_deviation: {
          summary:   bundle.panel_deviation_summary,
          per_event: panel_deviation_per_event,
        },
      });
    } catch (err) {
      console.error("[Judge Analytics Error]", err.message);
      res.status(500).json({ error: "Failed to load judge analytics" });
    }
  });

  // -------------------------------------------------------------
  // GET /api/judges/search: public typeahead (≥2 chars, ≤20 rows)
  // Same shape as /api/divers/search; powers the public Judges
  // directory search box. Username is deliberately omitted (it's
  // a credential identifier; the UI label is full_name + club).
  // -------------------------------------------------------------
  router.get("/api/judges/search", maybeAuth, async (req, res) => {
    const q = (req.query.q || "").trim();
    if (q.length < 2) return res.json([]);
    try {
      const r = await reads.query(
        `SELECT u.id, u.full_name,
                o.id AS org_id, o.name AS org_name, o.country_code,
                cl.id AS club_id, cl.name AS club_name, cl.short_code AS club_code
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'judge'
         JOIN organisations o  ON o.id = u.org_id
         LEFT JOIN clubs cl    ON cl.id = u.club_id
         WHERE u.full_name ILIKE $1
           AND u.deleted_at IS NULL
         ORDER BY
           CASE WHEN u.full_name ILIKE $2 THEN 0 ELSE 1 END,
           u.full_name ASC
         LIMIT 20`,
        [`%${q}%`, `${q}%`],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Judge Search Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/judges/directory: public paginated browse + filters.
  // Each row carries a `total_scores` count so the directory can
  // sort/filter on "judges with at least N dives officiated"
  // (the deviation rollups are noisy under N≈10, so surfacing the
  // count up-front lets the UI tell viewers when to trust the
  // summary numbers).
  //
  // Path is `/directory` (not just `/api/judges`) because the
  // routes/users.js judge-picker endpoint already owns
  // `/api/judges` for the meet-manager assign UI; that one is
  // org-scoped and returns a tiny shape, this one is public and
  // paginated. Different consumers, different shapes, so we keep
  // them on distinct paths.
  // -------------------------------------------------------------
  router.get("/api/judges/directory", maybeAuth, async (req, res) => {
    const q           = (req.query.q || "").trim();
    const orgId       = req.query.org_id || null;
    const clubId      = req.query.club_id || null;
    const countryCode = (req.query.country_code || "").trim().toUpperCase() || null;
    const limit       = Math.min(Math.max(Number(req.query.limit)  || 50, 1), 100);
    const offset      = Math.max(Number(req.query.offset) || 0, 0);
    try {
      const r = await reads.query(
        `SELECT u.id, u.full_name,
                o.id AS org_id, o.name AS org_name, o.country_code,
                cl.id AS club_id, cl.name AS club_name, cl.short_code AS club_code,
                /* Count of scores submitted by this judge across
                   all events. Useful for the directory: a judge
                   with 0 dives doesn't yet have analytics, and
                   anyone consuming the bias number wants to know
                   the sample size up-front. LEFT JOIN keeps zero-
                   judge rows in the listing. */
                COALESCE(scs.total_scores, 0)::int AS total_scores,
                COUNT(*) OVER ()::int AS total_count
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'judge'
         JOIN organisations o  ON o.id = u.org_id
         LEFT JOIN clubs cl    ON cl.id = u.club_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS total_scores
           FROM scores s WHERE s.judge_id = u.id
         ) scs ON TRUE
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
      console.error("[Judge Browse Error]", err.message);
      res.status(500).json({ total: 0, limit, offset, rows: [] });
    }
  });

  // -------------------------------------------------------------
  // PUT /api/users/me/judge-dashboard: persist widget layout
  // -------------------------------------------------------------
  router.put("/api/users/me/judge-dashboard", verifyToken, async (req, res) => {
    try {
      const { widgets } = req.body || {};
      if (!Array.isArray(widgets)) {
        return res.status(400).json({ error: "widgets must be an array" });
      }
      // Filter to known IDs and de-dupe, silently drop unknowns
      // rather than 400ing, so a future widget removal doesn't
      // brick old clients sending stale lists.
      const seen = new Set();
      const cleaned = [];
      for (const w of widgets) {
        if (typeof w !== "string") continue;
        if (!KNOWN_WIDGETS.has(w)) continue;
        if (seen.has(w)) continue;
        seen.add(w);
        cleaned.push(w);
      }
      const r = await pool.query(
        `UPDATE users
            SET judge_dashboard_widgets = $1::jsonb
          WHERE id = $2
          RETURNING judge_dashboard_widgets`,
        [JSON.stringify(cleaned), req.user.id],
      );
      if (!r.rows.length) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ widgets: r.rows[0].judge_dashboard_widgets });
    } catch (err) {
      console.error("[Save Judge Dashboard Error]", err.message);
      res.status(500).json({ error: "Failed to save dashboard preferences" });
    }
  });

  return router;
};
