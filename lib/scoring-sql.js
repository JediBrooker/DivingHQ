// Canonical per-dive scoring SQL fragments.
//
// Every surface that turns raw judge scores into official dive
// points (live scoreboard, records, venue boards, control-room
// history, stage seeding/advance, dive-offs, diver analytics)
// must agree on three invariants:
//
//   1. the calc_event_dive_points(...) call: judge ordering,
//      score ordering, panel size, DD, event type, and the
//      synchro flag derived from cdl.partner_id;
//   2. the join chain scores ⨝ events ⟕ event_judges ⟕
//      competitor_dive_lists ⟕ dive_directory;
//   3. the dive-identity rule COALESCE(s.dive_id, cdl.dive_id):
//      a score row's explicit dive_id wins, the dive-list entry
//      is the fallback, so list edits after scoring can't
//      silently re-price an already-scored dive.
//
// These three used to be copy-pasted into a dozen queries, and a
// scoring-rule change could fork results between the scoreboard,
// records, venue boards, and seeding. The builders below are pure
// string composition (no DB access) so the exact SQL each call
// site sends is unit-testable, see test/scoring-sql.test.js.
//
// Table aliases are fixed and part of the contract: s = scores,
// e = events, ej = event_judges, cdl = competitor_dive_lists,
// d = dive_directory. `select`, `where`, `groupBy`, `extraJoins`
// options reference them directly.
//
// Placeholder contract: the builders never invent $N positions.
// `where` is spliced verbatim, so the caller writes the $N
// numbers its surrounding query binds, same convention as
// db/queries.js. The default `where` expects $1 = event id.

// The approved-clubs join every public standings / panel read uses.
// club-approvals only pulls in string constants and helpers, nothing
// that touches the DB at load, so this stays safe for the pure tests.
const { PUBLIC_CLUB_JOIN } = require("./club-approvals");

// The scoring UDF call. `dd` is "MAX(d.dd)" when the GROUP BY
// collapses one dive's judge rows without grouping by d.dd, or just
// "d.dd" when it's already a grouping column (records, dive-by-dive
// history).
function perDivePointsExpr({ dd = "MAX(d.dd)" } = {}) {
  return [
    "calc_event_dive_points(",
    "  array_agg(ej.judge_number ORDER BY ej.judge_number),",
    "  array_agg(s.score ORDER BY ej.judge_number),",
    `  e.number_of_judges, ${dd}, e.event_type,`,
    "  BOOL_OR(cdl.partner_id IS NOT NULL)",
    ")",
  ].join("\n");
}

// The canonical FROM/JOIN chain. `extraJoins` (array of join
// clauses) is appended AFTER the chain; entries may reference any
// canonical alias (e.g. cdl.partner_id). Appending keeps the core
// chain byte-stable, since inner joins on s/u-style keys commute
// with the LEFT JOINs here, so position carries no semantics.
function perDiveJoins({ extraJoins = [] } = {}) {
  return [
    "FROM scores s",
    "JOIN events e ON e.id = s.event_id",
    "LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id",
    "LEFT JOIN competitor_dive_lists cdl",
    "  ON cdl.event_id = s.event_id",
    " AND cdl.competitor_id = s.competitor_id",
    " AND cdl.round_number = s.round_number",
    "LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)",
    ...extraJoins,
  ].join("\n");
}

