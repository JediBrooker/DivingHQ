// Event routes: CRUD + status transitions.
//
//   GET    /api/events            list (anon → Live/Completed only)
//   POST   /api/events            create (org_admin only)
//   PUT    /api/events/:id        update (event manager / org_admin)
//   DELETE /api/events/:id        remove (org_admin only)
//   PUT    /api/events/:id/status flip Upcoming/Live/Completed
//
// This file also carries round-dive templates and the plain stage
// advance (prelim -> semi -> final). Its sub-routers sit next to it:
// participation.js (other federations entering), super-final-seeding.js
// and super-final-bridge.js (Appendix 3), dive-offs.js and reserves.js,
// with the SQL they share in stage-helpers.js. Judges, managers and the
// Control Room roster have their own route modules (event-staff.js,
// control-room.js).
// loadEventForEntries, used by the diver-portal and team dive-list
// submit handlers, lives in lib/middleware.js so both share it.
//
// Mounted via:
//   app.use(require('./routes/events')({ … }))

const express = require("express");
const { recordAudit, auditFromReq } = require("../../lib/audit");
const createIdempotency = require("../../lib/idempotency");
const { getEventReadiness } = require("../../lib/workflow");
const { perDivePointsCte } = require("../../lib/scoring-sql");
const archiveCache = require("../../lib/archive-cache");
const {
  buildReflowProposal,
  stampActualStart,
} = require("../../lib/schedule-reflow");
const { retirePendingPayment } = require("../../lib/payment-lifecycle");
const {
  parseLockMinutes,
  insertDiveListRows,
  insertRoundDives,
  stampDiveListLock,
  refuseIfScoresExist,
} = require("./stage-helpers");

