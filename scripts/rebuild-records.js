#!/usr/bin/env node
//
// Recompute the record books from the scores themselves.
//
//   node scripts/rebuild-records.js                  dry run: report, write nothing
//   node scripts/rebuild-records.js --verbose        ...and list the rows that would move
//   node scripts/rebuild-records.js --org <uuid>     only that federation's books
//   node scripts/rebuild-records.js --apply          actually write it
//
// WHY THIS EXISTS
// ---------------
// Migration 094 split every book into Women's and Men's and stopped
// synchro and team dives from setting records. It backfilled gender onto
// the rows already there, but it couldn't undo the damage the old rules
// did: a man's dive that archived a woman's club record is still sitting
// in that book, just filed under Male now, and the woman's mark is in
// *_history. Only a replay of the scores can put that right, and a
// replay rewrites live data, so it's a deliberate sysadmin step and not
// something a migration does behind anyone's back.
//
// WHAT IT DOES
// ------------
// Every fully scored individual dive (not rehearsal, gender resolved the
// same way as the live path, via record_gender()) is replayed in the
// order it was scored. For each book the record is the best score, first
// to reach it wins a tie, and prev_score is whatever it beat. Then each
// book is compared with what's in the table now:
//
//   kept          identical, nothing to do
//   prev          same record, prev_score filled in
//   changed       a different record should stand here
//   added         a record the table is missing
//   removed       a row the scores don't support (e.g. from a synchro
//                 event, or an unresolved gender left NULL by 094)
//   unverifiable  the row's event has been deleted, so its scores are
//                 gone. Left alone unless the replay beats it.
//
// --apply copies every changed, removed or beaten row into the matching
// *_history table before replacing it, so nothing is thrown away, and
// does the whole thing in one transaction with the record tables locked
// (a dive completing mid-rebuild just waits for it). The dry run runs
// the same comparison, writes nothing and rolls back.
//
// KNOWN APPROXIMATION: the replay only knows a diver's club and region
// from their entry snapshot (competitor_dive_lists.rep_*, migration 090)
// and falls back to where they are today for older entries. Federation
// and continent are always where the diver is today. A diver who has
// changed federation will see their records follow them.
//
// Connection: same env as server.js and scripts/migrate.js.

require("dotenv").config();
const { Client } = require("pg");
const { perDiveSelect } = require("../lib/scoring-sql");
const { RECORD_TABLES } = require("../lib/records");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ["kept", "prev", "changed", "added", "removed", "unverifiable"];

// Where each scope's id comes from on a replayed dive, and how to tell
// whether a book belongs to the federation --org names. Continental books
// span federations, so an --org run leaves them out.
// `org` is spliced in as a literal because CREATE TABLE AS won't take
// bind parameters. It has been through UUID_RE before it gets here.
const SCOPE_SQL = {
  personal:    { key: "competitor_id", inOrg: (org) => `IN (SELECT id FROM users WHERE org_id = '${org}')` },
  club:        { key: "club_id",       inOrg: (org) => `IN (SELECT id FROM clubs WHERE org_id = '${org}')` },
  region:      { key: "region_id",     inOrg: (org) => `IN (SELECT id FROM regions WHERE org_id = '${org}')` },
  federation:  { key: "org_id",        inOrg: (org) => `= '${org}'::uuid` },
  continental: { key: "continent",     inOrg: null },
};

// Every dive that could set a record, one row each. Same scoring SQL as
// the live path (lib/scoring-sql.js), so a replayed score is the score
// the scoreboard showed.
function candidateDivesSql() {
  return `CREATE TEMP TABLE rr_dives ON COMMIT DROP AS
    SELECT * FROM (
      ${perDiveSelect({
        select: [
          "s.event_id", "s.competitor_id", "s.round_number",
          "e.height", "d.dive_code", "d.position",
          "record_gender(e.gender, u.gender) AS gender",
          "COALESCE(cdl.rep_club_id, u.club_id) AS club_id",
          "COALESCE(cdl.rep_region_id, rc.region_id) AS region_id",
          "u.org_id", "o.continent", "e.number_of_judges AS panel",
        ],
        dd:          "d.dd",
        pointsAlias: "dive_total",
        selectExtra: ["COUNT(s.score)::int AS judges_in", "MAX(s.created_at) AS set_at"],
        extraJoins: [
          "JOIN users u ON u.id = s.competitor_id",
          "JOIN organisations o ON o.id = u.org_id",
          "LEFT JOIN clubs rc ON rc.id = COALESCE(cdl.rep_club_id, u.club_id)",
        ],
        where: "e.event_type = 'individual' AND COALESCE(e.is_rehearsal, FALSE) = FALSE",
        groupBy: [
          "s.event_id", "s.competitor_id", "s.round_number",
          "e.height", "d.dive_code", "d.position", "d.dd", "e.gender", "u.gender",
          "cdl.rep_club_id", "u.club_id", "cdl.rep_region_id", "rc.region_id",
          "u.org_id", "o.continent",
        ],
      })}
    ) per
    WHERE judges_in >= panel
      AND gender IS NOT NULL
      AND dive_code IS NOT NULL AND position IS NOT NULL AND height IS NOT NULL
      AND dive_total IS NOT NULL`;
}

