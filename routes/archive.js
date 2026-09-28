// Results archive: public listing of every Live, Upcoming or
// Completed event across the platform. Powers the unified
// Scoreboard "browse all meets" page and the per-event recap.
//
//   GET /api/archive                 list (Live + Upcoming + Completed)
//   GET /api/archive/clubs           distinct clubs in the archive
//   GET /api/archive/:eventId/results  per-event recap payload
//
// All three are public, the data's already exposed via the live
// scoreboards anyway. No auth gate, no org filtering. The list
// query folds in current_round + last_diver_name for Live events
// so the "LIVE NOW" banner reads "Round 3 · Phoenix Patel diving"
// instead of a generic placeholder.
//
// Mounted via:
//   app.use(require('./routes/archive')({ pool }))

const express = require("express");
const { uuidParams } = require("../lib/uuid-param");
const {
  perDiveSelect, perDivePointsCte, teamStandingsCte, compStandingsCte, PUBLIC_PANEL_SQL,
} = require("../lib/scoring-sql");
const { eventRecordMarks } = require("../lib/records");

// Short-TTL cache for the two unbounded all-time aggregations
// (/api/archive and /api/archive/clubs). Lives in
// lib/archive-cache.js because the listing's `status` field is
// load-bearing for the SPA's live-vs-recap layout choice. The
// event status-flip route invalidates it on every successful
// transition, so the TTL only needs to bound the harmless fields
// (current_round, last_diver_name, counts).
const archiveCache = require("../lib/archive-cache");
const { PUBLIC_CLUB_JOIN } = require("../lib/club-approvals");
const archiveCacheGet = archiveCache.get;
const archiveCacheSet = archiveCache.set;

