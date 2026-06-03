// Core import pipeline for the DiveRecorder archive. Extracted from
// the CLI so it can be driven two ways:
//   * scripts/import-diverecorder.js — operator-run backfill / chunks
//   * routes/dr-archive.js           — sysadmin "import now" button +
//                                      the scheduled incremental sync
//
// The pipeline scrapes the Meet Explorer per country
// (selectmeet.php?nat=XXX), so every meet is tagged with the
// federation that ran it, then drills meet → event → diver → dives
// and upserts into the read-only dr_* tables. Every write is keyed on
// the source's own ids (mref/eref/dref), so the whole thing is
// idempotent and resumable, and `onlyNew` mode skips meets already
// present for a fast incremental sync.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  parseMeetList,
  parseEventList,
  parseEventMeta,
  parseSheetList,
  parseDiveSheet,
  COUNTRIES,
} = require("./diverecorder-parser");

const BASE = "https://diverecorder.co.uk/meetexplorer";
const USER_AGENT =
  "DivingHQ-Archive-Importer/1.0 (+https://divinghq.app; historical results indexing)";
const DEFAULT_CACHE_DIR = path.join(__dirname, "..", "scripts", ".dr-cache");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run `fn` over `items` with at most `limit` in flight at once,
// preserving input order in the returned results. Used to fetch a
// batch of diver sheets concurrently while keeping the rest of the
// pipeline simple.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// Build a polite fetcher: identifying UA, configurable inter-request
// delay, exponential backoff on 429/5xx, and an on-disk HTML cache so
// re-runs and resumes don't re-hit the server. `clock` is injected so
// the lib never calls Date.now()/Math.random() directly (keeps the
// workflow/test environments deterministic-friendly).
function createHttpFetcher({
  delayMs = 800,
  cacheDir = DEFAULT_CACHE_DIR,
  noCache = false,
  log = () => {},
} = {}) {
  function cachePath(url) {
    const hash = crypto.createHash("sha1").update(url).digest("hex");
    return path.join(cacheDir, `${hash}.html`);
  }
  return async function fetchHtml(url) {
    if (!noCache) {
      try {
        return fs.readFileSync(cachePath(url), "utf8");
      } catch {
        /* cache miss — fall through to network */
      }
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        });
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= 5) throw new Error(`HTTP ${res.status} after ${attempt} tries: ${url}`);
          const backoff = delayMs * 2 ** attempt;
          log(`! HTTP ${res.status} on ${url} — backing off ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
        const html = await res.text();
        if (!noCache) {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(cachePath(url), html);
        }
        await sleep(delayMs); // be polite between live requests
        return html;
      } catch (err) {
        if (attempt >= 5) throw err;
        const backoff = delayMs * 2 ** attempt;
        log(`! ${err.message} — retry in ${backoff}ms`);
        await sleep(backoff);
      }
    }
  };
}

// --- DB upserts (operate on any pg client/pool with .query) -----
async function upsertMeet(db, { mref, name, meetDate, countryCode, countryName }) {
  const r = await db.query(
    `INSERT INTO dr_meets (source_mref, name, meet_date, country_code, country_name, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (source_mref) DO UPDATE
       SET name = EXCLUDED.name,
           meet_date = COALESCE(EXCLUDED.meet_date, dr_meets.meet_date),
           country_code = COALESCE(EXCLUDED.country_code, dr_meets.country_code),
           country_name = COALESCE(EXCLUDED.country_name, dr_meets.country_name),
           last_seen_at = now()
     RETURNING id`,
    [mref, name, meetDate ?? null, countryCode ?? null, countryName ?? null],
  );
  return r.rows[0].id;
}

async function upsertEvent(db, drMeetId, { eref, name, eventDate, judgeCount }) {
  const { gender, height, phase } = parseEventMeta(name);
  const r = await db.query(
    `INSERT INTO dr_events
       (dr_meet_id, source_eref, name, gender, height, phase, event_date, judge_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dr_meet_id, source_eref) DO UPDATE
       SET name = EXCLUDED.name, gender = EXCLUDED.gender, height = EXCLUDED.height,
           phase = EXCLUDED.phase, event_date = EXCLUDED.event_date,
           judge_count = EXCLUDED.judge_count
     RETURNING id`,
    [drMeetId, eref, name, gender, height, phase, eventDate, judgeCount],
  );
  return r.rows[0].id;
}

async function upsertDiver(db, { name, club, birthYear }) {
  const r = await db.query(
    `INSERT INTO dr_divers (name, club_name, birth_year)
     VALUES ($1, $2, $3)
     ON CONFLICT (name, club_name, birth_year) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, club || "", birthYear ?? null],
  );
  return r.rows[0].id;
}

