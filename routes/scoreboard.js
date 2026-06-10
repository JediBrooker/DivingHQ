// Scoreboard routes — public endpoints that drive the live
// broadcast layout and the round-by-round leaderboard.
//
// /api/scoreboard/:eventId            standings + history + up next
// /api/scoreboard/:eventId/leaderboard cumulative rank with movement
//
// Mounted via:
//     app.use(require('./routes/scoreboard')({ pool, scoreboardCache }))
//
// Caching: /api/scoreboard/:eventId is read by every connected
// spectator + judge + control room ~once per score event. The
// underlying query joins seven tables and runs the trim UDF per
// dive, ~150ms in the seeded 50-event dataset. We cache the
// rendered payload per eventId with a short TTL (~5s); the
// socket layer invalidates the bucket the moment a new score
// commits, so the first reader after each score rebuilds and
// every subsequent reader within the next 5s gets the cached
// payload. See lib/scoreboard-cache.js for the strategy.

const express = require("express");
const { publicId } = require("../lib/public-id");
const { perDiveSelect, perDivePointsCte } = require("../lib/scoring-sql");

module.exports = function createScoreboardRouter({
  pool,
  scoreboardCache,
  metrics,
  optionalAuth,
}) {
  const router = express.Router();
  const maybeAuth = optionalAuth || ((req, _res, next) => next());

  async function ensureScoreboardVisible(req, res, eventId) {
    const ev = await pool.query(
      "SELECT id, org_id, status FROM events WHERE id = $1",
      [eventId],
    );
    if (!ev.rows.length) {
      res.status(404).json({ error: "Event not found" });
      return false;
    }
    const event = ev.rows[0];
    if (["Live", "Completed"].includes(event.status)) return true;
    if (req.user?.is_system_admin || req.user?.org_id === event.org_id) return true;
    if (req.user?.org_id) {
      const part = await pool.query(
        `SELECT 1 FROM event_participating_orgs
          WHERE event_id = $1 AND org_id = $2`,
        [eventId, req.user.org_id],
      );
      if (part.rows.length) return true;
    }
    res.status(404).json({ error: "Event not found" });
    return false;
  }

  router.get("/api/scoreboard/:eventId", maybeAuth, async (req, res) => {
    const eventId = req.params.eventId;
    // Cache lookup. ?cache=skip forces a rebuild — useful when a
    // referee has just corrected a score via the HTTP path and
    // wants to see the result reflected immediately (the HTTP
    // correction handler also calls invalidate(), so this is
    // belt-and-braces).
    try {
      if (!(await ensureScoreboardVisible(req, res, eventId))) return;
      if (scoreboardCache && req.query.cache !== "skip") {
        const hit = scoreboardCache.get(eventId);
        if (hit) {
          metrics?.scoreboardCacheHits.inc();
          res.set("X-Scoreboard-Cache", "hit");
          return res.json(hit);
        }
      }
      metrics?.scoreboardCacheMisses.inc();
      const [st, hi, up, panel] = await Promise.all([
        // Standings: per-dive points (trimmed × DD × scaling) summed
        // across all of a competitor's dives in the event.
        //
        // SUPER FINAL CARRY-FORWARD: when this event has a non-NULL
        // events.score_carry_from, the standings include dive points
        // from BOTH stages — the current event AND the parent stage
        // referenced in score_carry_from. This implements the
        // Diving World Cup Super Final §3.1 rule ("Head-to-Head
        // scores carry forward to Semi Final"). Filter is scoped
        // to competitors on the CURRENT event's roster so the H2H
        // losers (who aren't on the SF roster) don't pollute the
        // SF standings.
        pool.query(
          `WITH ${perDivePointsCte({
             select: ["s.competitor_id", "cdl.team_id", "s.event_id", "s.round_number"],
             where: `(s.event_id = $1
                    OR s.event_id = (SELECT score_carry_from FROM events WHERE id = $1))
               AND s.competitor_id IN (
                 SELECT competitor_id FROM competitor_dive_lists
                  WHERE event_id = $1
                    AND withdrawn_at IS NULL
                    AND is_reserve = FALSE
               )`,
           })},
           /* Team-event branch: aggregate by team. dives_desc is
              the descending-sorted array of dive points used as the
              World Aquatics tie-break key when two teams share a raw total.
              public_id is computed in Node from team_id below — we
              expose team_id here so the router can hash it. The
              spectator-facing JSON drops team_id and only emits
              public_id, so internal UUIDs still aren't leaked. */
           team_standings AS (
             SELECT t.id AS team_id,
                    t.name AS full_name,
                    NULL::char(3) AS country_code,
                    t.short_code AS club_name,
                    NULL::varchar AS partner_name,
                    NULL::uuid AS partner_id,
                    NULL::char(3) AS partner_country,
                    SUM(pd.dive_points) AS total,
                    array_agg(pd.dive_points ORDER BY pd.dive_points DESC) AS dives_desc
             FROM per_dive pd
             JOIN teams t ON t.id = pd.team_id
             WHERE (SELECT event_type FROM events WHERE id = $1) = 'team'
             GROUP BY t.id, t.name, t.short_code
           ),
           /* Individual / synchro branch: aggregate by competitor.
              partner_id is exposed on the row so the spectator
              scoreboard can render the synchro partner's name as
              a profile link (parallels the lead diver's link). */
           comp_standings AS (
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
               SELECT DISTINCT cdl.partner_id
               FROM competitor_dive_lists cdl
               WHERE cdl.event_id = $1 AND cdl.competitor_id = pd.competitor_id
                 AND cdl.partner_id IS NOT NULL
               LIMIT 1
             ) p ON true
             LEFT JOIN users pu ON pu.id = p.partner_id
             LEFT JOIN organisations pl ON pl.id = pu.org_id
             WHERE (SELECT event_type FROM events WHERE id = $1) <> 'team'
             GROUP BY u.id, u.full_name, o.country_code, cl.name,
                      p.partner_id, pu.full_name, pl.country_code
           ),
           merged AS (
             SELECT competitor_id, NULL::uuid AS team_id,
                    full_name, country_code, club_name,
                    partner_id, partner_name, partner_country, total, dives_desc
             FROM comp_standings
             UNION ALL
             SELECT NULL::uuid AS competitor_id, team_id,
                    full_name, country_code, club_name,
                    partner_id, partner_name, partner_country, total, dives_desc
             FROM team_standings
           )
           /* World Aquatics tie-break ordering: total desc, then highest dive,
              then second-highest, etc. (Postgres element-wise array
              comparison gives that.) is_tied_on_total flags pairs
              that shared the raw total but were separated by the
              tie-break, so the UI can hint at why. */
           SELECT competitor_id, team_id,
                  full_name, country_code, club_name,
                  partner_id, partner_name, partner_country, total,
                  COUNT(*) OVER (PARTITION BY total) > 1 AS is_tied_on_total
           FROM merged
           ORDER BY total DESC, dives_desc DESC`,
          [req.params.eventId],
        ),
        // History: each row is a fully-judged dive with its
        // official dive points.
        pool.query(
          // Dive-by-dive scope: d.dd is a grouping column, so it
          // feeds the UDF directly (no MAX() wrapper).
          `${perDiveSelect({
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
              `/* Parallel array — same ordering as judge_array,
                  so consumers can zip score chip i with
                  judge_numbers[i] then look up identity from
                  the top-level panel array. Robust to panels
                  with sparse judge_number sequences. */
               JSON_AGG(ej.judge_number ORDER BY ej.judge_number) AS judge_numbers`,
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
              "d.dive_code", "d.position", "d.description", "d.dd",
              "s.round_number",
            ],
          })}
           ORDER BY MAX(s.created_at) DESC LIMIT 10`,
          [req.params.eventId],
        ),
        // Up Next: every dive list row that hasn't been scored
        // yet, earliest round first. Returns the FULL queue (no
        // LIMIT) so the scoreboard's centre column can render a
        // scrollable "what's coming" list — truncating at the
        // server would force an artificial paging UX on the
        // client. A meet's competitor_dive_lists rarely exceeds
        // 600 rows (50 divers × 12 rounds), so the payload size
        // is bounded.
        //
        // round_order is the canonical 1-based diving order
        // within the round, computed across ALL non-withdrawn
        // rows for that round (not just the remaining ones) so
        // a diver's "diver 3 of 5 in round 2" stays stable as
        // earlier divers complete their dives. Falls back to
        // alphabetical when display_order is unset (matches the
        // historical sort).
        pool.query(
          `WITH ordered AS (
             SELECT cdl.id, cdl.event_id, cdl.competitor_id,
                    cdl.round_number, cdl.display_order, cdl.dive_id,
                    cdl.partner_id, cdl.team_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY cdl.round_number
                      ORDER BY cdl.display_order NULLS LAST,
                               u_inner.full_name,
                               cdl.competitor_id
                    ) AS round_order
             FROM competitor_dive_lists cdl
             JOIN users u_inner ON u_inner.id = cdl.competitor_id
             WHERE cdl.event_id = $1
               AND cdl.withdrawn_at IS NULL
               /* Migration 040: reserves don't appear in the
                  upcoming-dives queue. */
               AND cdl.is_reserve = FALSE
           )
           SELECT ordered.round_number, ordered.round_order::int AS round_order,
                  ordered.competitor_id, ordered.partner_id,
                  u.full_name, o.country_code,
                  cl.name AS club_name,
                  pu.full_name AS partner_name, pl.country_code AS partner_country,
                  t.name AS team_name,
                  d.dive_code, d.position, d.description, d.dd
           FROM ordered
           JOIN users u ON u.id = ordered.competitor_id
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs cl ON cl.id = u.club_id
           LEFT JOIN users pu ON pu.id = ordered.partner_id
           LEFT JOIN organisations pl ON pl.id = pu.org_id
           LEFT JOIN teams t ON t.id = ordered.team_id
           LEFT JOIN dive_directory d ON d.id = ordered.dive_id
           WHERE NOT EXISTS (
             SELECT 1 FROM scores s
             WHERE s.event_id = $1
               AND s.competitor_id = ordered.competitor_id
               AND s.round_number = ordered.round_number
           )
           ORDER BY ordered.round_number, ordered.round_order`,
          [req.params.eventId],
        ),
        // Panel — public listing of the judges seated for this
        // event, with country + club so the scoreboard can show
        // each chip's tooltip ("J3 — Maria Schmidt · GER · MDC")
        // and link the chip through to /judge-profile/<id>. Same
        // shape as /api/events/:id/judges but public-readable
        // (the scoreboard is anonymous-accessible, so the panel
        // identities have to be too — and judge profiles are
        // already public, so there's no new disclosure here).
        pool.query(
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

      // Compute the public_id hash in Node from competitor_id /
      // team_id; the Control Room matches the active diver to
      // a standings row by public_id and the SPA also uses
      // competitor_id to deep-link from a standings row to that
      // diver's profile (/profile/<id>). competitor_id was
      // previously redacted; it's exposed in the dive history
      // payload anyway so the redaction was inconsistent —
      // dropped to allow the diver-name link.
      const standings = st.rows.map(({ team_id, ...rest }) => ({
        ...rest,
        public_id:
          rest.competitor_id ? publicId("comp", eventId, rest.competitor_id) :
          team_id             ? publicId("team", eventId, team_id) :
          null,
      }));

      const payload = {
        standings,
        history: hi.rows,
        upcoming: up.rows,
        panel: panel.rows,
      };
      if (scoreboardCache) scoreboardCache.set(eventId, payload);
      res.set("X-Scoreboard-Cache", "miss");
      res.json(payload);
    } catch (err) {
      console.error("[Scoreboard Error]", err.message);
      res.status(500).json({ standings: [], history: [], upcoming: [], panel: [] });
    }
  });

  // Per-round leaderboard. Returns rankings for each round with
  // cumulative totals and the movement (change in rank) since the
  // previous round. Used by the scoreboard to render ↑/↓ arrows
  // next to the standings.
  //
  // Cached under the same per-event bucket as the main scoreboard
  // payload (lib/scoreboard-cache.js, derived key "leaderboard") —
  // the query below re-materialises every dive's trim UDF, so the
  // post-score viewer stampede the cache header comment describes
  // hits this endpoint just as hard as the sibling. The existing
  // invalidation hooks (socket submit_score, HTTP score
  // correction) call invalidate(eventId), which clears derived
  // keys too — no new hook needed.
  router.get("/api/scoreboard/:eventId/leaderboard", maybeAuth, async (req, res) => {
    const eventId = req.params.eventId;
    try {
      if (!(await ensureScoreboardVisible(req, res, eventId))) return;
      // ?cache=skip forces a rebuild — same escape hatch as the
      // main scoreboard endpoint above.
      if (scoreboardCache?.getDerived && req.query.cache !== "skip") {
        const hit = scoreboardCache.getDerived(eventId, "leaderboard");
        if (hit) {
          metrics?.scoreboardCacheHits.inc();
          res.set("X-Scoreboard-Cache", "hit");
          return res.json(hit);
        }
      }
      metrics?.scoreboardCacheMisses.inc();
      const r = await pool.query(
        `WITH ${perDivePointsCte({
           name:        "dive_totals",
           pointsAlias: "round_total",
         })},
         /* SUPER FINAL CARRY: when this event has score_carry_from
            set, prepend each diver's carried total as round 0 so
            the cumulative SUM OVER (ORDER BY round_number) picks
            it up before any in-stage round. The final SELECT
            filters round 0 out of the rendered leaderboard but
            its contribution to cumulative_total survives. Filter
            scoped to competitors on this event's roster so H2H
            losers don't appear in the SF's leaderboard.
            For non-super-final events (score_carry_from NULL) the
            CTE is empty and behaviour is unchanged. */
         ${perDivePointsCte({
           name:        "carry_rounds",
           // round 0 is the synthetic carry row; grouping stays
           // per-(competitor, source round) so the UDF runs once
           // per carried dive.
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
         })},
         carry_totals AS (
           SELECT competitor_id, 0 AS round_number,
                  SUM(round_total) AS round_total
           FROM carry_rounds
           GROUP BY competitor_id
         ),
         dive_totals_with_carry AS (
           SELECT * FROM dive_totals
           UNION ALL
           SELECT * FROM carry_totals
         ),
         cumulative AS (
           SELECT competitor_id, round_number, round_total,
                  SUM(round_total) OVER (
                    PARTITION BY competitor_id
                    ORDER BY round_number
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS cumulative_total,
                  /* All dives this competitor has done up to AND
                     including this round, sorted desc — the World Aquatics
                     tie-break key (highest single dive, then
                     second-highest, etc.). Postgres element-wise
                     array DESC ordering gives the World Aquatics semantics. */
                  array_agg(round_total) OVER (
                    PARTITION BY competitor_id
                    ORDER BY round_total DESC, round_number
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS dives_so_far_desc
           FROM dive_totals_with_carry
         ),
         ranked AS (
           /* Apply World Aquatics tie-break to per-round rankings so the
              up/down movement arrows on the live scoreboard match
              what the standings panel shows. Previously the
              leaderboard ordered by total DESC only, disagreeing
              with the standings panel right next to it. */
           SELECT *,
                  RANK() OVER (
                    PARTITION BY round_number
                    ORDER BY cumulative_total DESC, dives_so_far_desc DESC
                  ) AS rnk
           FROM cumulative
         ),
         with_prev AS (
           SELECT r.*,
                  LAG(r.rnk) OVER (PARTITION BY r.competitor_id ORDER BY r.round_number) AS prev_rnk
           FROM ranked r
         )
         SELECT wp.competitor_id, u.full_name, o.country_code, cl.name AS club_name,
                wp.round_number,
                wp.round_total,
                wp.cumulative_total,
                wp.rnk         AS rank,
                wp.prev_rnk    AS prev_rank,
                CASE WHEN wp.prev_rnk IS NULL THEN NULL
                     ELSE (wp.prev_rnk - wp.rnk) END AS movement
         FROM with_prev wp
         JOIN users u ON u.id = wp.competitor_id
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         /* Filter the synthetic carry-row (round_number=0) out of
            the rendered leaderboard. Its contribution survives in
            cumulative_total via the SUM OVER above. */
         WHERE wp.round_number > 0
         ORDER BY wp.round_number ASC, wp.rnk ASC`,
        [req.params.eventId],
      );

      const byRound = {};
      for (const row of r.rows) {
        const rn = row.round_number;
        if (!byRound[rn]) byRound[rn] = [];
        byRound[rn].push({
          competitor_id: row.competitor_id,
          full_name: row.full_name,
          country_code: row.country_code,
          club_name: row.club_name,
          round_total: Number(row.round_total),
          cumulative_total: Number(row.cumulative_total),
          rank: Number(row.rank),
          prev_rank: row.prev_rank == null ? null : Number(row.prev_rank),
          movement: row.movement == null ? null : Number(row.movement),
        });
      }
      const rounds = Object.keys(byRound)
        .map(Number)
        .sort((a, b) => a - b)
        .map((n) => ({ round_number: n, rankings: byRound[n] }));

      const payload = { rounds };
      if (scoreboardCache?.setDerived) {
        scoreboardCache.setDerived(eventId, "leaderboard", payload);
      }
      res.set("X-Scoreboard-Cache", "miss");
      res.json(payload);
    } catch (err) {
      console.error("[Leaderboard Error]", err.message);
      res.status(500).json({ rounds: [] });
    }
  });

  return router;
};
