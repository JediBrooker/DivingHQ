// Unit coverage for lib/scoring-sql.js, the canonical per-dive
// scoring SQL builders.
//
// Two layers of protection here, no DB needed since it's pure string assembly:
//
//   1. Exact snapshots of the high-traffic fragments (default
//      CTE, the seeding/leaderboard variant, the single-dive
//      SELECT). These are the queries that decide who advances,
//      so an accidental builder change must show up as a loud,
//      reviewable snapshot diff, not a silent SQL drift.
//   2. A table of every option combination the real call sites
//      use, each checked for the load-bearing pieces: the
//      calc_event_dive_points call, the COALESCE(s.dive_id,
//      cdl.dive_id) dive-identity rule, the full join chain, the
//      judge-ordered array_aggs, the synchro BOOL_OR flag, and
//      the mandatory e.number_of_judges/e.event_type grouping
//      tail.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  perDivePointsExpr,
  perDiveJoins,
  perDiveSelect,
  perDivePointsCte,
  teamStandingsCte,
  compStandingsCte,
  eventRepCodesCte,
  PUBLIC_PANEL_SQL,
  ownStageScores,
  stageMembers,
  carriedStageScores,
  standingsScoreScope,
  standingsPerDiveCte,
} = require("../lib/scoring-sql");

// ---------------------------------------------------------------
// 1. Exact snapshots.
// ---------------------------------------------------------------

const CANONICAL_JOINS =
`FROM scores s
JOIN events e ON e.id = s.event_id
LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
LEFT JOIN competitor_dive_lists cdl
  ON cdl.event_id = s.event_id
 AND cdl.competitor_id = s.competitor_id
 AND cdl.round_number = s.round_number
LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)`;

const DEFAULT_EXPR =
`calc_event_dive_points(
  array_agg(ej.judge_number ORDER BY ej.judge_number),
  array_agg(s.score ORDER BY ej.judge_number),
  e.number_of_judges, MAX(d.dd), e.event_type,
  BOOL_OR(cdl.partner_id IS NOT NULL)
)`;

test("snapshot: default CTE (super-final helpers, bridge F-tier)", () => {
  assert.equal(
    perDivePointsCte(),
    `per_dive AS (
SELECT s.competitor_id,
       s.round_number,
       ${DEFAULT_EXPR} AS dive_points
${CANONICAL_JOINS}
WHERE s.event_id = $1
GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
)`,
  );
});

test("snapshot: dive_totals/round_total CTE (advance ranking, H2H seeding, leaderboard)", () => {
  assert.equal(
    perDivePointsCte({ name: "dive_totals", pointsAlias: "round_total" }),
    `dive_totals AS (
SELECT s.competitor_id,
       s.round_number,
       ${DEFAULT_EXPR} AS round_total
${CANONICAL_JOINS}
WHERE s.event_id = $1
GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
)`,
  );
});

test("snapshot: single-dive SELECT (venue-state active-diver total)", () => {
  assert.equal(
    perDiveSelect({
      select:      [],
      pointsAlias: "pts",
      where:       "s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3",
      groupBy:     [],
    }),
    `SELECT ${DEFAULT_EXPR} AS pts
${CANONICAL_JOINS}
WHERE s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3
GROUP BY e.number_of_judges, e.event_type`,
  );
});

test("snapshot: perDivePointsExpr dd variants", () => {
  assert.equal(perDivePointsExpr(), DEFAULT_EXPR);
  assert.equal(
    perDivePointsExpr({ dd: "d.dd" }),
    DEFAULT_EXPR.replace("MAX(d.dd)", "d.dd"),
  );
});

test("snapshot: perDiveJoins with extraJoins appended after the chain", () => {
  assert.equal(perDiveJoins(), CANONICAL_JOINS);
  assert.equal(
    perDiveJoins({ extraJoins: ["JOIN users u ON u.id = s.competitor_id"] }),
    `${CANONICAL_JOINS}\nJOIN users u ON u.id = s.competitor_id`,
  );
});

// ---------------------------------------------------------------
// 2. Real call-site option combinations.
//
// One entry per converged call site (sites sharing a combo get
// listed together). `expect` adds per-site assertions on top of
// the shared load-bearing checks below.
// ---------------------------------------------------------------

