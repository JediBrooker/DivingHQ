// Coach routes — a coach picks up divers via coach_diver_links
// (created by an org admin in the User Manager). These endpoints
// power the coach's dashboard + on-behalf-of dive-list submission.
//
//   GET    /api/coach/dashboard                       per-diver next-dive + rank + last-dive
//   GET    /api/coach/up-next                         squad members in Live events,
//                                                     sorted by "dives until you're up"
//   GET    /api/coach/divers                          linked-divers tile list
//   GET    /api/coach/events                          events where the coach has a squad member entered
//                                                     OR which are open for entry
//   GET    /api/coach/dive-lists/:event_id            squad rows + current dive lists for one event
//   POST   /api/coach/dive-lists/:event_id/:diver_id  submit/edit a single diver's list
//   POST   /api/coach/dive-lists/:event_id/:diver_id/withdraw
//                                                     scratch a diver from an event
//   GET    /api/coach/alert-preferences               coach's push settings (auto-creates default)
//   POST   /api/coach/alert-preferences               update { enabled, dives_ahead }
//   GET    /api/orgs/:id/coach-links                  admin link admin view
//   POST   /api/orgs/:id/coach-links                  grant link
//   DELETE /api/coach-links/:id                       revoke link
//
// Mounted via:
//   app.use(require('./routes/coach')({ … }))

const express = require("express");
const { recordAudit } = require("../lib/audit");
const submitDiveList = require("../lib/dive-list-submit");

