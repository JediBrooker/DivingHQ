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
// numbering. See /api/divers/:id/analytics in routes/diver-profile.js
// for usage.

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
//   event_totals  : per-(event, competitor) sum of dive points
//   ranked        : event_totals + RANK() by total, plus an
//                   `is_tied_on_total` flag for the "=" marker and the
//                   field size.
//
// Required params:
//   $1 = competitor_id (uuid), the diver of interest
//   $2 = from_date (date or null)
//   $3 = to_date   (date or null)
//
// Ties are shared places. World Aquatics Competition Regulations Art
// 4.1.5: "If two or more Athletes or teams score the same number of
// total points at the end of an event or stage of an event, a tie is
// declared for that particular place." Diving has no highest-single-
// dive tie-break (that's a different sport's rule), and ranking by one
// here put a diver 10th in their analytics while the scoreboard, recap
// and results PDF all had them joint 9th, or cost them a shared bronze
// in the placings widget. RANK() over the total alone matches those
// surfaces (routes/scoreboard.js, routes/archive.js).
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
           SUM(dive_points) AS total
    FROM all_per_dive
    GROUP BY event_id, competitor_id
  ),
  ranked AS (
    SELECT et.*,
           RANK() OVER (
             PARTITION BY et.event_id
             ORDER BY et.total DESC
           ) AS rank,
           /* True when 2+ rows in this event share the SAME total, i.e.
              share a place. The UI shows an "=" marker for it. */
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
//     itself uses (Article 9.1.5 / dispatch via calc_event_dive_points)
//     and it's what spectators / referees compare a judge against
//     when checking whether the judge's call lined up with the
//     panel's consensus.
//   * `is_dropped`: TRUE when this judge's score was on the trimmed
//     ends (one of the highest k or lowest k for the panel size).
//     For a 7-judge panel this is the high-2 / low-2 the trim
//     drops, exactly two at each end even when marks tie (Art
//     9.1.5.1: "When more than two (2) of either the highest or
//     lowest awards are equal, only two (2) of each will be
//     cancelled"). Drives the "drop rate" + hi/lo asymmetry metrics
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
       Nothing is flagged until more than 2 × drop_count marks are in,
       the same point where panel_kept_mean starts trimming.
       Synchro panels (9, 11) are excluded from this signal,
       see the file header. */
    CASE
      WHEN e.event_type::text = 'synchro_pair' THEN NULL
      ELSE panel.trims AND (panel.my_pos <= panel.drop_count
                            OR panel.my_pos > panel.n - panel.drop_count)
    END                                    AS is_dropped,
    CASE
      WHEN e.event_type::text = 'synchro_pair' THEN NULL
      ELSE panel.trims AND panel.my_pos > panel.n - panel.drop_count
    END                                    AS is_dropped_high,
    CASE
      WHEN e.event_type::text = 'synchro_pair' THEN NULL
      ELSE panel.trims AND panel.my_pos <= panel.drop_count
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
       drop_count = 2 for 7-judge, 1 for 5-judge, 3 for 11-judge,
                    2 for 9-judge, 0 otherwise.
     Drops go by position in the sorted panel, not by value: the k
     lowest positions and the k highest, ordered by score and then
     judge number, which is the order the live trim and the
     scoreboard's chips use (useScoreTrim's dropEndsByJudgeNumber).
     This used to compare each mark against the k-th lowest and k-th
     highest values, which flags every judge sitting on a tied
     boundary. With half-point marks that's most dives, not a rare
     case: a unanimous panel had all of its judges flagged high AND
     low, and a judge who scored with the panel showed a drop rate
     near 100%. my_pos is this judge's position; n the marks in. */
  LEFT JOIN LATERAL (
    SELECT
      array_agg(p.score ORDER BY p.score)::numeric[] AS panel_scores,
      /* drop_count by panel size (Article 9.1.5.1-9.1.5.2 / calc_dive_points). */
      CASE
        WHEN e.number_of_judges = 5  THEN 1
        WHEN e.number_of_judges = 7  THEN 2
        WHEN e.number_of_judges = 9  THEN 2
        WHEN e.number_of_judges = 11 THEN 3
        ELSE 0
      END AS drop_count,
      COUNT(*)::int AS n,
      MAX(p.pos) FILTER (WHERE p.judge_id = s.judge_id) AS my_pos,
      COUNT(*) > 2 * (CASE
        WHEN e.number_of_judges = 5  THEN 1
        WHEN e.number_of_judges = 7  THEN 2
        WHEN e.number_of_judges = 9  THEN 2
        WHEN e.number_of_judges = 11 THEN 3
        ELSE 0
      END) AS trims
    FROM (
      SELECT s2.judge_id, s2.score,
             ROW_NUMBER() OVER (
               ORDER BY s2.score, ej2.judge_number NULLS LAST, s2.judge_id
             ) AS pos
      FROM scores s2
      LEFT JOIN event_judges ej2
        ON ej2.event_id = s2.event_id AND ej2.judge_id = s2.judge_id
      WHERE s2.event_id      = s.event_id
        AND s2.competitor_id = s.competitor_id
        AND s2.round_number  = s.round_number
    ) p
  ) panel ON TRUE
  WHERE s.judge_id = $1
    AND COALESCE(e.is_rehearsal, FALSE) = FALSE
    AND ($2::date IS NULL OR e.created_at >= $2::date)
    AND ($3::date IS NULL OR e.created_at <  $3::date + INTERVAL '1 day')
`;

module.exports = { PER_DIVE, FULL_FIELD_RANKING, JUDGE_PER_DIVE };