const CALL_SITES = [
  {
    site: "lib/super-final-helpers.js loadH2hPairResults + loadSfCumulative SF totals; routes/events/super-final-bridge.js F tier; routes/competitor.js live standings; routes/judge-ranking.js individual standings",
    sql: () => perDivePointsCte(),
    pointsAlias: "dive_points",
    where: "s.event_id = $1",
  },
  {
    site: "lib/super-final-helpers.js loadSfCumulative carry",
    sql: () => perDivePointsCte({
      select:  ["s.competitor_id"],
      groupBy: ["s.competitor_id", "s.round_number"],
    }),
    pointsAlias: "dive_points",
    where: "s.event_id = $1",
    expect: (sql) => {
      // round_number grouped but not projected.
      assert.ok(sql.includes("GROUP BY s.competitor_id, s.round_number,"));
      assert.ok(!sql.includes("SELECT s.competitor_id,\n       s.round_number"));
    },
  },
  {
    site: "routes/events/index.js rankedDiversForAdvance + super-final-seeding.js buildH2hSeedingPlan; routes/scoreboard.js leaderboard",
    sql: () => perDivePointsCte({ name: "dive_totals", pointsAlias: "round_total" }),
    pointsAlias: "round_total",
    where: "s.event_id = $1",
    expect: (sql) => assert.ok(sql.startsWith("dive_totals AS (")),
  },
  {
    site: "lib/venue-state.js combined rank+leaderboard CTE",
    sql: () => perDivePointsCte({
      select:      ["s.event_id", "s.competitor_id", "s.round_number"],
      pointsAlias: "pts",
    }),
    pointsAlias: "pts",
    where: "s.event_id = $1",
    expect: (sql) =>
      assert.ok(sql.includes(
        "GROUP BY s.event_id, s.competitor_id, s.round_number, e.number_of_judges, e.event_type")),
  },
  {
    site: "lib/venue-state.js single-dive total",
    sql: () => perDiveSelect({
      select:      [],
      pointsAlias: "pts",
      where:       "s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3",
      groupBy:     [],
    }),
    pointsAlias: "pts",
    where: "s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3",
    expect: (sql) =>
      assert.ok(sql.includes("GROUP BY e.number_of_judges, e.event_type")),
  },
  // The standings per_dive (standingsPerDiveCte: the scoreboard, the
  // recap, results.pdf/.csv and the score sheet) is a UNION of these two
  // branches, the event's own stage and the Super Final carry-forward
  // stage. One OR'd event filter kept the planner from pushing the event
  // id into the cdl/event_judges joins.
  {
    site: "standingsPerDiveCte own-stage branch (routes/scoreboard.js standings; routes/pdf.js results.pdf, and the unit standings behind results.csv and the score sheet)",
    sql: () => perDiveSelect({
      select: ["s.competitor_id", "cdl.team_id", "s.event_id", "s.round_number"],
      where:  ownStageScores(),
    }),
    pointsAlias: "dive_points",
    where: "WHERE (s.event_id = $1 AND COALESCE(cdl.is_reserve, FALSE) = FALSE)",
    expect: (sql) => {
      // A withdrawn diver keeps the dives they did.
      assert.ok(!sql.includes("withdrawn_at"));
      assert.ok(sql.includes(
        "GROUP BY s.competitor_id, cdl.team_id, s.event_id, s.round_number, e.number_of_judges, e.event_type"));
    },
  },
  {
    site: "standingsPerDiveCte carry-forward branch",
    sql: () => perDiveSelect({
      select: ["s.competitor_id", "cdl.team_id", "s.event_id", "s.round_number"],
      where:  carriedStageScores(),
    }),
    pointsAlias: "dive_points",
    where: "WHERE (s.event_id = (SELECT score_carry_from FROM events WHERE id = $1)",
    expect: (sql) => {
      // No OR left in the filter, each branch pins one event id.
      assert.ok(!/\bOR\b/.test(sql.slice(sql.indexOf("WHERE"))));
      assert.ok(sql.includes(
        "GROUP BY s.competitor_id, cdl.team_id, s.event_id, s.round_number, e.number_of_judges, e.event_type"));
    },
  },
  {
    site: "routes/scoreboard.js carry_rounds (synthetic round 0)",
    sql: () => perDivePointsCte({
      name:        "carry_rounds",
      select:      ["s.competitor_id", "0 AS round_number"],
      groupBy:     ["s.competitor_id", "s.round_number"],
      pointsAlias: "round_total",
      where:       carriedStageScores(),
    }),
    pointsAlias: "round_total",
    where: "score_carry_from",
    expect: (sql) => {
      assert.ok(sql.includes("0 AS round_number"));
      // Synthetic constant projected; real source round grouped.
      assert.ok(sql.includes("GROUP BY s.competitor_id, s.round_number,"));
    },
  },
  {
    site: "db/queries.js PER_DIVE",
    sql: () => perDiveSelect({
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
    }),
    pointsAlias: "dive_total",
    where: "s.competitor_id = $1",
    expect: (sql) => {
      assert.ok(sql.includes("AVG(s.score) AS avg_judge_score"));
      // groupByExtra lands AFTER the mandatory tail.
      assert.ok(sql.endsWith("e.number_of_judges, e.event_type, e.created_at"));
    },
  },
  {
    site: "db/queries.js FULL_FIELD_RANKING all_per_dive",
    sql: () => perDivePointsCte({
      name:   "all_per_dive",
      // team_id so unit_totals can rank the team in a team event.
      select: ["s.event_id", "s.competitor_id", "cdl.team_id", "s.round_number"],
      where:  "s.event_id IN (SELECT event_id FROM diver_events)",
    }),
    pointsAlias: "dive_points",
    where: "s.event_id IN (SELECT event_id FROM diver_events)",
    expect: (sql) => assert.ok(sql.startsWith("all_per_dive AS (")),
  },
  {
    site: "routes/events/super-final-bridge.js synchro pair standings",
    sql: () => perDivePointsCte({
      select:  ["cdl.competitor_id", "cdl.partner_id"],
      groupBy: ["cdl.competitor_id", "cdl.partner_id", "s.round_number"],
    }),
    pointsAlias: "dive_points",
    where: "s.event_id = $1",
    expect: (sql) => assert.ok(sql.includes(
      "GROUP BY cdl.competitor_id, cdl.partner_id, s.round_number, e.number_of_judges, e.event_type")),
  },
  {
    site: "routes/events/dive-offs.js tied check",
    sql: () => perDivePointsCte({
      select:  ["s.competitor_id"],
      groupBy: ["s.competitor_id", "s.round_number"],
      where:   "s.event_id = $1 AND s.competitor_id = ANY($2::uuid[])",
    }),
    pointsAlias: "dive_points",
    where: "s.event_id = $1 AND s.competitor_id = ANY($2::uuid[])",
  },
  {
    site: "lib/records.js record-context query",
    sql: () => perDiveSelect({
      select: [
        "u.id  AS user_id", "u.club_id", "u.org_id", "o.continent",
        "cl.name AS club_name", "o.name  AS org_name",
        "rg.id   AS region_id", "rg.name AS region_name",
        "u.full_name AS holder_name",
        "e.height", "e.event_type", "e.number_of_judges", "e.is_rehearsal",
        "d.dive_code", "d.position", "d.dd", "d.description",
      ],
      dd:          "d.dd",
      pointsAlias: "dive_total",
      selectExtra: ["COUNT(s.score)::int AS judges_in"],
      extraJoins: [
        "JOIN users u  ON u.id = s.competitor_id",
        "LEFT JOIN clubs cl ON cl.id = u.club_id",
        "JOIN organisations o ON o.id = u.org_id",
        "LEFT JOIN LATERAL event_rep_ids(s.event_id, s.competitor_id) rep ON true",
        "LEFT JOIN regions rg ON rg.id = rep.region_id",
      ],
      where: "s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3",
      groupBy: [
        "u.id", "u.club_id", "u.org_id", "o.continent", "cl.name", "o.name", "u.full_name",
        "rg.id", "rg.name",
        "e.height", "e.is_rehearsal",
        "d.dive_code", "d.position", "d.dd", "d.description",
      ],
    }),
    pointsAlias: "dive_total",
    dd: "d.dd",
    where: "s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3",
    expect: (sql) => {
      assert.ok(sql.includes("COUNT(s.score)::int AS judges_in"));
      // Extra joins ride after the canonical chain.
      assert.ok(sql.indexOf("JOIN users u ") > sql.indexOf("dive_directory d"));
      // The state record keys off the entry snapshot (migration 095),
      // not a straight join on the diver's current club.
      assert.ok(sql.includes("LEFT JOIN regions rg ON rg.id = rep.region_id"));
      assert.ok(!sql.includes("cl.region_id"));
    },
  },
  {
    site: "routes/control-room.js history",
    sql: () => perDiveSelect({
      select: [
        `u.full_name AS "diverName"`, "rc.code AS country_code",
        "cl.name AS club_name", "cl.short_code AS club_code",
        "pu.full_name AS partner_name", "rp.code AS partner_country",
        "t.name AS team_name", "t.short_code AS team_code",
        "s.competitor_id", "s.event_id", "s.round_number",
        "d.dive_code", "d.position", "d.dd", "d.description",
      ],
      dd:          "d.dd",
      pointsAlias: "total_points",
      selectExtra: [
        "JSON_AGG(s.score        ORDER BY ej.judge_number) AS judge_scores",
        "JSON_AGG(s.id           ORDER BY ej.judge_number) AS score_ids",
        "JSON_AGG(ej.judge_number ORDER BY ej.judge_number) AS judge_numbers",
      ],
      extraJoins: [
        "JOIN users u ON s.competitor_id = u.id",
        "JOIN organisations o ON u.org_id = o.id",
        "LEFT JOIN clubs cl ON cl.id = u.club_id AND cl.status = 'active'",
        "LEFT JOIN users pu ON pu.id = cdl.partner_id",
        "LEFT JOIN teams t ON t.id = cdl.team_id",
        "LEFT JOIN reps rc ON rc.id = s.competitor_id",
        "LEFT JOIN reps rp ON rp.id = pu.id",
      ],
      groupBy: [
        "u.full_name", "rc.code", "cl.name", "cl.short_code",
        "pu.id", "pu.full_name", "rp.code", "t.name", "t.short_code",
        "s.competitor_id", "s.event_id", "s.round_number",
        "d.dive_code", "d.position", "d.dd", "d.description",
      ],
    }),
    pointsAlias: "total_points",
    dd: "d.dd",
    where: "s.event_id = $1",
    expect: (sql) => {
      assert.ok(sql.includes("AS judge_scores"));
      assert.ok(sql.includes("LEFT JOIN users pu ON pu.id = cdl.partner_id"));
      // Rep codes come from the reps CTE (eventRepCodesCte), not a
      // per-dive function call.
      assert.ok(!sql.includes("event_rep_code("));
      assert.ok(/GROUP BY .*rc\.code.*rp\.code/.test(sql));
    },
  },
  {
    site: "routes/scoreboard.js history",
    sql: () => perDiveSelect({
      select: [
        "s.competitor_id", "u.full_name", "o.country_code", "cl.name AS club_name",
        "pu.id AS partner_id", "pu.full_name AS partner_name", "pl.country_code AS partner_country",
        "t.id AS team_id", "t.name AS team_name",
        "d.dive_code", "d.position", "d.description", "d.dd", "s.round_number",
      ],
      dd:          "d.dd",
      pointsAlias: "total_dive_score",
      selectExtra: [
        "STRING_AGG(s.score::text, ',' ORDER BY ej.judge_number) AS judge_array",
        "JSON_AGG(ej.judge_number ORDER BY ej.judge_number) AS judge_numbers",
      ],
      extraJoins: [
        "JOIN users u ON s.competitor_id = u.id",
        "JOIN organisations o ON u.org_id = o.id",
        "LEFT JOIN clubs cl ON cl.id = u.club_id",
        "LEFT JOIN users pu ON pu.id = cdl.partner_id",
        "LEFT JOIN organisations pl ON pl.id = pu.org_id",
        "LEFT JOIN teams t ON t.id = cdl.team_id",
      ],
      groupBy: [
        "s.competitor_id", "u.full_name", "o.country_code", "cl.name",
        "pu.id", "pu.full_name", "pl.country_code", "t.id", "t.name",
        "d.dive_code", "d.position", "d.description", "d.dd", "s.round_number",
      ],
    }),
    pointsAlias: "total_dive_score",
    dd: "d.dd",
    where: "s.event_id = $1",
    expect: (sql) => assert.ok(sql.includes("AS judge_array")),
  },
  {
    site: "routes/public-profile.js stats; routes/diver-profile.js profile stats (adds the $2/$3 date filter to where)",
    sql: () => perDivePointsCte({
      name:        "dive_totals",
      select:      ["s.event_id", "s.round_number"],
      pointsAlias: "dive_total",
      selectExtra: ["MAX(d.dd) AS dd"],
      where: `s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
    }),
    pointsAlias: "dive_total",
    where: "s.competitor_id = $1",
    expect: (sql) => {
      assert.ok(sql.startsWith("dive_totals AS ("));
      assert.ok(sql.includes("MAX(d.dd) AS dd"));
    },
  },
  {
    site: "routes/public-profile.js og-card best dive",
    sql: () => perDivePointsCte({
      select:      [],
      pointsAlias: "dive_total",
      where: `s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
      groupBy:     ["s.event_id", "s.round_number"],
    }),
    pointsAlias: "dive_total",
    where: "s.competitor_id = $1",
    expect: (sql) => {
      // No projected columns, the UDF is the whole select list.
      assert.ok(sql.includes("SELECT calc_event_dive_points("));
      assert.ok(sql.includes("GROUP BY s.event_id, s.round_number,"));
    },
  },
  {
    site: "routes/public-profile.js recent meets per_dive",
    sql: () => perDivePointsCte({
      select:      ["s.event_id", "s.competitor_id", "s.round_number"],
      pointsAlias: "pts",
      where: `s.event_id IN (
             SELECT e0.id
             FROM events e0
             WHERE COALESCE(e0.is_rehearsal, FALSE) = FALSE
               AND EXISTS (SELECT 1 FROM scores s0
                            WHERE s0.event_id = e0.id AND s0.competitor_id = $1)
             ORDER BY e0.created_at DESC, e0.id DESC
             LIMIT 5
           )`,
    }),
    pointsAlias: "pts",
    where: "ORDER BY e0.created_at DESC, e0.id DESC\n             LIMIT 5",
    expect: (sql) => {
      assert.ok(sql.startsWith("per_dive AS ("));
      // Ranks only the 5 events the page shows, not the whole career.
      assert.ok(!sql.includes("SELECT DISTINCT s0.event_id"));
    },
  },
  {
    site: "routes/diver-profile.js personal bests dive_totals",
    sql: () => perDivePointsCte({
      name: "dive_totals",
      select: [
        "s.event_id", "s.round_number",
        "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
      ],
      dd:          "d.dd",
      pointsAlias: "dive_total",
      where: `s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE
             AND d.id IS NOT NULL`,
    }),
    pointsAlias: "dive_total",
    dd: "d.dd",
    where: "AND d.id IS NOT NULL",
  },
  {
    site: "routes/diver-profile.js score-trend per_dive",
    sql: () => perDivePointsCte({
      select: ["s.event_id", "s.competitor_id", "s.round_number"],
      where: `s.event_id IN (SELECT event_id FROM diver_events)
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
    }),
    pointsAlias: "dive_points",
    where: "s.event_id IN (SELECT event_id FROM diver_events)",
  },
  {
    site: "routes/diver-profile.js compare_peers peer_dives",
    sql: () => perDivePointsCte({
      name:        "peer_dives",
      select:      ["s.event_id", "s.competitor_id", "s.round_number", "d.dd"],
      pointsAlias: "dive_total",
      extraJoins:  ["JOIN users u ON u.id = s.competitor_id"],
      where: `u.org_id = $4
               AND s.competitor_id <> $1
               AND COALESCE(e.is_rehearsal, FALSE) = FALSE
               AND ($2::date IS NULL OR e.created_at >= $2::date)
               AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')`,
    }),
    pointsAlias: "dive_total",
    where: "u.org_id = $4",
    expect: (sql) => {
      assert.ok(sql.startsWith("peer_dives AS ("));
      // Org-filter join rides after the canonical chain.
      assert.ok(sql.indexOf("JOIN users u ") > sql.indexOf("dive_directory d"));
    },
  },
  {
    site: "routes/diver-profile.js recent-form dive details",
    sql: () => perDiveSelect({
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
    }),
    pointsAlias: "dive_total",
    where: "s.event_id = ANY($2::uuid[])",
    expect: (sql) => assert.ok(sql.includes(") AS judges")),
  },
  {
    site: "routes/pdf.js score-sheet dives",
    sql: () => perDiveSelect({
      select: [
        "s.round_number",
        "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
        "e.number_of_judges", "e.event_type::text AS event_type",
      ],
      pointsAlias: "dive_total",
      selectExtra: [
        `array_agg(json_build_object(
                    'judge_number', ej.judge_number,
                    'score',        s.score
                  ) ORDER BY ej.judge_number) AS judges_json`,
      ],
      where: "s.event_id = $1 AND s.competitor_id = $2",
      groupBy: [
        "s.round_number",
        "d.dive_code", "d.position", "d.height", "d.dd", "d.description",
      ],
    }),
    pointsAlias: "dive_total",
    where: "s.event_id = $1 AND s.competitor_id = $2",
    expect: (sql) => assert.ok(sql.includes("AS judges_json")),
  },
  {
    site: "routes/pdf.js results.csv dives",
    sql: () => perDiveSelect({
      select: [
        "u.id AS competitor_id", "u.full_name AS diver_name", "o.country_code",
        "cl.name AS club_name", "cl.short_code AS club_code",
        "pu.full_name AS partner_name", "tm.name AS team_name",
        "s.round_number", "d.dive_code", "d.position", "d.dd",
      ],
      dd:          "d.dd",
      pointsAlias: "dive_total",
      selectExtra: [
        "STRING_AGG(s.score::text, ' ' ORDER BY ej.judge_number) AS judge_scores",
      ],
      extraJoins: [
        "JOIN users u  ON u.id = s.competitor_id",
        "JOIN organisations o ON o.id = u.org_id",
        "LEFT JOIN clubs cl  ON cl.id = u.club_id",
        "LEFT JOIN users pu ON pu.id = cdl.partner_id",
        "LEFT JOIN teams tm ON tm.id = cdl.team_id",
      ],
      where: "s.event_id = $1",
      groupBy: [
        "u.id", "u.full_name", "o.country_code", "cl.name", "cl.short_code",
        "pu.full_name", "tm.name",
        "s.round_number", "d.dive_code", "d.position", "d.dd",
      ],
    }),
    pointsAlias: "dive_total",
    dd: "d.dd",
    where: "s.event_id = $1",
    expect: (sql) => assert.ok(sql.includes("LEFT JOIN teams tm ON tm.id = cdl.team_id")),
  },
  {
    site: "routes/pdf.js results.pdf dive results",
    sql: () => perDiveSelect({
      select: [
        "u.id AS competitor_id", "u.full_name", "cl.name AS club_name",
        "event_rep_code($1, u.id, o.country_code) AS country_code",
        "pu.full_name AS partner_name",
        "cdl.team_id", "tm.name AS team_name",
        "s.round_number", "d.dive_code", "d.position", "d.dd",
      ],
      dd:          "d.dd",
      pointsAlias: "total_dive_score",
      selectExtra: [
        "STRING_AGG(s.score::text, ', ' ORDER BY ej.judge_number) AS judge_scores",
      ],
      extraJoins: [
        "JOIN users u ON s.competitor_id = u.id",
        "JOIN organisations o ON o.id = u.org_id",
        "LEFT JOIN clubs cl ON cl.id = u.club_id",
        "LEFT JOIN users pu ON pu.id = cdl.partner_id",
        "LEFT JOIN teams tm ON tm.id = cdl.team_id",
      ],
      where: "s.event_id = $1",
      groupBy: [
        "u.id", "u.full_name", "cl.name", "o.country_code", "pu.full_name",
        "cdl.team_id", "tm.name",
        "s.round_number", "d.dive_code", "d.position", "d.dd",
      ],
    }),
    pointsAlias: "total_dive_score",
    dd: "d.dd",
    where: "s.event_id = $1",
    expect: (sql) => {
      assert.ok(sql.includes("AS judge_scores"));
      // Team sheets group by team, so team_id rides on every dive row.
      assert.ok(sql.includes("LEFT JOIN teams tm ON tm.id = cdl.team_id"));
      assert.ok(/GROUP BY .*cdl\.team_id, tm\.name/.test(sql));
    },
  },
  {
    site: "routes/archive.js recap standings (standingsPerDiveCte own-stage branch + rehearsal filter)",
    sql: () => perDiveSelect({
      select: ["s.competitor_id", "cdl.team_id", "s.event_id", "s.round_number"],
      where: `${ownStageScores()}\n  AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
    }),
    pointsAlias: "dive_points",
    where: "COALESCE(e.is_rehearsal, FALSE) = FALSE",
    // The stage is grouped so a carried round 1 can't merge with this
    // stage's round 1.
    expect: (sql) => assert.ok(sql.includes(
      "GROUP BY s.competitor_id, cdl.team_id, s.event_id, s.round_number, e.number_of_judges, e.event_type")),
  },
  {
    site: "routes/archive.js results history",
    sql: () => perDiveSelect({
      select: [
        "u.id AS competitor_id", "u.full_name", "rc.code AS country_code", "cl.name AS club_name",
        "pu.id AS partner_id", "pu.full_name AS partner_name", "rp.code AS partner_country",
        "t.id AS team_id", "t.name AS team_name",
        "s.round_number",
        "d.dive_code", "d.position", "d.description", "d.dd",
      ],
      dd:          "d.dd",
      pointsAlias: "total_dive_score",
      selectExtra: [
        "STRING_AGG(s.score::text, ',' ORDER BY ej.judge_number) AS judge_scores",
        "JSON_AGG(ej.judge_number ORDER BY ej.judge_number) AS judge_numbers",
      ],
      extraJoins: [
        "JOIN users u ON s.competitor_id = u.id",
        "LEFT JOIN clubs cl ON cl.id = u.club_id AND cl.status = 'active'",
        "LEFT JOIN users pu ON pu.id = cdl.partner_id",
        "LEFT JOIN teams t ON t.id = cdl.team_id",
        "LEFT JOIN reps rc ON rc.id = u.id",
        "LEFT JOIN reps rp ON rp.id = pu.id",
      ],
      where: `s.event_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
      groupBy: [
        "u.id", "u.full_name", "rc.code", "cl.name",
        "pu.id", "pu.full_name", "rp.code",
        "t.id", "t.name",
        "s.round_number", "d.dive_code", "d.position", "d.description", "d.dd",
      ],
    }),
    pointsAlias: "total_dive_score",
    dd: "d.dd",
    where: "s.event_id = $1",
    expect: (sql) => {
      assert.ok(sql.includes("AS judge_numbers"));
      // Rep codes come from the reps CTE, so they're grouping columns
      // rather than a per-dive function call.
      assert.ok(!sql.includes("event_rep_code("));
      assert.ok(/GROUP BY .*rc\.code.*rp\.code/.test(sql));
    },
  },
  {
    site: "routes/coach.js dashboard per_dive",
    sql: () => perDivePointsCte({
      select:      ["s.event_id", "s.competitor_id", "s.round_number"],
      pointsAlias: "pts",
      where:       "s.event_id IN (SELECT event_id FROM upcoming_raw)",
    }),
    pointsAlias: "pts",
    where: "s.event_id IN (SELECT event_id FROM upcoming_raw)",
  },
  {
    site: "routes/judge-ranking.js team standings per_dive",
    sql: () => perDivePointsCte({
      select:  ["cdl.team_id", "s.round_number"],
      groupBy: ["cdl.team_id", "s.competitor_id", "s.round_number"],
    }),
    pointsAlias: "dive_points",
    where: "s.event_id = $1",
    expect: (sql) => {
      // competitor_id grouped (per-dive granularity) but not projected.
      assert.ok(sql.includes("GROUP BY cdl.team_id, s.competitor_id, s.round_number,"));
      assert.ok(!sql.includes("SELECT cdl.team_id,\n       s.competitor_id"));
    },
  },
];