async function rebuildScope(client, scope, { orgId, apply }) {
  const cfg = RECORD_TABLES[scope];
  const sq = SCOPE_SQL[scope];
  const holderCol = cfg.hasHolder ? "holder_id" : cfg.scopeCol;
  const onlyOrg = (col) => (orgId ? `AND ${col} ${sq.inOrg(orgId)}` : "");

  // The replayed book. The window gives each dive the best score before
  // it in its book; a dive only set a record if it beat that (strictly,
  // so the first to reach a score keeps it), and the book's record is
  // the highest of those, with the best it beat as prev_score.
  await client.query(`DROP TABLE IF EXISTS rr_new`);
  await client.query(
    `CREATE TEMP TABLE rr_new ON COMMIT DROP AS
     WITH cand AS (
       SELECT ${sq.key} AS scope_id, competitor_id AS holder_id, gender, height,
              dive_code, position, ROUND(dive_total::numeric, 2) AS score, event_id, set_at,
              MAX(ROUND(dive_total::numeric, 2)) OVER (
                PARTITION BY ${sq.key}, gender, height, dive_code, position
                ORDER BY set_at, event_id, round_number, competitor_id
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ) AS prior_best
       FROM rr_dives
       WHERE ${sq.key} IS NOT NULL ${onlyOrg(sq.key)}
     )
     SELECT DISTINCT ON (scope_id, gender, height, dive_code, position)
            scope_id, holder_id, gender, height, dive_code, position, score,
            prior_best AS prev_score, event_id, set_at
     FROM cand
     WHERE prior_best IS NULL OR score > prior_best
     ORDER BY scope_id, gender, height, dive_code, position, score DESC, set_at ASC`,
  );

  await client.query(`DROP TABLE IF EXISTS rr_diff`);
  await client.query(
    `CREATE TEMP TABLE rr_diff ON COMMIT DROP AS
     SELECT x.id AS existing_id, x.score AS old_score, x.holder_id AS old_holder,
            n.scope_id, n.holder_id, n.gender, n.height, n.dive_code, n.position,
            n.score, n.prev_score, n.event_id, n.set_at,
            COALESCE(x.scope_id::text, n.scope_id::text) AS book,
            COALESCE(x.gender, n.gender)::text AS book_gender,
            COALESCE(x.height, n.height)::text AS book_height,
            COALESCE(x.dive_code, n.dive_code) || COALESCE(x.position, n.position)::text AS book_dive,
            CASE
              WHEN x.id IS NULL THEN 'added'
              WHEN n.scope_id IS NULL AND x.event_id IS NULL THEN 'unverifiable'
              WHEN n.scope_id IS NULL THEN 'removed'
              WHEN x.event_id IS NULL AND n.score <= x.score THEN 'unverifiable'
              WHEN x.holder_id = n.holder_id AND x.score = n.score AND x.event_id = n.event_id
                THEN CASE WHEN x.prev_score IS NOT DISTINCT FROM n.prev_score THEN 'kept' ELSE 'prev' END
              ELSE 'changed'
            END AS category
     FROM (
       SELECT id, ${cfg.scopeCol} AS scope_id, ${holderCol} AS holder_id, gender, height,
              dive_code, position, score, prev_score, event_id
       FROM ${cfg.table}
       WHERE TRUE ${onlyOrg(cfg.scopeCol)}
     ) x
     FULL OUTER JOIN rr_new n
       ON n.scope_id = x.scope_id AND n.gender = x.gender AND n.height = x.height
      AND n.dive_code = x.dive_code AND n.position = x.position`,
  );

  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const tally = await client.query(`SELECT category, count(*)::int AS n FROM rr_diff GROUP BY category`);
  for (const r of tally.rows) counts[r.category] = r.n;

  const samples = (await client.query(
    `SELECT category, book, book_gender, book_height, book_dive, old_score, score
       FROM rr_diff WHERE category IN ('changed', 'added', 'removed')
      ORDER BY category, book, book_gender, book_height, book_dive LIMIT 50`,
  )).rows;

  if (!apply) return { scope, counts, samples };

  // Archive first, then replace. Every row that's about to change or go
  // lands in history with the same columns the live path archives.
  const cols = `${cfg.scopeCol}, ${cfg.hasHolder ? "holder_id, " : ""}gender, height, dive_code,
                position, score, prev_score, event_id, set_at`;
  await client.query(
    `INSERT INTO ${cfg.history} (${cols})
     SELECT ${cols} FROM ${cfg.table}
      WHERE id IN (SELECT existing_id FROM rr_diff WHERE category IN ('changed', 'removed'))`,
  );
  await client.query(
    `DELETE FROM ${cfg.table}
      WHERE id IN (SELECT existing_id FROM rr_diff WHERE category IN ('changed', 'removed'))`,
  );
  await client.query(
    `UPDATE ${cfg.table} t SET prev_score = d.prev_score
       FROM rr_diff d WHERE d.category = 'prev' AND t.id = d.existing_id`,
  );
  await client.query(
    `INSERT INTO ${cfg.table}
       (${cfg.scopeCol}, ${cfg.hasHolder ? "holder_id, " : ""}gender, height, dive_code,
        position, score, prev_score, event_id, set_at)
     SELECT scope_id, ${cfg.hasHolder ? "holder_id, " : ""}gender, height, dive_code,
            position, score, prev_score, event_id, set_at
       FROM rr_diff WHERE category IN ('changed', 'added')`,
  );

  return { scope, counts, samples };
}