async function upsertResult(db, drEventId, drDiverId, { dref, rank, total }) {
  const r = await db.query(
    `INSERT INTO dr_results (dr_event_id, dr_diver_id, source_dref, rank, total_score)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dr_event_id, source_dref) DO UPDATE
       SET dr_diver_id = EXCLUDED.dr_diver_id, rank = EXCLUDED.rank,
           total_score = EXCLUDED.total_score
     RETURNING id`,
    [drEventId, drDiverId, dref, rank, total],
  );
  return r.rows[0].id;
}

async function upsertDive(db, drResultId, d) {
  await db.query(
    `INSERT INTO dr_dives
       (dr_result_id, round_number, dive_code, position, degree_of_difficulty,
        judge_scores, dive_points, running_total)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (dr_result_id, round_number) DO UPDATE
       SET dive_code = EXCLUDED.dive_code, position = EXCLUDED.position,
           degree_of_difficulty = EXCLUDED.degree_of_difficulty,
           judge_scores = EXCLUDED.judge_scores, dive_points = EXCLUDED.dive_points,
           running_total = EXCLUDED.running_total`,
    [
      drResultId, d.roundNumber, d.diveCode, d.position, d.degreeOfDifficulty,
      JSON.stringify(d.judgeScores), d.divePoints, d.runningTotal,
    ],
  );
}

// Discover every meet, tagged with country, by scraping each
// country's filtered list. Later countries can't reassign a meet a
// previous one already claimed (a meet belongs to one federation).
async function discoverMeets(fetchHtml, { countries = COUNTRIES, log = () => {} } = {}) {
  const byMref = new Map();
  for (const c of countries) {
    let meets;
    try {
      const html = await fetchHtml(`${BASE}/selectmeet.php?nat=${c.nat}`);
      meets = parseMeetList(html);
    } catch (err) {
      log(`! country ${c.nat} list failed: ${err.message}`);
      continue;
    }
    let added = 0;
    for (const m of meets) {
      if (byMref.has(m.mref)) continue;
      byMref.set(m.mref, { ...m, countryCode: c.nat, countryName: c.name });
      added += 1;
    }
    log(`country ${c.nat} (${c.name}): ${meets.length} listed, ${added} new`);
  }
  return [...byMref.values()];
}

