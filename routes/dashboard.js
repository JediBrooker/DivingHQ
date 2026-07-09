// Dashboard bundle endpoint.
//
// The dashboard view used to fan out 5–6 parallel API calls on
// mount: /api/events, /api/role-requests, /api/orgs (sysadmin),
// /api/audit/recent, /api/judge/my-events, /api/coach/dashboard.
// Each is its own auth check + route handler + Postgres query.
// Fine for a single user, but 50 operators all hitting Refresh
// during a meet day = 50 × 6 = 300 round trips, plus the
// upstream connection pool churn.
//
// This single endpoint composes the same data on the server
// side via Promise.all and returns one response. Same auth, one
// round trip per dashboard mount.
//
//   GET /api/dashboard
//
//     {
//       events:           [...],   // filtered to roles the user can see
//       role_requests:    [...],   // org_admin only
//       pending_orgs:     [...],   // sysadmin only
//       recent_activity:  [...],   // org_admin only
//       judge_events:     [...],   // judge role only
//       coach:            { ... }, // coach role only, minimal slice
//       diver_event_ids:  [...],   // diver role only, event_ids the
//                                  // caller has an active (is_reserve=
//                                  // FALSE) competitor_dive_lists entry
//                                  // for. Lets the diver-tab "Meet day
//                                  // · Live now" card filter out events
//                                  // the diver isn't actually competing
//                                  // in (matches the gate on
//                                  // /api/events/:id/me-meet-day so a
//                                  // surfaced card never dead-ends in
//                                  // a 403).
//       diver_reserve_event_ids:    // diver role only, events where
//         [{event_id, reserve_position}, …]   // the caller is a reserve.
//                                  // Surfaced as a separate card so the
//                                  // diver can confirm their list before
//                                  // the post-advance lock fires.
//     }
//
// Each slice is fetched only when the caller's roles authorise
// it, so a diver-only account gets a tiny payload.
//
// Rate limit / auth: verifyToken at the route level. Queries
// scope by req.user.org_id (or open for sysadmin where the
// upstream endpoint already does so).

const express = require("express");
const { buildReadinessFromRow } = require("../lib/workflow");