for (const cs of CALL_SITES) {
  test(`call-site combo: ${cs.site}`, () => {
    const sql = cs.sql();

    // The scoring UDF appears exactly once, with the judge-ordered
    // aggregation arrays and the synchro flag.
    assert.equal(sql.split("calc_event_dive_points(").length - 1, 1);
    assert.ok(sql.includes("array_agg(ej.judge_number ORDER BY ej.judge_number)"));
    assert.ok(sql.includes("array_agg(s.score ORDER BY ej.judge_number)"));
    assert.ok(sql.includes("BOOL_OR(cdl.partner_id IS NOT NULL)"));

    // The dd argument (default MAX(d.dd)) sits between panel size
    // and event type.
    const dd = cs.dd || "MAX(d.dd)";
    assert.ok(sql.includes(`e.number_of_judges, ${dd}, e.event_type,`));

    // Full canonical join chain incl. the dive-identity rule.
    assert.ok(sql.includes("FROM scores s"));
    assert.ok(sql.includes("JOIN events e ON e.id = s.event_id"));
    assert.ok(sql.includes(
      "LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id"));
    assert.ok(sql.includes("LEFT JOIN competitor_dive_lists cdl"));
    assert.ok(sql.includes(
      "LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)"));

    // Caller's WHERE scope and points alias survive verbatim.
    assert.ok(sql.includes(cs.where));
    assert.ok(sql.includes(`AS ${cs.pointsAlias}`));

    // Mandatory grouping tail, both columns feed the UDF
    // un-aggregated.
    assert.ok(/GROUP BY .*e\.number_of_judges, e\.event_type/.test(sql));

    if (cs.expect) cs.expect(sql);
  });
}

