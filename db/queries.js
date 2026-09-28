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
// EVENT_DATE: when an event took place, for every analytics date range,
// year bucket and "most recent first" ordering. Needs events aliased `e`.
//
// The event's own scheduled time, else its meet's start date, else when
// the row was created. Everything used to key on events.created_at, but
// events are set up before entries open, often weeks ahead: a January
// championship created in December landed in the previous year's
// year_over_year, fell out of a range for the month it was held, and
// dropped off a judge's analytics for the month they judged it. Use
// this one expression everywhere a surface filters, groups or sorts by
// date, or the widgets stop agreeing with each other. (A correlated
// lookup rather than a join, so it drops into any query that has `e`.)
// =====================================================================
const EVENT_DATE = `COALESCE(e.scheduled_at,
  (SELECT m.start_date::timestamptz FROM meets m WHERE m.id = e.meet_id),
  e.created_at)`;
const EVENT_DATE_FILTER = `
    AND ($2::date IS NULL OR ${EVENT_DATE} >= $2::date)
    AND ($3::date IS NULL OR ${EVENT_DATE} < $3::date + INTERVAL '1 day')`;

// =====================================================================
// diverDivesWhere: WHERE fragment for "this diver's scored dives".
//
// Their own, plus a synchro pair's dives when the roster stored the pair
// once under the lead (Control Room import, manual add): the scores sit
// under the lead's competitor_id and the lead's dive-list row names this
// diver as partner_id. Profiles and analytics only matched
// s.competitor_id, so a partner's synchro events were missing from their
// profile altogether. The partner side only counts when the diver has no
// scores of their own in that event, because the consent flow
// (lib/dive-list-submit.js) writes a mirror row per partner and then each
// side is scored on its own.
//
// Keyed on the dive-list rows, (event, competitor, round), not a row-level
// `s.competitor_id = $1 OR cdl.partner_id = $1`. Every score has its
// dive-list row (scores has a foreign key to it), so it's the same set of
// dives. But the planner can't estimate an OR that spans two tables: it
// guessed a few dozen rows for a whole career, nested-looped the dive
// directory against them, and a long career's personal bests went from
// ~35ms to ~0.5s. The list here comes off one table through the
// competitor and partner indexes, so it estimates about as well as the
// plain `s.competitor_id = $1` did. It doesn't read cdl, so callers don't
// need the canonical join for it. `param` is the placeholder bound to the
// diver id.
// =====================================================================
function diverDivesWhere(param = "$1") {
  return `(s.event_id, s.competitor_id, s.round_number) IN (
      SELECT l.event_id, l.competitor_id, l.round_number
        FROM competitor_dive_lists l
       WHERE l.competitor_id = ${param}
          OR (l.partner_id = ${param}
              AND NOT EXISTS (SELECT 1 FROM scores own
                               WHERE own.event_id = l.event_id AND own.competitor_id = ${param})))`;
}

// =====================================================================
// PER_DIVE: one row per dive the diver performed.
//
// Filters to a single diver (diverDivesWhere, so a synchro partner gets
// the pair's dives) and (optionally) a date range. competitor_id comes
// back as the diver's own id either way, the callers filter on it.
// Columns:
//   event_id, competitor_id, round_number,
//   dive_code, position, height, dd, description,
//   event_type::text AS event_type, created_at (the EVENT_DATE),
//   dive_total, avg_judge_score
//
// Required params:
//   $1 = competitor_id (uuid)
//   $2 = from_date (date or null)
//   $3 = to_date   (date or null)
// =====================================================================
const PER_DIVE = perDiveSelect({
  select: [
    "s.event_id", "$1::uuid AS competitor_id", "s.round_number",
    "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
    "e.event_type::text AS event_type", `${EVENT_DATE} AS created_at`,
  ],
  pointsAlias: "dive_total",
  selectExtra: ["AVG(s.score) AS avg_judge_score"],
  where: `${diverDivesWhere("$1")}
    AND COALESCE(e.is_rehearsal, FALSE) = FALSE${EVENT_DATE_FILTER}`,
  groupBy: [
    "s.event_id", "s.competitor_id", "s.round_number",
    "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
  ],
  groupByExtra: ["e.scheduled_at", "e.meet_id", "e.created_at"],
});