// The whole rebuild, on a client the caller owns. Always leaves the
// transaction closed: COMMIT with apply, ROLLBACK without. A dry run
// issues no writes at all, the rollback just drops its temp tables.
async function rebuildRecords(client, { apply = false, orgId = null } = {}) {
  if (orgId && !UUID_RE.test(orgId)) throw new Error("--org must be an organisation UUID");
  await client.query("BEGIN");
  try {
    if (apply) {
      // Hold off the live writer (checkAndApplyRecords) for the few
      // seconds this takes, otherwise a dive finishing mid-rebuild could
      // be overwritten by a replay that never saw it.
      await client.query(
        `LOCK TABLE ${Object.values(RECORD_TABLES).map((c) => c.table).join(", ")}
         IN SHARE ROW EXCLUSIVE MODE`,
      );
    }
    await client.query(candidateDivesSql());
    const results = [];
    for (const scope of Object.keys(RECORD_TABLES)) {
      if (orgId && !SCOPE_SQL[scope].inOrg) continue;
      results.push(await rebuildScope(client, scope, { orgId, apply }));
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return results;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

function report(results, { apply, verbose }) {
  const lines = [];
  lines.push(apply
    ? "[rebuild-records] APPLIED. Replaced rows were copied to *_history first."
    : "[rebuild-records] DRY RUN, nothing was written. Pass --apply to write it.");
  lines.push("");
  lines.push(["scope".padEnd(12), ...CATEGORIES.map((c) => c.padStart(14))].join(""));
  for (const r of results) {
    lines.push([r.scope.padEnd(12), ...CATEGORIES.map((c) => String(r.counts[c]).padStart(14))].join(""));
  }
  if (verbose) {
    for (const r of results) {
      if (!r.samples.length) continue;
      lines.push("", `${r.scope} (first ${r.samples.length}):`);
      for (const s of r.samples) {
        const was = s.old_score != null ? ` was ${s.old_score}` : "";
        const now = s.score != null ? ` now ${s.score}` : "";
        lines.push(`  ${s.category.padEnd(8)} ${s.book} ${s.book_gender || "?"} ${s.book_height} ${s.book_dive}${was}${now}`);
      }
    }
  }
  return lines.join("\n");
}

function makeClient() {
  if (process.env.DATABASE_URL) return new Client({ connectionString: process.env.DATABASE_URL });
  return new Client({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port:     process.env.DB_PORT,
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const verbose = args.includes("--verbose");
  const orgIdx = args.indexOf("--org");
  const orgId = orgIdx >= 0 ? args[orgIdx + 1] : null;
  (async () => {
    const client = makeClient();
    await client.connect();
    try {
      const results = await rebuildRecords(client, { apply, orgId });
      console.log(report(results, { apply, verbose }));
    } catch (err) {
      console.error(`[rebuild-records] ${err.message}`);
      process.exitCode = 1;
    } finally {
      await client.end();
    }
  })();
}

module.exports = { rebuildRecords, report };
