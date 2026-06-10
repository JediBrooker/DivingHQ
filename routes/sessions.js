// Sessions / Schedule routes — Phases 1, 2, 3 & 4.
//
//   GET    /api/meets/:meetId/sessions               sessions + inlined blocks (P1)
//   GET    /api/meets/:meetId/schedule.ics           iCal feed, public (P1)
//   GET    /api/meets/:meetId/conflicts              conflict report (P2)
//   POST   /api/conflicts/dismiss                    dismiss a conflict (P2, auth)
//   DELETE /api/conflicts/dismiss/:id                un-dismiss a conflict (P2, auth)
//   PUT    /api/sessions/:id                         edit session metadata (P3, auth)
//   POST   /api/sessions/:id/duplicate               clone forward one day (P3, auth)
//   POST   /api/sessions/:sessionId/blocks           insert a block (P3, auth)
//   PUT    /api/blocks/:id                           edit a block (P3, auth)
//   DELETE /api/blocks/:id                           delete a block (P3, auth)
//   GET    /api/meets/:meetId/judges/availability    availability hint (P3)
//   POST   /api/blocks/reflow                        confirm live re-flow (P4, auth)
//
// Phase 1 shipped the read-only timeline and the iCal feed. Phase 2
// added conflict detection + per-conflict dismissal (§5). Phase 3
// (this layer) lights up manual editing per §2 of the design doc:
// drag-to-reorder / resize / insert / delete on the timeline, the
// "Duplicate to next day" action (§8.4), and a schedule-aware judge
// availability hint backing the panel picker. The schema for all of
// this was already created by migration 049, so Phase 3 is API + UI
// only — no new migration.
//
// EDIT-PATH CONFLICT RETURN
// -------------------------
// Every write that changes a block's window / boards / event /
// session re-runs detectConflicts(meetId) and filters the result to
// conflicts involving the just-touched block. We hand that subset
// back inline so the front-end can flash the block and surface the
// new entries in the drawer without a separate refetch round-trip.
// The full /api/meets/:meetId/conflicts list still rebuilds on the
// next drawer poll — the inline subset is a UX latency win, not a
// new source of truth.
//
// Phase 4 (live re-flow, this revision): operator marks an event
// Complete via PUT /api/events/:id/status — the events router calls
// buildReflowProposal() from lib/schedule-reflow.js and returns the
// proposal alongside the event row. The Control Room shows the
// modal, the operator picks which downstream blocks to shift, and
// the confirmed subset POSTs to /api/blocks/reflow below. That
// endpoint atomically shifts windows + appends the
// schedule_block_shifts ledger + emits schedule:shifted, which the
// SchedulerView's existing socket subscription picks up.
//
// SEEDING
// -------
// Sessions are seeded *lazily* the first time a meet editor opens
// the scheduler, rather than backfilled by the migration. Public
// reads never create rows. The seed runs inside a transaction and
// takes a per-meet advisory lock before it checks for existing
// sessions, so two managers opening the page simultaneously do
// not duplicate the day plan.
//
// EVENT-DURATION ESTIMATE
// -----------------------
// total_rounds × competitor_count × 90 seconds. Falls back to
// 90 minutes when an event has no competitors yet (the common
// case before sign-ups close). Crude, but the operator can drag
// in phase 3 — the seed is a starting point, not a constraint.
//
// Mounted via:
//   app.use(require('./routes/sessions')({ pool, optionalAuth }))

const express = require("express");
const {
  detectConflicts,
  computeResourceFingerprint,
} = require("../lib/schedule-conflicts");
const {
  buildReflowProposal,
  stampActualStart,
  REFLOW_NOISE_THRESHOLD_MS,
} = require("../lib/schedule-reflow");
const { recordAudit, auditFromReq } = require("../lib/audit");

// Default operator warmup length in front of every competition
// event. Editable per-block in phase 3 — for now it's the
// auto-seed value.
const WARMUP_MINUTES = 45;

// Fallback when an event has zero competitor_dive_lists rows
// (sign-ups haven't closed yet, or it's a draft event). 90 min
// matches a typical 6-round individual event with ~6 divers.
const FALLBACK_EVENT_MINUTES = 90;

// Per-dive seconds used in the duration heuristic. Matches the
// rule-of-thumb commentators use: ~1.5 minutes per dive once
// you bake in walk-up + replay + judge entry.
const SECONDS_PER_DIVE = 90;

// Heights the auto-seed creates boards for in "Main pool".
// Skips '0m' (poolside / non-board events) — those are the
// outlier and the operator can add a board manually later.
const SEEDED_BOARD_HEIGHTS = ["1m", "3m", "5m", "7.5m", "10m"];

// In-process cache for the conflict detector. The timeline drawer
// re-renders on every block-hover and the modal flow can ask for
// the full conflict list multiple times in quick succession; this
// absorbs that chatter without hammering the planner. 5 seconds is
// short enough that a freshly dismissed conflict shows up on the
// next drawer poll — the explicit `socket emit` after dismissal
// also drops the cache so updates feel instant on the original
// tab.
const CONFLICT_CACHE_TTL_MS = 5000;
const conflictCache = new Map(); // meetId -> { at: ms, value: Conflict[] }

function cachedConflicts(meetId) {
  const entry = conflictCache.get(meetId);
  if (!entry) return null;
  if (Date.now() - entry.at > CONFLICT_CACHE_TTL_MS) {
    conflictCache.delete(meetId);
    return null;
  }
  return entry.value;
}

function invalidateConflictCache(meetId) {
  if (!meetId) {
    conflictCache.clear();
    return;
  }
  conflictCache.delete(meetId);
}