// Migration 039: shape-check operator-prescribed round_dives. We
// only validate structure here (round numbering 1..N contiguous,
// dive_id is a string-or-null, height is numeric-or-null); FK
// validity is enforced by Postgres on INSERT.
function validateRoundDivesShape(round_dives) {
  if (round_dives == null) return { valid: true };
  if (!Array.isArray(round_dives)) {
    return { valid: false, error: "round_dives must be an array" };
  }
  if (round_dives.length > 12) {
    return { valid: false, error: "round_dives can have at most 12 rounds" };
  }
  const seen = new Set();
  for (let i = 0; i < round_dives.length; i++) {
    const slot = round_dives[i];
    if (!slot || typeof slot !== "object") {
      return { valid: false, error: `round_dives[${i}]: not an object` };
    }
    const rn = Number(slot.round_number);
    if (!Number.isInteger(rn) || rn < 1) {
      return { valid: false, error: `round_dives[${i}]: round_number must be a positive integer` };
    }
    if (seen.has(rn)) {
      return { valid: false, error: `round_dives[${i}]: duplicate round_number ${rn}` };
    }
    seen.add(rn);
    if (slot.dive_id != null && typeof slot.dive_id !== "string") {
      return { valid: false, error: `round_dives[${i}]: dive_id must be a uuid string or null` };
    }
    if (slot.height != null && slot.height !== "") {
      const h = Number(slot.height);
      if (!Number.isFinite(h) || h < 0 || h > 20) {
        return { valid: false, error: `round_dives[${i}]: height must be between 0 and 20 metres` };
      }
    }
  }
  // Round numbers must be contiguous 1..N (no gaps, since the
  // section/round-rules walker assumes this).
  for (let r = 1; r <= round_dives.length; r++) {
    if (!seen.has(r)) {
      return { valid: false, error: `round_dives missing round_number ${r}` };
    }
  }
  return { valid: true };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

// Valid event_format stages. Six values:
//   preliminary → semifinal → final         (standard chain)
//   super_final_h2h → super_final_semi
//                  → super_final_final      (Diving World Cup
//                                             Super Final 2026,
//                                             Appendix 3)
// 'final' is the default for standalone events. Module scope so
// the POST-create and PUT-update validators share one list and
// can't drift.
const SUPER_FINAL_FORMATS = ["super_final_h2h", "super_final_semi", "super_final_final"];
const ALLOWED_FORMATS = ["preliminary", "semifinal", "final", ...SUPER_FINAL_FORMATS];

module.exports = function createEventsRouter({
  pool,
  io,
  verifyToken,
  requireOrgAdmin,
  requireEventManager,
  sendEventStartedEmails,
  sendEventResultsEmails,
  activeDivers,
  meetHolds,
  // Optional: when supplied, the Completed-status cleanup
  // also drops the matching event_live_state row so the
  // table doesn't accumulate dead state.
  persistClearAll,
  // Optional. Used by the international-invite flow to notify
  // every org_admin of a newly-invited federation. Falls back
  // to a silent skip if the push engine isn't wired (the
  // notification row will simply not be created).
  push,
  // lib/middleware.js optionalAuth: decodes a valid JWT into
  // req.user (running the token-version / deleted_at /
  // suspended_at revocation checks) and treats anything else as
  // anonymous.
  optionalAuth,
  // Stripe module, needed by the deletion guard to retire
  // in-flight checkouts before cascade-deleting fee definitions.
  payments,
  // Club-hosted meets (migration 087), all optional. Without them
  // create/delete stay org_admin only.
  isMeetHostAdmin,
  isEventDelegate,
  requireTotpForPrivilegedRoles,
}) {
  if (!pool || !optionalAuth) {
    throw new Error("createEventsRouter requires { pool, optionalAuth, … }");
  }
  const router = express.Router();

  // org_admin, or admin of the club hosting the meet this is about. For
  // create that's body.meet_id (there's no event yet); for delete it's
  // the event's meet. Plain event_managers rows don't count here, being
  // asked to help run one event was never permission to delete it.
  function orgAdminOrMeetHost(meetIdOf) {
    if (!isMeetHostAdmin || !verifyToken) return requireOrgAdmin;
    return [
      (req, res, next) => verifyToken(req, res, async () => {
        if (req.user.is_system_admin || (req.user.org_roles || []).includes("org_admin")) return next();
        try {
          const meetId = await meetIdOf(req);
          if (meetId && await isMeetHostAdmin(meetId, req.user.id)) {
            req.viaHostClub = true;
            return next();
          }
        } catch (err) {
          console.error("[orgAdminOrMeetHost]", err.message);
          return res.status(500).json({ error: "Internal server error" });
        }
        res.status(403).json({ error: "Forbidden" });
      }),
      ...(requireTotpForPrivilegedRoles ? [requireTotpForPrivilegedRoles] : []),
    ];
  }
  const requireEventCreator = orgAdminOrMeetHost((req) => req.body?.meet_id);
  const requireEventDeleter = orgAdminOrMeetHost(async (req) => {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) return null;
    const r = await pool.query("SELECT meet_id FROM events WHERE id = $1", [req.params.id]);
    return r.rows[0]?.meet_id || null;
  });

  // Idempotency middleware (lib/idempotency.js). Applied to the
  // status-flip route below since that's a meet-time write the
  // outbox covers. Other writes in this router are pre-meet
  // setup (event create / edit / delete / advance / seed) and
  // stay on the legacy direct path. See DEC-01 and the
  // "online-only" classification in docs/offline-inventory.md.
  const { httpMiddleware: idem } = createIdempotency({ pool });

  async function notifyEventLive(event) {
    if (!push || typeof push.sendNotification !== "function" || !event?.id) return;
    try {
      const [judges, competitors, coaches] = await Promise.all([
        pool.query(
          `SELECT DISTINCT judge_id AS user_id
           FROM event_judges
           WHERE event_id = $1`,
          [event.id],
        ),
        pool.query(
          `SELECT DISTINCT competitor_id AS user_id
           FROM competitor_dive_lists
           WHERE event_id = $1
             AND withdrawn_at IS NULL
             AND is_reserve = FALSE`,
          [event.id],
        ),
        pool.query(
          `SELECT DISTINCT link.coach_id AS user_id
           FROM competitor_dive_lists cdl
           JOIN coach_diver_links link ON link.diver_id = cdl.competitor_id
           WHERE cdl.event_id = $1
             AND cdl.withdrawn_at IS NULL
             AND cdl.is_reserve = FALSE`,
          [event.id],
        ),
      ]);
      const judgeIds = judges.rows.map((r) => r.user_id).filter(Boolean);
      const competitorIds = competitors.rows.map((r) => r.user_id).filter(Boolean);
      const coachIds = coaches.rows.map((r) => r.user_id).filter(Boolean);

      await Promise.all([
        push.sendNotification(judgeIds, {
          category: "event_live",
          title: "Judging panel is live",
          body: event.name,
          data: { event_id: event.id, event_name: event.name, role: "judge" },
          action_url: `/judge?event=${event.id}`,
          ttl_seconds: 3600,
        }),
        push.sendNotification(competitorIds, {
          category: "event_live",
          title: "Your event is live",
          body: event.name,
          data: { event_id: event.id, event_name: event.name, role: "diver" },
          action_url: `/scoreboard/${event.id}`,
          ttl_seconds: 3600,
        }),
        push.sendNotification(coachIds, {
          category: "event_live",
          title: "Squad event is live",
          body: event.name,
          data: { event_id: event.id, event_name: event.name, role: "coach" },
          action_url: `/coach?event=${event.id}`,
          ttl_seconds: 3600,
        }),
      ]);
    } catch (err) {
      console.error("[Event Live Notify Error]", err.message);
    }
  }

  // -------------------------------------------------------------
  // GET /api/events: list events visible to the caller.
  //
  //   * anonymous   → Live/Completed only
  //   * sysadmin    → every event in every org
  //   * regular user → events in caller's org
  //
  // Optional query params:
  //   * status: comma-separated event_status values; narrows
  //     WITHIN the caller's visibility, never widens it (an
  //     anonymous caller asking for Upcoming gets [], not a leak).
  //   * limit: positive integer, capped at 500.
  //
  // 401-on-bad-JWT (rather than silent downgrade to public)
  // landed in Migration 021, if the caller sent a bad token they
  // meant to be authed, so the SPA needs the signal to prompt
  // re-login. optionalAuth leaves req.user unset for a bad token,
  // so the presence of an Authorization header is the signal; a
  // revoked / deleted / suspended session gets the same 401
  // (optionalAuth runs the token-version checks the old inline
  // jwt.verify peek skipped).
  // -------------------------------------------------------------
  router.get("/api/events", optionalAuth, async (req, res) => {
    try {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];
      if (token && !req.user) {
        return res.status(401).json({ error: "Token expired or invalid; please sign in again" });
      }

      // Values mirror init.sql's event_status enum.
      const EVENT_STATUSES = ["Upcoming", "Live", "Completed"];
      let statusFilter = null;
      if (req.query.status !== undefined) {
        statusFilter = String(req.query.status)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!statusFilter.length || statusFilter.some((s) => !EVENT_STATUSES.includes(s))) {
          return res.status(400).json({
            error: `status must be a comma-separated list of: ${EVENT_STATUSES.join(", ")}`,
          });
        }
      }
      let limit = null;
      if (req.query.limit !== undefined) {
        const n = Number(req.query.limit);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: "limit must be a positive integer" });
        }
        limit = Math.min(n, 500);
      }

      // participating_orgs_count > 0 → international event (the
      // SPA renders a globe chip and the federations modal
      // pre-loads the invited list). Subselect rather than LEFT
      // JOIN + GROUP BY so the rest of the query stays readable.
      const SELECT = `
        SELECT e.*, o.name AS org_name, o.country_code, o.slug AS org_slug,
               m.name AS meet_name, m.start_date AS meet_start_date,
               COALESCE(
                 (SELECT COUNT(*) FROM event_participating_orgs epo
                   WHERE epo.event_id = e.id),
                 0
               )::int AS participating_orgs_count
        FROM events e
        JOIN organisations o ON o.id = e.org_id
        LEFT JOIN meets m ON m.id = e.meet_id
      `;
      const where = [];
      const params = [];
      if (req.user?.is_system_admin) {
        // Sysadmin sees every event in every org, no scope clause needed.
      } else if (req.user) {
        // Show events the caller's org hosts OR events that
        // explicitly invited the caller's org via
        // event_participating_orgs. The EXISTS subquery is
        // short-circuited by the OR, so domestic-only orgs pay
        // no extra cost. Sysadmin already bypassed above.
        params.push(req.user.org_id);
        const p = `$${params.length}`;
        where.push(`(e.org_id = ${p}
                OR EXISTS (
                  SELECT 1 FROM event_participating_orgs epo
                   WHERE epo.event_id = e.id AND epo.org_id = ${p}
                ))`);
      } else {
        where.push(`e.status IN ('Live','Completed')`);
        where.push(`COALESCE(e.is_rehearsal, FALSE) = FALSE`);
      }
      if (statusFilter) {
        params.push(statusFilter);
        where.push(`e.status = ANY($${params.length}::event_status[])`);
      }
      let sql = `${SELECT}
           ${where.length ? `WHERE ${where.join("\n             AND ")}` : ""}
           ORDER BY e.created_at DESC`;
      if (limit != null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
      }
      const result = await pool.query(sql, params);
      res.json(result.rows);
    } catch (err) {
      console.error("[Events List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/events/:id/readiness", requireEventManager(), async (req, res) => {
    try {
      const readiness = await getEventReadiness(pool, {
        eventId: req.params.id,
        isSystemAdmin: !!req.user.is_system_admin,
        orgId: req.user.org_id,
      });
      if (!readiness) return res.status(404).json({ error: "Event not found" });
      res.json(readiness);
    } catch (err) {
      console.error("[Event Readiness Error]", err.message);
      res.status(500).json({ error: "Failed to load event readiness" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events: create an event in caller's org.
  //
  // org_admin only (no event_managers fallback becuase the event
  // doesn't exist yet, there's no row to be a manager of), or the
  // admin of the club hosting body.meet_id.
  // -------------------------------------------------------------
  router.post("/api/events", requireEventCreator, async (req, res) => {
    const {
      name, gender, number_of_judges, total_rounds, height, event_type, meet_id,
      age_group, scheduled_at, event_format, parent_event_id, advance_count,
      dd_limit_rounds, dd_limit_value,
      // Migration 020: optional registration deadline.
      entries_close_at,
      // Migration 031:
      //   enforce_referee_signoff: gate the simple manager-attests
      //                             sign-off path; force push or
      //                             credential entry by the named
      //                             referee.
      //   is_mixed_height:          multi-board event; the picker
      //                             widens to the full directory.
      enforce_referee_signoff, is_mixed_height,
      // Workflow: rehearsal events let meet staff dry-run the
      // entire scoring flow without public archive, email, or
      // record side effects.
      is_rehearsal,
      // Migration 038: structured round-by-round dive-list rules.
      // Optional, when null the legacy (dd_limit_rounds,
      // dd_limit_value) flat constraint applies. See
      // lib/round-rules.js for the shape + validator.
      round_rules,
      // Migration 039: operator-prescribed round dives. Array of
      // { round_number, dive_id|null, height|null }. Length, when
      // present, becomes the canonical total_rounds and overrides
      // any total_rounds field in the body.
      round_dives,
    } = req.body || {};

    // Validate round_dives shape + derive effective total_rounds.
    const rdCheck = validateRoundDivesShape(round_dives);
    if (!rdCheck.valid) {
      return res.status(400).json({ error: rdCheck.error });
    }
    const effectiveTotalRounds =
      Array.isArray(round_dives) && round_dives.length
        ? round_dives.length
        : (total_rounds || 6);

    // Validate round_rules shape if supplied, use the EFFECTIVE
    // total so the section-sum check sees the actual round count
    // when round_dives drove it.
    if (round_rules != null) {
      const rrCheck = require("../../lib/round-rules")
        .validateRoundRules(round_rules, effectiveTotalRounds);
      if (!rrCheck.valid) {
        return res.status(400).json({ error: rrCheck.error });
      }
    }

    // Synchronised pairs use exec/sync judge groups, so only panel
    // sizes with a defined grouping are accepted.
    const type = event_type || "individual";
    if (type === "synchro_pair" && ![7, 9, 11].includes(number_of_judges)) {
      return res.status(400).json({
        error: "Synchronised pair events require 7, 9 or 11 judges",
      });
    }
    // Validate event_format, see ALLOWED_FORMATS at module scope.
    const fmt = event_format || "final";
    if (!ALLOWED_FORMATS.includes(fmt)) {
      return res
        .status(400)
        .json({ error: `event_format must be one of: ${ALLOWED_FORMATS.join(', ')}` });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Validate meet_id if provided, must belong to the same org.
      if (meet_id) {
        const m = await client.query(
          "SELECT id FROM meets WHERE id = $1 AND org_id = $2",
          [meet_id, req.user.org_id],
        );
        if (!m.rows.length) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Meet not found in this organisation" });
        }
      }
      // Validate parent_event_id if this event is downstream of
      // another stage. Allowed parent shapes:
      //   semifinal         → parent must be a 'preliminary'
      //   final             → parent may be a 'preliminary' OR a 'semifinal'
      //                        OR a 'super_final_final' (allowing a
      //                        Stop-1 prelim/semi/final to feed the
      //                        Super Final H2H seeding via the
      //                        super_final_h2h branch below).
      //   preliminary       → must NOT have a parent (it's the source)
      //   super_final_h2h   → parent is the Stop-1 final (event_format
      //                        'final' or 'preliminary', the operator
      //                        picks whichever stage produced the
      //                        12-diver ranking).
      //   super_final_semi  → parent must be a 'super_final_h2h'
      //   super_final_final → parent must be a 'super_final_semi'
      if (parent_event_id) {
        if (fmt === "preliminary") {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Preliminary events can't have a parent stage" });
        }
        const p = await client.query(
          "SELECT id, event_format, org_id FROM events WHERE id = $1",
          [parent_event_id],
        );
        if (!p.rows.length || p.rows[0].org_id !== req.user.org_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Parent event not found in this org" });
        }
        // A club admin chains stages within their own events, not off a
        // neighbouring club's.
        if (req.viaHostClub && !(isEventDelegate && await isEventDelegate(parent_event_id, req.user.id))) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Parent event not found in this org" });
        }
        const parentFmt = p.rows[0].event_format;
        const allowedParents =
          fmt === "semifinal"          ? ["preliminary"]
          : fmt === "final"            ? ["preliminary", "semifinal"]
          : fmt === "super_final_h2h"  ? ["preliminary", "semifinal", "final"]
          : fmt === "super_final_semi" ? ["super_final_h2h"]
          : fmt === "super_final_final"? ["super_final_semi"]
          : [];
        if (!allowedParents.includes(parentFmt)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `A ${fmt} can only feed from ${allowedParents.join(' or ')} (got '${parentFmt}')`,
          });
        }
      }
      const evRes = await client.query(
        `INSERT INTO events
           (name, gender, age_group, number_of_judges, total_rounds, height,
            event_type, event_format, parent_event_id, advance_count,
            dd_limit_rounds, dd_limit_value, scheduled_at, entries_close_at,
            org_id, meet_id,
            enforce_referee_signoff, is_mixed_height, is_rehearsal,
            round_rules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [
          name,
          gender,
          age_group || null,
          number_of_judges || 5,
          effectiveTotalRounds,
          // For mixed-board events the column is informational
          // only, store NULL so any "filter dives by height"
          // logic that didn't get the is_mixed_height memo just
          // returns nothing rather than the wrong subset.
          is_mixed_height ? null : (height || null),
          type,
          fmt,
          parent_event_id || null,
          advance_count || 12,
          dd_limit_rounds || 0,
          dd_limit_value || null,
          scheduled_at || null,
          entries_close_at || null,
          req.user.org_id,
          meet_id || null,
          !!enforce_referee_signoff,
          !!is_mixed_height,
          !!is_rehearsal,
          round_rules ? JSON.stringify(round_rules) : null,
        ],
      );
      const event = evRes.rows[0];
      // Persist any operator-prescribed round dives (migration 039).
      if (Array.isArray(round_dives)) await insertRoundDives(client, event.id, round_dives);
      // Creator becomes the first event manager automatically.
      await client.query(
        "INSERT INTO event_managers (event_id, user_id, added_by) VALUES ($1,$2,$2)",
        [event.id, req.user.id],
      );
      // Audit the create. metadata captures the headline config
      // an admin would want to see when reviewing later. The full
      // event row is available via /events/:id if more detail
      // is needed.
      await recordAudit(client, {
        ...auditFromReq(req),
        org_id:      req.user.org_id,
        entity_type: "event",
        entity_id:   event.id,
        entity_name: event.name,
        action:      "event.created",
        metadata: {
          event_type: event.event_type,
          height:     event.height,
          number_of_judges: event.number_of_judges,
          total_rounds:     event.total_rounds,
          gender:     event.gender,
          age_group:  event.age_group,
          meet_id:    event.meet_id,
          is_rehearsal: event.is_rehearsal,
        },
      });
      await client.query("COMMIT");
      res.status(201).json(event);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Create Event Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // PUT /api/events/:id: partial update. Every COALESCE-able
  // field is treated as "leave alone if not sent". The
  // entries_close_at column uses tri-state semantics (undefined =
  // untouched, null/'' = clear, string = set) since "no value
  // sent" and "explicitly cleared" mean different things on a
  // nullable timestamp.
  // -------------------------------------------------------------
  router.put("/api/events/:id", requireEventManager(), async (req, res) => {
    const body = req.body || {};
    const {
      name, gender, number_of_judges, total_rounds, height, event_type,
      age_group, scheduled_at, event_format, parent_event_id, advance_count,
      dd_limit_rounds, dd_limit_value,
      entries_close_at,
      // Migration 031, see POST handler for the rationale.
      enforce_referee_signoff, is_mixed_height, is_rehearsal,
      // Migration 038: structured round rules. Tri-state:
      //   undefined → leave untouched
      //   null      → clear, fall back to legacy dd_limit_*
      //   {sections}→ set
      round_rules,
      // Migration 039: operator-prescribed round dives. Tri-state:
      //   undefined → leave untouched
      //   []        → clear all prescribed dives for this event
      //   [...slots]→ replace the existing rows
      round_dives,
    } = body;
    let currentEvent;
    try {
      const current = await pool.query(
        "SELECT event_type, number_of_judges, total_rounds, parent_event_id FROM events WHERE id = $1",
        [req.params.id],
      );
      currentEvent = current.rows[0];
    } catch (err) {
      console.error("[Update Event Current Read Error]", err.message);
      return res.status(500).json({ error: "Internal server error" });
    }
    const nextEventType = hasOwn(body, "event_type")
      ? event_type
      : currentEvent?.event_type;
    const nextJudgeCount = hasOwn(body, "number_of_judges")
      ? Number(number_of_judges)
      : Number(currentEvent?.number_of_judges);
    if (nextEventType === "synchro_pair" && ![7, 9, 11].includes(nextJudgeCount)) {
      return res.status(400).json({
        error: "Synchronised pair events require 7, 9 or 11 judges",
      });
    }
    if (event_format && !ALLOWED_FORMATS.includes(event_format)) {
      return res
        .status(400)
        .json({ error: `event_format must be one of: ${ALLOWED_FORMATS.join(', ')}` });
    }
    // Validate round_dives shape if supplied. When round_dives is
    // a non-empty array, it becomes the canonical total_rounds.
    const rdShape = validateRoundDivesShape(round_dives);
    if (!rdShape.valid) {
      return res.status(400).json({ error: rdShape.error });
    }
    const effectiveTotalRoundsForRules =
      Array.isArray(round_dives) && round_dives.length
        ? round_dives.length
        : (hasOwn(body, "total_rounds") ? total_rounds : currentEvent?.total_rounds);
    if (round_rules != null) {
      const rrCheck = require("../../lib/round-rules")
        .validateRoundRules(round_rules, effectiveTotalRoundsForRules);
      if (!rrCheck.valid) {
        return res.status(400).json({ error: rrCheck.error });
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // AUDIT FIX (Medium-1): when parent_event_id is being set or
      // changed, confirm the parent is in the caller's org. POST
      // /api/events already does this (the parent_event_id block in
      // its stage-chain validation); the PUT
      // handler had dropped the check. Without it, an org_admin in
      // Org A could PUT a child event with parent_event_id pointing
      // at any Org B event whose UUID they know, chaining through
      // the Super Final seed endpoints would then pull Org B's
      // ranked divers into Org A's H2H roster and fire push
      // notifications at Org B divers. Sysadmin bypass intact via
      // the is_system_admin flag.
      if (parent_event_id !== undefined && parent_event_id !== null) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(parent_event_id))
            || parent_event_id === req.params.id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Parent event not found in this org" });
        }
        const p = await client.query(
          "SELECT id, org_id FROM events WHERE id = $1",
          [parent_event_id],
        );
        if (
          !p.rows.length ||
          p.rows[0].org_id !== req.event.org_id ||
          (!req.user.is_system_admin && p.rows[0].org_id !== req.user.org_id)
        ) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Parent event not found in this org" });
        }
        // Same rule the POST applies. Everyone past requireEventManager
        // who isn't an org admin is here as a delegate of THIS event
        // (event_managers row, or admin of the club / region hosting its
        // meet), and that says nothing about the parent. childEvent()
        // hands advance/seed the oldest child, so pointing an older event
        // at a neighbour's prelim would hijack their final's qualifiers.
        // An unchanged parent is left alone so a plain edit still saves.
        const orgAdminHere = req.user.is_system_admin
          || ((req.user.org_roles || []).includes("org_admin") && req.event.org_id === req.user.org_id);
        const changing = parent_event_id !== currentEvent?.parent_event_id;
        if (!orgAdminHere && changing
            && !(isEventDelegate && await isEventDelegate(parent_event_id, req.user.id))) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Parent event not found in this org" });
        }
      }
      // ---- SET clause assembly (field-descriptor style, same
      // idiom as PUT /api/blocks/:id in routes/sessions.js). Each
      // field keeps the exact update semantics of the old
      // 31-positional-param statement:
      //   * truthy-set fields (the old COALESCE($n, col) columns):
      //     a truthy body value sets, anything falsy leaves alone.
      //   * key-presence tri-state fields (the old CASE WHEN
      //     $untouched columns): key absent → leave alone,
      //     null → clear, value → set.
      const sets = [];
      const args = [];
      const addSet = (column, value, cast = "") => {
        args.push(value);
        sets.push(`${column} = $${args.length}${cast}`);
      };

      // Truthy-set fields. "" / 0 / null all mean "leave alone".
      if (name) addSet("name", name);
      if (gender) addSet("gender", gender);
      if (number_of_judges) addSet("number_of_judges", number_of_judges);
      if (event_type) addSet("event_type", event_type);
      if (event_format) addSet("event_format", event_format);
      if (advance_count) addSet("advance_count", advance_count);
      // total_rounds: when round_dives is a non-empty array its
      // length wins; an empty array (`[]` = clear) reverts to the
      // body's total_rounds (or untouched if neither is set).
      // Falsy total_rounds (0 / null) also leaves the column alone.
      const totalRoundsForUpdate =
        Array.isArray(round_dives) && round_dives.length
          ? round_dives.length
          : (hasOwn(body, "total_rounds") ? (total_rounds || null) : null);
      if (totalRoundsForUpdate != null) addSet("total_rounds", totalRoundsForUpdate);
      // dd_limit_rounds sets on any non-nullish value, 0 is a
      // meaningful "no limit-rounds" value here, unlike the truthy
      // fields above.
      if (dd_limit_rounds != null) addSet("dd_limit_rounds", dd_limit_rounds);

      // height: flipping is_mixed_height on force-clears the column
      // (informational-only for mixed-board events, see the POST
      // handler); otherwise key-presence tri-state with "" → NULL.
      const heightClearedByMixed = hasOwn(body, "is_mixed_height") && !!is_mixed_height;
      if (heightClearedByMixed) {
        addSet("height", null, "::board_height");
      } else if (hasOwn(body, "height")) {
        addSet("height", height || null, "::board_height");
      }

      // Key-presence tri-state fields: absent → untouched,
      // null → clear, value → set.
      if (hasOwn(body, "age_group")) addSet("age_group", age_group ?? null);
      if (hasOwn(body, "parent_event_id")) addSet("parent_event_id", parent_event_id ?? null, "::uuid");
      if (hasOwn(body, "dd_limit_value")) addSet("dd_limit_value", dd_limit_value ?? null, "::numeric");
      if (hasOwn(body, "scheduled_at")) addSet("scheduled_at", scheduled_at ?? null, "::timestamptz");
      // entries_close_at additionally treats "" as clear, "no
      // value sent" and "explicitly cleared" mean different things
      // on a nullable timestamp.
      if (entries_close_at !== undefined) {
        addSet("entries_close_at", entries_close_at || null, "::timestamptz");
      }

      // Boolean flags: undefined = leave untouched, anything else =
      // set to its truthiness, since a partial PUT body must not
      // flip a flag back to its default.
      if (enforce_referee_signoff !== undefined) {
        addSet("enforce_referee_signoff", !!enforce_referee_signoff);
      }
      if (is_mixed_height !== undefined) addSet("is_mixed_height", !!is_mixed_height);
      if (is_rehearsal !== undefined) addSet("is_rehearsal", !!is_rehearsal);

      // round_rules tri-state: undefined → leave alone, null →
      // clear (fall back to legacy dd_limit_*), {sections} →
      // JSON-stringify and set.
      if (round_rules !== undefined) {
        addSet(
          "round_rules",
          round_rules === null ? null : JSON.stringify(round_rules),
          "::jsonb",
        );
      }

      let r;
      if (sets.length) {
        args.push(req.params.id, !!req.user.is_system_admin, req.user.org_id);
        r = await client.query(
          `UPDATE events SET ${sets.join(", ")}
            WHERE id = $${args.length - 2}
              AND ($${args.length - 1}::boolean OR org_id = $${args.length})
            RETURNING *`,
          args,
        );
      } else {
        // Nothing to update (the old statement still ran with every
        // field on its "leave alone" branch), preserve the
        // row-returning response and the 404 on a cross-org id.
        r = await client.query(
          "SELECT * FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
          [req.params.id, !!req.user.is_system_admin, req.user.org_id],
        );
      }
      if (!r.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Event not found" });
      }

      // Replace prescribed round_dives if the caller sent the key.
      // undefined → leave alone; [] → clear; non-empty → replace.
      if (round_dives !== undefined) {
        await client.query(
          "DELETE FROM event_round_dives WHERE event_id = $1",
          [req.params.id],
        );
        if (Array.isArray(round_dives)) await insertRoundDives(client, req.params.id, round_dives);
      }
      await client.query("COMMIT");
      res.json(r.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Update Event Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // DELETE /api/events/:id: org_admin only. CASCADE down to
  // dive lists, judges, scores etc. via FKs in init.sql.
  // -------------------------------------------------------------
  router.delete("/api/events/:id", requireEventDeleter, async (req, res) => {
    try {
      // Read the row first so the audit row carries the
      // (post-delete-orphaned) name + org. RETURNING * inside the
      // DELETE itself would also work but a separate SELECT is
      // clearer for readers.
      const prior = await pool.query(
        "SELECT id, name, org_id, status FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!prior.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const ev = prior.rows[0];
      // Refuse delete once any score has landed. The event's audit
      // trail and result history are evidentiary; deleting the row
      // would orphan score_audit rows (SET NULL post-035) and lose
      // the parent context. Sysadmins can still force the delete by
      // passing ?force=1, recorded in the audit metadata.
      const force = req.query.force === "1" || req.query.force === "true";
      const scoreCount = await pool.query(
        "SELECT COUNT(*)::int AS n FROM scores WHERE event_id = $1",
        [ev.id],
      );
      if (scoreCount.rows[0].n > 0 && !(force && req.user.is_system_admin)) {
        return res.status(409).json({
          error: `Refusing to delete: event has ${scoreCount.rows[0].n} recorded scores. Cancel or finalise the event instead.`,
          score_count: scoreCount.rows[0].n,
        });
      }
      // Money guard: refuse deletion when paid payments reference
      // this event, refund or cancel them first. Mirrors the class
      // deletion pattern (routes/classes.js).
      const paidCount = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM payments
          WHERE event_id = $1 AND status IN ('paid', 'partially_refunded')`,
        [ev.id],
      )).rows[0].n;
      if (paidCount > 0) {
        return res.status(409).json({
          error: `This event has ${paidCount} paid payment(s) — refund or cancel them before deleting.`,
          paid_count: paidCount,
        });
      }
      // Retire any in-flight checkouts so a payer can't complete
      // payment for an event that's about to be deleted.
      const pendingPayments = (await pool.query(
        `SELECT id, status, stripe_checkout_session FROM payments
          WHERE event_id = $1 AND status = 'pending'`,
        [ev.id],
      )).rows;
      for (const p of pendingPayments) {
        const outcome = await retirePendingPayment({ pool, payments, logger: console }, p);
        if (outcome === "paid") {
          return res.status(409).json({
            error: "A payment for this event was just completed — refresh and handle it before deleting.",
          });
        }
        if (outcome === "unavailable") {
          return res.status(503).json({
            error: "Couldn't verify an in-flight payment with Stripe — please try again.",
          });
        }
      }
      await pool.query("DELETE FROM events WHERE id = $1", [ev.id]);
      // A Live/Completed event may sit in the cached public
      // archive listing for up to 60s, bust it so the deleted
      // event drops out immediately.
      archiveCache.invalidate();
      // Audit. status preserved in metadata so a sysadmin
      // investigation can spot "this event was deleted while
      // it was Live" patterns.
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id:      ev.org_id,
        entity_type: "event",
        entity_id:   ev.id,
        entity_name: ev.name,
        action:      "event.deleted",
        metadata: { previous_status: ev.status },
      });
      res.json({ message: "Event deleted" });
    } catch (err) {
      console.error("[Delete Event Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PUT /api/events/:id/status: Upcoming → Live → Completed.
  // Fires notifications on the meaningful transitions and frees
  // the in-memory state when an event finalises.
  // -------------------------------------------------------------
  router.put("/api/events/:id/status", requireEventManager(), idem("event_status_flip"), async (req, res) => {
    const { status } = req.body || {};
    const validStatuses = ["Upcoming", "Live", "Completed"];
    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({ error: `Status must be one of: ${validStatuses.join(", ")}` });
    }
    try {
      // Atomic read-prev + flip in ONE statement. The previous
      // two-query version let two concurrent flips both observe
      // the same previousStatus and double-fire emails / push /
      // audit. The FOR UPDATE subquery serialises racers; the
      // loser re-evaluates prev_status against the committed row,
      // matches zero rows, and skips every transition side effect.
      const r = await pool.query(
        `UPDATE events SET status = $1
           FROM (SELECT id, status AS prev_status FROM events
                  WHERE id = $2 AND ($3::boolean OR org_id = $4)
                    FOR UPDATE) prior
          WHERE events.id = prior.id AND prior.prev_status <> $1
          RETURNING events.*, prior.prev_status`,
        [status, req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );

      let event, previousStatus;
      if (r.rows.length) {
        ({ prev_status: previousStatus, ...event } = r.rows[0]);
      } else {
        // Zero rows = the event isn't visible to the caller (404)
        // OR it's already at the target status. The no-op case
        // preserves the old response shape, return the row and
        // skip the transition side effects below (previousStatus
        // === status keeps every guard false).
        const cur = await pool.query(
          "SELECT * FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
          [req.params.id, !!req.user.is_system_admin, req.user.org_id],
        );
        if (!cur.rows.length)
          return res.status(404).json({ error: "Event not found" });
        event = cur.rows[0];
        previousStatus = event.status;
      }

      // Notify competitors on the meaningful transitions.
      // Best-effort, never blocks the response.
      if (previousStatus !== status) {
        // The public archive listing caches event statuses for
        // 60s, and the SPA picks the live-vs-recap scoreboard
        // layout from that field, so we bust it so a spectator
        // deep-linking right after this flip can't get the wrong
        // page mode.
        archiveCache.invalidate();

        if (!event.is_rehearsal) {
          if (status === "Live")      sendEventStartedEmails(event).catch(() => {});
          if (status === "Completed") sendEventResultsEmails(event).catch(() => {});
          if (status === "Live")      notifyEventLive(event).catch(() => {});
        }

        // Real-time push for the dashboard pulse strip. Emit
        // globally so any connected dashboard tab can refetch
        // its pulse data and update the LIVE / UPCOMING /
        // COMPLETED counts immediately. Cheap broadcast (no
        // sensitive data); recipients filter by what they're
        // authorised to see via their existing API gates.
        if (io && typeof io.emit === "function") {
          try {
            io.emit("event_status_changed", {
              event_id: event.id,
              org_id:   event.org_id,
              from:     previousStatus,
              to:       status,
            });
          } catch (_e) { /* ignore, best-effort */ }
        }

        // Audit the status flip. Specific actions for the
        // meaningful transitions ('event.started',
        // 'event.finalised', 'event.unfinalised') so the audit
        // view can colour-code or filter on them. Falls back
        // to a generic 'event.status_changed' for the unusual
        // hops (e.g. Live → Upcoming for a workflow re-do).
        let action = "event.status_changed";
        if (previousStatus === "Upcoming" && status === "Live")      action = "event.started";
        else if (previousStatus === "Live"     && status === "Completed") action = "event.finalised";
        else if (previousStatus === "Completed" && status === "Live") action = "event.unfinalised";
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id:      event.org_id,
          entity_type: "event",
          entity_id:   event.id,
          entity_name: event.name,
          action,
          metadata: { from: previousStatus, to: status },
        });
      }

      // Free up the in-memory state for finished events.
      // activeDivers and meetHolds are keyed by event_id and
      // would otherwise accumulate as meets pile up. Also
      // clear the persisted row in event_live_state so a
      // restart doesn't rehydrate dead state. Drop the venue
      // bridge sequence counter for the same reason, otherwise
      // the per-event Map grows unbounded over a meet-week.
      if (status === "Completed") {
        delete activeDivers[event.id];
        delete meetHolds[event.id];
        if (typeof persistClearAll === "function") {
          persistClearAll(event.id);
        }
        try {
          require("../../lib/venue-state").pruneSequenceForEvent(event.id);
        } catch (_e) { /* best-effort cleanup */ }
        // Drop the coach-alerts dedupe entry too, otherwise the
        // per-process Map would accumulate stale (event_id → key)
        // entries across a meet-week. Best-effort, never throws.
        try {
          require("../../lib/coach-alerts").pruneCompletedEvent(event.id);
        } catch (_e) { /* best-effort cleanup */ }
      }

      // ---------------------------------------------------------
      // Phase 4: session-scheduler bookkeeping + live re-flow.
      //
      // On Upcoming → Live: stamp actual_start_at on the matching
      //   schedule_block row (if any) so the post-meet debrief can
      //   diff planned vs observed. Best-effort and silent on
      //   no-match meets (older meets pre-scheduler, or the
      //   operator never put this event on a schedule).
      //
      // On any → Completed: stamp actual_end_at + build the reflow
      //   proposal. The proposal is returned alongside the event
      //   row as `reflow` (or null when the delta is below the
      //   noise floor, the event ran short, or there's no matching
      //   schedule block). The Control Room reads it and surfaces
      //   the modal.
      //
      // Wrapped in try/catch so a scheduler issue NEVER blocks the
      // status flip from succeeding, the operator's finalise
      // action is the load-bearing thing here. A failed reflow
      // just means we ship `event` without `reflow` and the
      // operator can use the manual editor in the scheduler view.
      // ---------------------------------------------------------
      let reflow = null;
      if (previousStatus !== status) {
        try {
          if (status === "Live") {
            await stampActualStart(pool, event.id, new Date());
          } else if (status === "Completed") {
            reflow = await buildReflowProposal(pool, event.id, new Date());
          }
        } catch (reflowErr) {
          // Don't let a scheduler-side failure (missing tables on
          // pre-049 deploys, transient pool issue) bubble up as a
          // 500, the status flip already committed.
          console.error("[Reflow Bookkeeping Error]", reflowErr.message);
        }
      }

      res.json({ ...event, reflow });
    } catch (err) {
      console.error("[Status Update Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // GET /api/events/:id/round-dives: operator-prescribed round
  // dives for a single event (migration 039). Returned as an
  // ordered array enriched with the dive's directory fields so
  // the diver portal can render the locked rows without a second
  // round-trip. Empty array when no rows exist.
  //
  // Public for Live/Completed events; authed scope for Upcoming
  // (mirrors the GET /api/events visibility contract, operators
  // shouldn't have their pre-meet bulletin leaked).
  // -------------------------------------------------------------
  router.get("/api/events/:id/round-dives", optionalAuth, async (req, res) => {
    try {
      // optionalAuth: a bad/revoked/suspended token reads as
      // anonymous, same floor as the old inline peek, but the
      // token-version / deleted_at / suspended_at checks now apply.
      const callerOrgId = req.user?.org_id || null;
      const callerIsSys = !!req.user?.is_system_admin;
      const ev = await pool.query(
        "SELECT org_id, status FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const evRow = ev.rows[0];
      const isAuthScope =
        callerIsSys || (callerOrgId && callerOrgId === evRow.org_id);
      if (!isAuthScope && !["Live", "Completed"].includes(evRow.status)) {
        return res.status(404).json({ error: "Event not found" });
      }
      const rows = await pool.query(
        `SELECT erd.round_number, erd.dive_id, erd.height,
                d.dive_code, d.position, d.dd, d.description,
                d.height AS dive_height
           FROM event_round_dives erd
           LEFT JOIN dive_directory d ON d.id = erd.dive_id
          WHERE erd.event_id = $1
          ORDER BY erd.round_number ASC`,
        [req.params.id],
      );
      res.json(rows.rows);
    } catch (err) {
      console.error("[Round Dives Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // International participation (participating orgs, invites,
  // eligible divers) is in routes/events/participation.js.
  router.use(require("./participation")({ pool, push, optionalAuth, requireOrgAdmin, verifyToken }));

  // -------------------------------------------------------------
  // Stage progression: prelim → semi → final.
  //
  //   GET  /api/events/:id/advance/preview
  //   POST /api/events/:id/advance
  //
  // :id is the PARENT event (the prelim or semifinal). The child
  // event is the one whose `parent_event_id` points at :id.
  //
  // Preview returns the WA tie-break ranking of the parent's
  // divers so the modal can show "who would advance" before the
  // operator commits.
  //
  // POST commits: it copies each chosen diver's per-round dives
  // into the child event's competitor_dive_lists, sets is_reserve
  // on the trailing N reserves, and assigns display_order per the
  // chosen mode:
  //
  //   'inherit': copy the parent's display_order, drop non-
  //               progressors, re-number 1..N (default for semi).
  //   'reverse': top diver dives LAST (default for finals).
  //   'random':  randomise the primaries.
  //
  // Reserves get is_reserve=true + reserve_position 1..M and no
  // display_order. The Control Room can later promote a reserve
  // (flipping the flag + assigning the next open display_order)
  // when a primary withdraws.
  // -------------------------------------------------------------
  async function rankedDiversForAdvance(client, parentEventId) {
    // Ranks divers by cumulative total with World Aquatics Art 4.1.5
    // shared-place ties (equal totals share a rank). Returns one row
    // per diver with their final cumulative rank, dive_id by round,
    // and display_order from the parent event so the 'inherit'
    // dive-order mode can carry it forward. The advance cut-off keeps
    // every diver sharing the boundary rank (WC §1.5.1: all tied
    // divers advance).
    const r = await client.query(
      `WITH ${perDivePointsCte({
         name:        "dive_totals",
         pointsAlias: "round_total",
       })},
       cumulative AS (
         SELECT competitor_id,
                SUM(round_total) AS total
         FROM dive_totals
         GROUP BY competitor_id
       ),
       ranked AS (
         SELECT competitor_id, total,
                RANK() OVER (ORDER BY total DESC)::int AS rnk
         FROM cumulative
       )
       SELECT r.competitor_id, r.total, r.rnk,
              u.full_name, u.username,
              MIN(cdl.display_order) AS parent_display_order,
              array_agg(json_build_object(
                'round_number', cdl.round_number,
                'dive_id',      cdl.dive_id
              ) ORDER BY cdl.round_number) FILTER (WHERE cdl.dive_id IS NOT NULL) AS dives
         FROM ranked r
         JOIN users u ON u.id = r.competitor_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = $1
          AND cdl.competitor_id = r.competitor_id
          AND cdl.withdrawn_at IS NULL
        GROUP BY r.competitor_id, r.total, r.rnk, u.full_name, u.username
        ORDER BY r.rnk ASC, u.full_name ASC`,
      [parentEventId],
    );
    return r.rows;
  }

  // Look up the child event of :id, the next stage that points
  // back at us via parent_event_id. Returns null if none exists.
  async function childEvent(client, parentEventId) {
    const r = await client.query(
      `SELECT id, event_format, total_rounds, status
         FROM events
        WHERE parent_event_id = $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [parentEventId],
    );
    return r.rows[0] || null;
  }

  router.get(
    "/api/events/:id/advance/preview",
    requireEventManager(),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const parent = await client.query(
          "SELECT id, event_format, status, advance_count, total_rounds FROM events WHERE id = $1",
          [req.params.id],
        );
        if (!parent.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        const ev = parent.rows[0];
        if (!["preliminary", "semifinal"].includes(ev.event_format)) {
          return res.status(400).json({ error: "Only preliminary or semifinal events advance" });
        }
        const child = await childEvent(client, ev.id);
        const ranked = await rankedDiversForAdvance(client, ev.id);
        res.json({
          parent: {
            id: ev.id,
            format: ev.event_format,
            status: ev.status,
            total_rounds: ev.total_rounds,
            advance_count: ev.advance_count,
          },
          child: child
            ? { id: child.id, format: child.event_format, total_rounds: child.total_rounds, status: child.status }
            : null,
          ranked,
        });
      } catch (err) {
        console.error("[Advance Preview Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  router.post(
    "/api/events/:id/advance",
    requireEventManager(),
    async (req, res) => {
      const {
        top_n,
        reserves = 0,
        dive_order, // 'inherit' | 'reverse' | 'random'
        // WA Article 6.7.3 (change of dives): a changed list has to be
        // in no later than 30 min after the end of the previous stage.
        // Configurable per-advance, 0 = no auto-lock (operator wants
        // no time pressure).
        lock_minutes = 30,
      } = req.body || {};
      const topN = parseInt(top_n);
      const resN = parseInt(reserves) || 0;
      const lockMin = parseLockMinutes(lock_minutes);
      if (!Number.isInteger(topN) || topN < 1) {
        return res.status(400).json({ error: "top_n must be a positive integer" });
      }
      if (resN < 0 || resN > 50) {
        return res.status(400).json({ error: "reserves must be between 0 and 50" });
      }
      const orderMode = ['inherit', 'reverse', 'random'].includes(dive_order)
        ? dive_order
        : 'inherit';

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const parentRes = await client.query(
          "SELECT id, event_format, status, total_rounds FROM events WHERE id = $1",
          [req.params.id],
        );
        if (!parentRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        const parent = parentRes.rows[0];
        if (!['preliminary', 'semifinal'].includes(parent.event_format)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Only preliminary or semifinal events advance" });
        }
        if (parent.status !== 'Completed') {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Parent event must be Completed before advancing divers",
          });
        }
        const child = await childEvent(client, parent.id);
        if (!child) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "No downstream event linked to this one — create the next stage first",
          });
        }
        if (child.status !== 'Upcoming') {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Child event must be Upcoming to seed its roster",
          });
        }
        const ranked = await rankedDiversForAdvance(client, parent.id);
        if (!ranked.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Parent event has no scored divers to advance",
          });
        }
        // Diving World Cup §1.5.1 (and WA Art 4.1.9.3): when a tie
        // straddles the advance cut-off, ALL tied divers advance, so
        // the primary count can exceed top_n. `ranked` is RANK()-ordered
        // on total (equal totals share a rank), so we keep every diver
        // whose rank is at or better than the diver on the boundary.
        const boundaryRank = ranked[topN - 1]?.rnk ?? null;
        // rnk comes back as a number (RANK()::int), but coerce
        // defensively so the comparison can never become a string
        // compare ("2" <= "13" is false and would drop tied divers).
        const primaries = boundaryRank == null
          ? ranked.slice(0, topN)
          : ranked.filter((r) => Number(r.rnk) <= Number(boundaryRank));
        // No boundary means the field is smaller than top_n and every
        // diver is already a primary, so there's nobody left to hold in
        // reserve. Filtering on a null boundary used to pick the same
        // divers again and the second insert hit the unique key (500).
        const reserveRows = boundaryRank == null
          ? []
          : ranked.filter((r) => Number(r.rnk) > Number(boundaryRank)).slice(0, resN);

        // Compute display_order for primaries per the chosen mode.
        // 'inherit': copy parent_display_order, then re-number 1..N
        //              so gaps from non-progressors close up.
        // 'reverse': top diver dives last → rank 1 gets order topN,
        //              rank topN gets order 1.
        // 'random':   Fisher-Yates a copy of [1..topN] and assign.
        const primaryOrder = primaries.map((r, i) => ({ idx: i, sort: r.parent_display_order ?? r.rnk }));
        if (orderMode === 'inherit') {
          primaryOrder.sort((a, b) =>
            (a.sort == null ? Infinity : a.sort) - (b.sort == null ? Infinity : b.sort),
          );
        } else if (orderMode === 'reverse') {
          // Already in rank order ascending, so reverse it: worst dives first, top last.
          primaryOrder.reverse();
        } else if (orderMode === 'random') {
          for (let i = primaryOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [primaryOrder[i], primaryOrder[j]] = [primaryOrder[j], primaryOrder[i]];
          }
        }
        // Build a competitor_id → display_order map (1-indexed).
        const displayOrderByCompetitor = new Map();
        primaryOrder.forEach((o, position) => {
          displayOrderByCompetitor.set(primaries[o.idx].competitor_id, position + 1);
        });

        // Pre-load any prescribed round dives for the child so we
        // can override the inherited dive_ids when the operator
        // pinned specific dives at the child level.
        const prescribedRes = await client.query(
          "SELECT round_number, dive_id FROM event_round_dives WHERE event_id = $1 AND dive_id IS NOT NULL",
          [child.id],
        );
        const prescribedByRound = new Map(
          prescribedRes.rows.map((r) => [r.round_number, r.dive_id]),
        );

        // Refuse if scores already exist on the child, a re-run
        // advance would CASCADE-delete them via the scores FK.
        // The status gate above isn't sufficient because PUT
        // /api/events/:id/status can flip a Live event back to
        // Upcoming. Belt-and-braces.
        const scoresErr = await refuseIfScoresExist(client, child.id);
        if (scoresErr) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: scoresErr });
        }

        // Wipe any existing roster on the child, re-running advance
        // is a "redo" not an append. The guard above prevents the
        // CASCADE-destroys-scores foot-gun.
        await client.query(
          "DELETE FROM competitor_dive_lists WHERE event_id = $1",
          [child.id],
        );

        const childRounds = child.total_rounds;
        // One multi-row INSERT for the whole reseed, primaries then
        // reserves.
        const seedRows = [];
        function pushDiverRows(diver, { isReserve, reservePos, displayOrder }) {
          const dives = Array.isArray(diver.dives) ? diver.dives : [];
          const byRound = new Map(dives.map((d) => [d.round_number, d.dive_id]));
          for (let r = 1; r <= childRounds; r++) {
            seedRows.push({
              competitor_id: diver.competitor_id,
              dive_id: prescribedByRound.has(r)
                ? prescribedByRound.get(r)
                : (byRound.get(r) || null),
              round_number: r,
              display_order: isReserve ? null : displayOrder,
              is_reserve: isReserve,
              reserve_position: isReserve ? reservePos : null,
            });
          }
        }

        for (const diver of primaries) {
          pushDiverRows(diver, {
            isReserve: false,
            reservePos: null,
            displayOrder: displayOrderByCompetitor.get(diver.competitor_id),
          });
        }
        for (let i = 0; i < reserveRows.length; i++) {
          pushDiverRows(reserveRows[i], {
            isReserve: true,
            reservePos: i + 1,
            displayOrder: null,
          });
        }
        await insertDiveListRows(client, child.id, seedRows);

        // Stamp the dive-list lock on the child event. The advance
        // endpoint runs after the parent is Completed (we already
        // gate on this above), so NOW() is approximately when the
        // previous stage ended. See stampDiveListLock for the WA
        // Article 6.7.3 window.
        const lockAtIso = await stampDiveListLock(client, child.id, lockMin);

        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   child.id,
          entity_name: null,
          action:      "event.advanced",
          metadata: {
            parent_event_id: parent.id,
            top_n: topN,
            reserves: resN,
            dive_order: orderMode,
            lock_minutes: lockMin,
            dive_list_locks_at: lockAtIso,
          },
        });

        await client.query("COMMIT");

        // Push notifications to advanced primaries + reserves so
        // they see "you've advanced, confirm or edit by [time]"
        // in the inbox. Best-effort; if the push engine isn't
        // wired the rows just skip notification.
        if (push && typeof push.sendNotification === "function") {
          try {
            const evNameRes = await pool.query(
              "SELECT name FROM events WHERE id = $1",
              [child.id],
            );
            const childName = evNameRes.rows[0]?.name || "the next stage";
            const lockHint = lockAtIso
              ? ` Locks at ${new Date(lockAtIso).toLocaleString()}.`
              : "";
            // Primaries: "You've advanced". Different copy from
            // reserves so the diver immediately knows whether
            // they're competing or on standby.
            const primaryIds = primaries.map((d) => d.competitor_id);
            if (primaryIds.length) {
              await push.sendNotification(primaryIds, {
                category:  "dive_list_advanced",
                title:     `You've advanced to "${childName}"`,
                body:      `Your dive list carried over from the previous stage.${lockHint} Tap to confirm or edit before then.`,
                data:      {
                  event_id: child.id,
                  parent_event_id: parent.id,
                  lock_at: lockAtIso,
                  is_reserve: false,
                },
                action_url: `/competitor?event=${child.id}`,
              });
            }
            // Reserves: explicit "you're a reserve" framing per
            // WA Article 4.1.12. Same lock window applies, they
            // should keep the list current in case they're
            // promoted before the deadline.
            if (reserveRows.length) {
              const reserveIds = reserveRows.map((d) => d.competitor_id);
              await push.sendNotification(reserveIds, {
                category:  "dive_list_reserve",
                title:     `You're a reserve for "${childName}"`,
                body:      `You'll only compete if a primary withdraws (WA Article 4.1.12).${lockHint} Tap to confirm or edit your list now so you're ready if you're promoted.`,
                data:      {
                  event_id: child.id,
                  parent_event_id: parent.id,
                  lock_at: lockAtIso,
                  is_reserve: true,
                },
                action_url: `/competitor?event=${child.id}`,
              });
            }
          } catch (notifErr) {
            console.error("[Advance Notification Skipped]", notifErr.message);
          }
        }

        res.json({
          advanced: primaries.length,
          reserves: reserveRows.length,
          dive_order: orderMode,
          child_event_id: child.id,
          dive_list_locks_at: lockAtIso,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Advance Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // Super Final seeding (seed-h2h and its preview, h2h-results,
  // seed-semi, seed-final; Appendix 3) is in
  // routes/events/super-final-seeding.js.
  router.use(require("./super-final-seeding")({ pool, push, requireEventManager }));

  // Dive-off routes (Super Final Appendix 3 §6) moved into a
  // sub-router so this file stays scannable. See
  // routes/events/dive-offs.js for the GET / POST / PATCH
  // handlers.
  router.use(require("./dive-offs")({ pool, requireEventManager }));

  // Super-Final synchro reserve + merged-rankings routes moved
  // into a sub-router. See routes/events/super-final-bridge.js.
  // It shares loadH2hPairResults + loadSfCumulative with the
  // seed-semi / seed-final handlers in super-final-seeding.js,
  // through lib/super-final-helpers.js.
  router.use(require("./super-final-bridge")({ pool, requireEventManager }));


  // Reserves routes (list + promote, with WA Article 4.1.8 /
  // 4.1.10 / 4.1.12 reverse-rank shift on replacement) moved
  // into a sub-router. See routes/events/reserves.js.
  router.use(require("./reserves")({ pool, requireEventManager, push }));

  return router;
};
