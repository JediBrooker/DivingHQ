// Super-Final scoring helpers (Appendix 3 §2 / §3 / §6).
//
// Two functions extracted from routes/events.js when that file
// crossed the "agent-grep cost real tokens" line. Both are pure
// in the sense that they take only a Postgres client + an event
// id and return rows — no closure dependencies on the events
// router. That's what makes them safe to share across:
//
//   • routes/events/index.js — used by seed-semi (POST) and
//                              seed-final (POST) handlers when
//                              they need to pull the prior
//                              stage's results to derive the
//                              next stage's seeding.
//   • routes/events/super-final-bridge.js — used by the merged
//                              super-final/rankings endpoint
//                              that joins H2H winners + SF
//                              cumulative totals + Final totals.
//
// Both helpers are exclusive to the Super Final flow. Keeping
// them in lib/ rather than inside routes/events/super-final-bridge.js
// means seed-semi / seed-final (which stay in index.js) don't
// have to reach into a sibling route file's internals.

const { perDivePointsCte } = require("./scoring-sql");

// Helper: load an H2H event's pair winners from the event id.
// Used by seed-semi, the merged-rankings endpoint, AND the
// public /h2h-results endpoint (which flattens the nested
// competitor_a/competitor_b objects onto its wire shape — that's
// why each competitor carries country_code here even though
// seed-semi doesn't read it).
async function loadH2hPairResults(client, h2hEventId) {
  const r = await client.query(
    `WITH ${perDivePointsCte()},
     competitor AS (
       SELECT pd.competitor_id, SUM(pd.dive_points) AS total
       FROM per_dive pd
       GROUP BY pd.competitor_id
     )
     SELECT cdl.competitor_id, cdl.group_number,
            MIN(cdl.display_order) AS display_order,
            u.full_name, o.country_code,
            COALESCE(c.total, 0) AS total
       FROM competitor_dive_lists cdl
       JOIN users u ON u.id = cdl.competitor_id
       JOIN organisations o ON o.id = u.org_id
       LEFT JOIN competitor c ON c.competitor_id = cdl.competitor_id
      WHERE cdl.event_id = $1
        AND cdl.is_reserve = FALSE
        AND cdl.withdrawn_at IS NULL
      GROUP BY cdl.competitor_id, cdl.group_number, u.full_name, o.country_code, c.total`,
    [h2hEventId],
  );
  const byGroup = { 1: [], 2: [] };
  for (const row of r.rows) {
    if (row.group_number == null) continue;
    byGroup[row.group_number] = byGroup[row.group_number] || [];
    byGroup[row.group_number].push(row);
  }
  for (const g of [1, 2]) {
    byGroup[g].sort((a, b) =>
      (a.display_order ?? Infinity) - (b.display_order ?? Infinity));
  }
  const pairs = [];
  const G1_PAIR_INDEXES = [0, 3, 4];
  const G2_PAIR_INDEXES = [1, 2, 5];
  for (const g of [1, 2]) {
    const indexes = g === 1 ? G1_PAIR_INDEXES : G2_PAIR_INDEXES;
    for (let p = 0; p < 3; p++) {
      const a = byGroup[g][p * 2];
      const b = byGroup[g][p * 2 + 1];
      if (!a || !b) continue;
      const totalA = Number(a.total);
      const totalB = Number(b.total);
      const tied = totalA === totalB;
      const winnerId = tied
        ? null
        : (totalA > totalB ? a.competitor_id : b.competitor_id);
      pairs.push({
        pair_index:      indexes[p],
        group_number:    g,
        competitor_a:    { id: a.competitor_id, full_name: a.full_name, country_code: a.country_code, total: totalA },
        competitor_b:    { id: b.competitor_id, full_name: b.full_name, country_code: b.country_code, total: totalB },
        winner_id:       winnerId,
        tied,
      });
    }
  }
  pairs.sort((a, b) => a.pair_index - b.pair_index);
  return pairs;
}

// Helper: cumulative SF results = SF totals + H2H carry-over.
// Used by seed-final + the merged-rankings endpoint. Returns
// an array of rows ordered by within-group rank, ascending.
async function loadSfCumulative(client, sfEventId) {
  const evRes = await client.query(
    `SELECT id, score_carry_from FROM events WHERE id = $1`,
    [sfEventId],
  );
  if (!evRes.rows.length) return [];
  const carry = evRes.rows[0].score_carry_from;
  // Pull SF totals + carry totals separately, then sum in JS
  // (cleaner than juggling a single CTE that has to cope with
  // a NULL carry_from and 7-table joins twice).
  // BUG-FIX: the previous shape `LEFT JOIN per_dive pd ON
  // pd.competitor_id = cdl.competitor_id` (without round_number)
  // produced an N×N Cartesian explosion — N rows in cdl × N
  // rows in per_dive per competitor → SUM was N× the real
  // total (where N = total_rounds). Pre-aggregate per_dive by
  // competitor_id with a CTE that already sums dive_points,
  // then LEFT JOIN that single-row-per-competitor view onto
  // cdl. The cdl GROUP BY collapses the duplicate rows but
  // pd_summed.total is now the unique correct figure.
  const sfTotalsRes = await client.query(
    `WITH ${perDivePointsCte()},
     per_competitor AS (
       SELECT competitor_id, COALESCE(SUM(dive_points), 0) AS sf_total
         FROM per_dive
        GROUP BY competitor_id
     )
     SELECT cdl.competitor_id, cdl.group_number,
            MIN(cdl.display_order) AS display_order,
            u.full_name, o.country_code,
            COALESCE(MAX(pc.sf_total), 0) AS sf_total
       FROM competitor_dive_lists cdl
       JOIN users u ON u.id = cdl.competitor_id
       JOIN organisations o ON o.id = u.org_id
       LEFT JOIN per_competitor pc ON pc.competitor_id = cdl.competitor_id
      WHERE cdl.event_id = $1
        AND cdl.withdrawn_at IS NULL
        AND cdl.is_reserve = FALSE
      GROUP BY cdl.competitor_id, cdl.group_number, u.full_name, o.country_code`,
    [sfEventId],
  );
  let carryByCompetitor = new Map();
  if (carry) {
    const carryRes = await client.query(
      `WITH ${perDivePointsCte({
         // Grouping stays per-(competitor, round) — one UDF call
         // per dive — even though only competitor_id is projected.
         select:  ["s.competitor_id"],
         groupBy: ["s.competitor_id", "s.round_number"],
       })}
       SELECT competitor_id, COALESCE(SUM(dive_points), 0) AS carry_total
         FROM per_dive
        GROUP BY competitor_id`,
      [carry],
    );
    for (const r of carryRes.rows) {
      carryByCompetitor.set(r.competitor_id, Number(r.carry_total));
    }
  }
  const rows = sfTotalsRes.rows.map((r) => ({
    competitor_id: r.competitor_id,
    group_number:  r.group_number,
    full_name:     r.full_name,
    country_code:  r.country_code,
    display_order: r.display_order,
    sf_total:      Number(r.sf_total),
    carry_total:   carryByCompetitor.get(r.competitor_id) || 0,
  }));
  for (const r of rows) {
    r.cumulative_total = r.sf_total + r.carry_total;
  }
  return rows;
}

module.exports = { loadH2hPairResults, loadSfCumulative };