// ---------------------------------------------------------------
// 3. Structural guarantees.
// ---------------------------------------------------------------

test("groupBy defaults to the select list", () => {
  const sql = perDiveSelect({ select: ["s.competitor_id", "cdl.team_id"] });
  assert.ok(sql.includes(
    "GROUP BY s.competitor_id, cdl.team_id, e.number_of_judges, e.event_type"));
});

test("CTE wrapper is name AS ( <select> )", () => {
  const cte = perDivePointsCte({ name: "x" });
  assert.ok(cte.startsWith("x AS (\nSELECT"));
  assert.ok(cte.endsWith("\n)"));
  // Inner body is exactly the bare-select form.
  assert.equal(cte, `x AS (\n${perDiveSelect()}\n)`);
});

// ---------------------------------------------------------------
// 4. Team standings (scoreboard, archive recap, results.pdf).
// ---------------------------------------------------------------

test("snapshot: teamStandingsCte default", () => {
  assert.equal(
    teamStandingsCte(),
    `team_standings AS (
SELECT t.id AS team_id,
       t.name AS full_name,
       event_team_rep_code($1, t.id) AS country_code,
       t.short_code AS club_name,
       NULL::uuid AS partner_id,
       NULL::varchar AS partner_name,
       NULL::text AS partner_country,
       SUM(pd.dive_points) AS total
FROM per_dive pd
JOIN teams t ON t.id = pd.team_id
WHERE (SELECT event_type FROM events WHERE id = $1) = 'team'
GROUP BY t.id, t.name, t.short_code
)`,
  );
});

