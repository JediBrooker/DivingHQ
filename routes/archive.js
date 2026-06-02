// Results archive — public listing of every Live or Completed
// event across the platform. Powers the unified Scoreboard
// "browse all meets" page and the per-event recap.
//
//   GET /api/archive                 list (Live + Completed)
//   GET /api/archive/clubs           distinct clubs in the archive
//   GET /api/archive/:eventId/results  per-event recap payload
//
// All three are public — the data is already exposed via the
// live scoreboards. No auth gate, no org filtering. The list
// query folds in current_round + last_diver_name for Live
// events so the "LIVE NOW" banner reads "Round 3 · Phoenix
// Patel diving" instead of a generic placeholder.
//
// Mounted via:
//   app.use(require('./routes/archive')({ pool }))

const express = require("express");

module.exports = function createArchiveRouter({ pool, readPool }) {
  if (!pool) throw new Error("createArchiveRouter requires { pool }");
  // Archive payloads are entirely "what happened" reads. Route
  // through the optional read replica so a long meet day's
  // archive browsing doesn't compete with live-scoring writes
  // for primary connections. Falls back to the writer when no
  // replica is configured.
  const reads = readPool || pool;
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/archive — every Live or Completed event with the
  // facets the unified Scoreboard's filter strip needs:
  // competitor_count, club_count, club_ids[], plus current_round
  // + last_diver_name for Live entries.
  // -------------------------------------------------------------
  router.get("/api/archive", async (req, res) => {
    try {
      // Each event row gains a competitor count, a club count, and
      // the list of distinct club ids that participated. The list
      // is what powers the client-side "filter by club" dropdown
      // without an extra round trip per filter change.
      //
      // Returns Live + Completed events so the unified Scoreboard
      // page can show both in the same browsable list. The status
      // column lets the client render a "LIVE NOW" badge / banner
      // for in-progress meets.
      //
      // For Live events we additionally fold in the current round
      // (= max round_number with any score recorded) and the
      // most-recent diver to score. The "LIVE NOW" banner uses
      // these to read "Round 3 · Phoenix Patel diving" instead of
      // a generic placeholder, which is far more compelling for a
      // spectator deciding whether to tap in.
      const events = await reads.query(
        `SELECT e.id, e.name, e.gender, e.height, e.total_rounds, e.number_of_judges,
                e.event_type, e.status,
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
         LEFT JOIN LATERAL (
           SELECT
             COUNT(DISTINCT s.competitor_id) AS competitor_count,
             COUNT(DISTINCT u.club_id) FILTER (WHERE u.club_id IS NOT NULL) AS club_count,
             ARRAY_AGG(DISTINCT u.club_id::text)
               FILTER (WHERE u.club_id IS NOT NULL) AS club_ids
           FROM scores s
           JOIN users u ON u.id = s.competitor_id
           WHERE s.event_id = e.id
         ) stat ON true
         LEFT JOIN LATERAL (
           SELECT
             MAX(s.round_number) AS current_round,
             (SELECT u2.full_name
              FROM scores s2
              JOIN users u2 ON u2.id = s2.competitor_id
              WHERE s2.event_id = e.id
              ORDER BY s2.created_at DESC
              LIMIT 1) AS last_diver_name
           FROM scores s
           WHERE s.event_id = e.id
         ) live ON e.status = 'Live'
         WHERE e.status IN ('Live', 'Completed')
           AND COALESCE(e.is_rehearsal, FALSE) = FALSE
         ORDER BY
           CASE e.status WHEN 'Live' THEN 0 ELSE 1 END,    -- live meets float to the top
           e.created_at DESC`,
      );
      res.json(events.rows);
    } catch (err) {
      console.error("[Archive Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/archive/clubs — distinct clubs that have appeared
  // in any live or completed meet. Drives the club filter
  // dropdown on the unified Scoreboard.
  // -------------------------------------------------------------
  router.get("/api/archive/clubs", async (req, res) => {
    try {
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
         ORDER BY o.country_code ASC, cl.name ASC`,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Archive Clubs Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/archive/:eventId/results — per-event recap.
  //
  // Returns:
  //   event:     event metadata
  //   standings: total per competitor (or per team, for team
  //              events), World Aquatics tie-break by descending dive
  //              points
  //   dives:     dive-by-dive history with judge scores chips
  //              ordered by panel position
  // -------------------------------------------------------------
  router.get("/api/archive/:eventId/results", async (req, res) => {
    try {
      const [ev, standings, history, panel] = await Promise.all([
        reads.query(
          `SELECT e.name, e.gender, e.height, e.total_rounds,
                  e.number_of_judges, e.event_type, o.name AS org_name
           FROM events e
           JOIN organisations o ON e.org_id = o.id
           WHERE e.id = $1
             AND e.status IN ('Live', 'Completed')
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
          [req.params.eventId],
        ),
        reads.query(
          `WITH per_dive AS (
             SELECT s.competitor_id, cdl.team_id, s.round_number,
                    calc_event_dive_points(
                      array_agg(ej.judge_number ORDER BY ej.judge_number),
                      array_agg(s.score ORDER BY ej.judge_number),
                      e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
    ) AS dive_points
             FROM scores s
             JOIN events e ON e.id = s.event_id
             LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
             LEFT JOIN competitor_dive_lists cdl
               ON cdl.event_id = s.event_id
              AND cdl.competitor_id = s.competitor_id
              AND cdl.round_number = s.round_number
             LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
             WHERE s.event_id = $1
               AND COALESCE(e.is_rehearsal, FALSE) = FALSE
             GROUP BY s.competitor_id, cdl.team_id, s.round_number, e.number_of_judges, e.event_type
           ),
           team_standings AS (
             SELECT t.name AS full_name,
                    NULL::char(3) AS country_code,
                    t.short_code AS club_name,
                    NULL::uuid AS partner_id,
                    NULL::varchar AS partner_name,
                    NULL::char(3) AS partner_country,
                    SUM(pd.dive_points) AS total
             FROM per_dive pd
             JOIN teams t ON t.id = pd.team_id
             WHERE (SELECT event_type FROM events WHERE id = $1) = 'team'
             GROUP BY t.id, t.name, t.short_code
           ),
           comp_standings AS (
             /* Group by u.id (not just u.full_name) so two divers
                sharing a name don't merge into one inflated row.
                u.id is the competitor_id the SPA uses to deep-
                link a standings row → /profile/<id>. partner_id is
                exposed alongside partner_name so the synchro
                partner gets the same /profile/<id> link. */
             SELECT u.id AS competitor_id,
                    u.full_name, o.country_code, cl.name AS club_name,
                    p.partner_id AS partner_id,
                    pu.full_name AS partner_name, pl.country_code AS partner_country,
                    SUM(pd.dive_points) AS total,
                    array_agg(pd.dive_points ORDER BY pd.dive_points DESC) AS dives_desc
             FROM per_dive pd
             JOIN users u ON u.id = pd.competitor_id
             JOIN organisations o ON o.id = u.org_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
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
           ),
           team_standings_padded AS (
             /* Pad the team-standings shape so the UNION below
                aligns: team rows have no individual competitor
                so competitor_id is NULL. */
             SELECT NULL::uuid AS competitor_id, * , NULL::numeric[] AS dives_desc
             FROM team_standings
           )
           SELECT competitor_id, full_name, country_code, club_name,
                  partner_id, partner_name, partner_country, total
           FROM (
             SELECT * FROM team_standings_padded
             UNION ALL
             SELECT * FROM comp_standings
           ) merged
           /* World Aquatics tie-break: highest single dive desc, then second
              highest, etc. team rows have NULL dives_desc which
              sorts last with NULLS LAST (default DESC). */
           ORDER BY total DESC, dives_desc DESC NULLS LAST`,
          [req.params.eventId],
        ),
        reads.query(
          /* Group by u.id (not full_name) so same-named divers stay
             separate. STRING_AGG ordered by judge_number (panel
             position), not judge_id (random UUID), so the chip
             order matches the actual panel layout the audience saw. */
          `SELECT u.id AS competitor_id, u.full_name, o.country_code, cl.name AS club_name,
                  pu.id AS partner_id, pu.full_name AS partner_name, pl.country_code AS partner_country,
                  t.id AS team_id, t.name AS team_name,
                  s.round_number,
                  d.dive_code, d.position, d.description, d.dd,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score ORDER BY ej.judge_number),
                    e.number_of_judges, d.dd, e.event_type,
                  BOOL_OR(cdl.partner_id IS NOT NULL)
    ) AS total_dive_score,
                  STRING_AGG(s.score::text, ',' ORDER BY ej.judge_number) AS judge_scores,
                  /* Parallel array — same order as judge_scores so
                     the SPA can zip chip i with judge_numbers[i]
                     and look up identity from the top-level
                     panel array. Robust to events where the
                     panel was edited mid-meet (sparse positions). */
                  JSON_AGG(ej.judge_number ORDER BY ej.judge_number) AS judge_numbers
           FROM scores s
           JOIN events e ON e.id = s.event_id
           JOIN users u ON s.competitor_id = u.id
           JOIN organisations o ON u.org_id = o.id
           LEFT JOIN clubs cl ON cl.id = u.club_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON s.competitor_id = cdl.competitor_id AND s.event_id = cdl.event_id AND s.round_number = cdl.round_number
           LEFT JOIN dive_directory d ON COALESCE(s.dive_id, cdl.dive_id) = d.id
           LEFT JOIN users pu ON pu.id = cdl.partner_id
           LEFT JOIN organisations pl ON pl.id = pu.org_id
           LEFT JOIN teams t ON t.id = cdl.team_id
           WHERE s.event_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE
           GROUP BY u.id, u.full_name, o.country_code, cl.name,
                    pu.id, pu.full_name, pl.country_code,
                    t.id, t.name,
                    s.round_number, d.dive_code, d.position, d.description, d.dd,
                    e.number_of_judges, e.event_type
           ORDER BY u.full_name ASC, u.id ASC, s.round_number ASC`,
          [req.params.eventId],
        ),
        // Panel — see /api/scoreboard/:id for the rationale: lets
        // the scoreboard show a tooltip on each chip and link the
        // chip to /judge-profile/<id>. Same shape across both
        // endpoints so the SPA's panel-by-number map can be built
        // identically for live + archived events.
        reads.query(
          `SELECT ej.judge_id, ej.judge_number,
                  u.full_name,
                  o.country_code  AS country_code,
                  o.name          AS org_name,
                  cl.name         AS club_name,
                  cl.short_code   AS club_code
           FROM event_judges ej
           JOIN users u         ON u.id = ej.judge_id
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs cl   ON cl.id = u.club_id
           WHERE ej.event_id = $1
           ORDER BY ej.judge_number ASC`,
          [req.params.eventId],
        ),
      ]);
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      res.json({
        event: ev.rows[0],
        standings: standings.rows,
        dives: history.rows,
        panel: panel.rows,
      });
    } catch (err) {
      console.error("[Archive Results Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