module.exports = function createCoachRouter({
  pool,
  verifyToken,
  requireOrgAdmin,
  bulkWriteLimiter,
  loadEventForEntries,
}) {
  if (!pool) throw new Error("createCoachRouter requires { pool, … }");
  const router = express.Router();

  // Helper: assert that the logged-in coach has a coach_diver_links
  // row for the target diver within the event's host org, or within
  // the diver's home federation when that federation is explicitly
  // participating in this event. Returns the diver row (with org_id)
  // on success; throws an http-shaped error otherwise.
  //
  // Tenant-boundary note: `coach_diver_links` is scoped per-org —
  // the same coach/diver pair can have separate link rows in
  // different federations. Asking only "is there ANY link?" let a
  // coach with one legitimate link in Org A act on that diver in
  // Org B's events, where the coach has no granted authority.
  // The third arg (the event's org_id) is required and parameterised
  // into the SELECT so the existing host-org branch still requires
  // the link to be in the same org as the event being acted on.
  //
  // Cross-federation exception: if the diver's home federation is
  // on event_participating_orgs, a coach link in that same home
  // federation can act too. The participating org, diver's home org,
  // and coach link org must all be the same value; do not collapse
  // this into "any link to this diver".
  async function requireCoachLink(coachId, diverId, eventOrgId, eventId) {
    if (!eventOrgId) {
      const err = new Error("requireCoachLink: eventOrgId is required");
      err.status = 500;
      throw err;
    }
    if (!eventId) {
      const err = new Error("requireCoachLink: eventId is required");
      err.status = 500;
      throw err;
    }
    const r = await pool.query(
      `SELECT u.id, u.org_id, u.full_name
         FROM coach_diver_links link
         JOIN users u ON u.id = link.diver_id
        WHERE link.coach_id = $1 AND link.diver_id = $2
          AND (
            link.org_id = $3
            OR EXISTS (
              SELECT 1 FROM event_participating_orgs epo
               WHERE epo.event_id = $4
                 AND epo.org_id   = u.org_id
                 AND link.org_id  = u.org_id
            )
          )`,
      [coachId, diverId, eventOrgId, eventId],
    );
    if (!r.rows.length) {
      const err = new Error("You aren't linked to this diver as a coach in this event's federation");
      err.status = 403;
      throw err;
    }
    return r.rows[0];
  }

  function coachEventAcceptsEntries(event) {
    if (!event || event.status !== "Upcoming") return false;
    const now = Date.now();
    if (event.entries_close_at && new Date(event.entries_close_at).getTime() <= now) return false;
    if (event.dive_list_locks_at && new Date(event.dive_list_locks_at).getTime() <= now) return false;
    return true;
  }

  function buildCoachEligibility({
    hostFederation = false,
    invitedFederation = false,
    canSubmit = false,
    canWithdraw = false,
  }) {
    const submit = Boolean(canSubmit);
    const withdraw = Boolean(canWithdraw);
    return {
      host_federation: Boolean(hostFederation),
      invited_federation: Boolean(invitedFederation),
      can_submit: submit,
      can_withdraw: withdraw,
      read_only: !submit && !withdraw,
    };
  }

  // -------------------------------------------------------------
  // GET /api/coach/dashboard — for every linked diver, return the
  // next dive they have in any Live event (round, dive code, DD)
  // plus their current rank in that event's standings, plus a
  // summary of their last dive's total. Powers the dedicated
  // /coach view; reuses coach_diver_links + per_dive aggregates.
  //
  // Schema-wise nothing new — this is just a join across the
  // existing pieces. Heavy enough that we don't want it in the
  // page-load critical path of the regular dashboard.
  // -------------------------------------------------------------
  router.get("/api/coach/dashboard", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `WITH my_divers AS (
           SELECT u.id, u.full_name, u.username,
                  o.country_code,
                  cl.name AS club_name, cl.short_code AS club_code,
                  link.note, link.created_at AS linked_at
           FROM coach_diver_links link
           JOIN users u           ON u.id = link.diver_id
           JOIN organisations o   ON o.id = u.org_id
           LEFT JOIN clubs cl     ON cl.id = u.club_id
           WHERE link.coach_id = $1
         ),
         /* Every dive the linked divers have on a non-completed
            event, with the event's status so we can filter live
            ones. Also carries meet_id + meet_name so the frontend
            can group cards by meet (a coach at a multi-meet
            weekend gets one section per meet rather than one big
            mixed grid). */
         upcoming_raw AS (
           /* LEFT JOIN dive_directory — a dive_list row with a
              NULL or stale dive_id (diver hasn't filed their full
              list yet) shouldn't drop the diver entirely from the
              coach's dashboard. */
           SELECT cdl.competitor_id, cdl.event_id, cdl.round_number,
                  cdl.display_order,
                  e.name AS event_name, e.status, e.event_type,
                  e.height, e.number_of_judges,
                  e.meet_id,
                  m.name AS meet_name,
                  d.dive_code, d.position, d.dd, d.description
           FROM competitor_dive_lists cdl
           JOIN events e ON e.id = cdl.event_id
           LEFT JOIN meets m ON m.id = e.meet_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.competitor_id IN (SELECT id FROM my_divers)
             AND cdl.withdrawn_at IS NULL
             AND e.status IN ('Live', 'Upcoming')
         ),
         /* Pick the diver's next round in each event — the lowest
            round_number that doesn't yet have all judges' scores. */
         scored_rounds AS (
           SELECT s.event_id, s.competitor_id, s.round_number,
                  COUNT(*) AS judges_in
           FROM scores s
           WHERE s.competitor_id IN (SELECT id FROM my_divers)
           GROUP BY s.event_id, s.competitor_id, s.round_number
         ),
         upcoming_with_status AS (
           SELECT ur.*,
                  COALESCE(sr.judges_in, 0) AS judges_in,
                  ur.number_of_judges - COALESCE(sr.judges_in, 0) AS judges_pending
           FROM upcoming_raw ur
           LEFT JOIN scored_rounds sr
             ON sr.event_id      = ur.event_id
            AND sr.competitor_id = ur.competitor_id
            AND sr.round_number  = ur.round_number
         ),
         next_dive AS (
           SELECT DISTINCT ON (competitor_id, event_id)
                  competitor_id, event_id, round_number,
                  event_name, status, event_type, height,
                  meet_id, meet_name,
                  dive_code, position, dd, description,
                  display_order, judges_pending
           FROM upcoming_with_status
           WHERE judges_pending > 0
           ORDER BY competitor_id, event_id, round_number ASC
         ),
         /* Last completed dive — the most recent round where
            every judge has scored. We want this on the card so
            the coach can see "Tom just landed 78.40 on his 109C
            in round 3" without clicking through. Computed as
            the highest round_number for which judges_in equals
            number_of_judges, then joined back to the upcoming_raw
            row for that same competitor/event/round (carrying
            the dive_code + dd + description) plus the actual
            dive total from per_dive (computed below in the main
            chain). */
         last_completed_round AS (
           SELECT DISTINCT ON (competitor_id, event_id)
                  competitor_id, event_id, round_number,
                  dive_code, position, dd, description
           FROM upcoming_with_status
           WHERE judges_pending = 0
           ORDER BY competitor_id, event_id, round_number DESC
         ),
         /* Standings per event so we can attach a current rank.
            We carry round_number through so we can also surface
            the per-round dive total for the "last completed dive"
            display below. */
         per_dive AS (
           SELECT s.event_id, s.competitor_id, s.round_number,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score        ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS pts
           FROM scores s
           JOIN events e ON e.id = s.event_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = s.event_id
            AND cdl.competitor_id = s.competitor_id
            AND cdl.round_number = s.round_number
           LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
           WHERE s.event_id IN (SELECT event_id FROM upcoming_raw)
           GROUP BY s.event_id, s.competitor_id, s.round_number, e.number_of_judges, e.event_type
         ),
         totals AS (
           SELECT event_id, competitor_id, SUM(pts)::numeric(8,2) AS total
           FROM per_dive GROUP BY event_id, competitor_id
         ),
         ranked AS (
           SELECT *, RANK() OVER (PARTITION BY event_id ORDER BY total DESC) AS rnk,
                  COUNT(*) OVER (PARTITION BY event_id)::int AS field_size
           FROM totals
         )
         SELECT md.id AS diver_id, md.full_name, md.username,
                md.country_code, md.club_name, md.club_code,
                md.note,
                nd.event_id, nd.event_name, nd.status AS event_status,
                nd.event_type, nd.height,
                nd.meet_id, nd.meet_name,
                nd.round_number, nd.dive_code, nd.position, nd.dd, nd.description,
                nd.display_order,
                r.total::numeric(8,2)   AS current_total,
                r.rnk::int              AS current_rank,
                r.field_size,
                /* Most-recent completed dive — surfaced as
                   "Last: R3 109C → 78.40" on the card so the coach
                   sees what just landed without clicking through.
                   NULL when the diver hasn't competed yet. */
                lcr.round_number AS last_dive_round,
                lcr.dive_code    AS last_dive_code,
                lcr.position     AS last_dive_position,
                lcr.dd           AS last_dive_dd,
                lcr.description  AS last_dive_description,
                lpd.pts::numeric(8,2) AS last_dive_points
         FROM my_divers md
         LEFT JOIN next_dive nd ON nd.competitor_id = md.id
         LEFT JOIN ranked r
           ON r.event_id = nd.event_id AND r.competitor_id = md.id
         LEFT JOIN last_completed_round lcr
           ON lcr.event_id = nd.event_id AND lcr.competitor_id = md.id
         LEFT JOIN per_dive lpd
           ON lpd.event_id      = lcr.event_id
          AND lpd.competitor_id = lcr.competitor_id
          AND lpd.round_number  = lcr.round_number
         ORDER BY
           /* Live events first, then upcoming, then divers with no
              upcoming dive at all */
           CASE WHEN nd.status = 'Live' THEN 0
                WHEN nd.status = 'Upcoming' THEN 1
                ELSE 2 END,
           md.full_name ASC`,
        [req.user.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Coach Dashboard Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/coach/up-next — the killer "your divers in the next
  // ~5 minutes" strip on the coach console. For every Live event
  // that has a current active diver (from event_live_state), find
  // every squad member whose display_order is AHEAD of the active
  // diver in the same round (or in a later round); compute "dives
  // until they're up" by walking through the dive_order; multiply
  // by the configurable seconds-per-dive to get an ETA. Results
  // sorted ETA ascending so the coach's eye lands on whoever's up
  // soonest first.
  //
  // Synchro-aware: in a synchro event each "dive slot" is one
  // pair, not two divers, so we DISTINCT-count pairs not bodies.
  //
  // Query string:
  //   seconds_per_dive  (optional, default 45, clamp 15..120)
  //   max_eta_minutes   (optional, default 20, clamp 1..60)
  // -------------------------------------------------------------
  router.get("/api/coach/up-next", verifyToken, async (req, res) => {
    const secondsPerDive = Math.max(
      15,
      Math.min(120, parseInt(req.query.seconds_per_dive, 10) || 45),
    );
    const maxEtaMinutes = Math.max(
      1,
      Math.min(60, parseInt(req.query.max_eta_minutes, 10) || 20),
    );
    const maxEtaSeconds = maxEtaMinutes * 60;
    try {
      const r = await pool.query(
        `WITH my_divers AS (
           SELECT u.id, u.full_name,
                  o.country_code,
                  cl.name AS club_name, cl.short_code AS club_code
           FROM coach_diver_links link
           JOIN users u           ON u.id = link.diver_id
           JOIN organisations o   ON o.id = u.org_id
           LEFT JOIN clubs cl     ON cl.id = u.club_id
           WHERE link.coach_id = $1
         ),
         /* Live events with a current active diver. The active
            payload carries the competitor_id + round_number, so
            we can look up the active diver's display_order in
            this event's dive list and walk forward from there. */
         live_active AS (
           SELECT els.event_id,
                  e.name        AS event_name,
                  e.event_type,
                  e.meet_id,
                  m.name        AS meet_name,
                  (els.active_diver_payload->>'competitor_id')::uuid AS active_competitor_id,
                  (els.active_diver_payload->>'round_number')::int   AS active_round
           FROM event_live_state els
           JOIN events e ON e.id = els.event_id
           LEFT JOIN meets m ON m.id = e.meet_id
           WHERE e.status = 'Live'
             AND els.active_diver_payload IS NOT NULL
             AND els.on_hold_reason IS NULL
         ),
         /* The active diver's display_order in their round. The
            squad members AHEAD of this number are "still to come"
            this round; everybody else is in later rounds (we add
            (total_in_round - active_order) + diver_order to get
            their position in the round-ordered queue). */
         active_position AS (
           SELECT la.*,
                  cdl.display_order AS active_display_order,
                  /* Total competitors in this round of this event.
                     Synchro pairs each have one dive_list row per
                     pair (the synchro lift in 042 collapses pairs
                     into one display_order slot), so this is
                     "slots per round" not "bodies per round". */
                  (SELECT COUNT(*) FROM competitor_dive_lists cdl2
                    WHERE cdl2.event_id = la.event_id
                      AND cdl2.round_number = la.active_round
                      AND cdl2.withdrawn_at IS NULL
                  ) AS slots_in_round
           FROM live_active la
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = la.event_id
            AND cdl.competitor_id = la.active_competitor_id
            AND cdl.round_number = la.active_round
         ),
         /* Every squad-member dive slot in a Live event that has
            an active diver. Walk to "dives until you're up": if
            same round and ahead by N → N dives; if later round →
            slots_remaining_in_current + slots_in_earlier_rounds +
            their_order_in_that_round. */
         squad_slots AS (
           SELECT cdl.competitor_id, cdl.event_id, cdl.round_number,
                  cdl.display_order,
                  ap.event_name, ap.event_type, ap.meet_id, ap.meet_name,
                  ap.active_round, ap.active_display_order, ap.slots_in_round,
                  md.full_name, md.country_code, md.club_name, md.club_code,
                  d.dive_code, d.position, d.dd, d.description
           FROM competitor_dive_lists cdl
           JOIN my_divers md ON md.id = cdl.competitor_id
           JOIN active_position ap ON ap.event_id = cdl.event_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.withdrawn_at IS NULL
             /* This round, AHEAD of active diver. Or any later round. */
             AND (
                  (cdl.round_number = ap.active_round
                   AND cdl.display_order > ap.active_display_order)
               OR cdl.round_number > ap.active_round
             )
         ),
         with_eta AS (
           SELECT *,
                  CASE
                    WHEN round_number = active_round
                      THEN display_order - active_display_order
                    ELSE
                      /* Dives left in the active round +
                         (round_number - active_round - 1) full rounds +
                         this slot's position in its round. */
                      (slots_in_round - active_display_order)
                      + (round_number - active_round - 1) * slots_in_round
                      + display_order
                  END AS dives_until
           FROM squad_slots
         )
         SELECT competitor_id AS diver_id, full_name, country_code,
                club_name, club_code,
                event_id, event_name, event_type, meet_id, meet_name,
                round_number, dive_code, position, dd, description,
                dives_until,
                (dives_until * $2)::int AS eta_seconds
         FROM with_eta
         WHERE dives_until > 0
           AND dives_until * $2 <= $3
         /* For a single diver across multiple Live events: keep
            both rows; the coach probably WANTS to see them in both
            strips. Just sort by ETA so the closest one shows first. */
         ORDER BY eta_seconds ASC, full_name ASC`,
        [req.user.id, secondsPerDive, maxEtaSeconds],
      );
      res.json({
        seconds_per_dive: secondsPerDive,
        max_eta_minutes: maxEtaMinutes,
        rows: r.rows,
      });
    } catch (err) {
      console.error("[Coach Up Next Error]", err.message);
      res.status(500).json({ seconds_per_dive: secondsPerDive, max_eta_minutes: maxEtaMinutes, rows: [] });
    }
  });

  // -------------------------------------------------------------
  // GET /api/coach/events — every event where the coach has at
  // least one linked diver entered, OR which is currently open
  // for entry within the coach's org (so the coach can pre-emptively
  // file lists before their divers are formally in the roster).
  //
  // Returns one row per event with:
  //   { event_id, event_name, height, event_type, status, meet_id,
  //     meet_name, entries_close_at, dive_list_locks_at,
  //     total_rounds, squad_entered_count, coach_eligibility }
  //
  // The Coach console uses this to drive the meet-day "Dive lists"
  // sub-page: pick an event → see your squad → edit per-diver list.
  // -------------------------------------------------------------
  router.get("/api/coach/events", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `WITH my_links AS (
           SELECT u.id AS diver_id,
                  u.org_id AS diver_org_id,
                  link.org_id AS link_org_id
             FROM coach_diver_links link
             JOIN users u ON u.id = link.diver_id
            WHERE link.coach_id = $1
         ),
         entered AS (
           SELECT DISTINCT e.id AS event_id, COUNT(DISTINCT cdl.competitor_id) AS squad_count
             FROM events e
             JOIN competitor_dive_lists cdl ON cdl.event_id = e.id
            WHERE cdl.competitor_id IN (SELECT diver_id FROM my_links)
              AND cdl.withdrawn_at IS NULL
              AND e.status IN ('Upcoming', 'Live')
            GROUP BY e.id
         ),
         open_for_entry AS (
           SELECT DISTINCT e.id AS event_id
             FROM events e
             JOIN my_links ml ON TRUE
             LEFT JOIN event_participating_orgs epo
                    ON epo.event_id = e.id
                   AND epo.org_id = ml.diver_org_id
            WHERE e.status = 'Upcoming'
              AND (e.entries_close_at IS NULL OR e.entries_close_at > now())
              AND (e.dive_list_locks_at IS NULL OR e.dive_list_locks_at > now())
              AND (
                ml.diver_org_id = e.org_id
                OR epo.org_id IS NOT NULL
                OR ml.link_org_id = e.org_id
              )
         ),
         write_scope AS (
           SELECT e.id AS event_id,
                  BOOL_OR(ml.link_org_id = e.org_id) AS coach_host_federation,
                  BOOL_OR(
                    epo.org_id IS NOT NULL
                    AND ml.link_org_id = ml.diver_org_id
                    AND ml.diver_org_id <> e.org_id
                  ) AS coach_invited_federation,
                  BOOL_OR(
                    (
                      ml.link_org_id = e.org_id
                      OR (
                        epo.org_id IS NOT NULL
                        AND ml.link_org_id = ml.diver_org_id
                      )
                    )
                    AND active_cdl.competitor_id IS NOT NULL
                  ) AS coach_has_withdrawable_entry
             FROM events e
             JOIN my_links ml ON TRUE
             LEFT JOIN event_participating_orgs epo
                    ON epo.event_id = e.id
                   AND epo.org_id = ml.diver_org_id
             LEFT JOIN competitor_dive_lists active_cdl
                    ON active_cdl.event_id = e.id
                   AND active_cdl.competitor_id = ml.diver_id
                   AND active_cdl.withdrawn_at IS NULL
            WHERE ml.diver_org_id = e.org_id
               OR epo.org_id IS NOT NULL
               OR ml.link_org_id = e.org_id
            GROUP BY e.id
         )
         SELECT e.id AS event_id, e.name AS event_name,
                e.height, e.event_type, e.status,
                e.meet_id, m.name AS meet_name,
                e.entries_close_at, e.dive_list_locks_at,
                e.total_rounds,
                COALESCE(ent.squad_count, 0)::int AS squad_entered_count,
                COALESCE(ws.coach_host_federation, false) AS coach_host_federation,
                COALESCE(ws.coach_invited_federation, false) AS coach_invited_federation,
                COALESCE(ws.coach_has_withdrawable_entry, false) AS coach_has_withdrawable_entry
           FROM events e
           LEFT JOIN meets m ON m.id = e.meet_id
           LEFT JOIN entered ent ON ent.event_id = e.id
           LEFT JOIN write_scope ws ON ws.event_id = e.id
          WHERE e.id IN (SELECT event_id FROM entered)
             OR e.id IN (SELECT event_id FROM open_for_entry)
          ORDER BY
            CASE e.status WHEN 'Live' THEN 0 WHEN 'Upcoming' THEN 1 ELSE 2 END,
            COALESCE(e.entries_close_at, e.scheduled_at, e.created_at) ASC`,
        [req.user.id],
      );
      res.json(r.rows.map((row) => {
        const {
          coach_host_federation,
          coach_invited_federation,
          coach_has_withdrawable_entry,
          ...eventRow
        } = row;
        const writable = coach_host_federation || coach_invited_federation;
        return {
          ...eventRow,
          coach_eligibility: buildCoachEligibility({
            hostFederation: coach_host_federation,
            invitedFederation: coach_invited_federation,
            canSubmit: writable && coachEventAcceptsEntries(row),
            canWithdraw: row.status !== "Completed" && coach_has_withdrawable_entry,
          }),
        };
      }));
    } catch (err) {
      console.error("[Coach Events Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/coach/dive-lists/:event_id — for one event, return
  // every linked diver who's entered (or eligible to enter) plus
  // their current dive list. Powers the bulk dive-list editor:
  //
  //   {
  //     event: { id, name, height, event_type, total_rounds,
  //              round_rules, entries_close_at, dive_list_locks_at,
  //              prescribed_rounds: [{ round_number, dive_id, height }] },
  //     divers: [
  //       {
  //         diver_id, full_name, country_code, club_name, club_code,
  //         partner_id, partner_name,
  //         confirmed_at, withdrawn_at,
  //         is_reserve, reserve_position,
  //         dives: [{ round_number, dive_id, dive_code, position, dd, description }]
  //       },
  //       …
  //     ]
  //   }
  //
  // We pull EVERY linked diver, not just the ones with a dive_list
  // row, so the coach can see "Emma has nothing entered yet —
  // build her a list" alongside divers who are already in.
  // -------------------------------------------------------------
  router.get("/api/coach/dive-lists/:event_id", verifyToken, async (req, res) => {
    try {
      const evRes = await pool.query(
        `SELECT e.id, e.name, e.height, e.event_type, e.status,
                e.org_id, e.total_rounds, e.round_rules,
                e.entries_close_at, e.dive_list_locks_at,
                e.meet_id, m.name AS meet_name
           FROM events e
           LEFT JOIN meets m ON m.id = e.meet_id
          WHERE e.id = $1`,
        [req.params.event_id],
      );
      if (!evRes.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const event = evRes.rows[0];

      const eligible = await pool.query(
        `SELECT 1
           FROM coach_diver_links link
           JOIN users u ON u.id = link.diver_id
          WHERE link.coach_id = $1
            AND (
              u.org_id = $2
              OR link.org_id = $2
              OR EXISTS (
                SELECT 1 FROM event_participating_orgs epo
                 WHERE epo.event_id = $3 AND epo.org_id = u.org_id
              )
            )
          LIMIT 1`,
        [req.user.id, event.org_id, req.params.event_id],
      );
      if (!eligible.rows.length) {
        return res.status(403).json({ error: "No linked divers are eligible for this event" });
      }

      const [prescribedRes, diverRes] = await Promise.all([
        pool.query(
          `SELECT round_number, dive_id, height
             FROM event_round_dives
            WHERE event_id = $1
            ORDER BY round_number`,
          [req.params.event_id],
        ),
        pool.query(
          `WITH my_divers AS (
             SELECT u.id, u.full_name, u.org_id,
                    o.country_code,
                    cl.name AS club_name, cl.short_code AS club_code,
                    BOOL_OR(link.org_id = $3) AS coach_host_federation,
                    BOOL_OR(
                      link.org_id = u.org_id
                      AND u.org_id <> $3
                      AND EXISTS (
                        SELECT 1 FROM event_participating_orgs epo
                         WHERE epo.event_id = $2 AND epo.org_id = u.org_id
                      )
                    ) AS coach_invited_federation
               FROM coach_diver_links link
               JOIN users u ON u.id = link.diver_id
               JOIN organisations o ON o.id = u.org_id
               LEFT JOIN clubs cl ON cl.id = u.club_id
              WHERE link.coach_id = $1
                AND (
                  u.org_id = $3
                  OR link.org_id = $3
                  OR EXISTS (
                    SELECT 1 FROM event_participating_orgs epo
                     WHERE epo.event_id = $2 AND epo.org_id = u.org_id
                  )
                )
              GROUP BY u.id, u.full_name, u.org_id,
                       o.country_code, cl.name, cl.short_code
           ),
           diver_dives AS (
             SELECT cdl.competitor_id,
                    cdl.partner_id,
                    pu.full_name AS partner_name,
                    cdl.round_number,
                    cdl.dive_id, cdl.confirmed_at, cdl.withdrawn_at,
                    cdl.is_reserve, cdl.reserve_position,
                    d.dive_code, d.position, d.dd, d.description
               FROM competitor_dive_lists cdl
               LEFT JOIN dive_directory d ON d.id = cdl.dive_id
               LEFT JOIN users pu ON pu.id = cdl.partner_id
              WHERE cdl.event_id = $2
                AND cdl.competitor_id IN (SELECT id FROM my_divers)
           )
           SELECT md.id AS diver_id, md.full_name, md.country_code,
                  md.club_name, md.club_code, md.org_id,
                  md.coach_host_federation,
                  md.coach_invited_federation,
                  /* aggregate to one row per diver with their dive_list as a JSON array */
                  COALESCE(json_agg(
                    json_build_object(
                      'round_number', dd.round_number,
                      'dive_id',      dd.dive_id,
                      'dive_code',    dd.dive_code,
                      'position',     dd.position,
                      'dd',           dd.dd,
                      'description',  dd.description
                    ) ORDER BY dd.round_number
                  ) FILTER (WHERE dd.round_number IS NOT NULL), '[]'::json) AS dives,
                  /* MAX(uuid) isn't defined in PostgreSQL; cast through
                     text so this aggregate parses. A diver has at most
                     one synchro partner per event so the "max" is
                     just "the single non-null value, or null". */
                  MAX(dd.partner_id::text)::uuid AS partner_id,
                  MAX(dd.partner_name) AS partner_name,
                  MAX(dd.confirmed_at) AS confirmed_at,
                  MAX(dd.withdrawn_at) AS withdrawn_at,
                  COUNT(dd.round_number) FILTER (
                    WHERE dd.round_number IS NOT NULL AND dd.withdrawn_at IS NULL
                  )::int AS active_dive_row_count,
                  BOOL_OR(dd.is_reserve)         AS is_reserve,
                  MIN(dd.reserve_position)::int  AS reserve_position
             FROM my_divers md
             LEFT JOIN diver_dives dd ON dd.competitor_id = md.id
            GROUP BY md.id, md.full_name, md.country_code,
                     md.club_name, md.club_code, md.org_id,
                     md.coach_host_federation, md.coach_invited_federation
            ORDER BY md.full_name`,
          [req.user.id, req.params.event_id, event.org_id],
        ),
      ]);

      // Cross-federation body-field leak guard. Even though the
      // eligibility check above lets a coach see the diver-list
      // shape for any event their linked divers COULD enter, we
      // don't want to surface the event's `round_rules`,
      // `prescribed_rounds`, or per-diver `partner_name` to a coach
      // in another federation UNTIL one of their divers has actually
      // been entered (a competitor_dive_lists row exists). Otherwise
      // any coach with a single multi-fed link could fingerprint
      // every event in every other org's calendar.
      const sameOrg = event.org_id === req.user.org_id;
      const anyEntered = diverRes.rows.some(
        (row) => Array.isArray(row.dives) && row.dives.length > 0,
      );
      const exposeBodyFields = sameOrg || anyEntered;

      const submitOpen = coachEventAcceptsEntries(event);
      const decoratedDivers = diverRes.rows.map((row) => {
        const {
          coach_host_federation,
          coach_invited_federation,
          active_dive_row_count,
          ...diverRow
        } = row;
        const writable = coach_host_federation || coach_invited_federation;
        return {
          ...diverRow,
          is_reserve: Boolean(diverRow.is_reserve),
          coach_eligibility: buildCoachEligibility({
            hostFederation: coach_host_federation,
            invitedFederation: coach_invited_federation,
            canSubmit: writable && submitOpen && !diverRow.withdrawn_at,
            canWithdraw: writable && event.status !== "Completed" && Number(active_dive_row_count || 0) > 0,
          }),
        };
      });
      const eventCoachEligibility = buildCoachEligibility({
        hostFederation: decoratedDivers.some((row) => row.coach_eligibility.host_federation),
        invitedFederation: decoratedDivers.some((row) => row.coach_eligibility.invited_federation),
        canSubmit: decoratedDivers.some((row) => row.coach_eligibility.can_submit),
        canWithdraw: decoratedDivers.some((row) => row.coach_eligibility.can_withdraw),
      });

      const divers = exposeBodyFields
        ? decoratedDivers
        : decoratedDivers.map((row) => ({
            ...row,
            // No linked divers entered AND we're cross-fed —
            // strip partner_name (it can identify another federation's
            // pairings) but keep the basic id+name so the picker still
            // works.
            partner_id: null,
            partner_name: null,
          }));

      res.json({
        event: {
          id: event.id,
          name: event.name,
          height: event.height,
          event_type: event.event_type,
          status: event.status,
          total_rounds: event.total_rounds,
          round_rules: exposeBodyFields ? event.round_rules : null,
          entries_close_at: event.entries_close_at,
          dive_list_locks_at: event.dive_list_locks_at,
          meet_id: event.meet_id,
          meet_name: event.meet_name,
          coach_eligibility: eventCoachEligibility,
          prescribed_rounds: exposeBodyFields ? prescribedRes.rows : [],
        },
        divers,
      });
    } catch (err) {
      console.error("[Coach Dive Lists Error]", err.message);
      res.status(500).json({ error: "Failed to load dive lists" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/coach/dive-lists/:event_id/:diver_id — submit /
  // edit one of the coach's linked divers' dive list for a given
  // event. Reuses the same validation + UPSERT as the diver-self
  // path (POST /api/competitor/submit-list) via the shared
  // lib/dive-list-submit helper, so prescribed-dive enforcement,
  // round-rules, and synchro partner checks are identical.
  //
  // Audit-logged with the coach + diver ids so the operator can
  // see "this list was submitted by their coach, not the diver".
  // -------------------------------------------------------------
  router.post(
    "/api/coach/dive-lists/:event_id/:diver_id",
    bulkWriteLimiter,
    verifyToken,
    async (req, res) => {
      const { event_id, diver_id } = req.params;
      const { dives, partner_id, actor_local_time } = req.body || {};
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Load the event first — we need its org_id so the coach
        // link gate can be scoped to the right federation. Otherwise
        // a coach with a link in Org A could act on the diver in Org
        // B's events (cross-tenant leak).
        // actor_local_time enables the late-arrival gate (DEC-04):
        // when the coach taps submit before the entry deadline but
        // the request only arrives after, the gate flags the rows
        // for referee review instead of returning 409.
        const gate = await loadEventForEntries(client, event_id, {
          actorLocalTime: actor_local_time,
        });
        if (gate.error) {
          await client.query("ROLLBACK");
          return res.status(gate.status).json({ error: gate.error });
        }

        // Coach → diver link gate, scoped to the event's org.
        let diver;
        try {
          diver = await requireCoachLink(req.user.id, diver_id, gate.event.org_id, gate.event.id);
        } catch (err) {
          await client.query("ROLLBACK");
          return res.status(err.status || 500).json({ error: err.message });
        }

        await submitDiveList({
          client,
          event: gate.event,
          actor: {
            id: req.user.id,
            org_id: req.user.org_id,
            is_system_admin: req.user.is_system_admin,
            full_name: req.user.full_name,
          },
          competitorId:    diver_id,
          competitorOrgId: diver.org_id,
          partnerId:       partner_id,
          dives,
          actorLocalTime:  actor_local_time,
          lateReview:      gate.lateReview,
        });

        // Audit: a coach acted on a diver's list. Operator visibility.
        // lib/audit.js reads `actor_id` + `metadata` — not `actor_user_id`
        // + `context` (caught by the new authz test pack, which discovered
        // the audit row had been writing NULLs for both fields silently).
        await recordAudit(client, {
          org_id: gate.event.org_id,
          actor_id: req.user.id,
          action: "coach.submit_dive_list",
          entity_type: "dive_list",
          entity_id: diver_id,
          metadata: {
            event_id,
            coach_id: req.user.id,
            diver_id,
            dive_count: Array.isArray(dives) ? dives.length : 0,
            partner_id: partner_id || null,
            actor_local_time: actor_local_time || null,
            late_review: gate.lateReview || false,
          },
        });

        await client.query("COMMIT");
        // late_review=true tells the coach UI to surface the
        // "flagged for referee review" toast.
        res.json({
          message: gate.lateReview
            ? `Dive list submitted for ${diver.full_name} — flagged for referee review (arrived after the entry deadline; the meet manager will confirm or deny)`
            : `Dive list submitted for ${diver.full_name}`,
          diver_id,
          late_review: gate.lateReview,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.status) {
          const body = { error: err.message };
          if (err.violations) body.violations = err.violations;
          return res.status(err.status).json(body);
        }
        console.error("[Coach Submit List Error]", err.message);
        res.status(500).json({ error: "Failed to submit dive list" });
      } finally {
        client.release();
      }
    },
  );

  // -------------------------------------------------------------
  // POST /api/coach/dive-lists/:event_id/:diver_id/withdraw
  //
  // Phase 4 — coach scratches one of their linked divers from an
  // event. Sets withdrawn_at, withdrawn_by_user_id (the coach),
  // and withdrawn_reason on every competitor_dive_lists row this
  // diver has in the event. Gated by:
  //
  //   1. coach_diver_links — coach must own the diver.
  //   2. Event must not be Completed (we don't rewrite history).
  //      Live events ARE permitted — sometimes a diver gets
  //      injured mid-event and pulls.
  //
  // Audit-logged as `coach.withdraw_dive_list` so the operator
  // can see at a glance "Tom was withdrawn by his coach @ 14:32,
  // reason: shoulder injury". On the live Control Room the
  // operator gets a meet_held-style banner so they're not blind-
  // sided when the diver disappears from the queue.
  // -------------------------------------------------------------
  router.post(
    "/api/coach/dive-lists/:event_id/:diver_id/withdraw",
    bulkWriteLimiter,
    verifyToken,
    async (req, res) => {
      const { event_id, diver_id } = req.params;
      const reason = (req.body?.reason || "").trim().slice(0, 500);
      // Offline-resilience clock (P4-1 / DEC-04). Captures when
      // the coach actually tapped Withdraw — useful for forensics
      // when an outbox-queued withdraw lands minutes after the
      // diver's first dive of the round.
      const actorLocalTime = req.body?.actor_local_time || null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Event-status gate. Load the event first so we have its
        // org_id for the link check below (tenant scoping) and so
        // we can refuse withdrawal from Completed events.
        const ev = await client.query(
          `SELECT id, name, status, org_id FROM events WHERE id = $1`,
          [event_id],
        );
        if (!ev.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        if (ev.rows[0].status === "Completed") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Event is Completed — withdrawing now would rewrite history",
          });
        }

        // Coach → diver link gate, scoped to the event's org so a
        // coach with a link in Org A can't withdraw the diver from
        // Org B's event.
        let diver;
        try {
          diver = await requireCoachLink(req.user.id, diver_id, ev.rows[0].org_id, ev.rows[0].id);
        } catch (err) {
          await client.query("ROLLBACK");
          return res.status(err.status || 500).json({ error: err.message });
        }

        // Mark every (un-withdrawn) row for this diver in this
        // event as withdrawn. If the diver has no rows at all,
        // 404. If every row is already withdrawn, 409 — nothing
        // to do, surface that to the coach.
        const upd = await client.query(
          `UPDATE competitor_dive_lists
              SET withdrawn_at         = NOW(),
                  withdrawn_by_user_id = $1,
                  withdrawn_reason     = $2
            WHERE event_id      = $3
              AND competitor_id = $4
              AND withdrawn_at IS NULL
            RETURNING id`,
          [req.user.id, reason || null, event_id, diver_id],
        );
        if (!upd.rows.length) {
          // Distinguish "not entered" from "already withdrawn".
          const any = await client.query(
            `SELECT 1 FROM competitor_dive_lists
              WHERE event_id = $1 AND competitor_id = $2 LIMIT 1`,
            [event_id, diver_id],
          );
          await client.query("ROLLBACK");
          if (!any.rows.length) {
            return res.status(404).json({
              error: `${diver.full_name} isn't entered in this event`,
            });
          }
          return res.status(409).json({
            error: `${diver.full_name} is already withdrawn from this event`,
          });
        }

        await recordAudit(client, {
          org_id: ev.rows[0].org_id,
          actor_id: req.user.id,
          action: "coach.withdraw_dive_list",
          entity_type: "dive_list",
          entity_id: diver_id,
          entity_name: diver.full_name,
          note: reason || null,
          metadata: {
            event_id,
            event_name: ev.rows[0].name,
            event_status: ev.rows[0].status,
            coach_id: req.user.id,
            diver_id,
            row_count: upd.rows.length,
            reason: reason || null,
            // P4-1 follow-up: capture the actor's wall-clock so a
            // forensic query can spot withdraws that landed late
            // (coach tapped at 14:01 offline; server saw it at
            // 14:35 mid-round, after the diver had already missed
            // their first dive).
            actor_local_time: actorLocalTime,
          },
        });

        await client.query("COMMIT");
        res.json({
          message: `${diver.full_name} withdrawn from ${ev.rows[0].name}`,
          diver_id,
          rows_updated: upd.rows.length,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Coach Withdraw Error]", err.message);
        res.status(500).json({ error: "Failed to withdraw" });
      } finally {
        client.release();
      }
    },
  );

  // -------------------------------------------------------------
  // GET /api/coach/alert-preferences — coach's "your diver is up
  // next" push settings. Auto-creates a default row on first read
  // so the coach doesn't have to manually opt in.
  //
  // POST /api/coach/alert-preferences — update { enabled, dives_ahead }
  // -------------------------------------------------------------
  router.get("/api/coach/alert-preferences", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `INSERT INTO coach_alert_preferences (coach_id, enabled, dives_ahead)
         VALUES ($1, true, 2)
         ON CONFLICT (coach_id) DO UPDATE
           SET updated_at = coach_alert_preferences.updated_at
         RETURNING enabled, dives_ahead, updated_at`,
        [req.user.id],
      );
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Coach Alert Prefs Read Error]", err.message);
      res.status(500).json({ error: "Failed to load preferences" });
    }
  });

  router.post("/api/coach/alert-preferences", bulkWriteLimiter, verifyToken, async (req, res) => {
    const { enabled, dives_ahead } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required" });
    }
    const ahead = Number(dives_ahead);
    if (!Number.isInteger(ahead) || ahead < 1 || ahead > 10) {
      return res.status(400).json({ error: "dives_ahead must be an integer 1..10" });
    }
    try {
      const r = await pool.query(
        `INSERT INTO coach_alert_preferences (coach_id, enabled, dives_ahead, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (coach_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               dives_ahead = EXCLUDED.dives_ahead,
               updated_at = now()
         RETURNING enabled, dives_ahead, updated_at`,
        [req.user.id, enabled, ahead],
      );
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Coach Alert Prefs Write Error]", err.message);
      res.status(500).json({ error: "Failed to save preferences" });
    }
  });

  // -------------------------------------------------------------
  // GET /api/coach/divers — coaches see their own linked divers,
  // minimal fields, enough to build a dashboard tile + click
  // through to each diver's profile (which already exists at
  // /profile/:id).
  // -------------------------------------------------------------
  router.get("/api/coach/divers", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name, u.username,
                cl.name AS club_name, cl.short_code AS club_code,
                o.country_code,
                link.created_at AS linked_at,
                link.note
         FROM coach_diver_links link
         JOIN users u ON u.id = link.diver_id
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE link.coach_id = $1
         ORDER BY u.full_name ASC`,
        [req.user.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Coach Divers Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // Coach-link administration (org admins)
  // -------------------------------------------------------------
  router.get("/api/orgs/:id/coach-links", requireOrgAdmin, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot read coach links in other organisations" });
    }
    try {
      const r = await pool.query(
        `SELECT link.id, link.coach_id, link.diver_id, link.created_at, link.note,
                c.full_name AS coach_name, d.full_name AS diver_name
         FROM coach_diver_links link
         JOIN users c ON c.id = link.coach_id
         JOIN users d ON d.id = link.diver_id
         WHERE link.org_id = $1
         ORDER BY c.full_name, d.full_name`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Coach Links List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.post("/api/orgs/:id/coach-links", requireOrgAdmin, async (req, res) => {
    const { coach_id, diver_id, note } = req.body || {};
    if (!coach_id || !diver_id) {
      return res.status(400).json({ error: "coach_id and diver_id are required" });
    }
    if (coach_id === diver_id) {
      return res.status(400).json({ error: "Coach and diver must be different users" });
    }
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot link users in other organisations" });
    }
    try {
      // Sanity check: both users belong to the target org.
      const usersRes = await pool.query(
        `SELECT id, org_id FROM users WHERE id = ANY($1)`,
        [[coach_id, diver_id]],
      );
      if (usersRes.rows.length !== 2) {
        return res.status(400).json({ error: "Coach or diver not found" });
      }
      for (const u of usersRes.rows) {
        if (u.org_id !== req.params.id) {
          return res
            .status(400)
            .json({ error: "Both users must belong to the target organisation" });
        }
      }
      const r = await pool.query(
        `INSERT INTO coach_diver_links (coach_id, diver_id, org_id, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (coach_id, diver_id) DO UPDATE SET note = EXCLUDED.note
         RETURNING id, coach_id, diver_id, note, created_at`,
        [coach_id, diver_id, req.params.id, note || null],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Coach Link Create Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/coach-links/:id", requireOrgAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        "DELETE FROM coach_diver_links WHERE id = $1 AND org_id = $2 RETURNING id",
        [req.params.id, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Link not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Coach Link Delete Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