test("teamStandingsCte: the label comes from the divers, the short code stays the subline", () => {
  const sql = teamStandingsCte();
  // Not NULL any more: team rows get the code their divers share.
  assert.ok(sql.includes("event_team_rep_code($1, t.id) AS country_code"));
  assert.ok(!/NULL::char\(3\) AS country_code/.test(sql));
  assert.ok(sql.includes("t.short_code AS club_name"));
  // One row per team, never per same-named team.
  assert.ok(/GROUP BY t\.id\b/.test(sql));
});

test("teamStandingsCte: name, source and event placeholder are the caller's", () => {
  const sql = teamStandingsCte({ name: "teams_x", perDive: "pd_src", eventId: "$2" });
  assert.ok(sql.startsWith("teams_x AS (\n"));
  assert.ok(sql.includes("FROM pd_src pd"));
  assert.ok(sql.includes("event_team_rep_code($2, t.id)"));
  assert.ok(sql.includes("WHERE id = $2) = 'team'"));
  assert.ok(!sql.includes("$1"));
});

// ---------------------------------------------------------------
// 5. Individual standings + public judge panel (scoreboard, archive
//    recap, results.pdf). Pinned so the three surfaces can't drift
//    apart again the way their inline copies did.
// ---------------------------------------------------------------

test("snapshot: compStandingsCte default", () => {
  assert.equal(
    compStandingsCte(),
    `comp_standings AS (
SELECT u.id AS competitor_id,
       u.full_name,
       event_rep_code($1, u.id, o.country_code) AS country_code,
       cl.name AS club_name,
       p.partner_id AS partner_id,
       pu.full_name AS partner_name,
       event_rep_code($1, p.partner_id, pl.country_code) AS partner_country,
       SUM(pd.dive_points) AS total
FROM per_dive pd
JOIN users u ON u.id = pd.competitor_id
JOIN organisations o ON o.id = u.org_id
LEFT JOIN clubs cl ON cl.id = u.club_id AND cl.status = 'active'
LEFT JOIN LATERAL (
  SELECT DISTINCT cdl.partner_id FROM competitor_dive_lists cdl
  WHERE cdl.event_id = $1 AND cdl.competitor_id = pd.competitor_id
    AND cdl.partner_id IS NOT NULL LIMIT 1
) p ON true
LEFT JOIN users pu ON pu.id = p.partner_id
LEFT JOIN organisations pl ON pl.id = pu.org_id
WHERE (SELECT event_type FROM events WHERE id = $1) <> 'team'
GROUP BY u.id, u.full_name, o.country_code, cl.name,
         p.partner_id, pu.full_name, pl.country_code
)`,
  );
});