module.exports = function createSessionsRouter({
  pool,
  optionalAuth,
  // Phase 2 additions — optional so the Phase 1 callsite (no auth /
  // no socket) still works if someone keeps the old signature, but
  // server.js wires them all in now so the conflict dismiss + emit
  // surface is live.
  requireMeetEditor,
  io,
} = {}) {
  if (!pool) throw new Error("createSessionsRouter requires { pool, … }");
  const router = express.Router();
  const maybeAuth = optionalAuth || ((req, _res, next) => next());

  // The dismiss endpoints need an auth gate. requireMeetEditor is
  // an array of middleware (role check + TOTP gate) — falls back
  // to a 503 if the host wired the router without it, so a
  // partially-configured deploy fails loudly instead of silently
  // accepting unauth'd dismissals.
  const editorGate = requireMeetEditor || ((_req, res) =>
    res.status(503).json({
      error: "Conflict dismissal requires an authenticated configuration",
    }));

  function userCanEditMeet(req, meet) {
    if (!req.user || !meet) return false;
    if (req.user.is_system_admin) return true;
    if (String(meet.org_id) !== String(req.user.org_id)) return false;
    const roles = req.user.org_roles || [];
    return roles.includes("org_admin") || roles.includes("meet_manager");
  }

  async function requireMeetEdit(client, req, res, meetId) {
    const r = await client.query(
      `SELECT id, org_id, name FROM meets WHERE id = $1`,
      [meetId],
    );
    if (!r.rowCount) {
      res.status(404).json({ error: "Meet not found" });
      return null;
    }
    const meet = r.rows[0];
    if (!userCanEditMeet(req, meet)) {
      res.status(403).json({ error: "You cannot edit this meet schedule" });
      return null;
    }
    return meet;
  }

  async function requireSessionEdit(client, req, res, sessionId) {
    const r = await client.query(
      `SELECT s.id AS session_id, s.name AS session_name,
              m.id, m.org_id, m.name
         FROM sessions s
         JOIN meets m ON m.id = s.meet_id
        WHERE s.id = $1`,
      [sessionId],
    );
    if (!r.rowCount) {
      res.status(404).json({ error: "Session not found" });
      return null;
    }
    const row = r.rows[0];
    const meet = { id: row.id, org_id: row.org_id, name: row.name };
    if (!userCanEditMeet(req, meet)) {
      res.status(403).json({ error: "You cannot edit this meet schedule" });
      return null;
    }
    return { meet, session_id: row.session_id, session_name: row.session_name };
  }

  async function requireBlockEdit(client, req, res, blockId) {
    const r = await client.query(
      `SELECT b.id AS block_id, b.session_id, b.label, b.starts_at, b.ends_at,
              s.meet_id,
              m.org_id, m.name AS meet_name
         FROM schedule_blocks b
         JOIN sessions s ON s.id = b.session_id
         JOIN meets m ON m.id = s.meet_id
        WHERE b.id = $1`,
      [blockId],
    );
    if (!r.rowCount) {
      res.status(404).json({ error: "Block not found" });
      return null;
    }
    const row = r.rows[0];
    const meet = { id: row.meet_id, org_id: row.org_id, name: row.meet_name };
    if (!userCanEditMeet(req, meet)) {
      res.status(403).json({ error: "You cannot edit this meet schedule" });
      return null;
    }
    return { meet, block: row };
  }

  async function auditSchedule(db, req, {
    meet,
    entityType,
    entityId,
    entityName = null,
    action,
    metadata = null,
    note = null,
  }) {
    await recordAudit(db, {
      ...auditFromReq(req),
      org_id: meet?.org_id || null,
      entity_type: entityType,
      entity_id: entityId || null,
      entity_name: entityName,
      action,
      metadata,
      note,
    });
  }

  // -------------------------------------------------------------
  // Seed helpers — both idempotent in the sense that they no-op
  // when their target rows already exist for the org / meet.
  // -------------------------------------------------------------

  async function ensureBoardsForOrg(client, orgId) {
    const existing = await client.query(
      `SELECT 1 FROM boards
        WHERE org_id = $1 AND archived_at IS NULL
        LIMIT 1`,
      [orgId],
    );
    if (existing.rowCount) return;
    // One board per seeded height in "Main pool". display_order
    // mirrors SEEDED_BOARD_HEIGHTS so the timeline columns render
    // shallowest → deepest left-to-right, matching the way
    // venues label boards.
    for (let i = 0; i < SEEDED_BOARD_HEIGHTS.length; i++) {
      const h = SEEDED_BOARD_HEIGHTS[i];
      await client.query(
        `INSERT INTO boards (org_id, pool_name, height, display_order)
         VALUES ($1, 'Main pool', $2, $3)
         ON CONFLICT (org_id, pool_name, height, label) DO NOTHING`,
        [orgId, h, i],
      );
    }
  }

  // Estimate the duration of a single event_start block in ms.
  // Falls back to FALLBACK_EVENT_MINUTES when competitor_count
  // is zero (no dive lists submitted yet).
  function estimateEventDurationMs(totalRounds, competitorCount) {
    if (!competitorCount || competitorCount <= 0) {
      return FALLBACK_EVENT_MINUTES * 60 * 1000;
    }
    const rounds = totalRounds && totalRounds > 0 ? totalRounds : 6;
    return rounds * competitorCount * SECONDS_PER_DIVE * 1000;
  }

  async function seedSessionsForMeet(client, meetId, orgId) {
    // Are there any events in this meet with a scheduled_at?
    // No scheduled_at → nothing for the seed to anchor against;
    // we leave the meet without sessions and the GET returns
    // [] until the operator stamps times.
    const eventsRes = await client.query(
      `SELECT e.id, e.name, e.height, e.total_rounds, e.scheduled_at,
              e.board_id,
              COALESCE((
                SELECT COUNT(DISTINCT competitor_id)
                FROM competitor_dive_lists
                WHERE event_id = e.id AND withdrawn_at IS NULL
              ), 0)::int AS competitor_count
         FROM events e
        WHERE e.meet_id = $1 AND e.scheduled_at IS NOT NULL
        ORDER BY e.scheduled_at ASC`,
      [meetId],
    );
    if (!eventsRes.rowCount) return;

    // Distinct days the meet covers, in UTC. The session-row
    // name uses the event-day in UTC; the front-end re-renders
    // in the viewer's locale. Discrete dates is the right grain
    // here — a one-day session "Saturday morning, 3m" on top of
    // a UTC instant matches how operators talk about the meet.
    const dayBuckets = new Map(); // ISO date -> sessionId (created below)
    for (const ev of eventsRes.rows) {
      const dayKey = ev.scheduled_at.toISOString().slice(0, 10);
      if (!dayBuckets.has(dayKey)) {
        const sessRes = await client.query(
          `INSERT INTO sessions (meet_id, name, session_date, pool)
           VALUES ($1, $2, $3::date, 'Main pool')
           RETURNING id`,
          [meetId, `Session — ${dayKey}`, dayKey],
        );
        dayBuckets.set(dayKey, sessRes.rows[0].id);
      }
    }

    // Look up the seeded "Main pool" boards once. Matching is
    // by enum height; events.board_id (if the operator already
    // pinned one) wins over the height lookup. Heights with no
    // matching board (e.g. a 0m exhibition event) drop through
    // with an empty board_ids array — the block still renders,
    // just not in a specific column.
    const boardsRes = await client.query(
      `SELECT id, height
         FROM boards
        WHERE org_id = $1 AND pool_name = 'Main pool' AND archived_at IS NULL`,
      [orgId],
    );
    const boardByHeight = new Map();
    for (const b of boardsRes.rows) boardByHeight.set(b.height, b.id);

    // One multi-row INSERT for the whole seed (2 rows per event:
    // warmup then event_start, same order the per-row loop used).
    // The UNNEST arrays stay aligned by index. board_ids is uuid[]
    // per row but the seed only ever pins zero-or-one board, so a
    // scalar board_id column is re-wrapped to the array form in SQL.
    const blockRows = {
      session_ids: [], block_types: [], labels: [],
      starts: [], ends: [], board_ids: [], event_ids: [],
    };
    for (const ev of eventsRes.rows) {
      const sessionId = dayBuckets.get(ev.scheduled_at.toISOString().slice(0, 10));
      const startsAt = new Date(ev.scheduled_at);
      const endsAt = new Date(
        startsAt.getTime() +
          estimateEventDurationMs(ev.total_rounds, ev.competitor_count),
      );
      const warmupStarts = new Date(startsAt.getTime() - WARMUP_MINUTES * 60 * 1000);
      const boardId = ev.board_id || (ev.height ? boardByHeight.get(ev.height) : null) || null;

      blockRows.session_ids.push(sessionId, sessionId);
      blockRows.block_types.push("warmup", "event_start");
      blockRows.labels.push(`Warmup — ${ev.name}`, ev.name);
      blockRows.starts.push(warmupStarts, startsAt);
      blockRows.ends.push(startsAt, endsAt);
      blockRows.board_ids.push(boardId, boardId);
      blockRows.event_ids.push(null, ev.id);
    }
    await client.query(
      `INSERT INTO schedule_blocks
         (session_id, block_type, label, starts_at, ends_at, board_ids, event_id)
       SELECT t.session_id, t.block_type::schedule_block_type, t.label,
              t.starts_at, t.ends_at,
              CASE WHEN t.board_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[t.board_id] END,
              t.event_id
       FROM UNNEST($1::uuid[], $2::text[], $3::text[], $4::timestamptz[],
                   $5::timestamptz[], $6::uuid[], $7::uuid[])
         AS t(session_id, block_type, label, starts_at, ends_at, board_id, event_id)`,
      [
        blockRows.session_ids, blockRows.block_types, blockRows.labels,
        blockRows.starts, blockRows.ends, blockRows.board_ids, blockRows.event_ids,
      ],
    );
  }

  // -------------------------------------------------------------
  // GET /api/meets/:meetId/sessions
  //
  // Returns [{ ...session, blocks: [...] }] with blocks inlined
  // (avoids N+1 on render). On the first call for a meet that
  // has events with scheduled_at but no sessions, the boards
  // and sessions are seeded inside a transaction.
  // -------------------------------------------------------------
  router.get("/api/meets/:meetId/sessions", maybeAuth, async (req, res) => {
    const { meetId } = req.params;
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const meetRes = await client.query(
        `SELECT id, org_id, name FROM meets WHERE id = $1`,
        [meetId],
      );
      if (!meetRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Meet not found" });
      }
      const meet = meetRes.rows[0];
      const orgId = meet.org_id;
      const canSeed = userCanEditMeet(req, meet);

      if (canSeed) {
        // Only authenticated meet editors create the initial board
        // and session rows. Public schedule views are pure reads.
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          [`schedule-seed:${meetId}`],
        );
        await ensureBoardsForOrg(client, orgId);
        const have = await client.query(
          `SELECT 1 FROM sessions WHERE meet_id = $1 LIMIT 1`,
          [meetId],
        );
        if (!have.rowCount) {
          await seedSessionsForMeet(client, meetId, orgId);
          await auditSchedule(client, req, {
            meet,
            entityType: "meet",
            entityId: meet.id,
            entityName: meet.name,
            action: "schedule.seeded",
          });
        }
      }

      // Read back. Sessions ordered by session_date so the UI
      // can render top-down; blocks ordered by starts_at so the
      // front-end doesn't have to re-sort.
      const sessionsRes = await client.query(
        `SELECT s.id, s.meet_id, s.name, s.session_date, s.pool,
                s.referee_user_id, s.created_at, s.updated_at
           FROM sessions s
          WHERE s.meet_id = $1
          ORDER BY s.session_date ASC, s.created_at ASC`,
        [meetId],
      );
      const sessionIds = sessionsRes.rows.map((r) => r.id);
      let blocks = [];
      if (sessionIds.length) {
        const blocksRes = await client.query(
          `SELECT b.id, b.session_id, b.block_type, b.label,
                  b.starts_at, b.ends_at, b.board_ids, b.event_id,
                  b.actual_start_at, b.actual_end_at, b.notes,
                  b.created_at, b.updated_at,
                  e.name AS event_name, e.height AS event_height
             FROM schedule_blocks b
             LEFT JOIN events e ON e.id = b.event_id
            WHERE b.session_id = ANY($1::uuid[])
            ORDER BY b.starts_at ASC, b.created_at ASC`,
          [sessionIds],
        );
        blocks = blocksRes.rows;
      }

      // Boards for the org so the front-end can render columns
      // without a second round trip. Filtered to non-archived.
      const boardsRes = await client.query(
        `SELECT id, pool_name, height, label, display_order
           FROM boards
          WHERE org_id = $1 AND archived_at IS NULL
          ORDER BY pool_name ASC, display_order ASC, height ASC`,
        [orgId],
      );

      const eventsRes = await client.query(
        `SELECT id, name, height, board_id, scheduled_at, status
           FROM events
          WHERE meet_id = $1
          ORDER BY scheduled_at ASC NULLS LAST, name ASC`,
        [meetId],
      );

      await client.query("COMMIT");

      const blocksBySession = new Map();
      for (const b of blocks) {
        if (!blocksBySession.has(b.session_id)) blocksBySession.set(b.session_id, []);
        blocksBySession.get(b.session_id).push(b);
      }
      const sessions = sessionsRes.rows.map((s) => ({
        ...s,
        blocks: blocksBySession.get(s.id) || [],
      }));
      res.json({ sessions, boards: boardsRes.rows, events: eventsRes.rows });
    } catch (err) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      }
      console.error("[GET sessions]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      if (client) client.release();
    }
  });

  // -------------------------------------------------------------
  // GET /api/meets/:meetId/schedule.ics
  //
  // Public iCal feed — one VEVENT per schedule_block. Coaches
  // subscribe in Apple Calendar / Outlook / Google Calendar and
  // re-fetch on their client's cadence; later phases' re-flow
  // shifts propagate automatically without push.
  //
  // No auth (parity with the public schedule page surface, which
  // ships in a later phase). The endpoint never emits anything
  // that wasn't already on the public scoreboard, so there's no
  // info leak.
  // -------------------------------------------------------------
  router.get("/api/meets/:meetId/schedule.ics", async (req, res) => {
    const { meetId } = req.params;
    try {
      const meetRes = await pool.query(
        `SELECT m.id, m.name, m.venue, o.name AS org_name
           FROM meets m
           JOIN organisations o ON o.id = m.org_id
          WHERE m.id = $1`,
        [meetId],
      );
      if (!meetRes.rowCount) {
        return res.status(404).type("text/plain").send("Meet not found");
      }
      const meet = meetRes.rows[0];

      // Pull blocks with their session, plus the human-readable
      // board labels concatenated server-side so the iCal writer
      // doesn't need a second query per row.
      const blocksRes = await pool.query(
        `SELECT b.id, b.block_type, b.label,
                b.starts_at, b.ends_at, b.notes,
                s.name AS session_name, s.pool AS session_pool,
                COALESCE((
                  SELECT string_agg(
                    COALESCE(bd.label, bd.height::text), ', '
                    ORDER BY bd.display_order
                  )
                  FROM boards bd
                  WHERE bd.id = ANY(b.board_ids)
                ), '') AS board_labels
           FROM schedule_blocks b
           JOIN sessions s ON s.id = b.session_id
          WHERE s.meet_id = $1
          ORDER BY b.starts_at ASC`,
        [meetId],
      );

      // Host fragment for the UID. RFC 5545 requires UIDs be
      // globally unique; "blockid@host" is the standard pattern.
      const host = req.get("host") || "divinghq.local";
      const ics = renderIcs({ meet, blocks: blocksRes.rows, host });

      res.set("Content-Type", "text/calendar; charset=utf-8");
      res.set(
        "Content-Disposition",
        `inline; filename="meet-${meetId}.ics"`,
      );
      // Calendar clients re-fetch on their own cadence; tell
      // shared caches not to hold the doc for long.
      res.set("Cache-Control", "public, max-age=60");
      res.send(ics);
    } catch (err) {
      console.error("[GET schedule.ics]", err.message);
      res.status(500).type("text/plain").send("Internal server error");
    }
  });

  // -------------------------------------------------------------
  // GET /api/meets/:meetId/conflicts        (Phase 2)
  //
  // Returns the full conflict report for a meet. Editor-only:
  // conflicts include judge/diver/referee names and operational
  // warnings that are not part of the public schedule surface.
  // 5-second in-process cache absorbs the timeline-drawer chatter.
  // -------------------------------------------------------------
  router.get("/api/meets/:meetId/conflicts", editorGate, async (req, res) => {
    const { meetId } = req.params;
    try {
      const meet = await requireMeetEdit(pool, req, res, meetId);
      if (!meet) return;

      const cached = cachedConflicts(meet.id);
      if (cached) return res.json({ conflicts: cached, cached: true });

      const conflicts = await detectConflicts(meet.id, pool);
      conflictCache.set(meet.id, { at: Date.now(), value: conflicts });
      res.json({ conflicts, cached: false });
    } catch (err) {
      console.error("[GET conflicts]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/conflicts/dismiss            (Phase 2, auth)
  //
  // Body: { block_a_id, block_b_id, resource_kind, reason? }
  //
  // The CHECK constraint on dismissed_conflicts requires
  // block_a_id < block_b_id (so (a,b) and (b,a) collapse to one
  // row). We normalise client input here so the operator can
  // dismiss from either "side" of the pair without surprises.
  //
  // The resource fingerprint is computed server-side from the
  // current membership of the resource — we never trust whatever
  // the client may have posted. The point of the fingerprint
  // (§5) is to resurface the conflict when membership shifts, so
  // it has to be derived from authoritative data, not the
  // potentially-stale view the operator clicked on.
  // -------------------------------------------------------------
  router.post("/api/conflicts/dismiss", editorGate, async (req, res) => {
    const body = req.body || {};
    let aId = body.block_a_id;
    let bId = body.block_b_id;
    const kind = body.resource_kind;
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;

    if (!aId || !bId || aId === bId) {
      return res.status(400).json({ error: "block_a_id and block_b_id are required and must differ" });
    }
    if (!["judge", "board", "diver", "referee"].includes(kind)) {
      return res.status(400).json({ error: "resource_kind must be one of judge|board|diver|referee" });
    }
    // Normalise pair order — UUID string compare matches Postgres'
    // uuid < operator (lexicographic on canonical form).
    if (aId > bId) [aId, bId] = [bId, aId];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const blocksRes = await client.query(
        `SELECT b.id, s.meet_id
           FROM schedule_blocks b
           JOIN sessions s ON s.id = b.session_id
          WHERE b.id = ANY($1::uuid[])`,
        [[aId, bId]],
      );
      if (blocksRes.rowCount !== 2) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "One or both blocks not found" });
      }
      const meetIds = new Set(blocksRes.rows.map((r) => r.meet_id));
      if (meetIds.size !== 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Blocks must be in the same meet" });
      }
      const meetId = blocksRes.rows[0].meet_id;
      const meet = await requireMeetEdit(client, req, res, meetId);
      if (!meet) {
        await client.query("ROLLBACK");
        return;
      }

      const fp = await computeResourceFingerprint(client, {
        blockAId: aId,
        blockBId: bId,
        resourceKind: kind,
      });

      // ON CONFLICT (block_a_id, block_b_id, resource_kind)
      // refreshes the fingerprint + reason for re-dismissals
      // (operator dismissed it, the membership changed and the
      // conflict resurfaced, they're dismissing the new version).
      const inserted = await client.query(
        `INSERT INTO dismissed_conflicts
           (meet_id, block_a_id, block_b_id, resource_kind,
            resource_fingerprint, dismissed_by, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (block_a_id, block_b_id, resource_kind)
         DO UPDATE SET
           resource_fingerprint = EXCLUDED.resource_fingerprint,
           dismissed_by         = EXCLUDED.dismissed_by,
           dismissed_at         = now(),
           reason               = EXCLUDED.reason
         RETURNING id, meet_id, block_a_id, block_b_id, resource_kind,
                   resource_fingerprint, dismissed_by, dismissed_at, reason`,
        [meetId, aId, bId, kind, fp, req.user?.id || null, reason],
      );
      const row = inserted.rows[0];

      await auditSchedule(client, req, {
        meet,
        entityType: "schedule_conflict",
        entityId: row.id,
        entityName: kind,
        action: "schedule.conflict_dismissed",
        metadata: {
          block_a_id: aId,
          block_b_id: bId,
          resource_kind: kind,
        },
        note: reason,
      });

      await client.query("COMMIT");
      invalidateConflictCache(meetId);

      // Tell every connected client that the conflict landscape
      // moved. The drawer subscribes and refetches; spectators
      // just ignore it. Best-effort — a missing io shouldn't
      // fail the dismissal.
      try {
        if (io && typeof io.emit === "function") {
          io.emit("schedule:conflict_dismissed", {
            meet_id: meetId,
            action: "dismiss",
          });
        }
      } catch (_e) { /* best-effort */ }

      res.json({ dismissal: row });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      console.error("[POST conflicts/dismiss]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // Phase 3 helpers
  // -------------------------------------------------------------

  // Pull a fresh inlined block row (event_name / event_height joined
  // in the same shape as the GET /sessions payload). Used by the
  // edit + insert endpoints to return the canonical post-write row
  // without making the caller re-fetch the full session.
  async function fetchBlockById(client, blockId) {
    const r = await client.query(
      `SELECT b.id, b.session_id, b.block_type, b.label,
              b.starts_at, b.ends_at, b.board_ids, b.event_id,
              b.actual_start_at, b.actual_end_at, b.notes,
              b.created_at, b.updated_at,
              e.name AS event_name, e.height AS event_height
         FROM schedule_blocks b
         LEFT JOIN events e ON e.id = b.event_id
        WHERE b.id = $1`,
      [blockId],
    );
    return r.rows[0] || null;
  }

  // Run the conflict detector then filter to just the entries that
  // mention `blockId`. Tolerates a missing detector return (empty
  // array) so a downstream change to the detector shape doesn't
  // break the write path.
  async function conflictsTouchingBlock(client, meetId, blockId) {
    try {
      const all = await detectConflicts(meetId, client);
      return all.filter(
        (c) => c.block_a?.id === blockId || c.block_b?.id === blockId,
      );
    } catch (err) {
      // Never let a detector failure roll back a successful write —
      // the operator can still inspect the drawer to see conflicts.
      console.error("[conflictsTouchingBlock]", err.message);
      return [];
    }
  }

  // board_ids comes in as an array of uuid strings (or null). We
  // validate every entry is a uuid-shaped string and that all board
  // ids resolve to non-archived rows in the org that owns the
  // session's meet. Returns the cleaned uuid[] (deduplicated,
  // order preserved) or throws with a message-suitable error.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  async function validateBoardIds(client, sessionId, raw) {
    if (raw == null) return null; // means "don't touch"
    if (!Array.isArray(raw)) throw new Error("board_ids must be an array");
    const seen = new Set();
    const cleaned = [];
    for (const id of raw) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        throw new Error("board_ids entries must be UUIDs");
      }
      if (!seen.has(id)) {
        seen.add(id);
        cleaned.push(id);
      }
    }
    if (!cleaned.length) return [];
    // Org-scope check: every board id must belong to the org that
    // owns the parent meet. Skipping this lets a hostile client
    // splice another federation's board into your session.
    const orgRow = await client.query(
      `SELECT m.org_id
         FROM sessions s
         JOIN meets m ON m.id = s.meet_id
        WHERE s.id = $1`,
      [sessionId],
    );
    if (!orgRow.rowCount) throw new Error("Session not found");
    const orgId = orgRow.rows[0].org_id;
    const valid = await client.query(
      `SELECT id FROM boards
        WHERE id = ANY($1::uuid[])
          AND org_id = $2
          AND archived_at IS NULL`,
      [cleaned, orgId],
    );
    if (valid.rowCount !== cleaned.length) {
      throw new Error("One or more board_ids are unknown or archived");
    }
    return cleaned;
  }

  // Optional event_id reference: must be in the same meet as the
  // session, or null (which clears the link — useful when an
  // event-start block is being re-purposed as a custom block).
  async function validateEventId(client, sessionId, raw) {
    if (raw == null) return { set: true, value: null };
    if (typeof raw !== "string" || !UUID_RE.test(raw)) {
      throw new Error("event_id must be a UUID or null");
    }
    const r = await client.query(
      `SELECT e.id
         FROM events e
         JOIN sessions s ON s.id = $1
        WHERE e.id = $2 AND e.meet_id = s.meet_id`,
      [sessionId, raw],
    );
    if (!r.rowCount) {
      throw new Error("event_id is not part of this meet");
    }
    return { set: true, value: raw };
  }

  const VALID_BLOCK_TYPES = ["warmup", "event_start", "break", "ceremony", "custom"];

  function safeEmit(event, payload) {
    if (!io || typeof io.emit !== "function") return;
    try { io.emit(event, payload); } catch (_e) { /* best-effort */ }
  }

  // -------------------------------------------------------------
  // PUT /api/blocks/:id                     (Phase 3, auth)
  //
  // Body: any subset of
  //   { starts_at, ends_at, board_ids, label, notes, block_type,
  //     event_id }
  //
  // Only the fields present on the request body are mutated. We
  // intentionally don't accept actual_start_at / actual_end_at —
  // those are written by the live re-flow flow in Phase 4 and don't
  // belong on a manual-edit endpoint.
  // -------------------------------------------------------------
  router.put("/api/blocks/:id", editorGate, async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid block id" });
    }
    const body = req.body || {};
    const sets = [];
    const args = [];
    let argIdx = 1;

    const client = await pool.connect();
    try {
      const existing = await client.query(
        `SELECT b.id, b.session_id, b.starts_at, b.ends_at,
                b.label, b.block_type, s.meet_id,
                m.org_id, m.name AS meet_name
           FROM schedule_blocks b
           JOIN sessions s ON s.id = b.session_id
           JOIN meets m ON m.id = s.meet_id
          WHERE b.id = $1`,
        [id],
      );
      if (!existing.rowCount) {
        return res.status(404).json({ error: "Block not found" });
      }
      const row = existing.rows[0];
      const sessionId = row.session_id;
      const meetId = row.meet_id;
      const meet = { id: meetId, org_id: row.org_id, name: row.meet_name };
      if (!userCanEditMeet(req, meet)) {
        return res.status(403).json({ error: "You cannot edit this meet schedule" });
      }

      // ---- Field-by-field validation + SET clause assembly ----
      let nextStartsAt = row.starts_at;
      let nextEndsAt = row.ends_at;

      if (body.starts_at !== undefined) {
        const d = new Date(body.starts_at);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: "starts_at is not a valid timestamp" });
        }
        nextStartsAt = d;
        sets.push(`starts_at = $${argIdx++}`);
        args.push(d.toISOString());
      }
      if (body.ends_at !== undefined) {
        const d = new Date(body.ends_at);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: "ends_at is not a valid timestamp" });
        }
        nextEndsAt = d;
        sets.push(`ends_at = $${argIdx++}`);
        args.push(d.toISOString());
      }
      if (new Date(nextEndsAt).getTime() <= new Date(nextStartsAt).getTime()) {
        return res.status(400).json({ error: "ends_at must be after starts_at" });
      }

      if (body.label !== undefined) {
        if (body.label !== null && typeof body.label !== "string") {
          return res.status(400).json({ error: "label must be a string or null" });
        }
        sets.push(`label = $${argIdx++}`);
        args.push(body.label == null ? null : body.label.slice(0, 160));
      }

      if (body.notes !== undefined) {
        if (body.notes !== null && typeof body.notes !== "string") {
          return res.status(400).json({ error: "notes must be a string or null" });
        }
        sets.push(`notes = $${argIdx++}`);
        args.push(body.notes == null ? null : body.notes.slice(0, 4000));
      }

      if (body.block_type !== undefined) {
        if (!VALID_BLOCK_TYPES.includes(body.block_type)) {
          return res.status(400).json({ error: "block_type is invalid" });
        }
        sets.push(`block_type = $${argIdx++}`);
        args.push(body.block_type);
      }

      if (body.board_ids !== undefined) {
        let cleaned;
        try {
          cleaned = await validateBoardIds(client, sessionId, body.board_ids);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
        sets.push(`board_ids = $${argIdx++}::uuid[]`);
        args.push(cleaned || []);
      }

      if (body.event_id !== undefined) {
        let ev;
        try {
          ev = await validateEventId(client, sessionId, body.event_id);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
        sets.push(`event_id = $${argIdx++}`);
        args.push(ev.value);
      }

      if (!sets.length) {
        // No-op write — return the existing row + the touching
        // conflicts so the caller gets a consistent response shape
        // even when nothing changed.
        const block = await fetchBlockById(client, id);
        const conflicts = await conflictsTouchingBlock(client, meetId, id);
        return res.json({ block, conflicts });
      }

      sets.push(`updated_at = now()`);
      args.push(id);
      await client.query(
        `UPDATE schedule_blocks SET ${sets.join(", ")} WHERE id = $${argIdx}`,
        args,
      );
      await auditSchedule(client, req, {
        meet,
        entityType: "schedule_block",
        entityId: id,
        entityName: row.label,
        action: "schedule.block_updated",
        metadata: {
          fields: Object.keys(body).filter((key) => body[key] !== undefined),
        },
      });

      const block = await fetchBlockById(client, id);
      // The detector is read-only, so we don't need a transaction
      // around the UPDATE + detect pair. Run it after the write
      // commits so the conflict set reflects the new values.
      invalidateConflictCache(meetId);
      const conflicts = await conflictsTouchingBlock(client, meetId, id);

      safeEmit("schedule:block_updated", {
        meet_id: meetId,
        session_id: sessionId,
        block_id: block.id,
      });
      res.json({ block, conflicts });
    } catch (err) {
      console.error("[PUT block]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // POST /api/sessions/:sessionId/blocks    (Phase 3, auth)
  //
  // Body: { block_type, label?, starts_at, ends_at, board_ids?,
  //         event_id?, notes? }
  // -------------------------------------------------------------
  router.post("/api/sessions/:sessionId/blocks", editorGate, async (req, res) => {
    const { sessionId } = req.params;
    if (!UUID_RE.test(sessionId)) {
      return res.status(400).json({ error: "Invalid session id" });
    }
    const body = req.body || {};
    if (!VALID_BLOCK_TYPES.includes(body.block_type)) {
      return res.status(400).json({ error: "block_type is required and must be valid" });
    }
    const starts = new Date(body.starts_at);
    const ends = new Date(body.ends_at);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      return res.status(400).json({ error: "starts_at and ends_at are required ISO timestamps" });
    }
    if (ends.getTime() <= starts.getTime()) {
      return res.status(400).json({ error: "ends_at must be after starts_at" });
    }

    const client = await pool.connect();
    try {
      const access = await requireSessionEdit(client, req, res, sessionId);
      if (!access) return;
      const meetId = access.meet.id;

      let boards;
      try {
        boards = await validateBoardIds(client, sessionId, body.board_ids ?? []);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      let eventId = null;
      if (body.event_id !== undefined && body.event_id !== null) {
        try {
          const ev = await validateEventId(client, sessionId, body.event_id);
          eventId = ev.value;
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }

      const label = body.label == null ? null : String(body.label).slice(0, 160);
      const notes = body.notes == null ? null : String(body.notes).slice(0, 4000);

      const ins = await client.query(
        `INSERT INTO schedule_blocks
           (session_id, block_type, label, starts_at, ends_at,
            board_ids, event_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8)
         RETURNING id`,
        [
          sessionId,
          body.block_type,
          label,
          starts.toISOString(),
          ends.toISOString(),
          boards || [],
          eventId,
          notes,
        ],
      );
      const blockId = ins.rows[0].id;
      await auditSchedule(client, req, {
        meet: access.meet,
        entityType: "schedule_block",
        entityId: blockId,
        entityName: label,
        action: "schedule.block_created",
        metadata: {
          session_id: sessionId,
          block_type: body.block_type,
          event_id: eventId,
        },
      });
      const block = await fetchBlockById(client, blockId);
      invalidateConflictCache(meetId);
      const conflicts = await conflictsTouchingBlock(client, meetId, blockId);

      safeEmit("schedule:block_updated", {
        meet_id: meetId,
        session_id: sessionId,
        block_id: block.id,
        created: true,
      });
      res.status(201).json({ block, conflicts });
    } catch (err) {
      console.error("[POST blocks]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // DELETE /api/blocks/:id                  (Phase 3, auth)
  //
  // Soft-impact delete: just drops the row. The schedule_block_shifts
  // FK cascades any audit rows for the block; Phase 3 doesn't read
  // those, so the cascade is fine. dismissed_conflicts is also
  // cascaded by the FK on (block_a_id, block_b_id) — which means a
  // dismissal that referenced this block disappears with it, exactly
  // the behaviour we want (the block is gone, the conflict is gone).
  // -------------------------------------------------------------
  router.delete("/api/blocks/:id", editorGate, async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid block id" });
    }
    const client = await pool.connect();
    try {
      const access = await requireBlockEdit(client, req, res, id);
      if (!access) return;
      const meetId = access.meet.id;
      const sessionId = access.block.session_id;
      await client.query(`DELETE FROM schedule_blocks WHERE id = $1`, [id]);
      await auditSchedule(client, req, {
        meet: access.meet,
        entityType: "schedule_block",
        entityId: id,
        entityName: access.block.label,
        action: "schedule.block_deleted",
        metadata: {
          session_id: sessionId,
          starts_at: access.block.starts_at,
          ends_at: access.block.ends_at,
        },
      });
      invalidateConflictCache(meetId);
      safeEmit("schedule:block_deleted", {
        meet_id: meetId,
        session_id: sessionId,
        block_id: id,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[DELETE block]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // PUT /api/sessions/:id                   (Phase 3, auth)
  //
  // Body: any subset of { name, session_date, pool, referee_user_id }
  // -------------------------------------------------------------
  router.put("/api/sessions/:id", editorGate, async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid session id" });
    }
    const body = req.body || {};
    const sets = [];
    const args = [];
    let argIdx = 1;

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return res.status(400).json({ error: "name must be a non-empty string" });
      }
      sets.push(`name = $${argIdx++}`);
      args.push(body.name.slice(0, 120));
    }
    if (body.session_date !== undefined) {
      // Accept either YYYY-MM-DD or an ISO timestamp; Postgres will
      // cast either to ::date below. We reject obvious garbage early
      // so the operator sees a friendlier 400 than a Postgres parse
      // error bubbling out as a 500.
      const s = String(body.session_date);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) {
        return res.status(400).json({ error: "session_date must be YYYY-MM-DD" });
      }
      sets.push(`session_date = $${argIdx++}::date`);
      args.push(s.slice(0, 10));
    }
    if (body.pool !== undefined) {
      if (body.pool !== null && typeof body.pool !== "string") {
        return res.status(400).json({ error: "pool must be a string or null" });
      }
      sets.push(`pool = $${argIdx++}`);
      args.push(body.pool == null ? null : body.pool.slice(0, 80));
    }
    if (body.referee_user_id !== undefined) {
      if (body.referee_user_id !== null && !UUID_RE.test(String(body.referee_user_id))) {
        return res.status(400).json({ error: "referee_user_id must be a UUID or null" });
      }
      sets.push(`referee_user_id = $${argIdx++}`);
      args.push(body.referee_user_id || null);
    }

    let access;
    try {
      access = await requireSessionEdit(pool, req, res, id);
      if (!access) return;
    } catch (err) {
      console.error("[PUT session gate]", err.message);
      return res.status(500).json({ error: "Internal server error" });
    }

    // An attached referee must hold the referee role in this meet's
    // org. Editing the session is already gated above, but the
    // referee_user_id itself was only format-checked — without this a
    // meet editor could bind an arbitrary or cross-org user as session
    // referee, polluting referee-conflict detection. (International
    // meets that need a participating-federation referee would extend
    // this to the participating-org set; today sessions are scoped to
    // the meet's own org.)
    if (body.referee_user_id) {
      const ref = await pool.query(
        `SELECT 1 FROM user_org_roles
          WHERE user_id = $1 AND org_id = $2 AND role = 'referee'`,
        [body.referee_user_id, access.meet.org_id],
      );
      if (!ref.rows.length) {
        return res.status(400).json({
          error: "Referee must hold the referee role in this meet's organisation",
        });
      }
    }

    if (!sets.length) {
      // No-op — return the current row so the caller gets a
      // predictable shape even when no fields were sent.
      const r = await pool.query(
        `SELECT id, meet_id, name, session_date, pool,
                referee_user_id, created_at, updated_at
           FROM sessions WHERE id = $1`,
        [id],
      );
      if (!r.rowCount) return res.status(404).json({ error: "Session not found" });
      return res.json({ session: r.rows[0] });
    }

    sets.push("updated_at = now()");
    args.push(id);
    try {
      const r = await pool.query(
        `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${argIdx}
         RETURNING id, meet_id, name, session_date, pool,
                   referee_user_id, created_at, updated_at`,
        args,
      );
      if (!r.rowCount) {
        return res.status(404).json({ error: "Session not found" });
      }
      const session = r.rows[0];
      await auditSchedule(pool, req, {
        meet: access.meet,
        entityType: "session",
        entityId: session.id,
        entityName: session.name,
        action: "schedule.session_updated",
        metadata: {
          fields: Object.keys(body).filter((key) => body[key] !== undefined),
        },
      });
      // Editing the session referee or its date can change the
      // referee-conflict landscape — invalidate the cache so the
      // next conflicts read recomputes.
      invalidateConflictCache(session.meet_id);
      safeEmit("schedule:block_updated", {
        meet_id: session.meet_id,
        session_id: session.id,
        session_updated: true,
      });
      res.json({ session });
    } catch (err) {
      console.error("[PUT session]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/sessions/:id/duplicate         (Phase 3, auth)
  //
  // Body: { target_date }
  //
  // §8.4: lift the whole session forward by `target_date -
  // source.session_date`. Inside one transaction so a half-copied
  // session never survives a mid-write error. Preserves board_ids
  // (the new day uses the same physical boards) and the session
  // name + pool + referee_user_id. Resets event_id and
  // actual_start_at / actual_end_at on every cloned block — the
  // new day's events haven't been created yet, and the cloned
  // window is the *planned* time, not an observed one.
  // -------------------------------------------------------------
  router.post("/api/sessions/:id/duplicate", editorGate, async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid session id" });
    }
    const body = req.body || {};
    const targetDateRaw = String(body.target_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateRaw)) {
      return res.status(400).json({ error: "target_date must be YYYY-MM-DD" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const srcRes = await client.query(
        `SELECT s.id, s.meet_id, s.name, s.session_date, s.pool, s.referee_user_id,
                m.org_id, m.name AS meet_name
           FROM sessions s
           JOIN meets m ON m.id = s.meet_id
          WHERE s.id = $1`,
        [id],
      );
      if (!srcRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Session not found" });
      }
      const src = srcRes.rows[0];
      const meet = { id: src.meet_id, org_id: src.org_id, name: src.meet_name };
      if (!userCanEditMeet(req, meet)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "You cannot edit this meet schedule" });
      }

      // Compute the delta in whole days so the timestamps shift by
      // exactly that integer day count — using straight ms subtraction
      // would inherit any DST offset between the source and target
      // date if one of them straddled a transition. Reading both as
      // YYYY-MM-DD strings keeps the arithmetic at calendar-day grain.
      const srcDateStr = (src.session_date instanceof Date
        ? src.session_date.toISOString().slice(0, 10)
        : String(src.session_date).slice(0, 10));
      const srcDay = Date.UTC(
        Number(srcDateStr.slice(0, 4)),
        Number(srcDateStr.slice(5, 7)) - 1,
        Number(srcDateStr.slice(8, 10)),
      );
      const dstDay = Date.UTC(
        Number(targetDateRaw.slice(0, 4)),
        Number(targetDateRaw.slice(5, 7)) - 1,
        Number(targetDateRaw.slice(8, 10)),
      );
      const deltaMs = dstDay - srcDay;
      if (deltaMs === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "target_date must differ from the source session date" });
      }

      // Clone the session row. We append "(copy)" only if the name
      // doesn't already end with the new date — operators routinely
      // run Day 1 → Day 2 → Day 3 from the same template and don't
      // want a chain of "(copy) (copy)" suffixes.
      const newSess = await client.query(
        `INSERT INTO sessions (meet_id, name, session_date, pool, referee_user_id)
         VALUES ($1, $2, $3::date, $4, $5)
         RETURNING id, meet_id, name, session_date, pool,
                   referee_user_id, created_at, updated_at`,
        [
          src.meet_id,
          src.name,
          targetDateRaw,
          src.pool,
          src.referee_user_id,
        ],
      );
      const newSessionId = newSess.rows[0].id;

      // Pull source blocks and copy each one with shifted windows.
      // Single round-trip insert via INSERT … SELECT keeps the
      // transaction short even on a multi-day championship session.
      await client.query(
        `INSERT INTO schedule_blocks
           (session_id, block_type, label, starts_at, ends_at,
            board_ids, event_id, actual_start_at, actual_end_at, notes)
         SELECT $1,
                block_type, label,
                starts_at + ($2 || ' milliseconds')::interval,
                ends_at   + ($2 || ' milliseconds')::interval,
                board_ids,
                NULL,         -- event_id reset — new day's events
                              -- don't exist yet
                NULL,         -- actual_start_at cleared
                NULL,         -- actual_end_at cleared
                notes
           FROM schedule_blocks
          WHERE session_id = $3`,
        [newSessionId, String(deltaMs), id],
      );

      // Read the cloned blocks back so the response mirrors the
      // shape /sessions returns (event_name / event_height joined
      // — they'll all be null on a fresh clone, but the keys are
      // present so the client doesn't have to special-case).
      const blocksRes = await client.query(
        `SELECT b.id, b.session_id, b.block_type, b.label,
                b.starts_at, b.ends_at, b.board_ids, b.event_id,
                b.actual_start_at, b.actual_end_at, b.notes,
                b.created_at, b.updated_at,
                e.name AS event_name, e.height AS event_height
           FROM schedule_blocks b
           LEFT JOIN events e ON e.id = b.event_id
          WHERE b.session_id = $1
          ORDER BY b.starts_at ASC, b.created_at ASC`,
        [newSessionId],
      );
      await auditSchedule(client, req, {
        meet,
        entityType: "session",
        entityId: newSessionId,
        entityName: newSess.rows[0].name,
        action: "schedule.session_duplicated",
        metadata: {
          source_session_id: src.id,
          target_date: targetDateRaw,
          block_count: blocksRes.rowCount,
        },
      });

      await client.query("COMMIT");
      invalidateConflictCache(src.meet_id);

      const session = { ...newSess.rows[0], blocks: blocksRes.rows };
      safeEmit("schedule:session_duplicated", {
        meet_id: src.meet_id,
        source_session_id: src.id,
        session_id: session.id,
      });
      res.status(201).json({ session });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      console.error("[POST session/duplicate]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // GET /api/meets/:meetId/judges/availability   (Phase 3)
  //
  // Query: ?at=<iso>
  //
  // Returns availability hints for every judge eligible on this
  // meet. A judge is "available" at `at` if they aren't on any
  // event panel whose containing schedule_block covers `at`;
  // otherwise we return the busy_until and the conflicting
  // block's label so the picker can surface a useful tooltip.
  //
  // 5-second in-process cache mirrors the conflict report. The
  // expensive part is the panel-join, and the picker pings this
  // every time the panel opens — caching by (meetId, at-rounded)
  // means a flurry of opens in a single drawer session resolves
  // off the same plan.
  // -------------------------------------------------------------
  const availabilityCache = new Map(); // key -> { at: ms, value: any }
  const AVAILABILITY_TTL_MS = 5000;
  router.get("/api/meets/:meetId/judges/availability", editorGate, async (req, res) => {
    const { meetId } = req.params;
    const atRaw = req.query.at;
    if (!atRaw) {
      return res.status(400).json({ error: "Query param `at` is required (ISO timestamp)" });
    }
    const at = new Date(String(atRaw));
    if (Number.isNaN(at.getTime())) {
      return res.status(400).json({ error: "`at` is not a valid timestamp" });
    }
    try {
      // Ownership gate BEFORE the cache lookup — within the 5s TTL
      // a cached entry must not be served to a caller who merely
      // shares the cache key but can't edit the meet (would leak
      // another org's judge availability). Mirrors the ordering in
      // GET /api/meets/:meetId/conflicts.
      const meet = await requireMeetEdit(pool, req, res, meetId);
      if (!meet) return;

      // Round the cache key to the nearest minute so two rapid opens
      // from the same panel-row collapse onto one cached plan even if
      // the client used Date.now() to fill `at`.
      const minuteKey = Math.floor(at.getTime() / 60000) * 60000;
      const cacheKey = `${meetId}:${minuteKey}`;
      const cached = availabilityCache.get(cacheKey);
      if (cached && Date.now() - cached.at <= AVAILABILITY_TTL_MS) {
        return res.json({ judges: cached.value, cached: true });
      }

      // For each judge currently on any event panel in this meet,
      // find whether they're seated for an event whose schedule
      // block covers `at`. We return both the available and busy
      // judges so the client can render every row with a hint
      // (defaulting unseen rows to 'available' falls to the front-
      // end).
      //
      // The query joins event_judges → events → schedule_blocks via
      // the block's event_id, then filters to blocks containing
      // `at`. A judge can show up on multiple panels — we group by
      // judge_id and pick the EARLIEST ends_at as the "busy_until"
      // so the picker's tooltip points to the soonest opening.
      const atIso = at.toISOString();
      const busyRes = await pool.query(
        `SELECT ej.judge_id,
                MIN(b.ends_at) AS busy_until,
                (
                  SELECT COALESCE(bb.label, e2.name)
                    FROM schedule_blocks bb
                    JOIN events e2 ON e2.id = bb.event_id
                    JOIN sessions ss ON ss.id = bb.session_id
                    JOIN event_judges ej2 ON ej2.event_id = e2.id
                                          AND ej2.judge_id = ej.judge_id
                   WHERE ss.meet_id = $1
                     AND bb.starts_at <= $2::timestamptz
                     AND bb.ends_at   >  $2::timestamptz
                   ORDER BY bb.ends_at ASC
                   LIMIT 1
                ) AS conflicting_event_label
           FROM event_judges ej
           JOIN events e ON e.id = ej.event_id
           JOIN schedule_blocks b ON b.event_id = e.id
           JOIN sessions s ON s.id = b.session_id
          WHERE s.meet_id = $1
            AND b.starts_at <= $2::timestamptz
            AND b.ends_at   >  $2::timestamptz
          GROUP BY ej.judge_id`,
        [meetId, atIso],
      );

      const judges = busyRes.rows.map((r) => ({
        judge_id: r.judge_id,
        status: "busy",
        busy_until: r.busy_until,
        conflicting_event_label: r.conflicting_event_label,
      }));
      availabilityCache.set(cacheKey, { at: Date.now(), value: judges });
      // Bound the cache so a long-lived process doesn't accumulate
      // a per-minute entry indefinitely. 200 entries ≈ 200 minutes
      // of distinct cache hits, far above the realistic working
      // set for a single meet day.
      if (availabilityCache.size > 200) {
        const oldestKey = availabilityCache.keys().next().value;
        availabilityCache.delete(oldestKey);
      }
      res.json({ judges, cached: false });
    } catch (err) {
      console.error("[GET availability]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/blocks/reflow                 (Phase 4, auth)
  //
  // Body: { meet_id, delta_seconds, block_ids: [...], reason? }
  //
  // Confirms the operator-driven live re-flow described in
  // docs/session-scheduler.md §6: shift the listed blocks forward
  // by delta_seconds inside one transaction, append a
  // schedule_block_shifts ledger row per block, and broadcast
  // `schedule:shifted` so public-schedule viewers refresh.
  //
  // Re-verification: we don't trust the client's delta_seconds at
  // face value, but we also don't want to reject every replay where
  // a real human took 10 seconds to confirm. The check is that
  // delta_seconds is positive and within a sane envelope (under
  // 24h — anything beyond is almost certainly bogus). The shift
  // candidates were already filtered to "haven't started" when the
  // modal was built; we re-check here with FOR UPDATE so a race
  // with a concurrent set_active_diver doesn't push us past an
  // event that just went Live.
  //
  // 409 on actual_start_at-set: the modal saw the block as
  // not-yet-started, but in the meantime someone (perhaps the same
  // operator from another tab) flipped its event Live. We refuse
  // the whole batch — partial reflow leaves the timeline in a
  // worse state than no reflow.
  // -------------------------------------------------------------
  router.post("/api/blocks/reflow", editorGate, async (req, res) => {
    const body = req.body || {};
    const meetId = body.meet_id;
    const deltaSeconds = Number(body.delta_seconds);
    const blockIdsRaw = Array.isArray(body.block_ids) ? body.block_ids : [];
    const reason =
      typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;

    if (!meetId || !UUID_RE.test(String(meetId))) {
      return res.status(400).json({ error: "meet_id is required (uuid)" });
    }
    if (
      !Number.isFinite(deltaSeconds) ||
      deltaSeconds <= 0 ||
      deltaSeconds > 24 * 60 * 60
    ) {
      return res.status(400).json({
        error: "delta_seconds must be a positive number under 86400",
      });
    }
    if (!blockIdsRaw.length) {
      return res.status(400).json({ error: "block_ids must be non-empty" });
    }
    const seen = new Set();
    const blockIds = [];
    for (const id of blockIdsRaw) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        return res
          .status(400)
          .json({ error: "block_ids entries must be UUIDs" });
      }
      if (!seen.has(id)) {
        seen.add(id);
        blockIds.push(id);
      }
    }

    const deltaMs = Math.round(deltaSeconds * 1000);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const meet = await requireMeetEdit(client, req, res, meetId);
      if (!meet) {
        await client.query("ROLLBACK");
        return;
      }

      // Lock the candidate rows + verify ownership via the parent
      // session. SELECT FOR UPDATE serialises against any concurrent
      // PUT /api/blocks/:id (manual edit) and against another tab
      // running the same reflow confirm — the second writer waits,
      // then sees actual_start_at-set or the new window and bails.
      const lockedRes = await client.query(
        `SELECT b.id, b.session_id, b.starts_at, b.ends_at,
                b.actual_start_at, s.meet_id
           FROM schedule_blocks b
           JOIN sessions s ON s.id = b.session_id
          WHERE b.id = ANY($1::uuid[])
            FOR UPDATE OF b`,
        [blockIds],
      );
      if (lockedRes.rowCount !== blockIds.length) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ error: "One or more block_ids not found" });
      }
      const meetSet = new Set(lockedRes.rows.map((r) => r.meet_id));
      if (meetSet.size !== 1 || !meetSet.has(meetId)) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "block_ids must all belong to the meet_id" });
      }
      // §6 guard — refuse if any candidate is already running. The
      // modal pre-filtered on this but the time between modal open
      // and confirm is operator-paced; a concurrent Live flip can
      // land in the gap.
      const startedAlready = lockedRes.rows.find(
        (r) => r.actual_start_at != null,
      );
      if (startedAlready) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "One or more blocks have already started — refetch the schedule and retry",
          conflicting_block_id: startedAlready.id,
        });
      }

      // Apply the shift + append the ledger row per block. We do
      // them in the lock order from the SELECT (id ASC isn't
      // guaranteed but it doesn't matter — every row is locked, no
      // deadlock window). One ledger row per block per shift event;
      // shifted_at uses the txn clock so all rows share a timestamp.
      const shiftedAt = new Date();
      const shiftedBy = req.user?.id || null;
      const shiftedBlockIds = [];
      for (const row of lockedRes.rows) {
        const newStarts = new Date(
          new Date(row.starts_at).getTime() + deltaMs,
        );
        const newEnds = new Date(
          new Date(row.ends_at).getTime() + deltaMs,
        );
        await client.query(
          `UPDATE schedule_blocks
              SET starts_at  = $2,
                  ends_at    = $3,
                  updated_at = now()
            WHERE id = $1`,
          [row.id, newStarts.toISOString(), newEnds.toISOString()],
        );
        await client.query(
          `INSERT INTO schedule_block_shifts
             (block_id, shifted_at, shifted_by,
              old_starts_at, new_starts_at, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            row.id,
            shiftedAt,
            shiftedBy,
            row.starts_at,
            newStarts.toISOString(),
            reason,
          ],
        );
        shiftedBlockIds.push(row.id);
      }

      await auditSchedule(client, req, {
        meet,
        entityType: "meet",
        entityId: meetId,
        entityName: meet.name,
        action: "schedule.shifted",
        metadata: {
          block_ids: shiftedBlockIds,
          delta_seconds: deltaSeconds,
        },
        note: reason,
      });

      await client.query("COMMIT");
      invalidateConflictCache(meetId);

      // Re-fetch the shifted rows (post-update) so the response
      // gives the caller the canonical new windows without a second
      // round-trip.
      const blocksRes = await pool.query(
        `SELECT b.id, b.session_id, b.block_type, b.label,
                b.starts_at, b.ends_at, b.board_ids, b.event_id,
                b.actual_start_at, b.actual_end_at, b.notes,
                b.created_at, b.updated_at,
                e.name AS event_name, e.height AS event_height
           FROM schedule_blocks b
           LEFT JOIN events e ON e.id = b.event_id
          WHERE b.id = ANY($1::uuid[])
          ORDER BY b.starts_at ASC`,
        [shiftedBlockIds],
      );

      safeEmit("schedule:shifted", {
        meet_id: meetId,
        shifted_block_ids: shiftedBlockIds,
        delta_seconds: deltaSeconds,
      });

      res.json({
        shifted: blocksRes.rows,
        delta_seconds: deltaSeconds,
      });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      console.error("[POST blocks/reflow]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // DELETE /api/conflicts/dismiss/:id      (Phase 2, auth)
  //
  // Un-dismiss a conflict. Drops the dismissed_conflicts row by
  // id and emits a refresh socket event so other tabs see the
  // restored warning immediately.
  // -------------------------------------------------------------
  router.delete("/api/conflicts/dismiss/:id", editorGate, async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid dismissal id" });
    }
    try {
      const existing = await pool.query(
        `SELECT dc.id, dc.meet_id, dc.block_a_id, dc.block_b_id, dc.resource_kind,
                m.org_id, m.name AS meet_name
           FROM dismissed_conflicts dc
           JOIN meets m ON m.id = dc.meet_id
          WHERE dc.id = $1`,
        [id],
      );
      if (!existing.rowCount) {
        return res.status(404).json({ error: "Dismissal not found" });
      }
      const rowBefore = existing.rows[0];
      const meet = { id: rowBefore.meet_id, org_id: rowBefore.org_id, name: rowBefore.meet_name };
      if (!userCanEditMeet(req, meet)) {
        return res.status(403).json({ error: "You cannot edit this meet schedule" });
      }
      const r = await pool.query(
        `DELETE FROM dismissed_conflicts WHERE id = $1
         RETURNING id, meet_id, block_a_id, block_b_id, resource_kind`,
        [id],
      );
      if (!r.rowCount) {
        return res.status(404).json({ error: "Dismissal not found" });
      }
      const row = r.rows[0];
      await auditSchedule(pool, req, {
        meet,
        entityType: "schedule_conflict",
        entityId: row.id,
        entityName: row.resource_kind,
        action: "schedule.conflict_undismissed",
        metadata: {
          block_a_id: row.block_a_id,
          block_b_id: row.block_b_id,
          resource_kind: row.resource_kind,
        },
      });
      invalidateConflictCache(row.meet_id);
      try {
        if (io && typeof io.emit === "function") {
          io.emit("schedule:conflict_dismissed", {
            meet_id: row.meet_id,
            action: "undismiss",
          });
        }
      } catch (_e) { /* best-effort */ }
      res.json({ message: "Dismissal removed", dismissal: row });
    } catch (err) {
      console.error("[DELETE conflicts/dismiss]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};

// -----------------------------------------------------------------
// iCal serializer.
//
// Hand-written rather than dragging in an npm dep — the format
// is small enough that the standards work fits in a screen:
//   * CRLF line endings (RFC 5545 §3.1)
//   * 75-octet line folding (continuation = CRLF + space)
//   * Escape: backslash, comma, semicolon, newline
//   * DTSTAMP / DTSTART / DTEND in UTC basic format (Z suffix)
// -----------------------------------------------------------------
function renderIcs({ meet, blocks, host }) {
  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//DivingHQ//Session Scheduler//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push(foldLine(`X-WR-CALNAME:${escapeText(meet.name)}`));
  if (meet.venue) {
    lines.push(foldLine(`X-WR-CALDESC:${escapeText(meet.venue)}`));
  }

  const stamp = formatIcsUtc(new Date());
  for (const b of blocks) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:block-${b.id}@${host}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${formatIcsUtc(b.starts_at)}`);
    lines.push(`DTEND:${formatIcsUtc(b.ends_at)}`);
    lines.push(foldLine(`SUMMARY:${escapeText(blockSummary(b))}`));
    const descParts = [];
    if (b.session_name) descParts.push(`Session: ${b.session_name}`);
    if (b.board_labels) descParts.push(`Board: ${b.board_labels}`);
    if (b.session_pool) descParts.push(`Pool: ${b.session_pool}`);
    if (b.notes) descParts.push(b.notes);
    if (descParts.length) {
      lines.push(foldLine(`DESCRIPTION:${escapeText(descParts.join("\n"))}`));
    }
    if (meet.venue) {
      lines.push(foldLine(`LOCATION:${escapeText(meet.venue)}`));
    }
    lines.push(`CATEGORIES:${b.block_type.toUpperCase()}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function blockSummary(b) {
  // Prefer the operator-set label; fall back to a sensible
  // default per block_type so a row with no label is still
  // useful when it lands in a coach's calendar.
  if (b.label && b.label.trim()) return b.label.trim();
  switch (b.block_type) {
    case "warmup":      return "Warmup";
    case "event_start": return "Event";
    case "break":       return "Break";
    case "ceremony":    return "Ceremony";
    default:            return "Scheduled block";
  }
}

// RFC 5545 escape rules — order matters: backslash first so it
// doesn't double-escape the others.
function escapeText(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// 20251231T235959Z — basic-format UTC, no separators.
function formatIcsUtc(value) {
  const d = value instanceof Date ? value : new Date(value);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

// RFC 5545 §3.1 — lines must not exceed 75 octets. Continuation
// lines start with a single space (CRLF + space). We chunk on
// byte length, not character length, since multibyte UTF-8
// characters count toward the limit. Splitting inside a
// multibyte sequence is avoided by walking codepoints and
// flushing whenever the next character would push us past 75.
function foldLine(line) {
  const encoded = Buffer.from(line, "utf8");
  if (encoded.length <= 75) return line;
  const out = [];
  let chunk = "";
  let chunkBytes = 0;
  // Iterate over codepoints (so emoji etc. don't get sliced).
  for (const ch of line) {
    const charBytes = Buffer.byteLength(ch, "utf8");
    // First chunk has no leading space, continuation chunks do
    // (1 octet for the space), so the budget tightens after the
    // first line.
    const budget = out.length === 0 ? 75 : 74;
    if (chunkBytes + charBytes > budget) {
      out.push(chunk);
      chunk = ch;
      chunkBytes = charBytes;
    } else {
      chunk += ch;
      chunkBytes += charBytes;
    }
  }
  if (chunk) out.push(chunk);
  return out.map((p, i) => (i === 0 ? p : " " + p)).join("\r\n");
}

module.exports.__test__ = { renderIcs, escapeText, formatIcsUtc, foldLine };
module.exports.__internals__ = {
  invalidateConflictCache,
  CONFLICT_CACHE_TTL_MS,
};
