// Shared SQL CTE templates for diver analytics.
//
// The analytics endpoint runs ~10 small rollups, and several of them
// share the same "compute per-dive points" or "rank against the
// full field" shape. Keeping the CTEs in one place means a fix to
// the calculation logic (e.g. a synchro edge case) lands in every
// query at once instead of needing four parallel edits.
//
// IMPORTANT: each helper documents which $N parameters it expects
// from the caller. The caller's responsible for binding those
// params in the right order. The helpers don't choose param
// numbers themselves since pg-style positional parameters mean
// outer queries that compose multiple CTEs need to control the
// numbering. See server.js' /api/divers/:id/analytics for usage.

const { perDiveSelect, perDivePointsCte } = require("../lib/scoring-sql");

// =====================================================================
// PER_DIVE: one row per dive the diver performed.
//
// Filters to a single competitor and (optionally) a date range.
// Columns:
//   event_id, competitor_id, round_number,
//   dive_code, position, height, dd, description,
//   event_type::text AS event_type, created_at,
//   dive_total, avg_judge_score
//
// Required params:
//   $1 = competitor_id (uuid)
//   $2 = from_date (date or null)
//   $3 = to_date   (date or null)
// =====================================================================
const PER_DIVE = perDiveSelect({
  select: [
    "s.event_id", "s.competitor_id", "s.round_number",
    "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
    "e.event_type::text AS event_type", "e.created_at",
  ],
  pointsAlias: "dive_total",
  selectExtra: ["AVG(s.score) AS avg_judge_score"],
  where: `s.competitor_id = $1
    AND COALESCE(e.is_rehearsal, FALSE) = FALSE
    AND ($2::date IS NULL OR e.created_at >= $2::date)
    AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')`,
  groupBy: [
    "s.event_id", "s.competitor_id", "s.round_number",
    "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
  ],
  groupByExtra: ["e.created_at"],
});

// =====================================================================
// FULL_FIELD_RANKING: for queries that need the diver's RANK against
// every competitor in their events (recent_form, placings, streak,
// year_over_year). Returns a chain of CTEs you splice into a parent
// WITH clause:
//
//   WITH ${FULL_FIELD_RANKING}
//   SELECT … FROM my_events WHERE …
//
// CTE chain:
//   diver_events  : { event_id }   the events the diver competed in
//   all_per_dive  : every dive in those events, by every competitor
//   event_totals  : per-(event, competitor) sum of dive points + a
//                   `dives_desc` array of the diver's dive points
//                   sorted descending (used as the tie-break key)
//   ranked        : event_totals + RANK over the World Aquatics ordering:
//                     ORDER BY total DESC, dives_desc DESC
//                   plus an `is_tied_on_total` flag for UI hints
//                   when two divers share a raw total but the
//                   secondary criterion separates them.
//
// Required params:
//   $1 = competitor_id (uuid), the diver of interest
//   $2 = from_date (date or null)
//   $3 = to_date   (date or null)
//
// World Aquatics tie-break: when two divers have the same total, the higher
// finish goes to whoever has the highest single dive; if those tie,
// the second-highest, and so on. Postgres' element-wise array
// comparison on `dives_desc DESC` implements that exactly:
// [9,8,7] > [9,8,6] > [9,8,5]. RANK() with that ordering gives the
// correct World Aquatics placement for free.
// =====================================================================
const FULL_FIELD_RANKING = `
  diver_events AS (
    SELECT DISTINCT s.event_id
    FROM scores s
    JOIN events e ON e.id = s.event_id
    WHERE s.competitor_id = $1
      AND COALESCE(e.is_rehearsal, FALSE) = FALSE
      AND ($2::date IS NULL OR e.created_at >= $2::date)
      AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')
  ),
  ${perDivePointsCte({
    name:   "all_per_dive",
    select: ["s.event_id", "s.competitor_id", "s.round_number"],
    where:  "s.event_id IN (SELECT event_id FROM diver_events)",
  })},
  event_totals AS (
    SELECT event_id, competitor_id,
           SUM(dive_points) AS total,
           array_agg(dive_points ORDER BY dive_points DESC) AS dives_desc
    FROM all_per_dive
    GROUP BY event_id, competitor_id
  ),
  ranked AS (
    SELECT et.*,
           RANK() OVER (
             PARTITION BY et.event_id
             ORDER BY et.total DESC, et.dives_desc DESC
           ) AS rank,
           /* True when 2+ rows in this event share the SAME total,
              shows an "=" marker in the UI so spectators understand why
              two divers with identical totals were separated. */
           COUNT(*) OVER (
             PARTITION BY et.event_id, et.total
           ) > 1 AS is_tied_on_total,
           /* field_size precomputed here (not in the outer SELECT)
              because outer queries filter to the diver via
              WHERE competitor_id = $1; window functions run AFTER
              WHERE so a window in the outer query would see only
              the one row and return 1. Computing it inside the
              CTE lets recent_form and friends just select it. */
           COUNT(*) OVER (PARTITION BY et.event_id)::int AS field_size
    FROM event_totals et
  )
`;