// Full per-dive SELECT statement (no CTE wrapper). One output row
// per (grouping-key) dive, the points column is the official dive
// total.
//
// Options (each maps to a real divergence among call sites):
//   select       columns/expressions BEFORE the points column.
//                Default ["s.competitor_id", "s.round_number"].
//   pointsAlias  alias for the points column. Default "dive_points".
//   dd           DD argument for the UDF, see perDivePointsExpr.
//   selectExtra  aggregate columns AFTER the points column
//                (e.g. AVG(s.score), JSON_AGG arrays).
//   extraJoins   see perDiveJoins.
//   where        verbatim WHERE body incl. the caller's $N
//                placeholders. Default "s.event_id = $1".
//   groupBy      grouping columns. Defaults to `select`, pass it
//                explicitly when `select` contains expressions
//                (e.g. "0 AS round_number") or when the grouping
//                is finer than the projection.
//   groupByExtra grouping columns appended after the mandatory
//                e.number_of_judges, e.event_type tail.
//
// The GROUP BY always ends with e.number_of_judges, e.event_type
// (+ groupByExtra): both feed the UDF un-aggregated, so they are
// structurally required, not optional.
function perDiveSelect({
  select = ["s.competitor_id", "s.round_number"],
  pointsAlias = "dive_points",
  dd = "MAX(d.dd)",
  selectExtra = [],
  extraJoins = [],
  where = "s.event_id = $1",
  groupBy,
  groupByExtra = [],
} = {}) {
  const selectList = [
    ...select,
    `${perDivePointsExpr({ dd })} AS ${pointsAlias}`,
    ...selectExtra,
  ];
  const groupList = [
    ...(groupBy || select),
    "e.number_of_judges",
    "e.event_type",
    ...groupByExtra,
  ];
  return [
    `SELECT ${selectList.join(",\n       ")}`,
    perDiveJoins({ extraJoins }),
    `WHERE ${where}`,
    `GROUP BY ${groupList.join(", ")}`,
  ].join("\n");
}

// CTE form: `<name> AS (<perDiveSelect>)`. Splice into a WITH
// list: `WITH ${perDivePointsCte()}, totals AS (...)`. Same
// options as perDiveSelect plus:
//   name  CTE name. Default "per_dive".
function perDivePointsCte(options = {}) {
  const { name = "per_dive", ...selectOptions } = options;
  return `${name} AS (\n${perDiveSelect(selectOptions)}\n)`;
}

// Team-event standings, one row per team, summed from a per-dive CTE
// that carries cdl.team_id (perDivePointsCte with "cdl.team_id" in its
// select). The scoreboard, the archive recap and results.pdf each had
// their own copy of this and they'd already drifted on column order.
//
// Shaped like the individual standings rows so callers can UNION ALL
// them by column name: team name in full_name, the team's representation
// code in country_code (event_team_rep_code, migration 095: the state /
// club / country its divers share, else the team org's country) and the
// team short code in club_name, where a diver row has its club. The
// partner columns are NULL. team_id is internal; public payloads hash
// or drop it.
//
// Options:
//   name     CTE name. Default "team_standings".
//   perDive  the per-dive CTE to read. Default "per_dive".
//   eventId  placeholder for the event id. Default "$1".
//
// Gated on event_type = 'team' so a caller can union it unconditionally
// with its individual branch (which gates on <> 'team').
function teamStandingsCte({ name = "team_standings", perDive = "per_dive", eventId = "$1" } = {}) {
  return [
    `${name} AS (`,
    "SELECT t.id AS team_id,",
    "       t.name AS full_name,",
    `       event_team_rep_code(${eventId}, t.id) AS country_code,`,
    "       t.short_code AS club_name,",
    "       NULL::uuid AS partner_id,",
    "       NULL::varchar AS partner_name,",
    "       NULL::text AS partner_country,",
    "       SUM(pd.dive_points) AS total",
    `FROM ${perDive} pd`,
    "JOIN teams t ON t.id = pd.team_id",
    `WHERE (SELECT event_type FROM events WHERE id = ${eventId}) = 'team'`,
    "GROUP BY t.id, t.name, t.short_code",
    ")",
  ].join("\n");
}