// Import one meet's full event/diver/dive tree.
async function importMeet(db, fetchHtml, meet, stats, { dryRun = false, concurrency = 1, log = () => {} } = {}) {
  log(`Meet ${meet.mref}: ${meet.name}${meet.countryCode ? ` [${meet.countryCode}]` : ""}`);
  let drMeetId = null;
  if (!dryRun) {
    drMeetId = await upsertMeet(db, {
      mref: meet.mref,
      name: meet.name,
      meetDate: meet.meetDate,
      countryCode: meet.countryCode,
      countryName: meet.countryName,
    });
  }
  stats.meets += 1;

  const events = parseEventList(await fetchHtml(`${BASE}/selectevent.php?mref=${meet.mref}`));
  for (const ev of events) {
    let sheet;
    try {
      sheet = parseSheetList(
        await fetchHtml(`${BASE}/selectsheet.php?mref=${meet.mref}&eref=${ev.eref}`),
      );
    } catch (err) {
      log(`  ! event ${ev.eref} sheet failed: ${err.message}`);
      continue;
    }

    let drEventId = null;
    if (!dryRun) {
      drEventId = await upsertEvent(db, drMeetId, {
        eref: ev.eref,
        name: ev.name,
        eventDate: sheet.eventDate,
        judgeCount: null,
      });
    }
    stats.events += 1;

    // Fetch every diver's divesheet concurrently (network-bound; this
    // is the bulk of the work), but keep DB writes serial afterwards —
    // a single pg client can't run concurrent queries.
    const fetched = await mapLimit(sheet.divers, concurrency, async (diver) => {
      try {
        const dsheet = parseDiveSheet(
          await fetchHtml(
            `${BASE}/showsheet.php?mref=${meet.mref}&eref=${ev.eref}&dref=${diver.dref}`,
          ),
        );
        return { diver, dsheet };
      } catch (err) {
        log(`    ! diver ${diver.dref} sheet failed: ${err.message}`);
        return { diver, dsheet: null };
      }
    });

    for (const { diver, dsheet } of fetched) {
      const club = dsheet?.club || diver.club;
      const birthYear = dsheet?.birthYear ?? null;
      stats.results += 1;
      if (dryRun) {
        stats.dives += dsheet?.dives.length || 0;
        continue;
      }

      const drDiverId = await upsertDiver(db, { name: diver.name, club, birthYear });
      const drResultId = await upsertResult(db, drEventId, drDiverId, diver);
      if (dsheet) {
        if (dsheet.judgeCount) {
          await db.query(
            `UPDATE dr_events SET judge_count = $1 WHERE id = $2 AND judge_count IS NULL`,
            [dsheet.judgeCount, drEventId],
          );
        }
        for (const dive of dsheet.dives) {
          await upsertDive(db, drResultId, dive);
          stats.dives += 1;
        }
      }
    }
    log(`  event ${ev.eref}: ${ev.name} — ${sheet.divers.length} divers`);
  }
}

// Top-level orchestration. Options:
//   onlyNew        — skip meets whose source_mref is already stored
//                    (fast incremental sync for the schedule/button)
//   limitMeets     — cap the number of meets imported (test batches)
//   meetRefs       — explicit list of mrefs to import (chunking)
//   countries      — subset of COUNTRIES to scan
//   dryRun         — parse only, no writes
//   shouldStop()   — cooperative cancel hook
//   onProgress(s)  — called with the running stats after each meet
async function importArchive(db, fetchHtml, opts = {}) {
  const {
    onlyNew = false,
    limitMeets = null,
    meetRefs = null,
    countries = COUNTRIES,
    dryRun = false,
    concurrency = 1,
    log = () => {},
    shouldStop = () => false,
    onProgress = () => {},
  } = opts;

  const stats = { meets: 0, events: 0, results: 0, dives: 0, skipped: 0, discovered: 0 };

  let meets = await discoverMeets(fetchHtml, { countries, log });
  if (meetRefs) {
    const want = new Set(meetRefs.map(Number));
    meets = meets.filter((m) => want.has(m.mref));
  }
  stats.discovered = meets.length;
  log(`Discovered ${meets.length} meet(s) across ${countries.length} country list(s).`);

  // Incremental sync: drop meets we already have so we only drill the
  // expensive event/diver pages for genuinely new meets.
  if (onlyNew && !dryRun) {
    const existing = await db.query(`SELECT source_mref FROM dr_meets`);
    const have = new Set(existing.rows.map((r) => r.source_mref));
    const before = meets.length;
    meets = meets.filter((m) => !have.has(m.mref));
    stats.skipped = before - meets.length;
    log(`onlyNew: ${stats.skipped} already imported, ${meets.length} to import.`);
  }

  // Newest first so an interrupted/limited run captures recent meets.
  meets.sort((a, b) => b.mref - a.mref);
  if (limitMeets != null) meets = meets.slice(0, limitMeets);

  for (const meet of meets) {
    if (shouldStop()) {
      log("Stop requested — halting.");
      break;
    }
    try {
      await importMeet(db, fetchHtml, meet, stats, { dryRun, concurrency, log });
    } catch (err) {
      log(`Meet ${meet.mref} failed: ${err.message}`);
    }
    onProgress({ ...stats });
  }

  log(
    `Done. discovered=${stats.discovered} meets=${stats.meets} events=${stats.events} ` +
      `results=${stats.results} dives=${stats.dives} skipped=${stats.skipped}`,
  );
  return stats;
}

module.exports = {
  BASE,
  USER_AGENT,
  DEFAULT_CACHE_DIR,
  createHttpFetcher,
  discoverMeets,
  importMeet,
  importArchive,
};