module.exports = function createArchiveRouter({ pool, readPool }) {
  if (!pool) throw new Error("createArchiveRouter requires { pool }");
  // Archive payloads are entirely "what happened" reads, so route
  // them through the optional read replica. Keeps a long meet
  // day's archive browsing from competing with live-scoring
  // writes for primary connections. Falls back to the writer
  // when no replica is configured, just in case.
  const reads = readPool || pool;
  const router = express.Router();
  uuidParams(router, "eventId");   // see lib/uuid-param.js

  // -------------------------------------------------------------
  // GET /api/archive: every Live or Completed event with the
  // facets the unified Scoreboard's filter strip needs:
  // competitor_count, club_count, club_ids[], plus current_round
  // + last_diver_name for Live entries.
  //
  // Optional pagination (additive, the default request still
  // returns the same full array the SPA consumes today):
  //   ?limit=N    cap the result count (clamped to 1..500)
  //   ?before=ISO cursor, only events created strictly before
  //               this timestamp. Pass the created_at of the last
  //               row from the previous page to fetch the next
  //               one. (Live/Upcoming rows sort first regardless
  //               of age, so a cursored page is most useful for
  //               walking the Completed back-catalogue.)
  // -------------------------------------------------------------
  router.get("/api/archive", async (req, res) => {
    try {
      // Parse the optional pagination params up front. limit is
      // clamped (same convention as /api/judges/directory). An
      // unparseable `before` cursor is a hard 400, sanity check so
      // we don't silently return the full unpaged set instead.
      const limit = req.query.limit != null
        ? Math.min(Math.max(Number(req.query.limit) || 0, 1), 500)
        : null;
      let before = null;
      if (req.query.before != null) {
        const t = Date.parse(req.query.before);
        if (Number.isNaN(t)) {
          return res.status(400).json({ error: "before must be an ISO timestamp" });
        }
        before = new Date(t).toISOString();
      }

      // Cache only the default (un-paginated) request, that's the
      // one every first-time scoreboard visitor fires. Skipping
      // arbitrary cursor variants keeps the key space bounded.
      const cacheable = limit == null && before == null;
      if (cacheable) {
        const hit = archiveCacheGet("archive");
        if (hit) return res.json(hit);
      }
      // Each event row gains a competitor count, a club count, and
      // the list of distinct club ids that participated. That list
      // is what powers the client-side "filter by club" dropdown
      // without an extra round trip per filter change.
      //
      // Returns Live, Upcoming and Completed events so the unified
      // Scoreboard page can show them in the same browsable list.
      // The status column lets the client render a "LIVE NOW"
      // badge/banner for in-progress meets.
      //
      // The stats come from one grouped pass over scores rather than
      // a lateral per event. The lateral version re-sorted users for
      // every one of ~700 events and was most of the 400+ ms cold
      // rebuild, which lands on the first spectator after every
      // status flip (that's when the cache gets cleared).
      //
      // For Live events we additionally fold in the current round
      // (max round_number with any score recorded) and the most
      // recent diver to score. The "LIVE NOW" banner uses these to
      // read "Round 3 · Phoenix Patel diving" instead of a generic
      // placeholder, which is way more compelling for a spectator
      // deciding whether to tap in. The Live check sits inside the
      // lateral (and inside the scalar subquery, since an aggregate
      // over zero rows still yields a row) so postgres skips the
      // whole thing for non-Live events. As a join condition it ran
      // for all of them and threw the answer away.
      const events = await reads.query(
        `SELECT e.id, e.name, e.gender, e.height, e.total_rounds, e.number_of_judges,
                e.event_type, e.status,
                e.event_format, e.parent_event_id,
                e.created_at, o.id AS org_id, o.name AS org_name, o.country_code,
                e.meet_id, m.name AS meet_name,
                m.start_date AS meet_start_date, m.end_date AS meet_end_date,
                COALESCE(stat.competitor_count, 0)::int AS competitor_count,
                COALESCE(stat.club_count, 0)::int       AS club_count,
                COALESCE(stat.club_ids, ARRAY[]::text[]) AS club_ids,
                live.current_round,
                live.last_diver_name
         FROM events e
         JOIN organisations o ON e.org_id = o.id
         LEFT JOIN meets m ON m.id = e.meet_id
         LEFT JOIN (
           SELECT ec.event_id,
             COUNT(*) AS competitor_count,
             COUNT(DISTINCT u.club_id) AS club_count,
             ARRAY_AGG(DISTINCT u.club_id::text)
               FILTER (WHERE u.club_id IS NOT NULL) AS club_ids
           FROM (SELECT DISTINCT event_id, competitor_id FROM scores) ec
           JOIN users u ON u.id = ec.competitor_id
           GROUP BY ec.event_id
         ) stat ON stat.event_id = e.id
         LEFT JOIN LATERAL (
           SELECT
             MAX(s.round_number) AS current_round,
             (SELECT u2.full_name
              FROM scores s2
              JOIN users u2 ON u2.id = s2.competitor_id
              WHERE s2.event_id = e.id AND e.status = 'Live'
              ORDER BY s2.created_at DESC
              LIMIT 1) AS last_diver_name
           FROM scores s
           WHERE s.event_id = e.id AND e.status = 'Live'
         ) live ON true
         WHERE e.status IN ('Live', 'Upcoming', 'Completed')
           AND COALESCE(e.is_rehearsal, FALSE) = FALSE
           AND ($1::timestamptz IS NULL OR e.created_at < $1::timestamptz)
         ORDER BY
           CASE e.status                                   -- live first, then upcoming, then completed
             WHEN 'Live' THEN 0 WHEN 'Upcoming' THEN 1 ELSE 2
           END,
           e.created_at DESC
         LIMIT $2`,
        [before, limit],
      );
      if (cacheable) archiveCacheSet("archive", events.rows);
      res.json(events.rows);
    } catch (err) {
      console.error("[Archive Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/archive/clubs: distinct clubs that have appeared
  // in any live or completed meet. Drives the club filter
  // dropdown on the unified Scoreboard.
  //
  // Optional ?limit=N (clamped to 1..500) caps the result count.
  // Additive, same convention as /api/archive above, the default
  // request still returns the full set the dropdown consumes.
  // -------------------------------------------------------------
  router.get("/api/archive/clubs", async (req, res) => {
    try {
      const limit = req.query.limit != null
        ? Math.min(Math.max(Number(req.query.limit) || 0, 1), 500)
        : null;
      // Cache only the default (un-capped) request, same posture
      // as /api/archive: arbitrary limit variants stay out of the
      // key space.
      const cacheable = limit == null;
      if (cacheable) {
        const hit = archiveCacheGet("clubs");
        if (hit) return res.json(hit);
      }
      // Approved clubs only: a founder waiting on their federation can
      // dive as an individual, but the club's name isn't public yet.
      const r = await reads.query(
        `SELECT DISTINCT cl.id, cl.name, cl.short_code,
                cl.org_id, o.name AS org_name, o.country_code
         FROM clubs cl
         JOIN users u ON u.club_id = cl.id
         JOIN scores s ON s.competitor_id = u.id
         JOIN events e ON e.id = s.event_id
          AND e.status IN ('Live', 'Completed')
          AND COALESCE(e.is_rehearsal, FALSE) = FALSE
         JOIN organisations o ON o.id = cl.org_id
         WHERE cl.status = 'active'
         ORDER BY o.country_code ASC, cl.name ASC
         LIMIT $1`,
        [limit],
      );
      if (cacheable) archiveCacheSet("clubs", r.rows);
      res.json(r.rows);
    } catch (err) {
      console.error("[Archive Clubs Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/archive/:eventId/results: per-event recap.
  //
  // Returns:
  //   event:     event metadata, plus the meet's represent_as and the
  //              org's region_label for the medal table heading
  //   standings: total per competitor (or per team, for team
  //              events), World Aquatics tie-break by descending dive
  //              points
  //   dives:     dive-by-dive history with judge scores chips
  //              ordered by panel position
  //   records:   record marks the event's dives hold (scoreboard chip)
  // -------------------------------------------------------------
  router.get("/api/archive/:eventId/results", async (req, res) => {
    try {
      const [ev, standings, history, panel, records] = await Promise.all([
        reads.query(
          /* represent_as (and what the host country calls its regions)
             let the recap title its medal table State / Club / Country
             to match the codes it groups by. An event outside any meet
             labels as country, same as event_rep_code(). */
          `SELECT e.name, e.gender, e.height, e.total_rounds,
                  e.number_of_judges, e.event_type, o.name AS org_name,
                  COALESCE(m.represent_as, 'country') AS represent_as,
                  o.region_label
           FROM events e
           JOIN organisations o ON e.org_id = o.id
           LEFT JOIN meets m ON m.id = e.meet_id
           WHERE e.id = $1
             AND e.status IN ('Live', 'Completed')
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
          [req.params.eventId],
        ),
        reads.query(
          `WITH ${perDivePointsCte({
             select: ["s.competitor_id", "cdl.team_id", "s.round_number"],
             where: `s.event_id = $1
               AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
           })},
           /* Team rows carry the code their divers share (migration
              095), so team events get chips and a medal table too. */
           ${teamStandingsCte()},
           /* competitor_id is what the SPA deep-links a standings row
              to (/profile/<id>), and partner_id gives the synchro
              partner the same link. */
           ${compStandingsCte()},
           merged AS (
             /* Columns by name, not *: team rows have no individual
                competitor, so competitor_id is NULL, and team_id stays
                out of the public payload. */
             SELECT NULL::uuid AS competitor_id, full_name, country_code, club_name,
                    partner_id, partner_name, partner_country, total
             FROM team_standings
             UNION ALL
             SELECT competitor_id, full_name, country_code, club_name,
                    partner_id, partner_name, partner_country, total
             FROM comp_standings
           )
           SELECT competitor_id, full_name, country_code, club_name,
                  partner_id, partner_name, partner_country, total,
                  RANK() OVER (ORDER BY total DESC) AS rank
           FROM merged
           /* World Aquatics Art 4.1.5: equal totals share a place, so
              RANK() over total alone gives the shared placing. Rows are
              ordered by total then name for a stable, rank-neutral
              display order. */
           ORDER BY total DESC, full_name ASC`,
          [req.params.eventId],
        ),
        reads.query(
          /* Group by u.id (not full_name) so same-named divers stay
             separate. STRING_AGG is ordered by judge_number (panel
             position), not judge_id (random UUID), so the chip
             order matches the actual panel layout the audience saw. */
          // Dive-by-dive scope: d.dd is a grouping column, so it
          // feeds straight into the UDF (no MAX() wrapper needed).
          `${perDiveSelect({
            select: [
              "u.id AS competitor_id", "u.full_name",
              "event_rep_code($1, u.id, o.country_code) AS country_code",
              "cl.name AS club_name",
              "pu.id AS partner_id", "pu.full_name AS partner_name",
              "event_rep_code($1, pu.id, pl.country_code) AS partner_country",
              "t.id AS team_id", "t.name AS team_name",
              "s.round_number",
              "d.dive_code", "d.position", "d.description", "d.dd",
            ],
            dd:          "d.dd",
            pointsAlias: "total_dive_score",
            selectExtra: [
              "STRING_AGG(s.score::text, ',' ORDER BY ej.judge_number) AS judge_scores",
              `/* Parallel array, same order as judge_scores so
                     the SPA can zip chip i with judge_numbers[i]
                     and look up identity from the top-level panel
                     array. Stays robust for events where the panel
                     got edited mid-meet (sparse positions). */
                  JSON_AGG(ej.judge_number ORDER BY ej.judge_number) AS judge_numbers`,
            ],
            extraJoins: [
              "JOIN users u ON s.competitor_id = u.id",
              "JOIN organisations o ON u.org_id = o.id",
              PUBLIC_CLUB_JOIN,
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
          })}
           ORDER BY u.full_name ASC, u.id ASC, s.round_number ASC`,
          [req.params.eventId],
        ),
        // Panel, see /api/scoreboard/:id for the rationale: lets
        // the scoreboard show a tooltip on each chip and link the
        // chip to /judge-profile/<id>. Same shape across both
        // endpoints so the SPAs panel-by-number map can be built
        // the same way for live + archived events.
        reads.query(PUBLIC_PANEL_SQL, [req.params.eventId]),
        // Same record marks the live scoreboard carries, so a record set
        // at this meet still wears its chip on the recap.
        eventRecordMarks(reads, req.params.eventId).catch((err) => {
          console.error("[Archive Records]", err.message);
          return [];
        }),
      ]);
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      res.json({
        event: ev.rows[0],
        standings: standings.rows,
        dives: history.rows,
        panel: panel.rows,
        records,
      });
    } catch (err) {
      console.error("[Archive Results Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