test("compStandingsCte: unions with the team branch by column name", () => {
  const cols = (sql) => sql.split("\nFROM ")[0]
    .replace(/^[^\n]*\nSELECT /, "")
    .split(",\n")
    .map((c) => c.trim().split(/\s+AS\s+|\s+/i).pop().replace(/^[a-z]+\./, ""));
  const comp = cols(compStandingsCte());
  const team = cols(teamStandingsCte());
  // Same shape after the id column (competitor_id vs team_id).
  assert.deepEqual(comp.slice(1), team.slice(1));
  assert.equal(comp[0], "competitor_id");
  assert.equal(team[0], "team_id");
});

test("compStandingsCte: one row per diver, gated off team events", () => {
  const sql = compStandingsCte();
  assert.ok(/GROUP BY u\.id\b/.test(sql), "grouped by id, so same-named divers stay apart");
  assert.ok(sql.includes("<> 'team'"));
  assert.ok(sql.includes("cl.status = 'active'"), "only approved club names are public");
});

test("compStandingsCte: name, source and event placeholder are the caller's", () => {
  const sql = compStandingsCte({ name: "divers_x", perDive: "pd_src", eventId: "$2" });
  assert.ok(sql.startsWith("divers_x AS (\n"));
  assert.ok(sql.includes("FROM pd_src pd"));
  assert.ok(sql.includes("event_rep_code($2, u.id, o.country_code)"));
  assert.ok(sql.includes("WHERE id = $2) <> 'team'"));
  assert.ok(!sql.includes("$1"));
});