// =====================================================================
// JUDGE_PER_DIVE: one row per (judge, dive) the judge scored.
//
// Filters to a single judge_id and (optionally) a date range. Each row
// includes:
//
//   * The judge's own score for that dive (`my_score`).
//   * The panel-kept mean (`panel_kept_mean`), the arithmetic mean
//     of the post World Aquatics-trim scores for that dive. This is
//     the reference point judge analytics measures against, not the
//     raw panel mean: the trim is what the dive-points formula
//     itself uses (Article 13 / dispatch via calc_event_dive_points)
//     and it's what spectators / referees compare a judge against
//     when checking whether the judge's call lined up with the
//     panel's consensus.
//   * `is_dropped`: TRUE when this judge's score was on the trimmed
//     ends (one of the highest k or lowest k for the panel size).
//     For a 7-judge panel this is the high-2 / low-2 the trim
//     drops. Drives the "drop rate" + hi/lo asymmetry metrics
//     (see WA Article 8.4.9, referee may remove a judge whose
//     judgement is unsatisfactory; a persistent hi-bias dropping
//     pattern is the kind of thing the WA judges programme
//     surfaces).
//   * `is_dropped_high` / `is_dropped_low`: disambiguate the two
//     ends of the trim. NULL when not dropped.
//   * `dive_group`: the first digit of dive_code (1=forward,
//     2=back, 3=reverse, 4=inward, 5=twisting, 6=armstand). Powers
//     the per-group breakdown widget.
//   * Diver demographics: diver_org_id, diver_country_code,
//     diver_club_id (for per-country / per-club bias breakdowns).
//
// The kept-mean is computed inline rather than via a SQL function,
// so we don't need a separate immutable function for trimmed-mean
// (calc_dive_points returns sum × DD × scaling, not the unweighted
// kept mean we want here). The CTE filters to the panel size n + 2
// (so a 5-judge panel returns a kept-mean over the middle 3) using
// the same drop_count rule as calc_dive_points.
//
// IMPORTANT: synchro events have role-grouped trim (sub-panels for
// exec A / exec B / synchronisation) that don't fit a single kept-
// mean. JUDGE_PER_DIVE excludes synchro_pair dives from the
// `panel_kept_mean` to avoid a misleading number, the analytics
// endpoint surfaces synchro dive counts separately.
//
// Required params:
//   $1 = judge_id (uuid)
//   $2 = from_date (date or null)
//   $3 = to_date   (date or null)
// =====================================================================
const JUDGE_PER_DIVE = `
  SELECT
    s.event_id,
    s.competitor_id,
    s.round_number,
    s.judge_id,
    s.score::numeric                       AS my_score,
    e.created_at,
    e.event_type::text                     AS event_type,
    e.number_of_judges                     AS panel_size,
    e.height                               AS event_height,
    d.dive_code,
    d.position,
    d.height                               AS dive_height,
    d.dd,
    /* First digit of dive_code → dive group. Lowercase 'a'..'z'
       might appear (armstand 6xxx) so cast TEXT → take left 1. */
    LEFT(d.dive_code, 1)                   AS dive_group,
    /* Diver context for per-country / per-club / per-diver
       breakdowns. LEFT JOIN so a diver whose user row was
       deleted (rare, soft delete) still leaves the dive in
       the analysis. */
    cu.org_id                              AS diver_org_id,
    co.country_code                        AS diver_country_code,
    cu.club_id                             AS diver_club_id,
    cl.short_code                          AS diver_club_code,
    cu.full_name                           AS diver_name,
    /* Panel context: the full panel's scores for THIS dive,
       used downstream by analytics rollups that need to know
       e.g. how the rest of the panel behaved on the same call. */
    panel.panel_scores                     AS panel_scores,
    /* Kept arithmetic mean: the AVG over the post World Aquatics-trim
       slice of the sorted panel. Synchro panels excluded (the
       trim is role-grouped, not a single mid-panel slice). For
       small panels where COUNT(*) <= drop_count*2 we fall back
       to the raw mean, same behaviour as calc_dive_points'
       "no trim if not enough scores" branch. */
    CASE
      WHEN e.event_type::text = 'synchro_pair' THEN NULL
      WHEN array_length(panel.panel_scores, 1) IS NULL THEN NULL
      WHEN array_length(panel.panel_scores, 1) <= panel.drop_count * 2 THEN
        (SELECT AVG(v)::numeric FROM unnest(panel.panel_scores) AS v)
      ELSE
        (SELECT AVG(v)::numeric
         FROM unnest(
           panel.panel_scores[
             (panel.drop_count + 1)
             :
             (array_length(panel.panel_scores, 1) - panel.drop_count)
           ]
         ) AS v)
    END                                    AS panel_kept_mean,
    /* This judge's relationship to the trim:
         - is_dropped       TRUE on the dropped low/high ends
         - is_dropped_high  TRUE only on the dropped HIGH end
         - is_dropped_low   TRUE only on the dropped LOW  end
       For 7-judge: drop_count = 2 → 2 highest + 2 lowest dropped.
       For 5-judge: drop_count = 1 → 1 highest + 1 lowest dropped.
       For 3-judge: drop_count = 0 → no scores dropped.
       Synchro panels (9, 11) are excluded from this signal,
       see the file header. */
    CASE
      WHEN e.event_type::text = 'synchro_pair' THEN NULL
      WHEN s.score >= panel.high_threshold THEN TRUE
      WHEN s.score <= panel.low_threshold  THEN TRUE
      ELSE FALSE
    END                                    AS is_dropped,
    CASE
      WHEN e.event_type::text = 'synchro_pair' THEN NULL
      WHEN s.score >= panel.high_threshold THEN TRUE
      ELSE FALSE
    END                                    AS is_dropped_high,
    CASE
      WHEN e.event_type::text = 'synchro_pair' THEN NULL
      WHEN s.score <= panel.low_threshold  THEN TRUE
      ELSE FALSE
    END                                    AS is_dropped_low
  FROM scores s
  JOIN events e ON e.id = s.event_id
  LEFT JOIN competitor_dive_lists cdl
    ON cdl.event_id = s.event_id
   AND cdl.competitor_id = s.competitor_id
   AND cdl.round_number = s.round_number
  LEFT JOIN dive_directory d
    ON d.id = COALESCE(s.dive_id, cdl.dive_id)
  LEFT JOIN users cu ON cu.id = s.competitor_id
  LEFT JOIN organisations co ON co.id = cu.org_id
  LEFT JOIN clubs cl ON cl.id = cu.club_id
  /* Panel-level rollup for the same (event, competitor, round).
     We compute the trim thresholds from the sorted panel scores:
       drop_count = 2 for 7-judge, 1 for 5-judge, 3 for 11-judge,
                    2 for 9-judge, 0 otherwise.
     low_threshold  = the (drop_count)th lowest score
     high_threshold = the (drop_count)th highest score
     A judge whose score is <= low_threshold sits on the dropped
     low end; >= high_threshold on the dropped high end. Ties
     break against the judge, same behaviour as the live trim,
     which drops "the lowest k by sorted order regardless of
     duplicates". This means a 3-way tie at the bottom drops all
     three, which over-reports drops on rare tie cases (fine for
     analytics); the trim function in init.sql does the same. */
  LEFT JOIN LATERAL (
    SELECT
      array_agg(s2.score ORDER BY s2.score)::numeric[] AS panel_scores,
      /* drop_count by panel size (Article 13 / calc_dive_points). */
      CASE
        WHEN e.number_of_judges = 5  THEN 1
        WHEN e.number_of_judges = 7  THEN 2
        WHEN e.number_of_judges = 9  THEN 2
        WHEN e.number_of_judges = 11 THEN 3
        ELSE 0
      END AS drop_count,
      /* low_threshold = the score at index (drop_count) when
         sorted ascending. For drop_count = 0 we pick a sentinel
         below the score range (-1) so no row is flagged. */
      COALESCE(
        (array_agg(s2.score ORDER BY s2.score))[
          (CASE
            WHEN e.number_of_judges = 5  THEN 1
            WHEN e.number_of_judges = 7  THEN 2
            WHEN e.number_of_judges = 9  THEN 2
            WHEN e.number_of_judges = 11 THEN 3
            ELSE 0
          END)
        ],
        -1
      ) AS low_threshold,
      /* high_threshold = the score at index (count - drop_count + 1)
         when sorted ascending. Sentinel 11 above the range when
         drop_count = 0. */
      COALESCE(
        (array_agg(s2.score ORDER BY s2.score))[
          (COUNT(*)::int - (CASE
            WHEN e.number_of_judges = 5  THEN 1
            WHEN e.number_of_judges = 7  THEN 2
            WHEN e.number_of_judges = 9  THEN 2
            WHEN e.number_of_judges = 11 THEN 3
            ELSE 0
          END) + 1)
        ],
        11
      ) AS high_threshold
    FROM scores s2
    WHERE s2.event_id      = s.event_id
      AND s2.competitor_id = s.competitor_id
      AND s2.round_number  = s.round_number
  ) panel ON TRUE
  WHERE s.judge_id = $1
    AND COALESCE(e.is_rehearsal, FALSE) = FALSE
    AND ($2::date IS NULL OR e.created_at >= $2::date)
    AND ($3::date IS NULL OR e.created_at <  $3::date + INTERVAL '1 day')
`;

module.exports = { PER_DIVE, FULL_FIELD_RANKING, JUDGE_PER_DIVE };
