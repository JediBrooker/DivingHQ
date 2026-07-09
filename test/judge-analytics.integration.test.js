// Integration test for the consolidated judge-analytics endpoint,
// run against a live Postgres.
//
// Background: GET /api/judges/:id/analytics used to run 16 separate
// queries, each one re-materialising the JUDGE_PER_DIVE CTE. It now runs
// ONE statement (JUDGE_ANALYTICS_BUNDLE) that materialises per_dive
// once and fans the 13 date-free widgets out as jsonb columns, plus
// 3 native date-bearing widgets. Output has to stay byte-identical to
// the per-query version, since node-postgres returns numeric as a STRING
// so the bundle casts every numeric ::text (raw jsonb would coerce
// it to a JS number and drop the trailing zeros).
//
// This test seeds a controlled meet where the math is hand-checkable
// and asserts:
//   * every widget key is present and correctly shaped,
//   * the breakdowns that need >= 3 dives actually populate,
//   * numerics arrive as strings ("0.500"), counts as numbers,
//   * the LIMIT-12 breakdowns are deterministically ordered, and
//   * the deviation / drop / trim math is unchanged.
//
// Heads up: skips (doesn't fail) when Postgres isn't reachable or the WA
// dive catalog (init.sql) hasn't been loaded into divinghq_test.
//
// Seeded scenario: a 5-judge, 3-round, 2-diver meet.
//   * panel of 5 → drop_count 1 (kept = middle 3 of the sorted 5)
//   * every dive scored J1=8.5 J2=8.0 J3=7.5 J4=7.0 J5=9.5
//       sorted [7.0,7.5,8.0,8.5,9.5] → drop 7.0 + 9.5
//       kept [7.5,8.0,8.5] → kept-mean 8.0, kept_low 7.5, kept_high 8.5
//   * target judge = J1 (8.5): +0.5 vs kept-mean, kept (not dropped),
//     inside [kept_low, kept_high] (not a loose outlier), |0.5| < 1.0
//     (not a tight differ)
//   * diverA in orgA (country ZAA, clubX); diverB in orgB (ZBB, clubY)
//   * 3 rounds each → 6 comparable dives; 3 per country / club / diver,
//     so the HAVING >= 3 breakdowns all populate

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

let pool;
let ready = true;
let app, httpServer, port;

// Fixture ids, cleaned up in after().
const ids = {};
const TARGET_SCORES = { 1: 8.5, 2: 8.0, 3: 7.5, 4: 7.0, 5: 9.5 }; // judge_number → score
const ROUNDS = [1, 2, 3];

