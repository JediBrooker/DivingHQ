// Event routes — CRUD + status transitions.
//
//   GET    /api/events            list (anon → Live/Completed only)
//   POST   /api/events            create (org_admin only)
//   PUT    /api/events/:id        update (event manager / org_admin)
//   DELETE /api/events/:id        remove (org_admin only)
//   PUT    /api/events/:id/status flip Upcoming/Live/Completed
//
// Adjacent concerns — judges, managers, roster, advance, dive
// templates, event-judges plumbing — live in their own routes
// modules (extraction in progress; many still in server.js as of
// the Phase-4 split). loadEventForEntries — used by the
// diver-portal and team dive-list submit handlers — moved into
// lib/middleware.js so it can be imported once and reused by
// both consumers.
//
// Mounted via:
//   app.use(require('./routes/events')({ … }))

const express = require("express");
const { recordAudit, auditFromReq } = require("../../lib/audit");
const createIdempotency = require("../../lib/idempotency");
const { getEventReadiness } = require("../../lib/workflow");
const {
  loadH2hPairResults,
  loadSfCumulative,
  loadResolvedDiveOffs,
  compareSfFinalists,
  diveOffPairKey,
} = require("../../lib/super-final-helpers");
const { perDivePointsCte } = require("../../lib/scoring-sql");
const archiveCache = require("../../lib/archive-cache");
const {
  buildReflowProposal,
  stampActualStart,
} = require("../../lib/schedule-reflow");

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
  JWT_SECRET,
  io,
  verifyToken,
  requireOrgAdmin,
  requireOrgRole,
  requireEventManager,
  sendEventStartedEmails,
  sendEventResultsEmails,
  activeDivers,
  meetHolds,
  // Optional — when supplied, the Completed-status cleanup
  // also drops the matching event_live_state row so the
  // table doesn't accumulate dead state.
  persistClearAll,
  // Optional. Used by the international-invite flow to notify
  // every org_admin of a newly-invited federation. Falls back
  // to a silent skip if the push engine isn't wired (the
  // notification row will simply not be created).
  push,
  // lib/middleware.js optionalAuth — decodes a valid JWT into
  // req.user (running the token-version / deleted_at /
  // suspended_at revocation checks) and treats anything else as
  // anonymous.
  optionalAuth,
}) {
  if (!pool || !JWT_SECRET || !optionalAuth) {
    throw new Error("createEventsRouter requires { pool, JWT_SECRET, optionalAuth, … }");
  }
  const router = express.Router();

  // Idempotency middleware (lib/idempotency.js). Applied to the
  // status-flip route below since that's a meet-time write the
  // outbox covers. Other writes in this router are pre-meet
  // setup (event create / edit / delete / advance / seed) and
  // stay on the legacy direct path — see DEC-01 and the
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

  async function orgAdminIds(orgId) {
    const admins = await pool.query(
      `SELECT DISTINCT u.id
         FROM user_org_roles r
         JOIN users u ON u.id = r.user_id
        WHERE r.org_id = $1 AND r.role = 'org_admin'`,
      [orgId],
    );
    return admins.rows.map((row) => row.id);
  }

  async function notifyOrgAdmins(orgId, payload) {
    if (!push || typeof push.sendNotification !== "function") return;
    const ids = await orgAdminIds(orgId);
    if (!ids.length) return;
    await push.sendNotification(ids, payload);
  }

  // Stamp (or clear) dive_list_locks_at on an event. World
  // Aquatics Article 6.7.3: a change-of-dives form must be
  // submitted "no later than thirty (30) minutes after the end of
  // the previous stage", so the advance/seed endpoints call this
  // right after reseeding — NOW() approximates when the previous
  // stage ended. lockMin = 0 means "no auto-lock" and clears any
  // stale value left by a prior advance/seed. Runs on the caller's
  // open transaction client. Returns the new lock as an ISO
  // string, or null when cleared.
  async function stampDiveListLock(client, eventId, lockMin) {
    if (lockMin > 0) {
      const lockRes = await client.query(
        `UPDATE events
            SET dive_list_locks_at = NOW() + ($2::int || ' minutes')::interval
          WHERE id = $1
          RETURNING dive_list_locks_at`,
        [eventId, lockMin],
      );
      return lockRes.rows[0]?.dive_list_locks_at?.toISOString() || null;
    }
    await client.query(
      "UPDATE events SET dive_list_locks_at = NULL WHERE id = $1",
      [eventId],
    );
    return null;
  }

  // -------------------------------------------------------------
  // GET /api/events — list events visible to the caller.
  //
  //   * anonymous   → Live/Completed only
  //   * sysadmin    → every event in every org
  //   * regular user → events in caller's org
  //
  // Optional query params:
  //   * status — comma-separated event_status values; narrows
  //     WITHIN the caller's visibility, never widens it (an
  //     anonymous caller asking for Upcoming gets [], not a leak).
  //   * limit  — positive integer, capped at 500.
  //
  // 401-on-bad-JWT (rather than silent downgrade to public)
  // landed in Migration 021 — if the caller sent a bad token they
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
      // SPA renders a 🌐 chip and the federations modal pre-loads
      // the invited list). Subselect rather than LEFT JOIN +
      // GROUP BY so the rest of the query stays readable.
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
        // Sysadmin sees every event in every org — no scope clause.
      } else if (req.user) {
        // Show events the caller's org hosts OR events that
        // explicitly invited the caller's org via
        // event_participating_orgs. The EXISTS subquery is
        // short-circuited by the OR — domestic-only orgs pay
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
  // POST /api/events — create an event in caller's org.
  //
  // org_admin only (no event_managers fallback because the event
  // doesn't exist yet — there's no row to be a manager of).
  // -------------------------------------------------------------
  router.post("/api/events", requireOrgAdmin, async (req, res) => {
    const {
      name, gender, number_of_judges, total_rounds, height, event_type, meet_id,
      age_group, scheduled_at, event_format, parent_event_id, advance_count,
      dd_limit_rounds, dd_limit_value,
      // Migration 020: optional registration deadline.
      entries_close_at,
      // Migration 031:
      //   enforce_referee_signoff — gate the simple manager-attests
      //                             sign-off path; force push or
      //                             credential entry by the named
      //                             referee.
      //   is_mixed_height         — multi-board event; the picker
      //                             widens to the full directory.
      enforce_referee_signoff, is_mixed_height,
      // Workflow: rehearsal events let meet staff dry-run the
      // entire scoring flow without public archive, email, or
      // record side effects.
      is_rehearsal,
      // Migration 038: structured round-by-round dive-list rules.
      // Optional — when null the legacy (dd_limit_rounds,
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

    // Validate round_rules shape if supplied — use the EFFECTIVE
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
    // Validate event_format — see ALLOWED_FORMATS at module scope.
    const fmt = event_format || "final";
    if (!ALLOWED_FORMATS.includes(fmt)) {
      return res
        .status(400)
        .json({ error: `event_format must be one of: ${ALLOWED_FORMATS.join(', ')}` });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Validate meet_id if provided — must belong to the same org.
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
      //                        'final' or 'preliminary' — the operator
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
          // only — store NULL so any "filter dives by height"
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
      if (Array.isArray(round_dives) && round_dives.length) {
        for (const slot of round_dives) {
          await client.query(
            `INSERT INTO event_round_dives (event_id, round_number, dive_id, height)
             VALUES ($1, $2, $3, $4)`,
            [
              event.id,
              slot.round_number,
              slot.dive_id || null,
              slot.height == null || slot.height === ""
                ? null
                : Number(slot.height),
            ],
          );
        }
      }
      // Creator becomes the first event manager automatically.
      await client.query(
        "INSERT INTO event_managers (event_id, user_id, added_by) VALUES ($1,$2,$2)",
        [event.id, req.user.id],
      );
      // Audit the create. metadata captures the headline config
      // an admin would want to see when reviewing later — full
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
  // PUT /api/events/:id — partial update. Every COALESCE-able
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
      // Migration 031 — see POST handler for the rationale.
      enforce_referee_signoff, is_mixed_height, is_rehearsal,
      // Migration 038 — structured round rules. Tri-state:
      //   undefined → leave untouched
      //   null      → clear, fall back to legacy dd_limit_*
      //   {sections}→ set
      round_rules,
      // Migration 039 — operator-prescribed round dives. Tri-state:
      //   undefined → leave untouched
      //   []        → clear all prescribed dives for this event
      //   [...slots]→ replace the existing rows
      round_dives,
    } = body;
    let currentEvent;
    try {
      const current = await pool.query(
        "SELECT event_type, number_of_judges, total_rounds FROM events WHERE id = $1",
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
      // /api/events already does this (~line 281-288); the PUT
      // handler had dropped the check. Without it, an org_admin in
      // Org A could PUT a child event with parent_event_id pointing
      // at any Org B event whose UUID they know — chaining through
      // the Super Final seed endpoints would then pull Org B's
      // ranked divers into Org A's H2H roster and fire push
      // notifications at Org B divers. Sysadmin bypass intact via
      // the is_system_admin flag.
      if (parent_event_id !== undefined && parent_event_id !== null) {
        const p = await client.query(
          "SELECT id, org_id FROM events WHERE id = $1",
          [parent_event_id],
        );
        if (
          !p.rows.length ||
          (!req.user.is_system_admin && p.rows[0].org_id !== req.user.org_id)
        ) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Parent event not found in this org" });
        }
      }
      // ---- SET clause assembly (field-descriptor style — same
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
      // dd_limit_rounds sets on any non-nullish value — 0 is a
      // meaningful "no limit-rounds" value here, unlike the truthy
      // fields above.
      if (dd_limit_rounds != null) addSet("dd_limit_rounds", dd_limit_rounds);

      // height: flipping is_mixed_height on force-clears the column
      // (informational-only for mixed-board events — see the POST
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
      // entries_close_at additionally treats "" as clear — "no
      // value sent" and "explicitly cleared" mean different things
      // on a nullable timestamp.
      if (entries_close_at !== undefined) {
        addSet("entries_close_at", entries_close_at || null, "::timestamptz");
      }

      // Boolean flags: undefined = leave untouched, anything else =
      // set to its truthiness — a partial PUT body must not flip a
      // flag back to its default.
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
        // field on its "leave alone" branch) — preserve the
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
        if (Array.isArray(round_dives) && round_dives.length) {
          for (const slot of round_dives) {
            await client.query(
              `INSERT INTO event_round_dives (event_id, round_number, dive_id, height)
               VALUES ($1, $2, $3, $4)`,
              [
                req.params.id,
                slot.round_number,
                slot.dive_id || null,
                slot.height == null || slot.height === ""
                  ? null
                  : Number(slot.height),
              ],
            );
          }
        }
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
  // DELETE /api/events/:id — org_admin only. CASCADE down to
  // dive lists, judges, scores etc. via FKs in init.sql.
  // -------------------------------------------------------------
  router.delete("/api/events/:id", requireOrgAdmin, async (req, res) => {
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
      await pool.query("DELETE FROM events WHERE id = $1", [ev.id]);
      // A Live/Completed event may sit in the cached public
      // archive listing for up to 60s — bust it so the deleted
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
  // PUT /api/events/:id/status — Upcoming → Live → Completed.
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
        // preserves the old response shape — return the row and
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
        // layout from that field — bust it so a spectator
        // deep-linking right after this flip can't get the wrong
        // page mode.
        archiveCache.invalidate();

        if (!event.is_rehearsal) {
          if (status === "Live")      sendEventStartedEmails(event).catch(() => {});
          if (status === "Completed") sendEventResultsEmails(event).catch(() => {});
          if (status === "Live")      notifyEventLive(event).catch(() => {});
        }

        // Real-time push for the dashboard pulse strip — emit
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
          } catch (_e) { /* ignore — best-effort */ }
        }

        // Audit the status flip. Specific actions for the
        // meaningful transitions ('event.started',
        // 'event.finalised', 'event.unfinalised') so the audit
        // view can colour-code or filter on them — falls back
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
      // bridge sequence counter for the same reason — otherwise
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
        // Drop the coach-alerts dedupe entry too — otherwise the
        // per-process Map would accumulate stale (event_id → key)
        // entries across a meet-week. Best-effort, never throws.
        try {
          require("../../lib/coach-alerts").pruneCompletedEvent(event.id);
        } catch (_e) { /* best-effort cleanup */ }
      }

      // ---------------------------------------------------------
      // Phase 4 — session-scheduler bookkeeping + live re-flow.
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
      // status flip from succeeding — the operator's finalise
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
          // 500 — the status flip already committed.
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
  // PARTICIPATING ORGS — opt-in list of OTHER federations whose
  // divers can self-enter this event. Host-org_admin manages.
  //
  //   GET    /api/events/:id/participating-orgs
  //   POST   /api/events/:id/participating-orgs   { org_id }
  //   DELETE /api/events/:id/participating-orgs/:org_id
  //
  // Empty list = domestic-only event (host-org divers only). Any
  // populated row makes this an international event in practice.
  // The host org is NEVER inserted here — events.org_id is the
  // source of truth for the host. See migration 036.
  // -------------------------------------------------------------

  // -------------------------------------------------------------
  // GET /api/events/:id/round-dives — operator-prescribed round
  // dives for a single event (migration 039). Returned as an
  // ordered array enriched with the dive's directory fields so
  // the diver portal can render the locked rows without a second
  // round-trip. Empty array when no rows exist.
  //
  // Public for Live/Completed events; authed scope for Upcoming
  // (mirrors the GET /api/events visibility contract — operators
  // shouldn't have their pre-meet bulletin leaked).
  // -------------------------------------------------------------
  router.get("/api/events/:id/round-dives", optionalAuth, async (req, res) => {
    try {
      // optionalAuth: a bad/revoked/suspended token reads as
      // anonymous — same floor as the old inline peek, but the
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

  // Public read — the meet's public landing page wants to render
  // "participating: AUS / NZL / FIJ" badges, so this endpoint is
  // open to anonymous spectators. Mirrors the privacy contract
  // of /api/events itself: anonymous callers only see Live or
  // Completed events. An Upcoming event's participating list is
  // the host's competitive intelligence and stays private until
  // the event flips Live (the same moment the public listing
  // reveals the event itself). Authed callers in the host org
  // (or sysadmin) bypass the status filter so the Federations
  // modal works pre-meet.
  router.get("/api/events/:id/participating-orgs", optionalAuth, async (req, res) => {
    try {
      // optionalAuth: a bad/revoked/suspended token reads as
      // anonymous — same floor as the old inline peek, but the
      // token-version / deleted_at / suspended_at checks now apply.
      const callerOrgId = req.user?.org_id || null;
      const callerIsSys = !!req.user?.is_system_admin;
      const ev = await pool.query(
        "SELECT org_id, status FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const { org_id: hostOrgId, status } = ev.rows[0];
      const callerIsHostOrParticipant = callerIsSys
        || callerOrgId === hostOrgId;
      if (!callerIsHostOrParticipant && status !== "Live" && status !== "Completed") {
        return res.json([]);
      }
      const r = await pool.query(
        `SELECT epo.org_id, epo.added_at,
                o.name AS org_name, o.country_code, o.slug AS org_slug
           FROM event_participating_orgs epo
           JOIN organisations o ON o.id = epo.org_id
          WHERE epo.event_id = $1
          ORDER BY o.name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Participating Orgs List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.get("/api/events/:id/participation-requests", requireOrgAdmin, async (req, res) => {
    try {
      const ev = await pool.query(
        "SELECT id, org_id, name FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const isSysAdmin = !!req.user.is_system_admin;
      const isHostAdmin = ev.rows[0].org_id === req.user.org_id;
      // Visiting org admins can only see their own invite row. If
      // none exists, this returns [] rather than leaking that
      // another federation was invited.
      const visibleSql = (isSysAdmin || isHostAdmin)
        ? "r.event_id = $1"
        : "r.event_id = $1 AND r.org_id = $2";
      const params = (isSysAdmin || isHostAdmin)
        ? [req.params.id]
        : [req.params.id, req.user.org_id];
      const r = await pool.query(
        `SELECT r.id, r.event_id, r.org_id, r.status, r.requested_at,
                r.responded_at, r.note,
                o.name AS org_name, o.country_code, o.slug AS org_slug,
                req.full_name AS requested_by_name,
                resp.full_name AS responded_by_name
           FROM event_participation_requests r
           JOIN organisations o ON o.id = r.org_id
           LEFT JOIN users req ON req.id = r.requested_by
           LEFT JOIN users resp ON resp.id = r.responded_by
          WHERE ${visibleSql}
          ORDER BY r.requested_at DESC`,
        params,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Participation Requests List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.post("/api/events/:id/participation-requests", requireOrgAdmin, async (req, res) => {
    const { org_id, note } = req.body || {};
    if (!org_id) return res.status(400).json({ error: "org_id is required" });
    try {
      const ev = await pool.query(
        "SELECT id, org_id, name, status FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (!req.user.is_system_admin && ev.rows[0].org_id !== req.user.org_id) {
        return res.status(403).json({ error: "You don't host this event" });
      }
      if (ev.rows[0].status === "Completed") {
        return res.status(409).json({
          error: "Event is already Completed — re-open it before inviting more federations",
        });
      }
      if (org_id === ev.rows[0].org_id) {
        return res.status(400).json({
          error: "Host org is implicit — don't list it as a participating org",
        });
      }
      const target = await pool.query(
        "SELECT id, name, status FROM organisations WHERE id = $1",
        [org_id],
      );
      if (!target.rows.length) return res.status(404).json({ error: "Target org not found" });
      if (target.rows[0].status !== "active") {
        return res.status(409).json({
          error: `${target.rows[0].name} is ${target.rows[0].status}; only active orgs can participate`,
        });
      }
      const accepted = await pool.query(
        "SELECT 1 FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2",
        [req.params.id, org_id],
      );
      if (accepted.rows.length) {
        return res.status(409).json({ error: `${target.rows[0].name} is already participating` });
      }
      const request = await pool.query(
        `INSERT INTO event_participation_requests
           (event_id, org_id, status, requested_by, requested_at, note)
         VALUES ($1, $2, 'pending', $3, now(), $4)
         ON CONFLICT (event_id, org_id) DO UPDATE
           SET status = 'pending',
               requested_by = EXCLUDED.requested_by,
               requested_at = now(),
               responded_by = NULL,
               responded_at = NULL,
               note = EXCLUDED.note
         RETURNING *`,
        [req.params.id, org_id, req.user.id, note || null],
      );
      try {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id: ev.rows[0].org_id,
          entity_type: "event",
          entity_id: ev.rows[0].id,
          entity_name: ev.rows[0].name,
          action: "event.participation_request.created",
          metadata: {
            request_id: request.rows[0].id,
            participating_org_id: org_id,
            participating_org_name: target.rows[0].name,
          },
        });
      } catch (auditErr) {
        console.error("[Participation Request Audit Skipped]", auditErr.message);
      }
      try {
        const hostOrg = await pool.query(
          "SELECT name FROM organisations WHERE id = $1",
          [ev.rows[0].org_id],
        );
        await notifyOrgAdmins(org_id, {
          category: "international_invite",
          title: `${hostOrg.rows[0]?.name || "A host federation"} invited you to "${ev.rows[0].name}"`,
          body: "Open Meet Manager to accept or decline participation.",
          data: {
            request_id: request.rows[0].id,
            event_id: ev.rows[0].id,
            host_org_id: ev.rows[0].org_id,
          },
          action_url: `/manager?event=${ev.rows[0].id}`,
        });
      } catch (notifErr) {
        console.error("[Participation Request Notification Skipped]", notifErr.message);
      }
      res.status(201).json(request.rows[0]);
    } catch (err) {
      console.error("[Create Participation Request Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/events/:id/participation-requests/:request_id/respond", requireOrgAdmin, async (req, res) => {
    const decision = String(req.body?.decision || "").toLowerCase();
    if (!["accepted", "declined"].includes(decision)) {
      return res.status(400).json({ error: "decision must be accepted or declined" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reqRow = await client.query(
        `SELECT r.*, e.name AS event_name, e.org_id AS host_org_id,
                o.name AS org_name
           FROM event_participation_requests r
           JOIN events e ON e.id = r.event_id
           JOIN organisations o ON o.id = r.org_id
          WHERE r.id = $1 AND r.event_id = $2
          FOR UPDATE`,
        [req.params.request_id, req.params.id],
      );
      if (!reqRow.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Participation request not found" });
      }
      const row = reqRow.rows[0];
      if (!req.user.is_system_admin && row.org_id !== req.user.org_id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Only the invited federation can respond" });
      }
      if (row.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Request is already ${row.status}` });
      }
      const updated = await client.query(
        `UPDATE event_participation_requests
            SET status = $1,
                responded_by = $2,
                responded_at = now()
          WHERE id = $3
          RETURNING *`,
        [decision, req.user.id, row.id],
      );
      if (decision === "accepted") {
        await client.query(
          `INSERT INTO event_participating_orgs (event_id, org_id, added_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (event_id, org_id) DO NOTHING`,
          [row.event_id, row.org_id, req.user.id],
        );
      }
      await recordAudit(client, {
        org_id: row.host_org_id,
        actor_id: req.user.id,
        entity_type: "event",
        entity_id: row.event_id,
        entity_name: row.event_name,
        action: `event.participation_request.${decision}`,
        metadata: {
          request_id: row.id,
          participating_org_id: row.org_id,
          participating_org_name: row.org_name,
        },
      });
      await client.query("COMMIT");
      try {
        await notifyOrgAdmins(row.host_org_id, {
          category: "international_invite",
          title: `${row.org_name} ${decision === "accepted" ? "accepted" : "declined"} "${row.event_name}"`,
          body: decision === "accepted"
            ? "Their divers can now enter under their home federation."
            : "They will not participate unless you send a new invite.",
          data: {
            request_id: row.id,
            event_id: row.event_id,
            participating_org_id: row.org_id,
            decision,
          },
          action_url: `/manager?event=${row.event_id}`,
        });
      } catch (notifErr) {
        console.error("[Participation Response Notification Skipped]", notifErr.message);
      }
      res.json(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Participation Request Response Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // Add — host org_admin only (or sysadmin). Same gate as POST
  // /api/events. The event is loaded first so the response can
  // confirm host-org match.
  router.post("/api/events/:id/participating-orgs", requireOrgAdmin, async (req, res) => {
    const { org_id } = req.body || {};
    if (!org_id) return res.status(400).json({ error: "org_id is required" });
    try {
      const ev = await pool.query(
        "SELECT id, org_id, name, status FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      // Only the HOST org's admin (or sysadmin) can grant
      // entry to other federations. requireOrgAdmin already
      // confirmed `org_admin` somewhere; tighten to "this event's
      // host org".
      if (!req.user.is_system_admin && ev.rows[0].org_id !== req.user.org_id) {
        return res.status(403).json({ error: "You don't host this event" });
      }
      // Refuse on already-finalised events — inviting a federation
      // post-Completed sends a stale "your divers can now self-
      // enter" notification (the entry-gate middleware would
      // reject every actual submit) AND opens a way to spam
      // foreign admins by toggling Completed → Upcoming and back.
      if (ev.rows[0].status === "Completed") {
        return res.status(409).json({
          error: "Event is already Completed — re-open it before inviting more federations",
        });
      }
      // Disallow listing the host's own org — that's the implicit
      // entry path, not a participating-org row.
      if (org_id === ev.rows[0].org_id) {
        return res.status(400).json({
          error: "Host org is implicit — don't list it as a participating org",
        });
      }
      // Active orgs only — pending/rejected/suspended can't
      // participate.
      const target = await pool.query(
        "SELECT id, name, status FROM organisations WHERE id = $1",
        [org_id],
      );
      if (!target.rows.length) return res.status(404).json({ error: "Target org not found" });
      if (target.rows[0].status !== "active") {
        return res.status(409).json({
          error: `${target.rows[0].name} is ${target.rows[0].status}; only active orgs can participate`,
        });
      }
      const inserted = await pool.query(
        `INSERT INTO event_participating_orgs (event_id, org_id, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id, org_id) DO NOTHING
         RETURNING event_id`,
        [req.params.id, org_id, req.user.id],
      );
      // Audit row so the host federation has a clean record of
      // who invited whom.
      try {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id:      ev.rows[0].org_id,
          entity_type: "event",
          entity_id:   ev.rows[0].id,
          entity_name: ev.rows[0].name,
          action:      "event.participating_org.added",
          metadata: { participating_org_id: org_id, participating_org_name: target.rows[0].name },
        });
      } catch (auditErr) {
        console.error("[Participating Org Audit Skipped]", auditErr.message);
      }
      // Fire an in-app notification to every org_admin of the
      // newly-invited federation. They land in /inbox and on
      // the dashboard pulse strip's incoming-feed; if web push
      // is wired they also buzz the admin's phone. ON CONFLICT
      // returning empty = the row already existed (re-add of an
      // already-invited org); skip the notification spam.
      if (inserted.rows.length && push && typeof push.sendNotification === "function") {
        try {
          // Find every user with org_admin in the invited org —
          // gate on user_org_roles.role alone, NOT on
          // users.org_id matching. A user can hold org_admin in
          // an org that isn't their primary; the previous
          // r.org_id = u.org_id predicate silently dropped those
          // admins from the fan-out.
          const admins = await pool.query(
            `SELECT DISTINCT u.id
               FROM user_org_roles r
               JOIN users u ON u.id = r.user_id
              WHERE r.org_id = $1 AND r.role = 'org_admin'`,
            [org_id],
          );
          const adminIds = admins.rows.map(r => r.id);
          if (adminIds.length) {
            const hostOrg = await pool.query(
              "SELECT name FROM organisations WHERE id = $1",
              [ev.rows[0].org_id],
            );
            await push.sendNotification(adminIds, {
              category:  "international_invite",
              title:     `${hostOrg.rows[0]?.name || "A host federation"} invited you to "${ev.rows[0].name}"`,
              body:      "Your divers can now self-enter this event. Open Meet Manager to see who's competing.",
              data:      { event_id: ev.rows[0].id, host_org_id: ev.rows[0].org_id },
              action_url: `/manager?event=${ev.rows[0].id}`,
            });
          }
        } catch (notifErr) {
          console.error("[Invite Notification Skipped]", notifErr.message);
        }
      }
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error("[Add Participating Org Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove — host org_admin removes ANY federation, OR a visiting
  // federation's own org_admin self-withdraws their participation.
  // The visiting-side path lets a country pull out without
  // pinging the host (e.g. funding cut, travel ban, schedule
  // clash) — existing roster entries stay intact (the diver
  // gates only block NEW entries) so no in-flight competition
  // is destabilised.
  router.delete("/api/events/:id/participating-orgs/:org_id", requireOrgAdmin, async (req, res) => {
    try {
      // Defense-in-depth: lowercase the URL-supplied UUIDs so a
      // mixed-case path (e.g. uppercase pasted from a copy-out)
      // doesn't fail the equality check below for a legitimate
      // self-withdraw, and so the audit row's metadata always
      // records the canonical lowercase form (audit search-by-
      // org-id stays consistent).
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const eventId = (req.params.id || "").toLowerCase();
      const orgId   = (req.params.org_id || "").toLowerCase();
      if (!UUID_RE.test(eventId) || !UUID_RE.test(orgId)) {
        return res.status(400).json({ error: "Invalid event_id or org_id (must be UUID)" });
      }
      const ev = await pool.query(
        "SELECT id, org_id, name FROM events WHERE id = $1",
        [eventId],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const isSysAdmin = !!req.user.is_system_admin;
      const isHostAdmin = ev.rows[0].org_id === req.user.org_id;
      const isSelfWithdraw = orgId === (req.user.org_id || "").toLowerCase();
      if (!isSysAdmin && !isHostAdmin && !isSelfWithdraw) {
        return res.status(403).json({
          error: "Only the host federation can remove other federations, and only the visiting federation can withdraw itself",
        });
      }
      const r = await pool.query(
        "DELETE FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2 RETURNING org_id",
        [eventId, orgId],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Not on the participating list" });
      try {
        await recordAudit(pool, {
          ...auditFromReq(req),
          // Audit row lands on the host org's books — that's where
          // the event lives and where compliance reads for it.
          // The metadata captures whether this was host-removal
          // or self-withdrawal so the trail reads correctly.
          org_id:      ev.rows[0].org_id,
          entity_type: "event",
          entity_id:   ev.rows[0].id,
          entity_name: ev.rows[0].name,
          action:      "event.participating_org.removed",
          metadata: {
            participating_org_id: orgId,
            removed_by_self: isSelfWithdraw && !isHostAdmin,
          },
        });
      } catch (auditErr) {
        console.error("[Participating Org Audit Skipped]", auditErr.message);
      }
      // Notify the host's org admins when a federation
      // self-withdraws — they need to know their roster expectation
      // changed. (Host-driven removal doesn't need this — the host
      // initiated it.)
      if (isSelfWithdraw && !isHostAdmin && push && typeof push.sendNotification === "function") {
        try {
          // Same multi-org-admin fix as the invite-fanout: gate
          // on r.role alone, not on r.org_id = u.org_id.
          const hostAdmins = await pool.query(
            `SELECT DISTINCT u.id
               FROM user_org_roles r
               JOIN users u ON u.id = r.user_id
              WHERE r.org_id = $1 AND r.role = 'org_admin'`,
            [ev.rows[0].org_id],
          );
          const adminIds = hostAdmins.rows.map(r => r.id);
          if (adminIds.length) {
            const leavingOrg = await pool.query(
              "SELECT name FROM organisations WHERE id = $1",
              [orgId],
            );
            await push.sendNotification(adminIds, {
              category:  "international_invite",
              title:     `${leavingOrg.rows[0]?.name || "A federation"} withdrew from "${ev.rows[0].name}"`,
              body:      "Their divers will no longer be able to enter new dive lists. Existing entries stay intact.",
              data:      { event_id: ev.rows[0].id, withdrawing_org_id: orgId },
              action_url: `/manager?event=${ev.rows[0].id}`,
            });
          }
        } catch (notifErr) {
          console.error("[Withdraw Notification Skipped]", notifErr.message);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Remove Participating Org Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Eligible divers for an event — host org's divers + every
  // participating org's divers. Used by the synchro-partner
  // picker and the late-entry roster lookup so a meet manager
  // can find foreign divers without hitting the org-scoped
  // /api/orgs/:id/divers endpoint.
  //
  // The previous gate was `verifyToken` only — any signed-in
  // user (including a freshly-registered spectator in any
  // federation) could enumerate full diver rosters of every
  // event in the system. Tightened to require either:
  //   1. event-staff for THIS event (requireEventManager),
  //      which covers the meet manager's late-entry use case;
  //   2. OR a diver/coach whose own org is on the event's
  //      eligibility list, which covers the synchro-partner
  //      picker for visiting federations.
  router.get("/api/events/:id/eligible-divers", verifyToken, async (req, res) => {
    try {
      // Org-eligibility check first (cheap). Sysadmins bypass.
      const evRow = await pool.query(
        "SELECT org_id FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!evRow.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const eventOrgId = evRow.rows[0].org_id;
      const isSysAdmin   = !!req.user.is_system_admin;
      const isHostOrg    = req.user.org_id === eventOrgId;
      let isEligibleOrg  = isHostOrg;
      if (!isSysAdmin && !isEligibleOrg) {
        const part = await pool.query(
          "SELECT 1 FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2",
          [req.params.id, req.user.org_id],
        );
        isEligibleOrg = part.rows.length > 0;
      }
      if (!isSysAdmin && !isEligibleOrg) {
        return res.status(403).json({
          error: "Your federation is not eligible for this event",
        });
      }
      const r = await pool.query(
        `SELECT u.id, u.full_name,
                u.org_id, o.name AS org_name, o.country_code,
                cl.name AS club_name, cl.short_code AS club_code
           FROM users u
           JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
           JOIN organisations o  ON o.id = u.org_id
           LEFT JOIN clubs cl    ON cl.id = u.club_id
          WHERE u.org_id IN (
                  SELECT org_id FROM events WHERE id = $1
                  UNION
                  SELECT org_id FROM event_participating_orgs WHERE event_id = $1
                )
          ORDER BY o.name ASC, u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Eligible Divers Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // Stage progression — prelim → semi → final.
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
  //   'inherit' — copy the parent's display_order, drop non-
  //               progressors, re-number 1..N (default for semi).
  //   'reverse' — top diver dives LAST (default for finals).
  //   'random'  — randomise the primaries.
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

  // Look up the child event of :id — the next stage that points
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

  // Refuse a re-seed (advance / seed-h2h / seed-semi / seed-final)
  // when the target event already has scored dives. The seed path
  // does `DELETE FROM competitor_dive_lists WHERE event_id = $1`
  // and `scores` cascades on competitor_dive_lists' (event_id,
  // competitor_id, round_number) FK — so a re-seed without this
  // guard SILENTLY destroys every recorded score. The route's
  // status === 'Upcoming' gate isn't sufficient because PUT
  // /api/events/:id/status lets a manager flip a Live event back
  // to Upcoming.
  //
  // Returns null when safe; otherwise returns an Express-ready
  // error string. Caller is expected to ROLLBACK + 409 on a
  // non-null return.
  async function refuseIfScoresExist(client, eventId) {
    const r = await client.query(
      "SELECT COUNT(*)::int AS n FROM scores WHERE event_id = $1",
      [eventId],
    );
    const n = r.rows[0]?.n || 0;
    if (n === 0) return null;
    return `Cannot re-seed: ${n} score row${n === 1 ? "" : "s"} already exist on this event. Clear the scores first (admin tooling) or use a different event.`;
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
        // World Aquatics Article 4.1.8 (start order / dive-list submission window): divers must submit the
        // next stage's list within 30 min of the prior stage's
        // results being announced. Configurable per-advance,
        // 0 = no auto-lock (operator wants no time pressure).
        lock_minutes = 30,
      } = req.body || {};
      const topN = parseInt(top_n);
      const resN = parseInt(reserves) || 0;
      const lockMin = Number.isFinite(parseInt(lock_minutes))
        ? Math.max(0, Math.min(parseInt(lock_minutes), 24 * 60))
        : 30;
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
        // straddles the advance cut-off, ALL tied divers advance — so
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
        const reserveRows = ranked
          .filter((r) => boundaryRank == null || Number(r.rnk) > Number(boundaryRank))
          .slice(0, resN);

        // Compute display_order for primaries per the chosen mode.
        // 'inherit' — copy parent_display_order, then re-number 1..N
        //              so gaps from non-progressors close up.
        // 'reverse' — top diver dives last → rank 1 gets order topN,
        //              rank topN gets order 1.
        // 'random'  — Fisher-Yates a copy of [1..topN] and assign.
        const primaryOrder = primaries.map((r, i) => ({ idx: i, sort: r.parent_display_order ?? r.rnk }));
        if (orderMode === 'inherit') {
          primaryOrder.sort((a, b) =>
            (a.sort == null ? Infinity : a.sort) - (b.sort == null ? Infinity : b.sort),
          );
        } else if (orderMode === 'reverse') {
          // Already in rank order ascending — reverse so worst dives first, top last.
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

        // Refuse if scores already exist on the child — a re-run
        // advance would CASCADE-delete them via the scores FK.
        // The status gate above isn't sufficient because PUT
        // /api/events/:id/status can flip a Live event back to
        // Upcoming. Belt-and-braces.
        const scoresErr = await refuseIfScoresExist(client, child.id);
        if (scoresErr) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: scoresErr });
        }

        // Wipe any existing roster on the child — re-running advance
        // is a "redo" not an append. The guard above prevents the
        // CASCADE-destroys-scores foot-gun.
        await client.query(
          "DELETE FROM competitor_dive_lists WHERE event_id = $1",
          [child.id],
        );

        const childRounds = child.total_rounds;
        // One multi-row INSERT for the whole reseed (primaries then
        // reserves, same row order the per-row loop produced). The
        // UNNEST arrays stay aligned by index.
        const seedRows = {
          competitor_ids: [], dive_ids: [], round_numbers: [],
          display_orders: [], is_reserves: [], reserve_positions: [],
        };
        function pushDiverRows(diver, { isReserve, reservePos, displayOrder }) {
          const dives = Array.isArray(diver.dives) ? diver.dives : [];
          const byRound = new Map(dives.map((d) => [d.round_number, d.dive_id]));
          for (let r = 1; r <= childRounds; r++) {
            const diveId = prescribedByRound.has(r)
              ? prescribedByRound.get(r)
              : (byRound.get(r) || null);
            seedRows.competitor_ids.push(diver.competitor_id);
            seedRows.dive_ids.push(diveId);
            seedRows.round_numbers.push(r);
            seedRows.display_orders.push(isReserve ? null : displayOrder);
            seedRows.is_reserves.push(isReserve);
            seedRows.reserve_positions.push(isReserve ? reservePos : null);
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
        await client.query(
          `INSERT INTO competitor_dive_lists
            (event_id, competitor_id, dive_id, round_number,
             display_order, is_reserve, reserve_position)
           SELECT $1::uuid, t.competitor_id, t.dive_id, t.round_number,
                  t.display_order, t.is_reserve, t.reserve_position
           FROM UNNEST($2::uuid[], $3::uuid[], $4::int[], $5::int[],
                       $6::boolean[], $7::int[])
             AS t(competitor_id, dive_id, round_number, display_order,
                  is_reserve, reserve_position)`,
          [
            child.id,
            seedRows.competitor_ids, seedRows.dive_ids, seedRows.round_numbers,
            seedRows.display_orders, seedRows.is_reserves, seedRows.reserve_positions,
          ],
        );

        // Stamp the dive-list lock on the child event. The advance
        // endpoint runs after the parent is Completed (we already
        // gate on this above), so NOW() is approximately when the
        // previous stage ended — see stampDiveListLock for the WA
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
        // they see "you've advanced — confirm or edit by [time]"
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
            // WA Article 4.1.12. Same lock window applies — they
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

  // -------------------------------------------------------------
  // SUPER FINAL — Diving World Cup 2026, Appendix 3.
  //
  // Three endpoint families implement the format:
  //   POST /seed-h2h               seed the 6 H2H pairs from the
  //                                Stop-1 ranking (Phase 2)
  //   GET  /seed-h2h/preview       read-only preview of the same
  //                                pairing logic (Phase 2)
  //   GET  /super-final/h2h-results
  //                                pair-by-pair winners after H2H
  //                                scoring (Phase 2)
  //   POST /seed-semi              seed 6 H2H winners into the SF
  //                                stage with carry-forward scoring
  //                                (Phase 3a)
  //   POST /seed-final             seed top-2-per-group from SF
  //                                cumulative; F resets scores
  //                                (Phase 3a)
  //   GET  /super-final/rankings   merged 1-12 ranking
  //                                (4 from F, 2 from SF non-q,
  //                                 6 from H2H non-advancers)
  //                                (Phase 3b)
  //   POST /dive-offs              referee-created tie-break record
  //                                (Phase 3c)
  //   PATCH/dive-offs/:id          update + resolve tie-break
  //                                (Phase 3c)
  //   GET  /dive-offs              list tie-breaks (public)
  //                                (Phase 3c)
  //   GET  /synchro-reserve-pool   eligible synchro replacements
  //                                (Phase 3d)
  //   POST /replace-from-synchro   referee swaps a withdrawn diver
  //                                for a synchro reserve
  //                                (Phase 3d)
  //
  // Source of truth: docs/2026.03.05-…-Super-Final…pdf Appendix 3.
  // -------------------------------------------------------------

  // Build the H2H seeding plan from a parent stage's ranking. Used
  // by both the preview endpoint (read-only) and the seed endpoint
  // (which writes after running this same logic).
  //
  // Steps:
  //   1. Pull ranked divers from the parent via the same helper the
  //      standard advance flow uses.
  //   2. Apply the per-Federation cap (Appendix 3 §1.1 / WC Rule
  //      1.4: "Maximum 2 divers per Federation"). Within each org,
  //      keep the top maxPerOrg divers; everyone else falls out.
  //   3. Take the global top 12 from what remains.
  //   4. Build pairs: indexes 0..5 →
  //        (rank 12 vs 1), (11 vs 2), (10 vs 3),
  //        (9 vs 4),       (8 vs 5),  (7 vs 6).
  //   5. Group assignment per Appendix 3 §2.1.1:
  //        Group 1: pairs (12,1), (9,4), (8,5)
  //        Group 2: pairs (11,2), (10,3), (7,6)
  //
  // Returns { pairs, top12, capped: [{ org_id, kept_count, dropped }],
  //           shortfall: null|string }. shortfall is set when fewer
  // than 12 divers qualify under the cap so the caller can 400 with
  // the explanation.
  async function buildH2hSeedingPlan(client, parentEventId, maxPerOrg) {
    // Pull every scored diver in the parent stage with their org.
    // We can't reuse rankedDiversForAdvance directly because it
    // doesn't surface org_id; instead, mirror its query with an
    // org_id projection so the per-Federation cap can run before
    // the top-12 cut.
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
         /* World Aquatics Art 4.1.5: equal totals share a rank.
            The 12-slot H2H bracket still needs a strict 1..12 order,
            so rows are ordered deterministically by name within a
            shared rank. (Dive-offs only resolve ties INSIDE the Super
            Final — H2H pairs and SF groups, Appendix 3 §6 — not this
            Stop-1 seeding cut, so there's no dive-off to consult here;
            WC §1.4.2.2 resolves Stop-1 ranking ties by the furthest-
            level scores, which is already the total being ranked.) */
         SELECT competitor_id, total,
                RANK() OVER (ORDER BY total DESC) AS rnk
         FROM cumulative
       )
       SELECT r.competitor_id, r.total, r.rnk,
              u.org_id, u.full_name, u.username,
              o.country_code,
              MIN(cdl.display_order) AS parent_display_order,
              array_agg(json_build_object(
                'round_number', cdl.round_number,
                'dive_id',      cdl.dive_id
              ) ORDER BY cdl.round_number) FILTER (WHERE cdl.dive_id IS NOT NULL) AS dives,
              ROW_NUMBER() OVER (PARTITION BY u.org_id
                                 ORDER BY r.total DESC, u.full_name ASC) AS org_rank
         FROM ranked r
         JOIN users u ON u.id = r.competitor_id
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = $1
          AND cdl.competitor_id = r.competitor_id
          AND cdl.withdrawn_at IS NULL
        GROUP BY r.competitor_id, r.total, r.rnk,
                 u.org_id, u.full_name, u.username, o.country_code
        ORDER BY r.rnk ASC, u.full_name ASC`,
      [parentEventId],
    );

    const allRanked = r.rows;
    // Apply the cap.
    const capRows = allRanked.filter((row) => Number(row.org_rank) <= maxPerOrg);
    // Track which orgs lost divers because of the cap so the
    // preview / seed response can show "Org A capped: 5 → 2".
    const orgCounts = new Map();
    for (const row of allRanked) {
      orgCounts.set(row.org_id, (orgCounts.get(row.org_id) || 0) + 1);
    }
    const orgKeptCounts = new Map();
    for (const row of capRows) {
      orgKeptCounts.set(row.org_id, (orgKeptCounts.get(row.org_id) || 0) + 1);
    }
    const capped = [];
    for (const [orgId, total] of orgCounts.entries()) {
      const kept = orgKeptCounts.get(orgId) || 0;
      if (total > kept) {
        capped.push({ org_id: orgId, total, kept_count: kept, dropped: total - kept });
      }
    }

    // Top 12 from the cap-applied pool.
    const top12 = capRows.slice(0, 12);
    const shortfall = top12.length < 12
      ? `Only ${top12.length} divers qualify under max_per_org=${maxPerOrg} — need 12 to seed an H2H bracket`
      : null;

    // Build pairs: index 0 = seed12 vs seed1, ..., index 5 = seed7 vs seed6.
    // Group 1 owns indexes [0, 3, 4] = (12,1), (9,4), (8,5).
    // Group 2 owns indexes [1, 2, 5] = (11,2), (10,3), (7,6).
    const GROUP_ASSIGN = {
      0: 1, 3: 1, 4: 1, // (12,1), (9,4), (8,5)
      1: 2, 2: 2, 5: 2, // (11,2), (10,3), (7,6)
    };
    const pairs = [];
    if (top12.length >= 12) {
      for (let i = 0; i < 6; i++) {
        const lower = top12[11 - i]; // seed 12, 11, 10, 9, 8, 7
        const higher = top12[i];     // seed  1,  2,  3, 4, 5, 6
        pairs.push({
          pair_index:      i,
          group_number:    GROUP_ASSIGN[i],
          seed_a:          11 - i + 1, // 12, 11, 10, 9, 8, 7 (the lower seed in the pair, dives first)
          seed_b:          i + 1,      //  1,  2,  3, 4, 5, 6
          competitor_a_id: lower.competitor_id,
          competitor_b_id: higher.competitor_id,
          full_name_a:     lower.full_name,
          full_name_b:     higher.full_name,
          country_code_a:  lower.country_code,
          country_code_b:  higher.country_code,
          // Carry the parent dive lists so the seed endpoint can
          // copy rounds 1..3 verbatim.
          dives_a:         Array.isArray(lower.dives) ? lower.dives : [],
          dives_b:         Array.isArray(higher.dives) ? higher.dives : [],
        });
      }
    }

    return { pairs, top12, capped, shortfall, allRanked };
  }

  // GET /api/events/:id/seed-h2h/preview — read-only.
  // :id is the H2H event itself (event_format=super_final_h2h).
  // Returns the proposed pairing without writing anything.
  router.get(
    "/api/events/:id/seed-h2h/preview",
    requireEventManager(),
    async (req, res) => {
      const maxPerOrg = parseInt(req.query.max_per_org) || 2;
      const client = await pool.connect();
      try {
        const evRes = await client.query(
          `SELECT id, event_format, status, parent_event_id, total_rounds, gender
             FROM events WHERE id = $1`,
          [req.params.id],
        );
        if (!evRes.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        const ev = evRes.rows[0];
        if (ev.event_format !== "super_final_h2h") {
          return res.status(400).json({ error: "Event is not a Super Final H2H stage" });
        }
        if (!ev.parent_event_id) {
          return res.status(400).json({
            error: "Super Final H2H must have parent_event_id set to the Stop-1 final",
          });
        }
        const plan = await buildH2hSeedingPlan(client, ev.parent_event_id, maxPerOrg);
        res.json({
          parent_event_id: ev.parent_event_id,
          max_per_org:     maxPerOrg,
          pairs:           plan.pairs,
          capped_orgs:     plan.capped,
          shortfall:       plan.shortfall,
          ranked:          plan.allRanked.map((r) => ({
            competitor_id:        r.competitor_id,
            full_name:            r.full_name,
            country_code:         r.country_code,
            org_id:               r.org_id,
            org_rank:             Number(r.org_rank),
            rnk:                  Number(r.rnk),
            total:                Number(r.total),
            qualifies_under_cap:  Number(r.org_rank) <= maxPerOrg,
            in_top_12:            plan.pairs.some((p) =>
              p.competitor_a_id === r.competitor_id ||
              p.competitor_b_id === r.competitor_id),
          })),
        });
      } catch (err) {
        console.error("[Seed H2H Preview Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // POST /api/events/:id/seed-h2h — commits the H2H bracket.
  //
  // Body (all optional):
  //   max_per_org   default 2  (Appendix 3 §1.1 — World Cup cap)
  //   lock_minutes  default 30 (WA Article 6.7.3 — change-of-dives)
  //
  // Writes 36 competitor_dive_lists rows (12 divers × 3 rounds),
  // sets group_number 1 or 2, sets display_order so the dive
  // sequence within a group is "Dive 1: divers 12,1; 9,4; 8,5"
  // (Appendix 3 §2.1.2 — lower-seeded diver of each pair goes
  // first within the pair, pairs in seed order). Stamps the
  // dive_list_locks_at on the H2H event.
  router.post(
    "/api/events/:id/seed-h2h",
    requireEventManager(),
    async (req, res) => {
      const maxPerOrg = Number.isFinite(parseInt(req.body?.max_per_org))
        ? Math.max(1, Math.min(parseInt(req.body.max_per_org), 12))
        : 2;
      const lockMin = Number.isFinite(parseInt(req.body?.lock_minutes))
        ? Math.max(0, Math.min(parseInt(req.body.lock_minutes), 24 * 60))
        : 30;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const evRes = await client.query(
          `SELECT id, event_format, status, parent_event_id,
                  total_rounds, gender, name
             FROM events WHERE id = $1`,
          [req.params.id],
        );
        if (!evRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        const ev = evRes.rows[0];
        if (ev.event_format !== "super_final_h2h") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Event is not a Super Final H2H stage (event_format=super_final_h2h)",
          });
        }
        if (ev.status !== "Upcoming") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "H2H must be Upcoming to seed (re-seeding only valid pre-Live)",
          });
        }
        if (Number(ev.total_rounds) !== 3) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "H2H must have total_rounds=3 (3 dives per Appendix 3 §1.2.2)",
          });
        }
        if (!ev.parent_event_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "H2H must have parent_event_id set to the Stop-1 final/qualifier",
          });
        }
        const parentRes = await client.query(
          "SELECT id, status FROM events WHERE id = $1",
          [ev.parent_event_id],
        );
        if (!parentRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Parent event not found" });
        }
        if (parentRes.rows[0].status !== "Completed") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Parent stage must be Completed before seeding H2H",
          });
        }

        const plan = await buildH2hSeedingPlan(client, ev.parent_event_id, maxPerOrg);
        if (plan.shortfall) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: plan.shortfall });
        }

        // Refuse if scores already exist — a re-seed would
        // CASCADE-delete them. See refuseIfScoresExist comment.
        const scoresErrH2h = await refuseIfScoresExist(client, ev.id);
        if (scoresErrH2h) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: scoresErrH2h });
        }

        // Wipe any existing roster on the H2H event — re-seeding
        // (still Upcoming, with no scores) is "redo not append".
        await client.query(
          "DELETE FROM competitor_dive_lists WHERE event_id = $1",
          [ev.id],
        );

        // Build the dive order. Appendix 3 §2.1.2 reads as:
        //
        //   Group 1 — Dive 1: Divers 12,1; 9,4; 8,5
        //   Group 1 — Dive 2: Same divers
        //   Group 1 — Dive 3: Same divers
        //   Group 2 — Dive 1: Divers 11,2; 10,3; 7,6
        //   …etc.
        //
        // In a single competitor_dive_lists.display_order field
        // (which is per-row, sorted within a round), we represent
        // this by giving each diver a group-local position within
        // their group: in Group 1, seed12 → position 1 (dives
        // first), seed1 → position 2, seed9 → 3, seed4 → 4,
        // seed8 → 5, seed5 → 6. Same shape in Group 2.
        //
        // The Up-Next query in scoreboard.js orders by
        // display_order NULLS LAST, then full_name; we use a
        // global display_order so Group 1's six rows always come
        // before Group 2's, matching the spec ("short break of a
        // few minutes between Head-to-Head from Group 1 and
        // Group 2"). Group-1 divers get display_order 1..6; Group
        // 2 gets 7..12.
        const orderByCompetitor = new Map();
        for (const pair of plan.pairs) {
          // Within Group 1: pairs at index 0, 3, 4 → group order 0, 1, 2
          // Within Group 2: pairs at index 1, 2, 5 → group order 0, 1, 2
          const groupPairOrder =
            pair.pair_index === 0 ? 0
            : pair.pair_index === 3 ? 1
            : pair.pair_index === 4 ? 2
            : pair.pair_index === 1 ? 0
            : pair.pair_index === 2 ? 1
            : 2; // pair_index === 5
          // Group 1 starts at display_order 1; Group 2 at 7.
          const groupBase = pair.group_number === 1 ? 1 : 7;
          // Lower-seeded diver of each pair dives first (Diver
          // 12 before Diver 1, etc.), so competitor_a_id (the
          // lower seed) gets the even-numbered slot in the pair
          // (1st of 2 within the pair).
          orderByCompetitor.set(pair.competitor_a_id, groupBase + groupPairOrder * 2);
          orderByCompetitor.set(pair.competitor_b_id, groupBase + groupPairOrder * 2 + 1);
        }

        // Per-diver: copy dive_id for rounds 1..3 from the parent
        // stage's submission. If a diver didn't have a row for a
        // given round in the parent (incomplete list), the dive_id
        // will be NULL and the diver will need to submit before
        // dive_list_locks_at.
        async function insertDiverRows(competitorId, dives, groupNumber, displayOrder) {
          const byRound = new Map(
            (dives || []).map((d) => [Number(d.round_number), d.dive_id]),
          );
          for (let r = 1; r <= 3; r++) {
            await client.query(
              `INSERT INTO competitor_dive_lists
                (event_id, competitor_id, dive_id, round_number,
                 display_order, group_number, is_reserve)
               VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
              [
                ev.id,
                competitorId,
                byRound.get(r) || null,
                r,
                displayOrder,
                groupNumber,
              ],
            );
          }
        }

        for (const pair of plan.pairs) {
          await insertDiverRows(
            pair.competitor_a_id,
            pair.dives_a,
            pair.group_number,
            orderByCompetitor.get(pair.competitor_a_id),
          );
          await insertDiverRows(
            pair.competitor_b_id,
            pair.dives_b,
            pair.group_number,
            orderByCompetitor.get(pair.competitor_b_id),
          );
        }

        // Lock the dive list — see stampDiveListLock for the WA
        // Article 6.7.3 window.
        const lockAtIso = await stampDiveListLock(client, ev.id, lockMin);

        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   ev.id,
          entity_name: ev.name,
          action:      "event.h2h_seeded",
          metadata: {
            parent_event_id: ev.parent_event_id,
            max_per_org:     maxPerOrg,
            lock_minutes:    lockMin,
            dive_list_locks_at: lockAtIso,
            pairs: plan.pairs.map((p) => ({
              pair_index:      p.pair_index,
              group_number:    p.group_number,
              seed_a:          p.seed_a,
              seed_b:          p.seed_b,
              competitor_a_id: p.competitor_a_id,
              competitor_b_id: p.competitor_b_id,
            })),
            capped_orgs: plan.capped,
          },
        });

        await client.query("COMMIT");

        // Push notifications to the 12 advanced divers — same
        // best-effort pattern as /advance.
        if (push && typeof push.sendNotification === "function") {
          try {
            const ids = plan.pairs.flatMap((p) => [p.competitor_a_id, p.competitor_b_id]);
            const lockHint = lockAtIso
              ? ` Locks at ${new Date(lockAtIso).toLocaleString()}.`
              : "";
            await push.sendNotification(ids, {
              category:  "h2h_seeded",
              title:     `You've advanced to "${ev.name}" Head-to-Head`,
              body:      `Pick your 3 H2H dives.${lockHint} Tap to confirm or edit.`,
              data:      {
                event_id:        ev.id,
                parent_event_id: ev.parent_event_id,
                lock_at:         lockAtIso,
              },
              action_url: `/competitor?event=${ev.id}`,
            });
          } catch (notifErr) {
            console.error("[H2H Seed Notification Skipped]", notifErr.message);
          }
        }

        res.json({
          seeded:             12,
          pairs:              plan.pairs.map((p) => ({
            pair_index:      p.pair_index,
            group_number:    p.group_number,
            seed_a:          p.seed_a,
            seed_b:          p.seed_b,
            competitor_a_id: p.competitor_a_id,
            competitor_b_id: p.competitor_b_id,
            full_name_a:     p.full_name_a,
            full_name_b:     p.full_name_b,
            country_code_a:  p.country_code_a,
            country_code_b:  p.country_code_b,
          })),
          dive_list_locks_at: lockAtIso,
          capped_orgs:        plan.capped,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Seed H2H Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // GET /api/events/:id/super-final/h2h-results — public read.
  //
  // Sums each diver's 3 H2H dives and declares the winner of each
  // pair. tied=true means the meet manager needs to resolve via
  // a dive-off (Phase 3c).
  //
  // Public-readable: the bracket outcome is part of the official
  // record, same posture as /api/scoreboard/:eventId.
  router.get(
    "/api/events/:id/super-final/h2h-results",
    async (req, res) => {
      try {
        const evRes = await pool.query(
          `SELECT id, event_format, parent_event_id FROM events WHERE id = $1`,
          [req.params.id],
        );
        if (!evRes.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        if (evRes.rows[0].event_format !== "super_final_h2h") {
          return res.status(400).json({ error: "Event is not a Super Final H2H stage" });
        }

        // Same pair reconstruction (group bucketing, display_order
        // sort, G1/G2 pair indexes, tie detection) as the seed-semi
        // flow — one algorithm in lib/super-final-helpers.js. Only
        // the wire shape lives here: the public contract is flat
        // *_a/*_b keys plus seeds derived from pair_index per
        // Appendix 3 §2.1.1, and the SPA + external consumers
        // parse exactly that.
        const pairs = await loadH2hPairResults(pool, req.params.id);
        const SEEDS_BY_PAIR_INDEX = [
          [12, 1], [11, 2], [10, 3], [9, 4], [8, 5], [7, 6],
        ];
        res.json({
          pairs: pairs.map((p) => ({
            pair_index:      p.pair_index,
            group_number:    p.group_number,
            seed_a:          SEEDS_BY_PAIR_INDEX[p.pair_index][0],
            seed_b:          SEEDS_BY_PAIR_INDEX[p.pair_index][1],
            competitor_a_id: p.competitor_a.id,
            competitor_b_id: p.competitor_b.id,
            full_name_a:     p.competitor_a.full_name,
            full_name_b:     p.competitor_b.full_name,
            country_code_a:  p.competitor_a.country_code,
            country_code_b:  p.competitor_b.country_code,
            total_a:         p.competitor_a.total,
            total_b:         p.competitor_b.total,
            winner_id:       p.winner_id,
            tied:            p.tied,
            tied_on_total:   p.tied_on_total,
            resolved_by:     p.resolved_by,
          })),
        });
      } catch (err) {
        console.error("[H2H Results Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );


  // POST /api/events/:id/seed-semi
  // :id is the SF event (event_format=super_final_semi). Pulls
  // the 6 H2H winners, sets score_carry_from = h2h.id so the
  // standings sum H2H + SF totals (Appendix 3 §3.1), seeds
  // each diver's parent dive_ids 4..5 (W) or 4..6 (M) into
  // SF round_numbers 1..2 / 1..3 (Appendix 3 §2.2.1).
  //
  // Body: { lock_minutes: 30 } (default).
  router.post(
    "/api/events/:id/seed-semi",
    requireEventManager(),
    async (req, res) => {
      const lockMin = Number.isFinite(parseInt(req.body?.lock_minutes))
        ? Math.max(0, Math.min(parseInt(req.body.lock_minutes), 24 * 60))
        : 30;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const evRes = await client.query(
          `SELECT id, event_format, status, parent_event_id, gender, name, total_rounds
             FROM events WHERE id = $1`,
          [req.params.id],
        );
        if (!evRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        const ev = evRes.rows[0];
        if (ev.event_format !== "super_final_semi") {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Event is not a Super Final SF stage" });
        }
        if (ev.status !== "Upcoming") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "SF must be Upcoming to seed (re-seeding only valid pre-Live)",
          });
        }
        if (!ev.parent_event_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "SF must have parent_event_id pointing at the H2H event",
          });
        }
        if (ev.gender === "Mixed") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Super Final isn't supported for Mixed individual events (Appendix 3 §1 — split by gender)",
          });
        }
        // Total rounds for SF: 2 dives for women, 3 for men
        // (Appendix 3 §2.2 — "Men: 3 additional dives, Women: 2
        // additional dives"). The event row holds the SF count
        // (2 or 3); we validate it matches the gender.
        const expectedSfRounds = ev.gender === "Male" ? 3 : 2;
        if (Number(ev.total_rounds) !== expectedSfRounds) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `SF total_rounds must be ${expectedSfRounds} for ${ev.gender} (Appendix 3 §2.2)`,
          });
        }

        const h2hRes = await client.query(
          `SELECT id, status, parent_event_id FROM events WHERE id = $1`,
          [ev.parent_event_id],
        );
        if (!h2hRes.rows.length || h2hRes.rows[0].status !== "Completed") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "H2H stage must be Completed before seeding SF",
          });
        }
        const h2h = h2hRes.rows[0];

        const pairs = await loadH2hPairResults(client, h2h.id);
        if (pairs.length !== 6) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `H2H must have exactly 6 pairs (got ${pairs.length})`,
          });
        }
        if (pairs.some((p) => p.tied)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Resolve dive-offs first — some H2H pairs are still tied",
          });
        }

        // The 6 winners regroup: G1 = winners from H2H G1 (3
        // divers); G2 = winners from H2H G2 (3 divers). Each
        // winner's group carries forward.
        const winners = [];
        for (const p of pairs) {
          const w = p.winner_id === p.competitor_a.id ? p.competitor_a : p.competitor_b;
          winners.push({
            competitor_id: w.id,
            full_name:     w.full_name,
            group_number:  p.group_number,
            h2h_total:     w.total,
          });
        }

        // Reverse-rank within group: the LOWEST scorer in each
        // group dives first (Appendix 3 §2.2 — "starting order
        // is reversed from H2H results within the same group").
        // Group 1 winners get display_order 1..3; Group 2 get
        // 4..6. Lowest H2H score within group → 1 / 4
        // (dives first), highest → 3 / 6.
        const orderByCompetitor = new Map();
        for (const g of [1, 2]) {
          const inGroup = winners
            .filter((w) => w.group_number === g)
            .sort((a, b) => a.h2h_total - b.h2h_total); // ascending
          const base = g === 1 ? 1 : 4;
          inGroup.forEach((w, i) => orderByCompetitor.set(w.competitor_id, base + i));
        }

        // Pull each winner's parent (Stop-1) submission so we
        // can copy dives 4..5 (W) or 4..6 (M). The "parent" of
        // the SF in the dive-list sense is the H2H's parent —
        // the actual Stop-1 final/qualifier where the divers
        // submitted their full lists. h2h.parent_event_id is
        // that event.
        if (!h2h.parent_event_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "H2H stage is missing parent_event_id (the Stop-1 qualifier)",
          });
        }
        // Map: competitor_id → { round_number → dive_id } from
        // the original Stop-1 submission. Rounds 4..5/6 are the
        // SF's dives.
        const stop1ListsRes = await client.query(
          `SELECT competitor_id, round_number, dive_id
             FROM competitor_dive_lists
            WHERE event_id = $1
              AND withdrawn_at IS NULL
              AND is_reserve = FALSE
              AND competitor_id = ANY($2::uuid[])`,
          [h2h.parent_event_id, winners.map((w) => w.competitor_id)],
        );
        const stop1ByCompetitor = new Map();
        for (const r of stop1ListsRes.rows) {
          if (!stop1ByCompetitor.has(r.competitor_id)) {
            stop1ByCompetitor.set(r.competitor_id, new Map());
          }
          stop1ByCompetitor.get(r.competitor_id).set(Number(r.round_number), r.dive_id);
        }

        // Refuse if scores already exist — see refuseIfScoresExist.
        const scoresErrSemi = await refuseIfScoresExist(client, ev.id);
        if (scoresErrSemi) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: scoresErrSemi });
        }

        // Wipe + reseed.
        await client.query(
          "DELETE FROM competitor_dive_lists WHERE event_id = $1",
          [ev.id],
        );

        // Seed SF rows. Each diver gets total_rounds rows;
        // round_number r in the SF event uses the Stop-1
        // submission's round (3 + r) — i.e. SF round 1 → Stop-1
        // round 4, SF round 2 → Stop-1 round 5, SF round 3
        // (men only) → Stop-1 round 6. One multi-row INSERT; the
        // UNNEST arrays stay aligned by index.
        const seedRows = {
          competitor_ids: [], dive_ids: [], round_numbers: [],
          display_orders: [], group_numbers: [],
        };
        for (const w of winners) {
          const stop1Map = stop1ByCompetitor.get(w.competitor_id) || new Map();
          for (let r = 1; r <= expectedSfRounds; r++) {
            const stop1Round = 3 + r; // SF r=1 → parent r=4, etc.
            seedRows.competitor_ids.push(w.competitor_id);
            seedRows.dive_ids.push(stop1Map.get(stop1Round) || null);
            seedRows.round_numbers.push(r);
            seedRows.display_orders.push(orderByCompetitor.get(w.competitor_id));
            seedRows.group_numbers.push(w.group_number);
          }
        }
        await client.query(
          `INSERT INTO competitor_dive_lists
            (event_id, competitor_id, dive_id, round_number,
             display_order, group_number, is_reserve)
           SELECT $1::uuid, t.competitor_id, t.dive_id, t.round_number,
                  t.display_order, t.group_number, FALSE
           FROM UNNEST($2::uuid[], $3::uuid[], $4::int[], $5::int[], $6::int[])
             AS t(competitor_id, dive_id, round_number, display_order,
                  group_number)`,
          [
            ev.id,
            seedRows.competitor_ids, seedRows.dive_ids, seedRows.round_numbers,
            seedRows.display_orders, seedRows.group_numbers,
          ],
        );

        // Set score_carry_from so standings include H2H
        // (Appendix 3 §3.1 — "H2H scores carry forward to SF").
        await client.query(
          "UPDATE events SET score_carry_from = $2 WHERE id = $1",
          [ev.id, h2h.id],
        );

        // Lock window — same WA Article 6.7.3 default as
        // /advance, but this stage runs immediately after H2H so
        // the operator may want a tighter window. Default 30.
        const lockAtIso = await stampDiveListLock(client, ev.id, lockMin);

        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   ev.id,
          entity_name: ev.name,
          action:      "event.semi_seeded",
          metadata: {
            h2h_event_id:    h2h.id,
            stop1_event_id:  h2h.parent_event_id,
            score_carry_from: h2h.id,
            sf_rounds:       expectedSfRounds,
            gender:          ev.gender,
            lock_minutes:    lockMin,
            dive_list_locks_at: lockAtIso,
            winners: winners.map((w) => ({
              competitor_id: w.competitor_id,
              group_number:  w.group_number,
              h2h_total:     w.h2h_total,
            })),
          },
        });

        await client.query("COMMIT");

        // Push notifications to the 6 advanced divers.
        if (push && typeof push.sendNotification === "function") {
          try {
            const ids = winners.map((w) => w.competitor_id);
            const lockHint = lockAtIso
              ? ` Locks at ${new Date(lockAtIso).toLocaleString()}.`
              : "";
            await push.sendNotification(ids, {
              category:  "sf_seeded",
              title:     `You've advanced to "${ev.name}" Semi Final`,
              body:      `Your remaining ${expectedSfRounds} dives carry forward from your Stop-1 submission.${lockHint}`,
              data:      { event_id: ev.id, h2h_event_id: h2h.id, lock_at: lockAtIso },
              action_url: `/competitor?event=${ev.id}`,
            });
          } catch (notifErr) {
            console.error("[SF Seed Notification Skipped]", notifErr.message);
          }
        }

        const byGroup = { 1: [], 2: [] };
        for (const w of winners) {
          byGroup[w.group_number].push({
            competitor_id: w.competitor_id,
            full_name:     w.full_name,
            display_order: orderByCompetitor.get(w.competitor_id),
            h2h_total:     w.h2h_total,
          });
        }

        res.json({
          seeded:             6,
          score_carry_from:   h2h.id,
          sf_rounds:          expectedSfRounds,
          gender:             ev.gender,
          by_group:           byGroup,
          dive_list_locks_at: lockAtIso,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Seed SF Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );


  // POST /api/events/:id/seed-final
  // :id is the F event (event_format=super_final_final). Top-2
  // per SF group on cumulative score (H2H+SF) → 4 finalists.
  // F resets scores (Appendix 3 §3.2 — score_carry_from=NULL).
  // F.total_rounds = 5 (W) / 6 (M); roster seeds full Stop-1
  // submission rounds 1..5/6.
  //
  // Body: { lock_minutes: 15 } (Appendix 3 §4.1 — 15-min break
  // between SF and F, change-of-dives must be made AFTER SF and
  // at LATEST 5 minutes before F → effective lock at NOW() +
  // (lock_minutes - 5)).
  router.post(
    "/api/events/:id/seed-final",
    requireEventManager(),
    async (req, res) => {
      const rawLockMin = Number.isFinite(parseInt(req.body?.lock_minutes))
        ? Math.max(5, Math.min(parseInt(req.body.lock_minutes), 24 * 60))
        : 15;
      // Effective lock: 5-min buffer before F starts (Appendix 3 §4.1).
      const lockMin = Math.max(0, rawLockMin - 5);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const evRes = await client.query(
          `SELECT id, event_format, status, parent_event_id, gender, name, total_rounds
             FROM events WHERE id = $1`,
          [req.params.id],
        );
        if (!evRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        const ev = evRes.rows[0];
        if (ev.event_format !== "super_final_final") {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Event is not a Super Final F stage" });
        }
        if (ev.status !== "Upcoming") {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "F must be Upcoming to seed" });
        }
        if (!ev.parent_event_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "F must have parent_event_id pointing at the SF event",
          });
        }
        const expectedFRounds = ev.gender === "Male" ? 6 : 5;
        if (Number(ev.total_rounds) !== expectedFRounds) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `F total_rounds must be ${expectedFRounds} for ${ev.gender} (Appendix 3 §2.3 — full dive list)`,
          });
        }

        const sfRes = await client.query(
          `SELECT id, status, parent_event_id FROM events WHERE id = $1`,
          [ev.parent_event_id],
        );
        if (!sfRes.rows.length || sfRes.rows[0].status !== "Completed") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "SF stage must be Completed before seeding F",
          });
        }
        const sf = sfRes.rows[0];

        // The Stop-1 dive list lives at h2h.parent_event_id; the
        // SF.parent_event_id points at H2H, so we walk H2H to
        // find the Stop-1 event id.
        const h2hRes = await client.query(
          "SELECT id, parent_event_id FROM events WHERE id = $1",
          [sf.parent_event_id],
        );
        const stop1EventId = h2hRes.rows[0]?.parent_event_id;
        if (!stop1EventId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Could not resolve Stop-1 event from SF chain (SF → H2H → Stop-1)",
          });
        }

        const sfRows = await loadSfCumulative(client, sf.id);
        if (sfRows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "SF stage has no scored divers — cannot seed F",
          });
        }
        // Top 2 per group on cumulative_total. A within-group tie on
        // the qualifying cut-off is broken by the recorded SF dive-off
        // (Appendix 3 §6); if two divers are tied across the 2nd/3rd
        // boundary with no dive-off, refuse — the same gate seed-semi
        // applies to H2H pairs.
        const sfDiveOffs = await loadResolvedDiveOffs(client, sf.id);
        const finalists = [];
        const unresolvedGroups = [];
        for (const g of [1, 2]) {
          const inGroup = sfRows
            .filter((r) => r.group_number === g)
            .sort((a, b) => compareSfFinalists(a, b, sfDiveOffs));
          if (
            inGroup.length > 2 &&
            inGroup[1].cumulative_total === inGroup[2].cumulative_total &&
            !sfDiveOffs.get(diveOffPairKey(inGroup[1].competitor_id, inGroup[2].competitor_id))
          ) {
            unresolvedGroups.push(g);
          }
          finalists.push(...inGroup.slice(0, 2));
        }
        if (unresolvedGroups.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `Resolve dive-offs first — SF group ${unresolvedGroups.join(" & ")} ${unresolvedGroups.length === 1 ? "has a tie" : "have ties"} at the qualifying cut-off`,
          });
        }
        if (finalists.length !== 4) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `Expected 4 finalists (top-2 per group); got ${finalists.length}`,
          });
        }

        // Pull each finalist's full Stop-1 dive list (rounds
        // 1..5/6) so we can seed it verbatim into the F event.
        const stop1ListsRes = await client.query(
          `SELECT competitor_id, round_number, dive_id
             FROM competitor_dive_lists
            WHERE event_id = $1
              AND withdrawn_at IS NULL
              AND is_reserve = FALSE
              AND competitor_id = ANY($2::uuid[])`,
          [stop1EventId, finalists.map((f) => f.competitor_id)],
        );
        const stop1ByCompetitor = new Map();
        for (const r of stop1ListsRes.rows) {
          if (!stop1ByCompetitor.has(r.competitor_id)) {
            stop1ByCompetitor.set(r.competitor_id, new Map());
          }
          stop1ByCompetitor.get(r.competitor_id).set(Number(r.round_number), r.dive_id);
        }

        // Reverse rank: highest cumulative dives last (display_order=4).
        // Order finalists by cumulative_total ascending and assign 1..4.
        const ordered = [...finalists].sort((a, b) => a.cumulative_total - b.cumulative_total);
        const orderByCompetitor = new Map();
        ordered.forEach((f, i) => orderByCompetitor.set(f.competitor_id, i + 1));

        // Refuse if scores already exist — see refuseIfScoresExist.
        const scoresErrFinal = await refuseIfScoresExist(client, ev.id);
        if (scoresErrFinal) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: scoresErrFinal });
        }

        await client.query(
          "DELETE FROM competitor_dive_lists WHERE event_id = $1",
          [ev.id],
        );

        // One multi-row INSERT; the UNNEST arrays stay aligned by
        // index. group_number is NULL in the F event — groups only
        // exist in the H2H / SF stages.
        const seedRows = {
          competitor_ids: [], dive_ids: [], round_numbers: [], display_orders: [],
        };
        for (const f of finalists) {
          const stop1Map = stop1ByCompetitor.get(f.competitor_id) || new Map();
          for (let r = 1; r <= expectedFRounds; r++) {
            seedRows.competitor_ids.push(f.competitor_id);
            seedRows.dive_ids.push(stop1Map.get(r) || null);
            seedRows.round_numbers.push(r);
            seedRows.display_orders.push(orderByCompetitor.get(f.competitor_id));
          }
        }
        await client.query(
          `INSERT INTO competitor_dive_lists
            (event_id, competitor_id, dive_id, round_number,
             display_order, group_number, is_reserve)
           SELECT $1::uuid, t.competitor_id, t.dive_id, t.round_number,
                  t.display_order, NULL::int, FALSE
           FROM UNNEST($2::uuid[], $3::uuid[], $4::int[], $5::int[])
             AS t(competitor_id, dive_id, round_number, display_order)`,
          [
            ev.id,
            seedRows.competitor_ids, seedRows.dive_ids,
            seedRows.round_numbers, seedRows.display_orders,
          ],
        );

        // F resets scores (Appendix 3 §3.2). Make sure
        // score_carry_from is NULL.
        await client.query(
          "UPDATE events SET score_carry_from = NULL WHERE id = $1",
          [ev.id],
        );

        // Lock window — Appendix 3 §4.1: 15-min break between
        // SF and F, change-of-dives must be made up to "5
        // minutes before the Final" → effective lock = NOW() +
        // (lock_minutes - 5), already folded into lockMin above.
        const lockAtIso = await stampDiveListLock(client, ev.id, lockMin);

        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   ev.id,
          entity_name: ev.name,
          action:      "event.final_seeded",
          metadata: {
            sf_event_id:        sf.id,
            stop1_event_id:     stop1EventId,
            f_rounds:           expectedFRounds,
            gender:             ev.gender,
            lock_minutes_input: rawLockMin,
            lock_minutes_eff:   lockMin,
            dive_list_locks_at: lockAtIso,
            finalists: finalists.map((f) => ({
              competitor_id:    f.competitor_id,
              cumulative_total: f.cumulative_total,
              group_number:     f.group_number,
            })),
          },
        });

        await client.query("COMMIT");

        if (push && typeof push.sendNotification === "function") {
          try {
            const ids = finalists.map((f) => f.competitor_id);
            const lockHint = lockAtIso
              ? ` Dive list locks at ${new Date(lockAtIso).toLocaleString()} (5 min before the Final).`
              : "";
            await push.sendNotification(ids, {
              category:  "f_seeded",
              title:     `You've advanced to "${ev.name}" Final`,
              body:      `Scores reset — full ${expectedFRounds}-dive list. Highest cumulative dives last.${lockHint}`,
              data:      { event_id: ev.id, sf_event_id: sf.id, lock_at: lockAtIso },
              action_url: `/competitor?event=${ev.id}`,
            });
          } catch (notifErr) {
            console.error("[F Seed Notification Skipped]", notifErr.message);
          }
        }

        res.json({
          seeded:             4,
          f_rounds:           expectedFRounds,
          gender:             ev.gender,
          finalists: finalists.map((f) => ({
            competitor_id:    f.competitor_id,
            full_name:        f.full_name,
            country_code:     f.country_code,
            cumulative_total: f.cumulative_total,
            display_order:    orderByCompetitor.get(f.competitor_id),
            group_number:     f.group_number,
          })),
          dive_list_locks_at: lockAtIso,
          score_carry_from:   null,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Seed F Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // Dive-off routes (Super Final Appendix 3 §6) moved into a
  // sub-router so this file stays scannable. See
  // routes/events/dive-offs.js for the GET / POST / PATCH
  // handlers.
  router.use(require("./dive-offs")({ pool, requireEventManager }));

  // Super-Final synchro reserve + merged-rankings routes moved
  // into a sub-router. See routes/events/super-final-bridge.js.
  // The seed-semi / seed-final POST handlers above still use
  // loadH2hPairResults + loadSfCumulative; both helpers now
  // live in lib/super-final-helpers.js so both this file and
  // the sub-router can import them.
  router.use(require("./super-final-bridge")({ pool, requireEventManager }));


  // Reserves routes (list + promote, with WA Article 4.1.8 /
  // 4.1.10 / 4.1.12 reverse-rank shift on replacement) moved
  // into a sub-router. See routes/events/reserves.js.
  router.use(require("./reserves")({ pool, requireEventManager, push }));

  return router;
};