// Individual / synchro standings, one row per diver, summed from a
// per-dive CTE that carries competitor_id. The scoreboard, the archive
// recap and results.pdf each had a copy (the pdf one a trimmed version),
// same story as teamStandingsCte above.
//
// Columns line up with teamStandingsCte so the two UNION ALL by name:
// competitor_id, full_name, country_code (the meet's representation code
// via event_rep_code, migration 090), club_name (approved clubs only),
// partner_id, partner_name, partner_country, total. Callers pick the
// columns they want out of it; results.pdf only prints a few.
//
// Grouped by u.id, not the name, or two divers who share a name merge
// into one row with both their points (that happened, more than once).
// The partner comes from a LIMIT 1 lateral on the diver, so the partner
// columns don't split a diver's row.
//
// Options match teamStandingsCte. Gated on event_type <> 'team' so it
// unions unconditionally with the team branch.
function compStandingsCte({ name = "comp_standings", perDive = "per_dive", eventId = "$1" } = {}) {
  return [
    `${name} AS (`,
    "SELECT u.id AS competitor_id,",
    "       u.full_name,",
    `       event_rep_code(${eventId}, u.id, o.country_code) AS country_code,`,
    "       cl.name AS club_name,",
    "       p.partner_id AS partner_id,",
    "       pu.full_name AS partner_name,",
    `       event_rep_code(${eventId}, p.partner_id, pl.country_code) AS partner_country,`,
    "       SUM(pd.dive_points) AS total",
    `FROM ${perDive} pd`,
    "JOIN users u ON u.id = pd.competitor_id",
    "JOIN organisations o ON o.id = u.org_id",
    PUBLIC_CLUB_JOIN,
    "LEFT JOIN LATERAL (",
    "  SELECT DISTINCT cdl.partner_id FROM competitor_dive_lists cdl",
    `  WHERE cdl.event_id = ${eventId} AND cdl.competitor_id = pd.competitor_id`,
    "    AND cdl.partner_id IS NOT NULL LIMIT 1",
    ") p ON true",
    "LEFT JOIN users pu ON pu.id = p.partner_id",
    "LEFT JOIN organisations pl ON pl.id = pu.org_id",
    `WHERE (SELECT event_type FROM events WHERE id = ${eventId}) <> 'team'`,
    "GROUP BY u.id, u.full_name, o.country_code, cl.name,",
    "         p.partner_id, pu.full_name, pl.country_code",
    ")",
  ].join("\n");
}

// Which scores count towards an event's standings, as a WHERE body for
// perDivePointsCte. `eventId` is the placeholder the caller binds.
//
// ownStageScores: every dive scored in the event itself, reserve rows
// aside. A diver who withdraws mid-event keeps the dives they already did
// (the Control Room's withdraw says as much), so there's no roster filter
// here. The live scoreboard used to drop them, then the recap put them
// back once the event completed, and the places shifted.
//
// carriedStageScores: a Super Final stage (events.score_carry_from set)
// also counts the parent stage's scores, Appendix 3 §3.1, but only for
// divers who are in this stage, i.e. on its active roster or with a dive
// already scored in it. That keeps the H2H losers out and a diver who
// pulled out before diving the SF off the board.
//
// standingsScoreScope is the two together, for the scoreboard, the
// recap, results.pdf/.csv and the score sheet, so a finished stage shows
// the totals spectators saw live.
function ownStageScores({ eventId = "$1" } = {}) {
  return `(s.event_id = ${eventId} AND COALESCE(cdl.is_reserve, FALSE) = FALSE)`;
}

function carriedStageScores({ eventId = "$1" } = {}) {
  return [
    `(s.event_id = (SELECT score_carry_from FROM events WHERE id = ${eventId})`,
    " AND s.competitor_id IN (",
    "   SELECT r.competitor_id FROM competitor_dive_lists r",
    `    WHERE r.event_id = ${eventId} AND r.is_reserve = FALSE AND r.withdrawn_at IS NULL`,
    "   UNION",
    `   SELECT sc.competitor_id FROM scores sc WHERE sc.event_id = ${eventId}`,
    " ))",
  ].join("\n");
}

function standingsScoreScope({ eventId = "$1" } = {}) {
  return `(${ownStageScores({ eventId })}\n OR ${carriedStageScores({ eventId })})`;
}

// The judges seated on an event, for the public scoreboard and recap
// chips ("J3: Maria Schmidt · GER · MDC") and their /judge-profile links.
// $1 is the event id. Approved clubs only, like every public surface.
const PUBLIC_PANEL_SQL = `SELECT ej.judge_id, ej.judge_number,
       u.full_name,
       o.country_code  AS country_code,
       o.name          AS org_name,
       cl.name         AS club_name,
       cl.short_code   AS club_code
FROM event_judges ej
JOIN users u         ON u.id = ej.judge_id
JOIN organisations o ON o.id = u.org_id
${PUBLIC_CLUB_JOIN}
WHERE ej.event_id = $1
ORDER BY ej.judge_number ASC`;

module.exports = {
  perDivePointsExpr,
  perDiveJoins,
  perDiveSelect,
  perDivePointsCte,
  teamStandingsCte,
  compStandingsCte,
  ownStageScores,
  carriedStageScores,
  standingsScoreScope,
  PUBLIC_PANEL_SQL,
};