before(async () => {
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user:     process.env.DB_USER     || process.env.PGUSER,
        host:     process.env.DB_HOST     || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port:     Number(process.env.DB_PORT || process.env.PGPORT || 5432),
      });

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    ready = false;
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  // Grab a 3m dive from the WA catalog (init.sql) so per_dive has a
  // height + dd + group to bucket on.
  const dive = await pool.query(
    `SELECT id, dive_code, dd FROM dive_directory
     WHERE height = 3.0 ORDER BY dive_code LIMIT 1`,
  );
  if (!dive.rows.length) {
    ready = false;
    console.warn("[skip] dive_directory empty — load init.sql into divinghq_test");
    return;
  }
  ids.diveId = dive.rows[0].id;
  ids.diveCode = dive.rows[0].dive_code;
  ids.diveDd = Number(dive.rows[0].dd);

  const sfx = crypto.randomBytes(4).toString("hex");

  const mkOrg = async (name, country) => {
    const r = await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [`${name}-${sfx}`, country, `${name}-${sfx}`],
    );
    return r.rows[0].id;
  };
  ids.orgA = await mkOrg("ja-a", "ZAA");
  ids.orgB = await mkOrg("ja-b", "ZBB");

  const mkClub = async (orgId, name, code) => {
    const r = await pool.query(
      `INSERT INTO clubs (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id`,
      [orgId, `${name}-${sfx}`, code],
    );
    return r.rows[0].id;
  };
  ids.clubX = await mkClub(ids.orgA, "club-x", "CX");
  ids.clubY = await mkClub(ids.orgB, "club-y", "CY");

  const mkUser = async (orgId, uname, fullName, role, clubId = null) => {
    const u = await pool.query(
      `INSERT INTO users (username, password, full_name, org_id, club_id, email_verified_at)
       VALUES ($1, 'x', $2, $3, $4, now()) RETURNING id`,
      [`${uname}-${sfx}`, fullName, orgId, clubId],
    );
    const id = u.rows[0].id;
    await pool.query(
      `INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)`,
      [id, orgId, role],
    );
    return id;
  };

  // 5 judges in orgA, J1 is the one we're running analytics on.
  ids.judges = [];
  for (let n = 1; n <= 5; n++) {
    ids.judges.push(await mkUser(ids.orgA, `j${n}`, `Judge ${n}`, "judge"));
  }
  ids.targetJudge = ids.judges[0];

  // 2 divers, one per org/country/club.
  ids.diverA = await mkUser(ids.orgA, "dvr-a", "Diver A", "diver", ids.clubX);
  ids.diverB = await mkUser(ids.orgB, "dvr-b", "Diver B", "diver", ids.clubY);

  const ev = await pool.query(
    `INSERT INTO events (
       org_id, name, gender, status, height, event_type, total_rounds, number_of_judges
     ) VALUES ($1, $2, 'Male', 'Live', '3m', 'individual', 3, 5)
     RETURNING id`,
    [ids.orgA, `ja-int-${sfx}`],
  );
  ids.eventId = ev.rows[0].id;

  for (let n = 1; n <= 5; n++) {
    await pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)`,
      [ids.eventId, ids.judges[n - 1], n],
    );
  }

  // Dive lists, plus full 5-judge panel scores for both divers across 3 rounds.
  for (const competitorId of [ids.diverA, ids.diverB]) {
    for (const round of ROUNDS) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number)
         VALUES ($1, $2, $3, $4)`,
        [ids.eventId, competitorId, ids.diveId, round],
      );
      for (let n = 1; n <= 5; n++) {
        await pool.query(
          `INSERT INTO scores (event_id, competitor_id, round_number, judge_id, score)
           VALUES ($1, $2, $3, $4, $5)`,
          [ids.eventId, competitorId, round, ids.judges[n - 1], TARGET_SCORES[n]],
        );
      }
    }
  }

  // Mount the real router with public (anonymous) auth and a no-op
  // date-range parser, basically how server.js wires it up minus the JWT.
  app = express();
  const anon = (req, _res, next) => { req.user = null; next(); };
  app.use(require("../routes/judge-analytics")({
    pool,
    verifyToken: anon,
    optionalAuth: anon,
    parseDateRange: () => ({ from: null, to: null }),
  }));
  httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  port = httpServer.address().port;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (pool && ready) {
    try {
      if (ids.eventId) await pool.query(`DELETE FROM events WHERE id = $1`, [ids.eventId]);
      for (const id of [...(ids.judges || []), ids.diverA, ids.diverB]) {
        if (id) await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
      }
      if (ids.clubX) await pool.query(`DELETE FROM clubs WHERE id = $1`, [ids.clubX]);
      if (ids.clubY) await pool.query(`DELETE FROM clubs WHERE id = $1`, [ids.clubY]);
      if (ids.orgA) await pool.query(`DELETE FROM organisations WHERE id = $1`, [ids.orgA]);
      if (ids.orgB) await pool.query(`DELETE FROM organisations WHERE id = $1`, [ids.orgB]);
    } catch (err) {
      console.warn(`[cleanup] ${err.message}`);
    }
  }
  if (pool) await pool.end();
});

async function analytics() {
  const res = await fetch(`http://127.0.0.1:${port}/api/judges/${ids.targetJudge}/analytics`);
  assert.equal(res.status, 200, "analytics endpoint should 200");
  return res.json();
}

test("bundle: every widget key present and correctly shaped", async (t) => {
  if (!ready) return t.skip("Postgres / catalog unavailable");
  const a = await analytics();
  for (const k of [
    "bias_summary", "deviation_distribution", "agreement_rate", "drop_rate",
    "height_breakdown", "group_breakdown", "country_breakdown", "club_breakdown",
    "diver_breakdown", "round_breakdown", "dd_breakdown", "recent_meets",
    "score_trend", "panel_compare", "panel_deviation",
  ]) {
    assert.ok(k in a, `missing widget: ${k}`);
  }
  assert.equal(typeof a.bias_summary, "object");
  for (const arr of ["deviation_distribution", "height_breakdown", "round_breakdown",
    "country_breakdown", "club_breakdown", "diver_breakdown", "recent_meets", "score_trend"]) {
    assert.ok(Array.isArray(a[arr]), `${arr} should be an array`);
  }
  assert.ok("summary" in a.panel_deviation && "per_event" in a.panel_deviation);
});