test("PUBLIC_PANEL_SQL: judge chips, approved clubs only, panel order", () => {
  assert.ok(PUBLIC_PANEL_SQL.includes("FROM event_judges ej"));
  assert.ok(PUBLIC_PANEL_SQL.includes("LEFT JOIN clubs cl ON cl.id = u.club_id AND cl.status = 'active'"));
  assert.ok(PUBLIC_PANEL_SQL.includes("WHERE ej.event_id = $1"));
  assert.ok(PUBLIC_PANEL_SQL.trim().endsWith("ORDER BY ej.judge_number ASC"));
  for (const col of ["judge_id", "judge_number", "full_name", "country_code", "org_name", "club_name", "club_code"]) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(PUBLIC_PANEL_SQL), `panel keeps ${col}`);
  }
});

// ---------------------------------------------------------------
// 6. Per-event representation codes (Control Room roster and history,
//    scoreboard up-next and leaderboard, archive recap dives).
// ---------------------------------------------------------------

test("snapshot: eventRepCodesCte default", () => {
  assert.equal(
    eventRepCodesCte(),
    `reps AS MATERIALIZED (
SELECT x.id, event_rep_code($1, x.id, ro.country_code) AS code
FROM (
  SELECT competitor_id AS id FROM competitor_dive_lists WHERE event_id = $1
  UNION
  SELECT partner_id FROM competitor_dive_lists
   WHERE event_id = $1 AND partner_id IS NOT NULL
) x
LEFT JOIN users ru ON ru.id = x.id
LEFT JOIN organisations ro ON ro.id = ru.org_id
)`,
  );
});

test("eventRepCodesCte: one call per person, leads and partners both", () => {
  const sql = eventRepCodesCte();
  // A single function call, run once per row of the deduped set.
  assert.equal(sql.split("event_rep_code(").length - 1, 1);
  // UNION, not ALL, so a diver on six rounds is one row, not six.
  assert.ok(/\n  UNION\n/.test(sql));
  assert.ok(sql.includes("partner_id IS NOT NULL"));
  // Materialised: callers join it twice (diver and partner), and an
  // inlined CTE would put the per-row calls back.
  assert.ok(sql.startsWith("reps AS MATERIALIZED ("));
});