// =====================================================================
// FULL_FIELD_RANKING: for queries that need the diver's RANK against
// every competitor in their events (recent_form, placings, streak,
// year_over_year, the profile trend, the public profile). Returns a
// chain of CTEs you splice into a parent WITH clause:
//
//   WITH ${FULL_FIELD_RANKING}
//   SELECT … FROM ranked r WHERE r.competitor_id = $1
//
// CTE chain:
//   diver_events  : { event_id, scored_as } the events the diver has a
//                   result in, and whose rows carry it: the diver's own,
//                   or the lead's for a synchro pair stored under the
//                   lead (see diverDivesWhere)
//   all_per_dive  : every dive in those events, by every competitor
//   unit_totals   : per-(event, unit) sum of dive points. The unit is
//                   what the event ranks: the team in a team event,
//                   the diver otherwise.
//   unit_ranked   : unit_totals + RANK() over total, `is_tied_on_total`
//                   (the "=" marker) and `field_size`
//   ranked        : the diver's row per event: competitor_id = $1 and
//                   their unit's total, rank, tie flag and field size
//
// Team events: standings rank teams (teamStandingsCte), so a member gets
// their team's total and place, out of the number of teams. Ranking the
// members against each other printed a team's gold as a member's bronze.
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
//
// fullFieldRanking({ latest: n }) is the same chain cut down to the
// diver's n most recent events before anything gets ranked. Most recent
// by EVENT_DATE with the id breaking ties, the order the analytics
// recent_form lists them in, so the public profile's five are the same
// five. A place only depends on its own event's field, so the public
// profile's "last 5 meets" doesn't have to rank a whole career to keep
// five rows of it. FULL_FIELD_RANKING is the uncut one.
// =====================================================================
function fullFieldRanking({ latest = null } = {}) {
  const scoredIn = `
    SELECT DISTINCT s.event_id, s.competitor_id AS scored_as
    FROM scores s
    JOIN events e ON e.id = s.event_id
    WHERE ${diverDivesWhere("$1")}
      AND COALESCE(e.is_rehearsal, FALSE) = FALSE${EVENT_DATE_FILTER}`;
  let diverEvents = scoredIn;
  if (latest != null) {
    if (!Number.isInteger(latest) || latest < 1) {
      throw new Error(`fullFieldRanking: latest must be a positive integer, got ${latest}`);
    }
    diverEvents = `
    SELECT de.event_id, de.scored_as
    FROM (${scoredIn}
    ) de
    JOIN events e ON e.id = de.event_id
    ORDER BY ${EVENT_DATE} DESC, e.id DESC
    LIMIT ${latest}`;
  }
  return `
  diver_events AS (${diverEvents}
  ),
  ${perDivePointsCte({
    name:   "all_per_dive",
    select: ["s.event_id", "s.competitor_id", "cdl.team_id", "s.round_number"],
    where:  "s.event_id IN (SELECT event_id FROM diver_events)",
  })},
  unit_totals AS (
    SELECT apd.event_id,
           CASE WHEN e.event_type = 'team' THEN apd.team_id ELSE apd.competitor_id END AS unit_id,
           SUM(apd.dive_points) AS total
    FROM all_per_dive apd
    JOIN events e ON e.id = apd.event_id
    /* A team-event dive with no team isn't on the standings either. */
    WHERE e.event_type <> 'team' OR apd.team_id IS NOT NULL
    GROUP BY 1, 2
  ),
  unit_ranked AS (
    SELECT ut.*,
           RANK() OVER (
             PARTITION BY ut.event_id
             ORDER BY ut.total DESC
           ) AS rank,
           /* True when 2+ rows in this event share the SAME total, i.e.
              share a place. The UI shows an "=" marker for it. */
           COUNT(*) OVER (
             PARTITION BY ut.event_id, ut.total
           ) > 1 AS is_tied_on_total,
           /* field_size precomputed here (not in the outer SELECT)
              because outer queries filter to the diver via
              WHERE competitor_id = $1; window functions run AFTER
              WHERE so a window in the outer query would see only
              the one row and return 1. Computing it inside the
              CTE lets recent_form and friends just select it. */
           COUNT(*) OVER (PARTITION BY ut.event_id)::int AS field_size
    FROM unit_totals ut
  ),
  ranked AS (
    SELECT de.event_id, $1::uuid AS competitor_id, de.scored_as,
           ur.unit_id, ur.total, ur.rank, ur.is_tied_on_total, ur.field_size
    FROM diver_events de
    JOIN events e ON e.id = de.event_id
    JOIN unit_ranked ur
      ON ur.event_id = de.event_id
     AND ur.unit_id = CASE WHEN e.event_type = 'team'
           THEN (SELECT apd.team_id FROM all_per_dive apd
                  WHERE apd.event_id = de.event_id AND apd.competitor_id = de.scored_as
                    AND apd.team_id IS NOT NULL
                  LIMIT 1)
           ELSE de.scored_as END
  )
`;
}
const FULL_FIELD_RANKING = fullFieldRanking();

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
    ${EVENT_DATE}                          AS created_at,
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
    /* From the approved-clubs join, not cu.club_id: the club breakdown
       is public and a pending club's id and code stay private
       (migration 096). */
    cl.id                                  AS diver_club_id,
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
  LEFT JOIN clubs cl ON cl.id = cu.club_id AND cl.status = 'active'
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
    AND COALESCE(e.is_rehearsal, FALSE) = FALSE${EVENT_DATE_FILTER}
`;

module.exports = {
  EVENT_DATE, EVENT_DATE_FILTER, PER_DIVE, FULL_FIELD_RANKING, fullFieldRanking,
  JUDGE_PER_DIVE, diverDivesWhere,
};