test("bundle: numerics are strings (::text), counts are numbers", async (t) => {
  if (!ready) return t.skip("Postgres / catalog unavailable");
  const a = await analytics();
  // node-postgres returns numeric as a string, and the bundle preserves
  // that by casting ::text. A regression back to raw jsonb would show up
  // here as a number with the trailing zeros dropped.
  assert.equal(typeof a.bias_summary.mean_signed_deviation, "string");
  assert.match(a.bias_summary.mean_signed_deviation, /^-?\d+\.\d{3}$/);
  assert.equal(typeof a.bias_summary.sample_size, "number");
  assert.equal(typeof a.height_breakdown[0].signed_deviation, "string");
  assert.equal(typeof a.height_breakdown[0].dives, "number");
  assert.equal(typeof a.height_breakdown[0].height, "string"); // numeric(3,1) → "3.0"
});

test("bundle: deviation + trim math unchanged (J1 = +0.5 vs kept-mean)", async (t) => {
  if (!ready) return t.skip("Postgres / catalog unavailable");
  const a = await analytics();

  assert.equal(a.bias_summary.sample_size, 6);
  assert.equal(a.bias_summary.mean_signed_deviation, "0.500");
  assert.equal(a.bias_summary.mean_abs_deviation, "0.500");
  assert.equal(a.bias_summary.stddev_deviation, "0.000");

  assert.equal(a.agreement_rate.total, 6);
  assert.equal(a.agreement_rate.within_half, 6);
  assert.equal(a.agreement_rate.within_half_rate, "1.000");

  // J1 = 8.5 is kept (sorted slice [7.5, 8.0, 8.5]), never trimmed.
  assert.equal(a.drop_rate.sample_size, 6);
  assert.equal(a.drop_rate.dropped, 0);
  assert.equal(a.drop_rate.drop_rate, "0.000");

  assert.equal(a.panel_compare.dives, 6);
  assert.equal(a.panel_compare.my_avg, "8.50");
  assert.equal(a.panel_compare.panel_avg, "8.00");

  // 8.5 sits right on kept_high (8.5), not outside it, so not a loose differ;
  // |+0.5| < 1.0 → not a tight differ either.
  assert.equal(a.panel_deviation.summary.total, 6);
  assert.equal(a.panel_deviation.summary.differ_loose, 0);
  assert.equal(a.panel_deviation.summary.differ_tight, 0);
});

test("bundle: HAVING>=3 breakdowns populate, deterministically ordered", async (t) => {
  if (!ready) return t.skip("Postgres / catalog unavailable");
  const a = await analytics();

  // 1 height (3m), 1 dive group, 3 rounds.
  assert.equal(a.height_breakdown.length, 1);
  assert.equal(a.height_breakdown[0].height, "3.0");
  assert.equal(a.height_breakdown[0].dives, 6);
  assert.equal(a.round_breakdown.length, 3);
  assert.deepEqual(a.round_breakdown.map((r) => r.round_number), [1, 2, 3]);
  assert.equal(a.round_breakdown[0].dives, 2);

  // 2 countries / clubs / divers, each with exactly 3 dives (>=3).
  assert.equal(a.country_breakdown.length, 2);
  assert.deepEqual(a.country_breakdown.map((c) => c.dives), [3, 3]);
  // Tie on |deviation| (+0.5 everywhere), so it falls to the deterministic
  // tiebreaker (country_code ASC): ZAA before ZBB.
  assert.deepEqual(a.country_breakdown.map((c) => c.country_code), ["ZAA", "ZBB"]);

  assert.equal(a.club_breakdown.length, 2);
  assert.deepEqual(a.club_breakdown.map((c) => c.dives), [3, 3]);
  // club_id ASC tiebreaker → stable order across runs.
  const clubIds = a.club_breakdown.map((c) => c.club_id);
  assert.deepEqual(clubIds, [...clubIds].sort());

  assert.equal(a.diver_breakdown.length, 2);
  assert.deepEqual(a.diver_breakdown.map((d) => d.dives), [3, 3]);
  const diverIds = a.diver_breakdown.map((d) => d.diver_id);
  assert.deepEqual(diverIds, [...diverIds].sort());

  // dd_breakdown: 1 bucket (the chosen dive's DD), all 6 dives.
  assert.equal(a.dd_breakdown.length, 1);
  assert.equal(a.dd_breakdown[0].dives, 6);
});

test("bundle: date-bearing widgets (native) intact", async (t) => {
  if (!ready) return t.skip("Postgres / catalog unavailable");
  const a = await analytics();
  assert.equal(a.recent_meets.length, 1);
  assert.equal(a.recent_meets[0].dives, 6);
  assert.equal(a.score_trend.length, 1); // one week
  assert.equal(a.score_trend[0].dives, 6);
  assert.equal(a.panel_deviation.per_event.length, 1);
});
