// Unit coverage for lib/scoring-sql.js — the canonical per-dive
// scoring SQL builders.
//
// Two layers of protection, no DB needed (pure string assembly):
//
//   1. Exact snapshots of the high-traffic fragments (default
//      CTE, the seeding/leaderboard variant, the single-dive
//      SELECT). These are the queries that decide who advances —
//      an accidental builder change must show up as a loud,
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
// One entry per converged call site (sites sharing a combo are
// listed together). `expect` adds per-site assertions on top of
// the shared load-bearing checks below.
// ---------------------------------------------------------------

const CALL_SITES = [
  {
    site: "lib/super-final-helpers.js loadH2hPairResults + loadSfCumulative SF totals; routes/events/super-final-bridge.js F tier; routes/competitor.js live standings; routes/pdf.js results.pdf standings; routes/judge-ranking.js individual standings",
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
    site: "routes/events/index.js rankedDiversForAdvance + buildH2hSeedingPlan; routes/scoreboard.js leaderboard",
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
  {
    site: "routes/scoreboard.js standings (super-final carry-forward)",
    sql: () => perDivePointsCte({
      select: ["s.competitor_id", "cdl.team_id", "s.event_id", "s.round_number"],
      where: `(s.event_id = $1
                    OR s.event_id = (SELECT score_carry_from FROM events WHERE id = $1))
               AND s.competitor_id IN (
                 SELECT competitor_id FROM competitor_dive_lists
                  WHERE event_id = $1
                    AND withdrawn_at IS NULL
                    AND is_reserve = FALSE
               )`,
    }),
    pointsAlias: "dive_points",
    where: "score_carry_from",
    expect: (sql) => assert.ok(sql.includes(
      "GROUP BY s.competitor_id, cdl.team_id, s.event_id, s.round_number, e.number_of_judges, e.event_type")),
  },
  {
    site: "routes/scoreboard.js carry_rounds (synthetic round 0)",
    sql: () => perDivePointsCte({
      name:        "carry_rounds",
      select:      ["s.competitor_id", "0 AS round_number"],
      groupBy:     ["s.competitor_id", "s.round_number"],
      pointsAlias: "round_total",
      where: `s.event_id = (SELECT score_carry_from FROM events WHERE id = $1)
             AND s.competitor_id IN (
               SELECT competitor_id FROM competitor_dive_lists
                WHERE event_id = $1
                  AND withdrawn_at IS NULL
                  AND is_reserve = FALSE
             )`,
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
      select: ["s.event_id", "s.competitor_id", "s.round_number"],
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
      ],
      where: "s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3",
      groupBy: [
        "u.id", "u.club_id", "u.org_id", "o.continent", "cl.name", "o.name", "u.full_name",
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
    },
  },
  {
    site: "routes/control-room.js history",
    sql: () => perDiveSelect({
      select: [
        `u.full_name AS "diverName"`, "o.country_code",
        "cl.name AS club_name", "cl.short_code AS club_code",
        "pu.full_name AS partner_name", "po.country_code AS partner_country",
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
        "LEFT JOIN clubs cl ON cl.id = u.club_id",
        "LEFT JOIN users pu ON pu.id = cdl.partner_id",
        "LEFT JOIN organisations po ON po.id = pu.org_id",
        "LEFT JOIN teams t ON t.id = cdl.team_id",
      ],
      groupBy: [
        "u.full_name", "o.country_code", "cl.name", "cl.short_code",
        "pu.full_name", "po.country_code", "t.name", "t.short_code",
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
      // No projected columns — the UDF is the whole select list.
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
             SELECT DISTINCT s0.event_id
             FROM scores s0
             JOIN events e0 ON e0.id = s0.event_id
             WHERE s0.competitor_id = $1
               AND COALESCE(e0.is_rehearsal, FALSE) = FALSE
           )`,
    }),
    pointsAlias: "pts",
    where: "SELECT DISTINCT s0.event_id",
    expect: (sql) => assert.ok(sql.startsWith("per_dive AS (")),
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
    site: "routes/pdf.js score-sheet placing + results.csv placings per_dive",
    sql: () => perDivePointsCte({
      select:      ["s.competitor_id"],
      pointsAlias: "pts",
      groupBy:     ["s.competitor_id", "s.round_number"],
    }),
    pointsAlias: "pts",
    where: "s.event_id = $1",
    expect: (sql) =>
      assert.ok(sql.includes("GROUP BY s.competitor_id, s.round_number,")),
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
        "pu.full_name AS partner_name",
        "s.round_number", "d.dive_code", "d.position", "d.dd",
      ],
      dd:          "d.dd",
      pointsAlias: "total_dive_score",
      selectExtra: [
        "STRING_AGG(s.score::text, ', ' ORDER BY ej.judge_number) AS judge_scores",
      ],
      extraJoins: [
        "JOIN users u ON s.competitor_id = u.id",
        "LEFT JOIN clubs cl ON cl.id = u.club_id",
        "LEFT JOIN users pu ON pu.id = cdl.partner_id",
      ],
      where: "s.event_id = $1",
      groupBy: [
        "u.id", "u.full_name", "cl.name", "pu.full_name",
        "s.round_number", "d.dive_code", "d.position", "d.dd",
      ],
    }),
    pointsAlias: "total_dive_score",
    dd: "d.dd",
    where: "s.event_id = $1",
    expect: (sql) => assert.ok(sql.includes("AS judge_scores")),
  },
  {
    site: "routes/archive.js results standings per_dive",
    sql: () => perDivePointsCte({
      select: ["s.competitor_id", "cdl.team_id", "s.round_number"],
      where: `s.event_id = $1
               AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
    }),
    pointsAlias: "dive_points",
    where: "COALESCE(e.is_rehearsal, FALSE) = FALSE",
    expect: (sql) => assert.ok(sql.includes(
      "GROUP BY s.competitor_id, cdl.team_id, s.round_number, e.number_of_judges, e.event_type")),
  },
  {
    site: "routes/archive.js results history",
    sql: () => perDiveSelect({
      select: [
        "u.id AS competitor_id", "u.full_name", "o.country_code", "cl.name AS club_name",
        "pu.id AS partner_id", "pu.full_name AS partner_name", "pl.country_code AS partner_country",
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
        "JOIN organisations o ON u.org_id = o.id",
        "LEFT JOIN clubs cl ON cl.id = u.club_id",
        "LEFT JOIN users pu ON pu.id = cdl.partner_id",
        "LEFT JOIN organisations pl ON pl.id = pu.org_id",
        "LEFT JOIN teams t ON t.id = cdl.team_id",
      ],
      where: `s.event_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
      groupBy: [
        "u.id", "u.full_name", "o.country_code", "cl.name",
        "pu.id", "pu.full_name", "pl.country_code",
        "t.id", "t.name",
        "s.round_number", "d.dive_code", "d.position", "d.description", "d.dd",
      ],
    }),
    pointsAlias: "total_dive_score",
    dd: "d.dd",
    where: "s.event_id = $1",
    expect: (sql) => assert.ok(sql.includes("AS judge_numbers")),
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

    // Mandatory grouping tail — both columns feed the UDF
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