test("eventRepCodesCte: name, event placeholder and competitor source are the caller's", () => {
  const sql = eventRepCodesCte({ name: "codes", eventId: "$2", competitorsFrom: "scores" });
  assert.ok(sql.startsWith("codes AS MATERIALIZED (\n"));
  assert.ok(sql.includes("event_rep_code($2, x.id, ro.country_code)"));
  assert.ok(sql.includes("SELECT competitor_id AS id FROM scores WHERE event_id = $2"));
  // Partners always come off the dive list.
  assert.ok(sql.includes("SELECT partner_id FROM competitor_dive_lists"));
  assert.ok(!sql.includes("$1"));
});

test("standingsScoreScope: own dives (withdrawn included), plus the carried stage for divers in this one", () => {
  const own = ownStageScores();
  assert.ok(own.includes("s.event_id = $1"));
  assert.ok(own.includes("COALESCE(cdl.is_reserve, FALSE) = FALSE"), "reserves don't count");
  assert.ok(!own.includes("withdrawn_at"), "a withdrawn diver keeps the dives they did");
  const carried = carriedStageScores({ eventId: "$3" });
  assert.ok(carried.includes("SELECT score_carry_from FROM events WHERE id = $3"));
  assert.ok(carried.includes(stageMembers({ eventId: "$3" })));
  assert.ok(!carried.includes("$1"));
  // In the stage: an active non-reserve row, or a non-reserve row that's
  // been scored. A reserve's scored try-out isn't a way in.
  const [active, scored] = stageMembers({ eventId: "$3" }).split("\n   UNION\n");
  assert.ok(active.includes("r.event_id = $3 AND r.is_reserve = FALSE AND r.withdrawn_at IS NULL"), "on this stage's active roster");
  assert.ok(scored.includes("JOIN scores sc ON sc.event_id = r.event_id AND sc.competitor_id = r.competitor_id"), "or already scored in it");
  assert.ok(scored.includes("sc.round_number = r.round_number"));
  assert.ok(scored.includes("r.event_id = $3 AND r.is_reserve = FALSE"), "on a row that isn't a reserve's");
  assert.ok(!scored.includes("withdrawn_at"), "withdrawn mid-stage still counts");
  assert.ok(!/\bOR\b/.test(stageMembers()));
  const both = standingsScoreScope();
  assert.ok(both.includes(own) && both.includes(carriedStageScores()));
  assert.ok(/\)\n OR \(/.test(both));
});

test("standingsPerDiveCte: the scope as a UNION of the own and carried stages", () => {
  const select = ["s.competitor_id", "cdl.team_id", "s.event_id", "s.round_number"];
  const sql = standingsPerDiveCte({ select, and: "COALESCE(e.is_rehearsal, FALSE) = FALSE" });
  assert.ok(sql.startsWith("per_dive AS (\nSELECT"));
  assert.ok(sql.endsWith("\n)"));
  const branches = sql.slice("per_dive AS (\n".length, -2).split("\nUNION\n");
  assert.equal(branches.length, 2, "plain UNION, two branches");
  assert.equal(
    branches[0],
    perDiveSelect({ select, where: `${ownStageScores()}\n  AND COALESCE(e.is_rehearsal, FALSE) = FALSE` }),
  );
  assert.equal(
    branches[1],
    perDiveSelect({ select, where: `${carriedStageScores()}\n  AND COALESCE(e.is_rehearsal, FALSE) = FALSE` }),
  );
  // Same rows standingsScoreScope picks, minus the OR between the stages.
  assert.ok(!sql.includes(standingsScoreScope()));
  // Name and placeholder are the caller's.
  const named = standingsPerDiveCte({ name: "pd", eventId: "$2", select });
  assert.ok(named.startsWith("pd AS (\n"));
  assert.ok(!named.includes("$1"));
  // Without the stage in the select a carried round and this stage's
  // round could come out identical and merge in the UNION.
  assert.throws(() => standingsPerDiveCte({ select: ["s.competitor_id", "s.round_number"] }), /s\.event_id/);
});

// db/queries.js diverDivesWhere: the diver's dives plus a lead-stored synchro
// pair's, keyed on dive-list rows so the planner can estimate it (a row-level
// OR across scores and cdl came out ~15x slower on a long career).
test("diverDivesWhere: keyed on the diver's and the lead's dive-list rows, no cdl alias", () => {
  const { diverDivesWhere, fullFieldRanking, FULL_FIELD_RANKING } = require("../db/queries");
  const sql = diverDivesWhere("$4");
  assert.ok(sql.startsWith("(s.event_id, s.competitor_id, s.round_number) IN ("));
  assert.ok(sql.includes("l.competitor_id = $4"));
  assert.ok(sql.includes("l.partner_id = $4"));
  // A mirrored consent-flow pair is scored on both sides: the partner's
  // own scores win, the lead's aren't added on top.
  assert.ok(sql.includes("NOT EXISTS (SELECT 1 FROM scores own"));
  assert.ok(!/\bcdl\./.test(sql), "doesn't need the caller's cdl join");
  assert.ok(!sql.includes("$1"));
  // The public profile's cut: newest n events first (by when they took
  // place, like recent_form), then the same chain.
  const { EVENT_DATE } = require("../db/queries");
  assert.equal(FULL_FIELD_RANKING, fullFieldRanking());
  const cut = fullFieldRanking({ latest: 5 });
  assert.ok(cut.includes(`ORDER BY ${EVENT_DATE} DESC, e.id DESC\n    LIMIT 5`));
  assert.ok(!cut.includes("e.created_at DESC"));
  assert.ok(!FULL_FIELD_RANKING.includes("LIMIT 5"));
  assert.throws(() => fullFieldRanking({ latest: 0 }), /positive integer/);
});