module.exports = function createDashboardRouter({ pool, verifyToken }) {
  if (!pool || !verifyToken) {
    throw new Error("createDashboardRouter requires { pool, verifyToken }");
  }
  const router = express.Router();

  router.get("/api/dashboard", verifyToken, async (req, res) => {
    const user = req.user;
    const roles = user.org_roles || [];
    const isSysAdmin = !!user.is_system_admin;
    const has = (r) => roles.includes(r) || isSysAdmin;

    const tasks = {};

    // ---- Events (operators + divers + meet managers) ----
    if (has("org_admin") || has("meet_manager") || has("diver")) {
      // Mirrors what /api/events returns. Org admin / meet
      // manager / diver see their org's events PLUS any event
      // their org has been invited to via event_participating_orgs
      // (commit 48fa8d5). Heads up: without the EXISTS clause, the
      // dashboard pulse strip's INVITED chip silently never fires
      // for visiting federations because their bundle ships zero
      // foreign events.
      tasks.events = pool.query(
        `SELECT e.id, e.name, e.status, e.event_type::text AS event_type,
                e.gender, e.height, e.age_group,
                e.total_rounds, e.number_of_judges,
                e.scheduled_at, e.entries_close_at, e.is_rehearsal,
                e.org_id, e.meet_id, e.parent_event_id,
                e.event_format::text AS event_format,
                o.name AS org_name, o.country_code,
                m.name AS meet_name
         FROM events e
         LEFT JOIN organisations o ON o.id = e.org_id
         LEFT JOIN meets m ON m.id = e.meet_id
         WHERE $1::boolean
            OR e.org_id = $2
            OR EXISTS (
                 SELECT 1 FROM event_participating_orgs epo
                  WHERE epo.event_id = e.id AND epo.org_id = $2
               )
         ORDER BY e.created_at DESC
         LIMIT 100`,
        [isSysAdmin, user.org_id],
      ).then((r) => r.rows).catch(() => []);
    }

    // ---- Workflow actions (org_admin / meet_manager) ----
    // A compact "what should I do next?" list for operators. It
    // uses the same readiness builder exposed by /events/:id/readiness
    // so dashboard and Control Room speak the same workflow language.
    if (has("org_admin") || has("meet_manager")) {
      tasks.workflow_actions = pool.query(
        `WITH visible_events AS (
           SELECT e.id, e.name, e.status, e.number_of_judges,
                  e.total_rounds,
                  e.scheduled_at, e.entries_close_at, e.is_rehearsal,
                  e.check_in_done_at, e.dive_order_randomised_at,
                  e.dive_order_signed_off_at, e.created_at
           FROM events e
           WHERE ($1::boolean OR e.org_id = $2)
             AND e.status IN ('Upcoming', 'Live')
           ORDER BY
             CASE e.status WHEN 'Live' THEN 0 WHEN 'Upcoming' THEN 1 ELSE 2 END,
             e.scheduled_at NULLS LAST,
             e.created_at DESC
           LIMIT 60
         ),
         roster AS (
           SELECT cdl.event_id,
                  COUNT(DISTINCT cdl.competitor_id)
                    FILTER (WHERE cdl.withdrawn_at IS NULL AND cdl.is_reserve = FALSE)::int AS active_diver_count,
                  COUNT(DISTINCT cdl.competitor_id)
                    FILTER (WHERE cdl.withdrawn_at IS NULL AND cdl.is_reserve = TRUE)::int AS reserve_count,
                  COUNT(DISTINCT cdl.competitor_id)
                    FILTER (WHERE cdl.withdrawn_at IS NOT NULL)::int AS withdrawn_count,
                  COUNT(*)
                    FILTER (WHERE cdl.withdrawn_at IS NULL AND cdl.is_reserve = FALSE AND cdl.dive_id IS NULL)::int AS missing_dive_rows
           FROM competitor_dive_lists cdl
           JOIN visible_events ve ON ve.id = cdl.event_id
           GROUP BY cdl.event_id
         ),
         incomplete AS (
           SELECT event_id, COUNT(*)::int AS incomplete_diver_count
           FROM (
             SELECT cdl.event_id, cdl.competitor_id
             FROM competitor_dive_lists cdl
             JOIN visible_events ve ON ve.id = cdl.event_id
             WHERE cdl.withdrawn_at IS NULL
               AND cdl.is_reserve = FALSE
             GROUP BY cdl.event_id, cdl.competitor_id, ve.total_rounds
             HAVING COUNT(*) < ve.total_rounds
                 OR COUNT(*) FILTER (WHERE cdl.dive_id IS NULL) > 0
           ) x
           GROUP BY event_id
         ),
         judges AS (
           SELECT ej.event_id, COUNT(*)::int AS judge_count
           FROM event_judges ej
           JOIN visible_events ve ON ve.id = ej.event_id
           GROUP BY ej.event_id
         ),
         pending_signoff AS (
           SELECT DISTINCT ON (rsr.event_id)
                  rsr.event_id, u.full_name AS pending_signoff_referee_name
           FROM referee_signoff_requests rsr
           JOIN users u ON u.id = rsr.target_referee_id
           JOIN visible_events ve ON ve.id = rsr.event_id
           WHERE rsr.status = 'pending'
           ORDER BY rsr.event_id, rsr.created_at DESC
         )
         SELECT ve.id, ve.name, ve.status, ve.number_of_judges,
                ve.scheduled_at, ve.entries_close_at, ve.is_rehearsal,
                ve.check_in_done_at, ve.dive_order_randomised_at,
                ve.dive_order_signed_off_at,
                COALESCE(roster.active_diver_count, 0)::int AS active_diver_count,
                COALESCE(roster.reserve_count, 0)::int AS reserve_count,
                COALESCE(roster.withdrawn_count, 0)::int AS withdrawn_count,
                COALESCE(roster.missing_dive_rows, 0)::int AS missing_dive_rows,
                COALESCE(incomplete.incomplete_diver_count, 0)::int AS incomplete_diver_count,
                COALESCE(judges.judge_count, 0)::int AS judge_count,
                pending_signoff.pending_signoff_referee_name
         FROM visible_events ve
         LEFT JOIN roster ON roster.event_id = ve.id
         LEFT JOIN incomplete ON incomplete.event_id = ve.id
         LEFT JOIN judges ON judges.event_id = ve.id
         LEFT JOIN pending_signoff ON pending_signoff.event_id = ve.id`,
        [isSysAdmin, user.org_id],
      ).then((r) => r.rows.map(buildReadinessFromRow)).catch(() => []);
    }

    // ---- Role requests (org_admin / sysadmin) ----
    if (has("org_admin")) {
      tasks.role_requests = pool.query(
        `SELECT rr.id, rr.requested_role, rr.status, rr.note, rr.created_at,
                rr.org_id, o.name AS org_name, o.country_code,
                u.id AS user_id, u.username, u.full_name
         FROM role_requests rr
         JOIN users u           ON rr.user_id = u.id
         JOIN organisations o   ON rr.org_id = o.id
         WHERE rr.status = 'pending' AND ($2::boolean OR rr.org_id = $1)
         ORDER BY o.name ASC, rr.created_at ASC`,
        [user.org_id, isSysAdmin],
      ).then((r) => r.rows).catch(() => []);
    }

    // ---- Pending org registrations (sysadmin only) ----
    if (isSysAdmin) {
      tasks.pending_orgs = pool.query(
        `SELECT id, name, country_code, status, created_at
         FROM organisations
         WHERE status = 'pending'
         ORDER BY created_at DESC`,
      ).then((r) => r.rows).catch(() => []);
    }

    // ---- Recent activity feed (org_admin only) ----
    // Mirrors /api/audit/recent but inlined here so we
    // don't pay the extra HTTP round trip. 7-day window,
    // top 10 across score + role + activity logs.
    if (has("org_admin")) {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const orgScope = isSysAdmin ? null : user.org_id;
      tasks.recent_activity = (async () => {
        const scoreSql = `
          SELECT a.id, a.created_at, a.action::text AS action,
                 a.competitor_id, comp.full_name AS competitor_name,
                 a.judge_id, jud.full_name AS judge_name,
                 a.actor_user_id, act.full_name AS actor_name,
                 a.event_id, e.name AS event_name,
                 a.round_number, a.old_score, a.new_score, a.reason,
                 e.org_id, o.name AS org_name
          FROM score_audit_log a
          JOIN events e        ON e.id = a.event_id
          LEFT JOIN organisations o ON o.id = e.org_id
          LEFT JOIN users comp ON comp.id = a.competitor_id
          LEFT JOIN users jud  ON jud.id  = a.judge_id
          LEFT JOIN users act  ON act.id  = a.actor_user_id
          WHERE a.created_at >= $1
            AND ($2::uuid IS NULL OR e.org_id = $2::uuid)
          ORDER BY a.created_at DESC
          LIMIT 10`;
        const roleSql = `
          SELECT a.id, a.created_at, a.action::text AS action,
                 a.user_id, target.full_name AS target_name,
                 a.actor_id, actor.full_name AS actor_name,
                 a.role::text AS role, a.note,
                 a.org_id, o.name AS org_name
          FROM role_audit_log a
          JOIN organisations o ON o.id = a.org_id
          LEFT JOIN users target ON target.id = a.user_id
          LEFT JOIN users actor  ON actor.id  = a.actor_id
          WHERE a.created_at >= $1
            AND ($2::uuid IS NULL OR a.org_id = $2::uuid)
          ORDER BY a.created_at DESC
          LIMIT 10`;
        const activitySql = `
          SELECT a.id, a.created_at, a.action,
                 a.entity_type, a.entity_id, a.entity_name,
                 a.metadata, a.note,
                 a.actor_id, actor.full_name AS actor_name,
                 a.org_id, o.name AS org_name
          FROM audit_log a
          LEFT JOIN organisations o ON o.id = a.org_id
          LEFT JOIN users actor     ON actor.id = a.actor_id
          WHERE a.created_at >= $1
            AND ($2::uuid IS NULL OR a.org_id = $2::uuid)
          ORDER BY a.created_at DESC
          LIMIT 10`;
        try {
          const [s, ro, ac] = await Promise.all([
            pool.query(scoreSql,    [since, orgScope]),
            pool.query(roleSql,     [since, orgScope]),
            pool.query(activitySql, [since, orgScope]),
          ]);
          return [
            ...s.rows .map((r) => ({ kind: "score",    ...r })),
            ...ro.rows.map((r) => ({ kind: "role",     ...r })),
            ...ac.rows.map((r) => ({ kind: "activity", ...r })),
          ].sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at),
          ).slice(0, 10);
        } catch {
          return [];
        }
      })();
    }

    // ---- Judge events (judge role only) ----
    if (has("judge")) {
      tasks.judge_events = pool.query(
        `SELECT e.id, e.name, e.status, e.event_type::text AS event_type,
                e.height, e.total_rounds, e.number_of_judges,
                e.scheduled_at,
                ej.judge_number
         FROM event_judges ej
         JOIN events e ON e.id = ej.event_id
         WHERE ej.judge_id = $1
           AND e.status IN ('Upcoming', 'Live')
         ORDER BY e.scheduled_at NULLS LAST, e.created_at DESC
         LIMIT 25`,
        [user.id],
      ).then((r) => r.rows).catch(() => []);
    }

    // ---- Referee desk (referee role only) ----
    if (has("referee")) {
      tasks.referee_desk = (async () => {
        try {
          const [pending, signed, live] = await Promise.all([
            pool.query(
              `SELECT rsr.id AS request_id, rsr.event_id, rsr.created_at,
                      rsr.expires_at, e.name AS event_name, e.status,
                      e.scheduled_at, u.full_name AS requested_by_name
               FROM referee_signoff_requests rsr
               JOIN events e ON e.id = rsr.event_id
               JOIN users u ON u.id = rsr.requested_by
               WHERE rsr.target_referee_id = $1
                 AND rsr.status = 'pending'
                 AND ($2::boolean OR e.org_id = $3)
               ORDER BY rsr.created_at DESC
               LIMIT 10`,
              [user.id, isSysAdmin, user.org_id],
            ),
            pool.query(
              `SELECT e.id AS event_id, e.name AS event_name, e.status,
                      e.scheduled_at, e.dive_order_signed_off_at
               FROM events e
               WHERE e.dive_order_signed_off_by = $1
                 AND e.status IN ('Upcoming', 'Live')
                 AND ($2::boolean OR e.org_id = $3)
               ORDER BY e.scheduled_at NULLS LAST, e.created_at DESC
               LIMIT 10`,
              [user.id, isSysAdmin, user.org_id],
            ),
            pool.query(
              `SELECT id AS event_id, name AS event_name, status, scheduled_at
               FROM events
               WHERE status = 'Live'
                 AND ($1::boolean OR org_id = $2)
               ORDER BY scheduled_at NULLS LAST, created_at DESC
               LIMIT 10`,
              [isSysAdmin, user.org_id],
            ),
          ]);
          return {
            pending_signoffs: pending.rows,
            signed_events: signed.rows,
            live_events: live.rows,
          };
        } catch {
          return { pending_signoffs: [], signed_events: [], live_events: [] };
        }
      })();
    }

    // ---- Diver entered-event ids (diver role only) ----
    // Mirrors the gate on /api/events/:id/me-meet-day exactly:
    // an entry in competitor_dive_lists whose withdrawn_at is
    // null counts as "this diver is in this event". We only need
    // the ids, the SPA already has the full event row from
    // `events` and intersects.
    if (has("diver")) {
      tasks.diver_event_ids = pool.query(
        `SELECT DISTINCT event_id
           FROM competitor_dive_lists
          WHERE competitor_id = $1
            AND withdrawn_at IS NULL
            AND is_reserve = FALSE`,
        [user.id],
      ).then((r) => r.rows.map((row) => row.event_id)).catch(() => []);
      // Migration 040: seperate slice for events where the
      // diver is a reserve. Surfaced as a "You're a reserve in
      // [event]" card on the diver tab. The Meet Day card
      // doesn't make sense here (reserves don't compete) but the
      // diver should still see the event so they can confirm
      // their list before the lock.
      tasks.diver_reserve_event_ids = pool.query(
        `SELECT DISTINCT event_id, MIN(reserve_position) AS reserve_position
           FROM competitor_dive_lists
          WHERE competitor_id = $1
            AND withdrawn_at IS NULL
            AND is_reserve = TRUE
          GROUP BY event_id`,
        [user.id],
      ).then((r) => r.rows.map((row) => ({
        event_id: row.event_id,
        reserve_position: row.reserve_position,
      }))).catch(() => []);
    }

    // ---- Coach slice (coach role only) ----
    // Minimal, just divers list with names + clubs. Full coach
    // dashboard data still goes via /api/coach/dashboard
    // when the user actually opens the Coach tab, this is
    // just enough for the pulse chip + tab badge.
    if (has("coach")) {
      tasks.coach = pool.query(
        `SELECT u.id, u.full_name, u.username,
                cl.name AS club_name, cl.short_code AS club_code
         FROM coach_diver_links link
         JOIN users u       ON u.id = link.diver_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE link.coach_id = $1
         ORDER BY u.full_name ASC
         LIMIT 50`,
        [user.id],
      ).then((r) => ({ divers: r.rows })).catch(() => ({ divers: [] }));

      tasks.coach_workbench = pool.query(
        `WITH my_divers AS (
           SELECT link.diver_id, u.full_name AS diver_name
           FROM coach_diver_links link
           JOIN users u ON u.id = link.diver_id
           WHERE link.coach_id = $1
         ),
         entered AS (
           SELECT e.id AS event_id, e.name AS event_name, e.status,
                  e.scheduled_at, e.entries_close_at, e.total_rounds,
                  e.is_rehearsal, md.diver_id, md.diver_name,
                  COUNT(*)::int AS rows_entered,
                  COUNT(*) FILTER (WHERE cdl.dive_id IS NULL)::int AS missing_dive_rows
           FROM my_divers md
           JOIN competitor_dive_lists cdl ON cdl.competitor_id = md.diver_id
           JOIN events e ON e.id = cdl.event_id
           WHERE cdl.withdrawn_at IS NULL
             AND cdl.is_reserve = FALSE
             AND e.status IN ('Upcoming', 'Live')
             AND ($2::boolean OR e.org_id = $3)
           GROUP BY e.id, e.name, e.status, e.scheduled_at, e.entries_close_at,
                    e.total_rounds, e.is_rehearsal, md.diver_id, md.diver_name
         )
         SELECT *
         FROM entered
         ORDER BY
           CASE status WHEN 'Live' THEN 0 ELSE 1 END,
           entries_close_at NULLS LAST,
           scheduled_at NULLS LAST,
           event_name ASC
         LIMIT 50`,
        [user.id, isSysAdmin, user.org_id],
      ).then((r) => {
        const now = Date.now();
        const rows = r.rows.map((row) => ({
          ...row,
          incomplete: Number(row.rows_entered) < Number(row.total_rounds)
            || Number(row.missing_dive_rows) > 0,
          closing_soon: row.entries_close_at
            ? new Date(row.entries_close_at).getTime() > now
              && new Date(row.entries_close_at).getTime() < now + 7 * 86_400_000
            : false,
        }));
        return {
          live: rows.filter((row) => row.status === "Live"),
          incomplete_lists: rows.filter((row) => row.status === "Upcoming" && row.incomplete),
          closing_soon: rows.filter((row) => row.status === "Upcoming" && row.closing_soon),
        };
      }).catch(() => ({ live: [], incomplete_lists: [], closing_soon: [] }));
    }

    try {
      // Resolve every authorised slice in parallel.
      const keys = Object.keys(tasks);
      const values = await Promise.all(keys.map((k) => tasks[k]));
      const out = {};
      keys.forEach((k, i) => { out[k] = values[i]; });
      res.json(out);
    } catch (err) {
      console.error("[dashboard bundle] error:", err.message);
      res.status(500).json({ error: "Failed to load dashboard" });
    }
  });

  return router;
};
