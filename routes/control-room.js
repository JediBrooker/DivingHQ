// Control-Room routes — everything the operator hits from the
// pre-meet roster screen and during-meet queue management.
//
//   GET    /api/events/:id/roster                roster + dive lists
//   PUT    /api/dive-lists/:id/order             single-row reorder
//   PUT    /api/events/:id/dive-lists/reorder    bulk drag-and-drop
//   POST   /api/events/:id/dive-lists/randomize  shuffle pre-meet
//   PUT    /api/dive-lists/:id/withdraw          scratch / reinstate
//   GET    /api/events/:id/attendance            check-in list
//   PUT    /api/events/:id/attendance/:competitorId  set status
//   POST   /api/events/:id/roster                late-entry add
//   POST   /api/events/:id/roster/import         CSV bulk import
//   GET    /api/events/:id/audit-recent          risky workflow audit rows
//   GET    /api/events/:id/history               public dive history
//
// Reorder + randomize are locked once an event flips out of
// 'Upcoming'; operators withdraw scratchers instead. Late-entry
// is the manager-only override that intentionally works after
// entries close (the diver showed up; we can't say "you're too
// late" once the meet is running).
//
// Mounted via:
//   app.use(require('./routes/control-room')({ … }))

const express = require("express");
const QRCode  = require("qrcode");
const { publicId } = require("../lib/public-id");
const { recordAudit, auditFromReq } = require("../lib/audit");
const createIdempotency = require("../lib/idempotency");
const { t } = require("../lib/server-i18n");
const { perDiveSelect } = require("../lib/scoring-sql");

// Mirrors init.sql's dive_position enum. Pre-validating each CSV
// cell keeps a bad value from ever reaching the ::dive_position
// cast — in commit mode that cast error would abort the whole
// import transaction (see the SAVEPOINT fence in
// buildRosterImportPlan).
const DIVE_POSITIONS = new Set(["A", "B", "C", "D"]);

// Light CSV parser. Handles "quoted, fields", "doubled""quotes"
// inside quoted fields, and trailing/leading whitespace. Doesn't
// pull a dependency for what's a 30-line job; the input is
// always small (a meet roster, not a database export).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuoted = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuoted = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        if (field.length || row.length) { row.push(field); rows.push(row); }
        row = []; field = "";
      } else {
        field += ch;
      }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

module.exports = function createControlRoomRouter({
  pool,
  requireOrgRole,
  requireMeetEditor,
  bulkWriteLimiter,
  ensureEventOrgGate,
  // lib/middleware.js exports the canonical pre-meet ("Upcoming")
  // gate; the server.js mount doesn't pass it yet, so the factory
  // falls back to a behaviour-identical local twin below when
  // absent. Optional so existing mounts keep working unchanged.
  ensureEventPreMeet,
  // Cut 2 deps: push for the request → notify hop, bcrypt + totp
  // for the credential-fallback verification path. All three are
  // optional in the factory signature so existing test setups
  // that mount this router with the smaller dep list don't break;
  // the relevant endpoints 503 when their deps aren't present.
  push,
  bcrypt,
  totp,
}) {
  if (!pool || !ensureEventPreMeet) {
    throw new Error("createControlRoomRouter requires { pool, ensureEventPreMeet, … }");
  }
  const router = express.Router();

  // Tuple repeated 7× across the original section. Build it once
  // here so a typo can't drift one route's role gate.
  const requireMeetController = requireOrgRole(["org_admin", "meet_manager", "referee"]);

  // Idempotency middleware for the meet-time HTTP writes the
  // operator's outbox routes through. The middleware is opt-in
  // per-route: routes that don't get the helper applied work
  // exactly as before (legacy direct-call flow). See
  // docs/offline-p1-design.md §2 for the contract.
  const { httpMiddleware: idem } = createIdempotency({ pool });

  function importErr(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  async function buildRosterImportPlan(client, event, csv, { commit = false } = {}) {
    const heightNumeric = event.height ? parseFloat(event.height) : null;
    const rows = parseCsv(csv);
    if (!rows.length) throw importErr(400, "CSV had no data rows");

    const header = rows.shift().map((h) => h.trim().toLowerCase());
    const userIdx = header.indexOf("username");
    const partnerIdx = header.indexOf("partner_username");
    if (userIdx < 0) throw importErr(400, 'CSV must include a "username" column');

    const roundCols = [];
    for (let n = 1; n <= 12; n++) {
      const ci = header.indexOf(`round_${n}_code`);
      const pi = header.indexOf(`round_${n}_pos`);
      if (ci >= 0 && pi >= 0) roundCols.push({ round: n, codeIdx: ci, posIdx: pi });
    }
    if (!roundCols.length) {
      throw importErr(400, 'CSV must include at least one round_N_code + round_N_pos pair');
    }

    const stats = {
      preview: !commit,
      added: 0,
      skipped: 0,
      rounds_written: 0,
      errors: [],
      rows: [],
    };

    let rowN = 0;
    for (const row of rows) {
      const username = (row[userIdx] || "").trim();
      if (!username) {
        stats.skipped++;
        continue;
      }

      const previewRow = {
        username,
        full_name: null,
        partner_username: null,
        partner_name: null,
        rounds: [],
      };

      // Row-level fence (commit mode only). An unexpected DB error
      // below — bad cast, FK violation — would otherwise abort the
      // surrounding transaction: every later row then fails with
      // "current transaction is aborted", COMMIT quietly becomes a
      // rollback, and the route still returns 200 with bogus counts.
      rowN++;
      if (commit) await client.query(`SAVEPOINT row_${rowN}`);
      try {
        const u = await client.query(
          "SELECT id, full_name FROM users WHERE username = $1 AND org_id = $2",
          [username, event.org_id],
        );
        if (!u.rows.length) {
          stats.errors.push({ username, error: "User not found in this org" });
          stats.rows.push(previewRow);
          continue;
        }
        const competitorId = u.rows[0].id;
        previewRow.full_name = u.rows[0].full_name;

        let partnerId = null;
        if (partnerIdx >= 0) {
          const partnerName = (row[partnerIdx] || "").trim();
          if (partnerName) {
            previewRow.partner_username = partnerName;
            const p = await client.query(
              "SELECT id, full_name FROM users WHERE username = $1 AND org_id = $2",
              [partnerName, event.org_id],
            );
            if (!p.rows.length) {
              stats.errors.push({ username, error: `Partner ${partnerName} not found` });
              stats.rows.push(previewRow);
              continue;
            }
            partnerId = p.rows[0].id;
            previewRow.partner_name = p.rows[0].full_name;
          }
        }

        for (const { round, codeIdx, posIdx } of roundCols) {
          const code = (row[codeIdx] || "").trim();
          const pos = (row[posIdx] || "").trim().toUpperCase();
          if (!code || !pos) continue;
          // Whitelist before the ::dive_position cast below — see
          // the DIVE_POSITIONS note at the top of the file.
          if (!DIVE_POSITIONS.has(pos)) {
            stats.errors.push({
              username,
              error: `Round ${round}: "${pos}" is not a valid position (${[...DIVE_POSITIONS].join(", ")})`,
            });
            continue;
          }
          const d = await client.query(
            `SELECT id FROM dive_directory
             WHERE dive_code = $1 AND position = $2::dive_position
               AND ($3::numeric IS NULL OR height = $3::numeric)`,
            [code, pos, heightNumeric],
          );
          if (!d.rows.length) {
            stats.errors.push({
              username,
              error: `Round ${round}: ${code}${pos} not in directory${heightNumeric ? ` for ${event.height}` : ""}`,
            });
            continue;
          }

          const existing = await client.query(
            `SELECT cdl.id, dd.dive_code, dd.position
               FROM competitor_dive_lists cdl
               LEFT JOIN dive_directory dd ON dd.id = cdl.dive_id
              WHERE cdl.event_id = $1
                AND cdl.competitor_id = $2
                AND cdl.round_number = $3`,
            [event.id, competitorId, round],
          );
          previewRow.rounds.push({
            round_number: round,
            dive_code: code,
            position: pos,
            action: existing.rows.length ? "update" : "insert",
            current: existing.rows.length
              ? `${existing.rows[0].dive_code || "empty"}${existing.rows[0].position || ""}`
              : null,
          });

          if (commit) {
            await client.query(
              `INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, dive_id, round_number)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (event_id, competitor_id, round_number)
               DO UPDATE SET dive_id = EXCLUDED.dive_id, partner_id = EXCLUDED.partner_id`,
              [event.id, competitorId, partnerId, d.rows[0].id, round],
            );
          }
          stats.rounds_written++;
        }
        stats.added++;
        stats.rows.push(previewRow);
      } catch (rowErr) {
        // Roll back just this row's writes; the savepoint restores
        // the transaction so later rows still commit.
        if (commit) await client.query(`ROLLBACK TO SAVEPOINT row_${rowN}`);
        stats.errors.push({ username, error: rowErr.message });
        stats.rows.push(previewRow);
      } finally {
        // ROLLBACK TO keeps the savepoint defined; RELEASE here
        // closes the subtransaction on every exit path (success,
        // row error, or an in-row `continue`).
        if (commit) await client.query(`RELEASE SAVEPOINT row_${rowN}`);
      }
    }

    return stats;
  }

  // -------------------------------------------------------------
  // GET /api/events/:id/roster — full dive list + diver metadata
  // for the Control Room queue. Withdrawn rows are returned but
  // flagged so the UI can render scratched divers separately.
  // -------------------------------------------------------------
  router.get("/api/events/:id/roster", requireMeetController, async (req, res) => {
    try {
      // Cross-org gate. requireOrgRole only checks the caller HAS
      // a role; it doesn't check the event in :id is in their org.
      // Without this any meet_manager could enumerate roster +
      // dive lists for any other org's events by guessing UUIDs.
      if (!(await ensureEventOrgGate(req, res, "id"))) return;

      // round_order is the canonical 1-based diving position
       // within a round, computed via ROW_NUMBER over the same
       // sort key the ORDER BY uses. Mirrors the spectator
       // scoreboard's upcoming query — see routes/scoreboard.js.
       // Two reasons to compute it server-side rather than have
       // the SPA render display_order verbatim:
       //   1. Self-healing against historic data corrupted by the
       //      pre-fix randomise SQL bug (display_order values
       //      could end up like 4 / 6 / 9 for a 3-pair event).
       //      ROW_NUMBER ignores the actual stored value and
       //      produces clean 1..N from the relative order, so the
       //      Control Room renders correct position badges even
       //      for events randomised before the fix landed.
       //   2. Withdrawn rows can leave gaps in display_order;
       //      round_order skips them so spectators don't see
       //      "Diver 1 · Diver 3 · Diver 4" with no #2.
      const r = await pool.query(
        `WITH ordered AS (
           SELECT cdl.id, cdl.event_id, cdl.competitor_id,
                  cdl.round_number, cdl.display_order, cdl.dive_id,
                  cdl.partner_id, cdl.team_id, cdl.withdrawn_at,
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
             /* Migration 040: reserves are in the roster but
                don't compete unless promoted — exclude them
                from the active queue. */
             AND cdl.is_reserve = FALSE
         )
         SELECT cdl.id AS dive_list_id,
                cdl.display_order, cdl.withdrawn_at,
                COALESCE(ordered.round_order, NULL) AS round_order,
                u.id AS competitor_id, u.full_name,
                o.id AS competitor_org_id,
                o.name AS competitor_org_name,
                o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                cdl.partner_id, pu.full_name AS partner_name, po.country_code AS partner_country,
                cdl.team_id, t.name AS team_name, t.short_code AS team_code,
                /* public_id + team_public_id used to be computed
                   inline with pgcrypto's digest() — but pgcrypto
                   isn't enabled on every postgres install, and a
                   missing extension threw the whole query. We now
                   compute them in Node after the result lands
                   (see publicId() below). */
                cdl.event_id, cdl.round_number, cdl.dive_id,
                d.dive_code, d.description, d.dd, d.position,
                e.event_type, e.number_of_judges,
                /* Payments (Migration 066): is this diver's entry paid?
                   Correlated EXISTS, not a JOIN — the roster is the
                   scoring queue, so it must never multiply rows. */
                EXISTS (
                  SELECT 1 FROM payments p
                   WHERE p.payer_user_id = cdl.competitor_id
                     AND p.subject_type = 'event_entry'
                     AND p.status = 'paid'
                     /* per-event entry OR a meet-level registration
                        covering every event of this meet (POST
                        /api/meets/:id/checkout) */
                     AND (p.event_id = cdl.event_id
                          OR (p.meet_id IS NOT NULL AND p.meet_id = e.meet_id))
                ) AS paid_entry
         FROM users u
         JOIN competitor_dive_lists cdl ON u.id = cdl.competitor_id
         /* LEFT JOIN ordered — withdrawn rows aren't in the CTE
            (which excludes them so the position numbering stays
            tight) but we still want them in the response so the
            SPA can render scratched divers as a separate band.
            round_order is NULL for withdrawn rows. */
         LEFT JOIN ordered ON ordered.id = cdl.id
         /* LEFT JOIN dive_directory — a competitor_dive_lists row
            with cdl.dive_id IS NULL (diver hasn't filed their
            full list yet) or pointing at a deleted directory
            entry would otherwise drop the diver from the queue
            entirely. INNER JOIN here was previously rendering
            an empty 0/0 queue for any event with a single bad
            row. The frontend handles NULL dive_code/dd gracefully. */
         LEFT JOIN dive_directory d ON cdl.dive_id = d.id
         JOIN organisations o ON u.org_id = o.id
         JOIN events e ON e.id = cdl.event_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         LEFT JOIN organisations po ON po.id = pu.org_id
         LEFT JOIN teams t ON t.id = cdl.team_id
         WHERE cdl.event_id = $1
         ORDER BY cdl.round_number ASC,
                  t.name ASC NULLS LAST,
                  cdl.display_order ASC NULLS LAST,
                  u.full_name ASC`,
        [req.params.id],
      );
      const enriched = r.rows.map((row) => ({
        ...row,
        public_id:      publicId("comp", row.event_id, row.competitor_id),
        team_public_id: row.team_id
          ? publicId("team", row.event_id, row.team_id)
          : null,
      }));
      res.json(enriched);
    } catch (err) {
      console.error("[Roster Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/events/:id/audit-recent — event-scoped audit rows
  // for Control Room risky workflows. The org-wide audit feed is
  // org-admin only; Control Room operators also include meet
  // managers/referees, so this route keeps the same event-org
  // gate as roster mutations and exposes only rows tied to the
  // selected event.
  // -------------------------------------------------------------
  router.get("/api/events/:id/audit-recent", requireMeetController, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const limit = clampAuditLimit(req.query.limit);
      const r = await pool.query(
        `WITH score_rows AS (
           SELECT
             'score'::text AS kind,
             a.id::text AS id,
             a.created_at,
             a.action::text AS action,
             a.reason,
             a.round_number,
             a.old_score,
             a.new_score,
             comp.full_name AS competitor_name,
             jud.full_name AS judge_name,
             act.full_name AS actor_name,
             NULL::text AS entity_type,
             NULL::text AS entity_name,
             NULL::jsonb AS metadata
           FROM score_audit_log a
           LEFT JOIN users comp ON comp.id = a.competitor_id
           LEFT JOIN users jud  ON jud.id  = a.judge_id
           LEFT JOIN users act  ON act.id  = a.actor_user_id
           WHERE a.event_id = $1
             AND a.action::text <> 'insert'
         ),
         activity_rows AS (
           SELECT
             'activity'::text AS kind,
             a.id::text AS id,
             a.created_at,
             a.action,
             a.note AS reason,
             NULL::int AS round_number,
             NULL::numeric AS old_score,
             NULL::numeric AS new_score,
             NULL::text AS competitor_name,
             NULL::text AS judge_name,
             act.full_name AS actor_name,
             a.entity_type,
             a.entity_name,
             a.metadata
           FROM audit_log a
           LEFT JOIN users act ON act.id = a.actor_id
           WHERE (
             a.entity_id = $1
             OR (
               (a.metadata->>'event_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               AND (a.metadata->>'event_id')::uuid = $1
             )
           )
             AND (
               a.action IN (
                 'coach.submit_dive_list',
                 'coach.withdraw_dive_list',
                 'event.workflow_reset',
                 'late_arrival.allowed',
                 'late_arrival.denied',
                 'reserve.promoted',
                 'reserve.replaced_diver',
                 'roster.dive_edited',
                 'roster.late_entry_added',
                 'roster.reinstated',
                 'roster.withdrew'
               )
               OR a.action LIKE 'event.dive_off_%'
               OR a.action LIKE 'event.%_seeded'
             )
         )
         SELECT *
         FROM (
           SELECT * FROM score_rows
           UNION ALL
           SELECT * FROM activity_rows
         ) rows
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [req.params.id, limit],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Control Audit Recent Error]", err.message);
      res.status(500).json({ error: "Failed to load recent audit" });
    }
  });

  // -------------------------------------------------------------
  // PUT /api/dive-lists/:id/order — single-row reorder. Body:
  // { display_order: int | null }. Locked once status != Upcoming.
  // -------------------------------------------------------------
  router.put("/api/dive-lists/:id/order", requireMeetController, idem("dive_list_reorder_one"), async (req, res) => {
    const { display_order } = req.body || {};
    if (display_order != null && !Number.isInteger(display_order)) {
      return res.status(400).json({ error: "display_order must be an integer or null" });
    }
    try {
      const owner = await pool.query(
        `SELECT e.id, e.org_id
         FROM competitor_dive_lists cdl
         JOIN events e ON e.id = cdl.event_id
         WHERE cdl.id = $1`,
        [req.params.id],
      );
      if (!owner.rows.length) {
        return res.status(404).json({ error: "Dive list row not found" });
      }
      const ev = owner.rows[0];
      if (!req.user.is_system_admin && ev.org_id !== req.user.org_id) {
        return res.status(403).json({ error: "Event is not in your organisation" });
      }
      if (!(await ensureEventPreMeet(req, res, ev.id))) return;
      const r = await pool.query(
        `UPDATE competitor_dive_lists cdl
         SET display_order = $1
         WHERE cdl.id = $2
         RETURNING cdl.id, cdl.display_order`,
        [display_order ?? null, req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Dive list row not found" });
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Reorder Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PUT /api/events/:id/dive-lists/reorder — bulk drag-and-drop.
  // Atomic against partial failures. Cap of 500 rows / request.
  // -------------------------------------------------------------
  router.put("/api/events/:id/dive-lists/reorder", requireMeetController, idem("dive_list_reorder_bulk"), async (req, res) => {
    const eventId = req.params.id;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }
    if (rows.length > 500) {
      return res.status(413).json({ error: "Too many rows in one request" });
    }
    for (const r of rows) {
      if (!r || typeof r.id !== "string"
          || !Number.isInteger(r.display_order)) {
        return res.status(400).json({ error: "Each row needs id (uuid) + integer display_order" });
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ev = await client.query(
        "SELECT id FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Event not found" });
      }
      if (!(await ensureEventPreMeet(req, res, eventId, client))) {
        await client.query("ROLLBACK");
        return;
      }
      let updated = 0;
      for (const r of rows) {
        const u = await client.query(
          `UPDATE competitor_dive_lists
           SET display_order = $1
           WHERE id = $2 AND event_id = $3`,
          [r.display_order, r.id, eventId],
        );
        updated += u.rowCount;
      }
      await client.query("COMMIT");
      res.json({ ok: true, updated });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Bulk Reorder Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/dive-lists/randomize — pre-meet shuffle.
  // Each unique competitor gets one random position applied to
  // every round they're in, so "Diver Z dives 1st" stays
  // consistent across rounds.
  // -------------------------------------------------------------
  router.post("/api/events/:id/dive-lists/randomize", requireMeetController, idem("dive_list_randomize"), async (req, res) => {
    const eventId = req.params.id;
    // One transaction for the shuffle + the workflow stamp below —
    // a crash between the two must not leave a re-shuffled order
    // still carrying the previous shuffle's referee sign-off.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ev = await client.query(
        "SELECT id FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Event not found" });
      }
      if (!(await ensureEventPreMeet(req, res, eventId, client))) {
        await client.query("ROLLBACK");
        return;
      }

      // Pick a random ordering of the unique competitors, then
      // apply that ordering across every round in one UPDATE.
      // Withdrawn rows are excluded from the shuffle pool but
      // still get a display_order assigned via the JOIN — they
      // just sort to the end of their slot when reinstated.
      // SELECT DISTINCT col, ROW_NUMBER() OVER (...) is a known
      // SQL footgun — the window function evaluates BEFORE the
      // DISTINCT, so a 3-pair × 3-round synchro event got
      // positions 1..9 assigned to its 9 cdl rows and the
      // subsequent JOIN matched arbitrarily, leaving display_order
      // values like 4 / 6 / 9 instead of 1 / 2 / 3. Splitting the
      // DISTINCT into its own subquery first guarantees we
      // ROW_NUMBER over UNIQUE competitors only.
      const r = await client.query(
        `WITH shuffled AS (
           SELECT competitor_id,
                  ROW_NUMBER() OVER (ORDER BY random()) AS pos
           FROM (
             SELECT DISTINCT competitor_id
             FROM competitor_dive_lists
             WHERE event_id = $1
               AND withdrawn_at IS NULL
               /* Migration 040: reserves are kept in the roster
                  but not in the dive-order shuffle. */
               AND is_reserve = FALSE
           ) u
         )
         UPDATE competitor_dive_lists cdl
         SET display_order = sh.pos
         FROM shuffled sh
         WHERE cdl.event_id = $1
           AND cdl.competitor_id = sh.competitor_id
         RETURNING cdl.id`,
        [eventId],
      );

      // Pre-meet workflow: the order has changed, so stamp
      // randomised_at and clear any prior sign-off — the referee
      // signs off on the FINAL order, not a previous shuffle.
      await client.query(
        `UPDATE events
         SET dive_order_randomised_at = now(),
             dive_order_signed_off_at = NULL,
             dive_order_signed_off_by = NULL
         WHERE id = $1`,
        [eventId],
      );

      await client.query("COMMIT");
      res.json({ ok: true, updated: r.rowCount });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Randomize Order Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/dive-order/sign-off — referee approves
  // the published order. Records who signed off + when. The
  // Control Room's 3-state button reads this back via the events
  // payload and turns green ("Start Event") once the timestamp
  // is set.
  //
  // Role gate is the same requireMeetController used by the
  // reorder endpoints — meet_managers, referees and org_admins
  // can sign off. The recorded signed_off_by user_id is whoever
  // was logged in at that moment, so the audit trail still names
  // the actual person regardless of which staff role they hold.
  // -------------------------------------------------------------
  router.post("/api/events/:id/dive-order/sign-off", requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        `SELECT id, status, name, dive_order_randomised_at,
                enforce_referee_signoff
         FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot sign off — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      // Enforcement gate. When the event has enforce_referee_signoff = TRUE
      // the manager-attests path is forbidden — the actual referee must
      // approve via push, credential entry, or the Cut 3 code handoff.
      // Defence in depth: the SPA hides the manager-attests tab when
      // enforced, but a hand-crafted curl shouldn't smuggle past it.
      if (ev.rows[0].enforce_referee_signoff) {
        return res.status(403).json({
          error: "This event requires referee sign-off. Use the push, code, or credential path.",
          enforced: true,
        });
      }
      const r = await pool.query(
        `UPDATE events
         SET dive_order_signed_off_at = now(),
             dive_order_signed_off_by = $1
         WHERE id = $2
         RETURNING dive_order_signed_off_at, dive_order_signed_off_by`,
        [req.user.id, eventId],
      );
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Dive Order Sign-Off Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/check-in/confirm — operator confirms
  // pre-meet check-in is complete and the workflow can advance
  // to the randomise step. Stamps check_in_done_at on the event.
  // The actual per-diver attendance rows live in event_attendance
  // and are unaffected; this is just the gate signal.
  // -------------------------------------------------------------
  router.post("/api/events/:id/check-in/confirm", requireMeetController, idem("check_in_confirm"), async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        `SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot confirm check-in — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      const r = await pool.query(
        `UPDATE events
         SET check_in_done_at = COALESCE(check_in_done_at, now())
         WHERE id = $1
         RETURNING check_in_done_at`,
        [eventId],
      );
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Check-In Confirm Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/dive-order/reset — clears every pre-meet
  // workflow stamp (check-in confirmation, randomise, sign-off)
  // so the operator can walk the four states again from the top.
  // Used by the "↺ Reset" affordance next to the workflow button.
  // -------------------------------------------------------------
  router.post("/api/events/:id/dive-order/reset", requireMeetController, idem("dive_order_reset"), async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        `SELECT id, status, name, org_id FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot reset workflow — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      await pool.query(
        `UPDATE events
         SET check_in_done_at         = NULL,
             dive_order_randomised_at = NULL,
             dive_order_signed_off_at = NULL,
             dive_order_signed_off_by = NULL
         WHERE id = $1`,
        [eventId],
      );
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id:      ev.rows[0].org_id,
        entity_type: "event",
        entity_id:   ev.rows[0].id,
        entity_name: ev.rows[0].name,
        action:      "event.workflow_reset",
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Dive Order Reset Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/dive-order/confirm — operator chose to
  // skip the randomise step (e.g. the order was already arranged
  // manually) and wants to advance to sign-off. Just stamps
  // randomised_at without touching display_order.
  // -------------------------------------------------------------
  router.post("/api/events/:id/dive-order/confirm", requireMeetController, idem("dive_order_confirm"), async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        `SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot advance workflow — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      await pool.query(
        `UPDATE events
         SET dive_order_randomised_at = COALESCE(dive_order_randomised_at, now())
         WHERE id = $1`,
        [eventId],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[Dive Order Confirm Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // CUT 2 — REFEREE SIGN-OFF VIA PUSH + CREDENTIAL FALLBACK
  //
  // Three endpoints replace the simple POST /dive-order/sign-off:
  //
  //   GET  /events/:id/referees        — picker dropdown source
  //   POST /events/:id/sign-off/request    — manager picks ref;
  //          creates a request row + fires the push notification
  //   POST /events/:id/sign-off/respond    — referee taps Approve/Deny
  //          via the in-app banner; closes the loop
  //   POST /events/:id/sign-off/credential — fallback when the
  //          referee can't get the push (no device registered,
  //          permissions denied). Referee enters their username +
  //          password (+ TOTP if enabled) on the manager's laptop;
  //          server verifies and stamps signed_off_by = referee.id
  //
  // The simple POST /dive-order/sign-off (manager pre-confirms
  // verbally, no attribution) stays in place as the lightest-
  // touch option. The new endpoints add proper attribution when
  // the meet calls for it.
  // -------------------------------------------------------------

  // GET /api/events/:id/referees — list referees in the event's
  // org so the manager modal has something to populate. Names +
  // ids only; no contact info, no role tuples.
  router.get("/api/events/:id/referees", requireMeetController, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const r = await pool.query(
        `SELECT u.id, u.full_name, u.username
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id
         WHERE u.org_id = (SELECT org_id FROM events WHERE id = $1)
           AND r.role = 'referee'
         ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Referees List Error]", err.message);
      res.status(500).json([]);
    }
  });

  // POST /api/events/:id/dive-order/sign-off/request
  //   Body: { referee_id }
  // Creates a referee_signoff_requests row + fires a notification
  // through the reusable push engine. Returns the request id so
  // the manager's modal can subscribe to its outcome.
  router.post("/api/events/:id/dive-order/sign-off/request",
              requireMeetController, async (req, res) => {
    if (!push) {
      return res.status(503).json({ error: "Push backend not configured" });
    }
    const eventId = req.params.id;
    const { referee_id } = req.body || {};
    if (!referee_id) return res.status(400).json({ error: "referee_id required" });
    try {
      const ev = await pool.query(
        `SELECT id, name, status, org_id FROM events
         WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot request sign-off — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      // Verify the referee exists, belongs to the event's org,
      // and actually holds the referee role. A meet manager
      // shouldn't be able to "ask the diver" to sign off.
      const refQ = await pool.query(
        `SELECT u.id, u.full_name
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id
         WHERE u.id = $1 AND u.org_id = $2 AND r.role = 'referee'
         LIMIT 1`,
        [referee_id, ev.rows[0].org_id],
      );
      if (!refQ.rows.length) {
        return res.status(400).json({ error: "Selected user is not a referee in this org" });
      }

      // Expire any prior pending request for the same event so
      // the modal only ever sees the latest one.
      await pool.query(
        `UPDATE referee_signoff_requests
         SET status = 'expired', responded_at = now()
         WHERE event_id = $1 AND status = 'pending'`,
        [eventId],
      );

      // Fetch the manager's name now so we can put it in the
      // notification body without another join later.
      const managerQ = await pool.query(
        "SELECT full_name FROM users WHERE id = $1",
        [req.user.id],
      );
      const managerName = managerQ.rows[0]?.full_name || "A meet manager";

      // Insert request first (without notification_id) so we
      // have an id to include in the push payload. Notification
      // gets linked back via UPDATE below.
      const reqIns = await pool.query(
        `INSERT INTO referee_signoff_requests
           (event_id, requested_by, target_referee_id)
         VALUES ($1, $2, $3)
         RETURNING id, expires_at`,
        [eventId, req.user.id, referee_id],
      );
      const requestId = reqIns.rows[0].id;

      // Fire the notification — push (where subscribed) plus
      // socket emit (always). 5-min TTL matches the request row's
      // expires_at default.
      const result = await push.sendNotification([referee_id], {
        category: "referee_signoff",
        title: "Referee sign-off requested",
        body: `${managerName} asked you to approve the dive order for ${ev.rows[0].name}.`,
        data: {
          event_id: eventId,
          event_name: ev.rows[0].name,
          request_id: requestId,
          requested_by_name: managerName,
        },
        action_url: `/control?signoff_request=${requestId}`,
        actions: [
          { action: "approve", title: "Approve" },
          { action: "deny",    title: "Deny"    },
        ],
        ttl_seconds: 300,
      });

      const notificationId = result.notification_ids[0] || null;
      if (notificationId) {
        await pool.query(
          `UPDATE referee_signoff_requests
           SET notification_id = $1
           WHERE id = $2`,
          [notificationId, requestId],
        );
      }

      res.status(201).json({
        ok: true,
        request_id: requestId,
        expires_at: reqIns.rows[0].expires_at,
        dispatched: result.dispatched,
      });
    } catch (err) {
      console.error("[Sign-Off Request Error]", err.message);
      res.status(500).json({ error: "Failed to request sign-off" });
    }
  });

  // POST /api/events/:id/dive-order/sign-off/respond
  //   Body: { request_id, decision: 'approve' | 'deny' }
  // Referee's SPA hits this from the in-app banner Approve/Deny
  // buttons (or from a deep-linked /control?signoff_request=...).
  // Auth attributes the action to whoever's signed in — must
  // match referee_signoff_requests.target_referee_id.
  router.post("/api/events/:id/dive-order/sign-off/respond",
              requireMeetController, async (req, res) => {
    const { request_id, decision } = req.body || {};
    if (!request_id || !["approve", "deny"].includes(decision)) {
      return res.status(400).json({ error: "request_id + decision (approve|deny) required" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reqQ = await client.query(
        `SELECT id, event_id, target_referee_id, status, expires_at
         FROM referee_signoff_requests
         WHERE id = $1 AND event_id = $2
         FOR UPDATE`,
        [request_id, req.params.id],
      );
      if (!reqQ.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Request not found" });
      }
      const reqRow = reqQ.rows[0];
      if (reqRow.target_referee_id !== req.user.id && !req.user.is_system_admin) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Not the targeted referee for this request" });
      }
      if (reqRow.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Request already ${reqRow.status}`,
          status: reqRow.status,
        });
      }
      if (new Date(reqRow.expires_at) < new Date()) {
        await client.query(
          `UPDATE referee_signoff_requests
           SET status = 'expired', responded_at = now()
           WHERE id = $1`,
          [request_id],
        );
        await client.query("COMMIT");
        return res.status(409).json({ error: "Request expired" });
      }

      const newStatus = decision === "approve" ? "approved" : "declined";
      await client.query(
        `UPDATE referee_signoff_requests
         SET status = $1, decision_method = 'push', responded_at = now()
         WHERE id = $2`,
        [newStatus, request_id],
      );

      if (decision === "approve") {
        await client.query(
          `UPDATE events
           SET dive_order_signed_off_at = now(),
               dive_order_signed_off_by = $1
           WHERE id = $2`,
          [req.user.id, req.params.id],
        );
      }
      await client.query("COMMIT");

      // Notify the manager + anyone else watching the event so
      // their modal flips out of "waiting for referee" state.
      // Doesn't go through the push engine (no need to OS-notify
      // the manager — they're staring at the screen).
      const io = push?.io || null;
      if (push) {
        // Best-effort emit. We don't have a direct handle to the
        // manager's user_id here, but the SPA listens for any
        // referee_signoff_response on its event room.
        try {
          // event_id room is already joined by the Control Room
          // (existing subscribe_event call), so that's where we
          // emit.
          push.emitEvent?.(reqRow.event_id, "referee_signoff_response", {
            request_id, decision: newStatus, by_user_id: req.user.id,
          });
        } catch { /* silent */ }
      }
      res.json({ ok: true, status: newStatus });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Sign-Off Respond Error]", err.message);
      res.status(500).json({ error: "Failed to record response" });
    } finally {
      client.release();
    }
  });

  // POST /api/events/:id/dive-order/sign-off/credential
  //   Body: { username, password, code? }
  // Fallback path: meet manager hands the laptop to the referee.
  // Referee enters their own credentials (+ TOTP code if 2FA is
  // on). Server verifies, ensures they hold the referee role for
  // this event's org, and stamps signed_off_by = their user id.
  // The manager's session is untouched — no JWT swap.
  router.post("/api/events/:id/dive-order/sign-off/credential",
              requireMeetController, async (req, res) => {
    if (!bcrypt) {
      return res.status(503).json({ error: "Credential verifier not wired" });
    }
    const { username, password, code } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username + password required" });
    }
    try {
      const ev = await pool.query(
        `SELECT id, name, status, org_id FROM events
         WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }

      // Look up the user by username. Pull totp fields too so we
      // can enforce the second factor in the same round-trip.
      const u = await pool.query(
        `SELECT id, password, org_id, email_verified_at,
                totp_enabled_at, totp_secret, totp_recovery_codes
         FROM users WHERE username = $1`,
        [username],
      );
      const user = u.rows[0];
      // Constant-time compare against a dummy when the user
      // doesn't exist — same hardening as the main login flow,
      // copy-pasted shape rather than imported to keep this
      // module standalone.
      const fakeHash = "$2b$12$00000000000000000000000000000000000000000000000000000";
      const passwordOk = await bcrypt.compare(password, user?.password || fakeHash);
      if (!user || !passwordOk) {
        return res.status(401).json({ error: "Invalid username or password" });
      }
      if (!user.email_verified_at) {
        return res.status(403).json({ error: "Account email not verified" });
      }
      // Org match: the referee must be in the same org as the
      // event (or sysadmin). Stops a referee from another org
      // accidentally signing off the wrong meet.
      if (user.org_id !== ev.rows[0].org_id) {
        return res.status(403).json({ error: "Referee is not in this event's org" });
      }
      // Referee role check — BEFORE the TOTP block so a one-time
      // recovery code is never consumed for a user who turns out not
      // to be a referee (a 403 they'd get regardless). Also tightens
      // the password oracle: a non-referee learns nothing new.
      const roleQ = await pool.query(
        `SELECT 1 FROM user_org_roles
         WHERE user_id = $1 AND org_id = $2 AND role = 'referee' LIMIT 1`,
        [user.id, ev.rows[0].org_id],
      );
      if (!roleQ.rows.length) {
        return res.status(403).json({ error: "User is not a referee" });
      }
      // TOTP if enabled.
      if (user.totp_enabled_at) {
        if (!totp) return res.status(503).json({ error: "TOTP verifier not wired" });
        if (!code) return res.status(401).json({ error: "TOTP code required", needs_totp: true });
        const looksLikeTotp = typeof code === "string" && /^\d{6}$/.test(code);
        // Replay guard (migration 063), same shape as the main
        // login flow: consume the matched time-step via a
        // conditional UPDATE so a code observed during this
        // sign-off can't mint a second use within the ~90s
        // verify window.
        let accepted = false;
        if (looksLikeTotp) {
          const matchedStep = totp.verifyTokenDelta(user.totp_secret, code);
          if (matchedStep != null) {
            const consumed = await pool.query(
              `UPDATE users
               SET totp_last_used_step = $1
               WHERE id = $2
                 AND (totp_last_used_step IS NULL OR totp_last_used_step < $1)
               RETURNING id`,
              [matchedStep, user.id],
            );
            accepted = consumed.rowCount > 0;
          }
        }
        if (!accepted) {
          const recovery = await totp.consumeRecoveryCode(
            user.totp_recovery_codes || [], code,
          );
          if (recovery.matched) {
            await pool.query(
              `UPDATE users SET totp_recovery_codes = $1::jsonb WHERE id = $2`,
              [JSON.stringify(recovery.remainingHashes), user.id],
            );
            accepted = true;
          }
        }
        if (!accepted) return res.status(401).json({ error: "Invalid TOTP code" });
      }

      // Stamp the sign-off in the event row + close any pending
      // push request for the same event (the referee just signed
      // in person, the push is moot).
      //
      // IMPORTANT: BEGIN/COMMIT must run on the same pooled
      // connection. Using `pool.query` here checks out a fresh
      // connection per call, so the BEGIN ran on a connection
      // that was returned to the pool before the UPDATEs ran on
      // (potentially different) ones — i.e. no transaction at
      // all. A failure between the two UPDATEs would leave the
      // event signed off but the referee_signoff_requests row
      // stuck "pending" forever.
      const txClient = await pool.connect();
      try {
        await txClient.query("BEGIN");
        await txClient.query(
          `UPDATE events
           SET dive_order_signed_off_at = now(),
               dive_order_signed_off_by = $1
           WHERE id = $2`,
          [user.id, req.params.id],
        );
        await txClient.query(
          `UPDATE referee_signoff_requests
           SET status = 'approved', decision_method = 'credential',
               responded_at = now()
           WHERE event_id = $1 AND status = 'pending'
             AND target_referee_id = $2`,
          [req.params.id, user.id],
        );
        await txClient.query("COMMIT");
      } catch (err) {
        await txClient.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        txClient.release();
      }

      res.json({
        ok: true,
        signed_off_by: { id: user.id, full_name: undefined /* not fetched */ },
      });
    } catch (err) {
      console.error("[Sign-Off Credential Error]", err.message);
      res.status(500).json({ error: "Sign-off failed" });
    }
  });

  // -------------------------------------------------------------
  // CUT 3 — CODE HANDOFF
  //
  // The push and credential paths cover most setups, but they
  // both require something — push permission OR the referee
  // physically at the manager's laptop. Cut 3 plugs the gap: the
  // manager generates a 6-digit code on their screen; the
  // referee opens DivingHQ on their own already-signed-in
  // device, navigates to /sign-off-codes, types the code in.
  // Server matches code → pending request → stamps signed_off_by
  // = the referee whose session typed it.
  //
  //   POST /api/events/:id/dive-order/sign-off/code
  //     Body: { referee_id }
  //     Returns: { request_id, code, expires_at }
  //
  //   POST /api/sign-off/code/verify
  //     Body: { code }
  //     Auth: must be a referee. Looks up the pending request
  //     keyed on (target_referee_id = req.user.id, code), stamps
  //     the event's sign-off in the same txn.
  // -------------------------------------------------------------

  // 1-in-1,000,000 collision per code per referee, well below
  // any practical run rate. Cryptographically random rather than
  // Math.random so the codes aren't predictable from the prior
  // batch.
  function generateHandoffCode() {
    const buf = require("crypto").randomBytes(4);
    const n = buf.readUInt32BE(0) % 1_000_000;
    return n.toString().padStart(6, "0");
  }

  router.post("/api/events/:id/dive-order/sign-off/code",
              requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    const { referee_id } = req.body || {};
    if (!referee_id) return res.status(400).json({ error: "referee_id required" });
    try {
      const ev = await pool.query(
        `SELECT id, name, status, org_id FROM events
         WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot generate code — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      // Same referee-validation as the push request path.
      const refQ = await pool.query(
        `SELECT u.id FROM users u
         JOIN user_org_roles r ON r.user_id = u.id
         WHERE u.id = $1 AND u.org_id = $2 AND r.role = 'referee' LIMIT 1`,
        [referee_id, ev.rows[0].org_id],
      );
      if (!refQ.rows.length) {
        return res.status(400).json({ error: "Selected user is not a referee in this org" });
      }

      // Expire any prior pending request for the same event so
      // the modal only ever sees the latest one.
      await pool.query(
        `UPDATE referee_signoff_requests
         SET status = 'expired', responded_at = now()
         WHERE event_id = $1 AND status = 'pending'`,
        [eventId],
      );

      // Retry on the unique-pending-code-per-referee index race.
      // Three tries is plenty — the cardinality is 1e6 and the
      // partial index narrows to <1 active code per referee on
      // average.
      let attempts = 0;
      let inserted;
      while (attempts++ < 3 && !inserted) {
        const code = generateHandoffCode();
        try {
          inserted = await pool.query(
            `INSERT INTO referee_signoff_requests
               (event_id, requested_by, target_referee_id, handoff_code)
             VALUES ($1, $2, $3, $4)
             RETURNING id, expires_at, handoff_code`,
            [eventId, req.user.id, referee_id, code],
          );
        } catch (err) {
          if (err.code !== "23505") throw err;
          // Collision on (target_referee_id, handoff_code) WHERE
          // pending — try again with a fresh code. Won't happen
          // in practice but the retry guards against the rare
          // case where two managers are both generating codes
          // for the same referee at the exact same instant.
        }
      }
      if (!inserted) {
        return res.status(503).json({ error: "Could not allocate a handoff code; try again" });
      }

      // QR encodes a deep link back into the SPA's referee-side
      // sign-off page with the code pre-filled. Server-side render
      // (qrcode → PNG data URL) keeps the SPA free of an extra
      // client lib and means the manager's tab doesn't need to do
      // canvas work mid-meet. Same auth path on the receiving end:
      // the referee scans, lands on /sign-off-codes?code=…, the
      // SPA auto-submits if they're already signed in OR bounces
      // through /login?next=… and back. The QR carries no secret
      // beyond what the typeable code already has — the verifier
      // still requires the referee's own JWT (target_referee_id =
      // req.user.id) so a leaked QR is useless to anyone but the
      // specific referee the manager picked.
      // APP_BASE_URL must be configured. Without it the previous
      // fallback used `req.get('host')` — a client-supplied header
      // that an attacker can spoof to point the QR at their own
      // domain (the referee would then type the code into the
      // attacker's site, which replays it to the real server).
      // Refusing to issue a code when the env is missing surfaces
      // the misconfiguration loudly instead of silently exposing
      // the open-redirect.
      const baseUrl = process.env.APP_BASE_URL;
      if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
        return res.status(503).json({
          error: "Sign-off codes are not available — APP_BASE_URL is not configured",
        });
      }
      const deepLink = `${baseUrl}/sign-off-codes?code=${encodeURIComponent(inserted.rows[0].handoff_code)}`;
      let qrDataUrl = null;
      try {
        qrDataUrl = await QRCode.toDataURL(deepLink, {
          // Slightly larger + higher error-correction than default
          // so a phone camera in a dim pool deck still resolves it.
          // 256×256 is plenty at the modal's render size; "M" is
          // 15% redundancy which tolerates a thumb-print on the
          // manager's screen.
          width: 256,
          margin: 1,
          errorCorrectionLevel: "M",
        });
      } catch (err) {
        // QR is a UX nicety — falling back to the typeable code
        // alone keeps the modal functional if the generator hits
        // an edge case.
        console.error("[Sign-Off QR Generate Error]", err.message);
      }

      res.status(201).json({
        ok: true,
        request_id:   inserted.rows[0].id,
        code:         inserted.rows[0].handoff_code,
        expires_at:   inserted.rows[0].expires_at,
        qr_data_url:  qrDataUrl,
        deep_link:    deepLink,
      });
    } catch (err) {
      console.error("[Sign-Off Code Generate Error]", err.message);
      res.status(500).json({ error: "Failed to generate code" });
    }
  });

  // POST /api/sign-off/code/verify
  //   Body: { code }
  // Used by the referee on their own device (SignOffCodeView).
  // Looks up the pending request keyed on the caller's user_id,
  // stamps the event sign-off, fires the same socket broadcast
  // the push respond endpoint does so the manager modal flips.
  router.post("/api/sign-off/code/verify",
              requireOrgRole(["referee", "org_admin"]), async (req, res) => {
    const code = String(req.body?.code || "").trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Code must be 6 digits" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reqQ = await client.query(
        `SELECT id, event_id, expires_at, status
         FROM referee_signoff_requests
         WHERE target_referee_id = $1 AND handoff_code = $2
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [req.user.id, code],
      );
      if (!reqQ.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Code not recognised" });
      }
      const reqRow = reqQ.rows[0];
      if (reqRow.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Code already ${reqRow.status}` });
      }
      if (new Date(reqRow.expires_at) < new Date()) {
        await client.query(
          `UPDATE referee_signoff_requests SET status='expired', responded_at=now() WHERE id=$1`,
          [reqRow.id],
        );
        await client.query("COMMIT");
        return res.status(409).json({ error: "Code expired" });
      }
      await client.query(
        `UPDATE referee_signoff_requests
         SET status='approved', decision_method='code', responded_at=now()
         WHERE id=$1`,
        [reqRow.id],
      );
      await client.query(
        `UPDATE events
         SET dive_order_signed_off_at = now(),
             dive_order_signed_off_by = $1
         WHERE id = $2`,
        [req.user.id, reqRow.event_id],
      );
      await client.query("COMMIT");

      // Broadcast so the manager's open Control Room flips out
      // of "waiting" state — same channel the push respond path
      // uses.
      try {
        push?.emitEvent?.(reqRow.event_id, "referee_signoff_response", {
          request_id: reqRow.id, decision: "approved", by_user_id: req.user.id,
        });
      } catch { /* silent */ }

      res.json({ ok: true, event_id: reqRow.event_id });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Sign-Off Code Verify Error]", err.message);
      res.status(500).json({ error: "Verification failed" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // PUT /api/dive-lists/:id/withdraw — scratch / reinstate. Body:
  // { withdrawn: bool }. Standings still attribute prior dives;
  // the active queue excludes them from upcoming rounds.
  // -------------------------------------------------------------
  router.put("/api/dive-lists/:id/withdraw", requireMeetController, idem("dive_list_withdraw"), async (req, res) => {
    const { withdrawn } = req.body || {};
    try {
      const r = await pool.query(
        `UPDATE competitor_dive_lists cdl
         SET withdrawn_at = CASE WHEN $1::boolean THEN now() ELSE NULL END
         FROM events e, users u
         WHERE cdl.id = $2 AND cdl.event_id = e.id AND cdl.competitor_id = u.id
           AND ($3::boolean OR e.org_id = $4)
         RETURNING cdl.id, cdl.event_id, cdl.competitor_id, cdl.withdrawn_at,
                   e.org_id, e.name AS event_name, u.full_name AS diver_name`,
        [!!withdrawn, req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Dive list row not found" });
      const row = r.rows[0];
      // Audit. Record the diver's name in entity_name so the
      // audit feed reads "Withdrew Avery Ueno from 2024 FRA
      // Grand Prix 10m" — both halves of the link are useful.
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id:      row.org_id,
        entity_type: "roster_entry",
        entity_id:   row.id,
        entity_name: row.diver_name,
        action:      withdrawn ? "roster.withdrew" : "roster.reinstated",
        metadata: {
          event_id:      row.event_id,
          event_name:    row.event_name,
          competitor_id: row.competitor_id,
        },
      });
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Withdraw Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // CHECK-IN / ATTENDANCE (Migration 016)
  // Operators flip a Present / Late / Absent chip per diver.
  // Status is per-(event, competitor); the absence of a row means
  // "not yet checked in" so the operator can see who hasn't been
  // ticked off.
  // -------------------------------------------------------------
  router.get("/api/events/:id/attendance", requireMeetController, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const r = await pool.query(
        `SELECT u.id AS competitor_id, u.full_name,
                o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                ea.status::text  AS status,
                ea.set_at,
                actor.full_name  AS set_by_name
         FROM (
           SELECT DISTINCT competitor_id
           FROM competitor_dive_lists WHERE event_id = $1
         ) entry
         JOIN users u           ON u.id = entry.competitor_id
         JOIN organisations o   ON o.id = u.org_id
         LEFT JOIN clubs cl     ON cl.id = u.club_id
         LEFT JOIN event_attendance ea
           ON ea.event_id = $1 AND ea.competitor_id = u.id
         LEFT JOIN users actor  ON actor.id = ea.set_by
         ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Attendance List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/events/:id/attendance/:competitorId", requireMeetController, idem("attendance_set"), async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const { status } = req.body || {};
      const VALID = new Set(["present", "late", "absent"]);
      if (status != null && !VALID.has(status)) {
        return res.status(400).json({ error: "status must be present | late | absent | null" });
      }
      if (status == null) {
        await pool.query(
          `DELETE FROM event_attendance
           WHERE event_id = $1 AND competitor_id = $2`,
          [req.params.id, req.params.competitorId],
        );
        return res.json({ ok: true, status: null });
      }
      const r = await pool.query(
        `INSERT INTO event_attendance (event_id, competitor_id, status, set_by)
         VALUES ($1, $2, $3::attendance_status, $4)
         ON CONFLICT (event_id, competitor_id)
         DO UPDATE SET status = EXCLUDED.status,
                       set_at = now(),
                       set_by = EXCLUDED.set_by
         RETURNING status::text AS status, set_at`,
        [req.params.id, req.params.competitorId, status, req.user.id],
      );
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Attendance Set Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/roster — late-entry add. Used when a
  // diver shows up but didn't pre-submit a list. Single-row
  // version of the CSV import.
  // -------------------------------------------------------------
  router.post("/api/events/:id/roster", requireMeetEditor, idem("roster_late_add"), async (req, res) => {
    const { competitor_id, dive_id, round_number, partner_id, team_id } = req.body || {};
    if (!competitor_id || !dive_id || !round_number) {
      return res.status(400).json({
        error: "competitor_id, dive_id, and round_number are required",
      });
    }
    try {
      const ev = await pool.query(
        "SELECT id, org_id, name, total_rounds FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const eventOrgId = ev.rows[0].org_id;

      // Bounds-check against the event's round count BEFORE the
      // INSERT — a non-integer would otherwise surface as a
      // Postgres cast error (500) instead of a validation 400.
      const totalRounds = ev.rows[0].total_rounds;
      if (!Number.isInteger(round_number) || round_number < 1 || round_number > totalRounds) {
        return res.status(400).json({
          error: `round_number must be an integer between 1 and ${totalRounds}`,
        });
      }

      const u = await pool.query(
        "SELECT id, org_id, full_name FROM users WHERE id = $1",
        [competitor_id],
      );
      if (!u.rows.length || u.rows[0].org_id !== eventOrgId) {
        return res.status(400).json({ error: "Competitor must belong to this organisation" });
      }

      // An attached partner / team must belong to the same org as the
      // event (AGENTS.md isInSameOrg invariant). Without this a meet
      // manager could splice a cross-org user/team into the roster —
      // the public GET /api/events/:id/history joins on partner_id and
      // would leak that foreign user's name + country.
      if (partner_id) {
        const p = await pool.query(
          "SELECT 1 FROM users WHERE id = $1 AND org_id = $2",
          [partner_id, eventOrgId],
        );
        if (!p.rows.length) {
          return res.status(400).json({ error: "Partner must belong to this organisation" });
        }
      }
      if (team_id) {
        const tm = await pool.query(
          "SELECT 1 FROM teams WHERE id = $1 AND org_id = $2",
          [team_id, eventOrgId],
        );
        if (!tm.rows.length) {
          return res.status(400).json({ error: "Team must belong to this organisation" });
        }
      }

      // xmax=0 on the returning row distinguishes a fresh
      // INSERT from an ON-CONFLICT UPDATE — the audit row's
      // action differs (late_entry_added vs dive_edited) so
      // a referee scrolling the audit log can tell whether
      // a roster row was added (e.g. walk-up entry) or an
      // existing diver's dive was changed mid-event.
      const r = await pool.query(
        `INSERT INTO competitor_dive_lists
           (event_id, competitor_id, dive_id, round_number, partner_id, team_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id, competitor_id, round_number)
         DO UPDATE SET dive_id = EXCLUDED.dive_id,
                       partner_id = EXCLUDED.partner_id,
                       team_id = EXCLUDED.team_id,
                       withdrawn_at = NULL
         RETURNING id, (xmax = 0) AS was_inserted`,
        [req.params.id, competitor_id, dive_id, round_number, partner_id || null, team_id || null],
      );
      const wasInserted = r.rows[0].was_inserted === true;
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id:      eventOrgId,
        entity_type: "roster_entry",
        entity_id:   r.rows[0].id,
        entity_name: u.rows[0].full_name,
        action:      wasInserted ? "roster.late_entry_added" : "roster.dive_edited",
        metadata: {
          event_id:      ev.rows[0].id,
          event_name:    ev.rows[0].name,
          competitor_id,
          round_number,
          dive_id,
          partner_id:    partner_id || null,
          team_id:       team_id || null,
        },
      });
      res.status(wasInserted ? 201 : 200).json({
        ok: true,
        dive_list_id: r.rows[0].id,
        action: wasInserted ? "added" : "edited",
      });
    } catch (err) {
      console.error("[Late Entry Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/roster/import — CSV bulk import.
  // Header: username,partner_username,round_1_code,round_1_pos,…
  // Per-row errors are returned without failing the whole import.
  // bulkWriteLimiter caps abuse — the parser itself caps input at
  // 200KB.
  // -------------------------------------------------------------
  router.post("/api/events/:id/roster/import",
    bulkWriteLimiter,
    requireMeetEditor,
    async (req, res) => {
      const { csv, preview, dry_run } = req.body || {};
      if (typeof csv !== "string" || !csv.trim()) {
        return res.status(400).json({ error: "csv body field is required" });
      }
      if (csv.length > 200_000) {
        return res.status(413).json({ error: "CSV is too large (max ~200KB / a few thousand rows)." });
      }
      const client = await pool.connect();
      let inTransaction = false;
      try {
        const ev = await client.query(
          "SELECT id, org_id, height, total_rounds, event_type FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
          [req.params.id, !!req.user.is_system_admin, req.user.org_id],
        );
        if (!ev.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        const event = ev.rows[0];
        const commit = !(preview === true || dry_run === true);
        if (commit) {
          await client.query("BEGIN");
          inTransaction = true;
        }
        const stats = await buildRosterImportPlan(client, event, csv, { commit });
        if (commit) {
          await client.query("COMMIT");
          inTransaction = false;
        }
        res.json(stats);
      } catch (err) {
        if (inTransaction) await client.query("ROLLBACK");
        if (err.status) {
          return res.status(err.status).json({ error: err.message });
        }
        console.error("[Roster Import Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // -------------------------------------------------------------
  // GET /api/events/:id/history — public dive-by-dive recap. Used
  // by the live scoreboard and the post-meet recap. No auth: the
  // data is already public via the scoreboard endpoint.
  // -------------------------------------------------------------
  router.get("/api/events/:id/history", async (req, res) => {
    try {
      // Dive-by-dive scope: d.dd is a grouping column, so it
      // feeds the UDF directly (no MAX() wrapper).
      const r = await pool.query(
        `${perDiveSelect({
          select: [
            `u.full_name AS "diverName"`, "o.country_code",
            "cl.name AS club_name", "cl.short_code AS club_code",
            "pu.full_name AS partner_name",
            "po.country_code AS partner_country",
            "t.name AS team_name", "t.short_code AS team_code",
            "s.competitor_id", "s.event_id", "s.round_number",
            "d.dive_code", "d.position", "d.dd", "d.description",
          ],
          dd:          "d.dd",
          pointsAlias: "total_points",
          selectExtra: [
            `/* Three parallel arrays — same ordering across all
                three so consumers can zip them. ej.judge_number
                (panel position 1..N) gives the canonical order;
                s.judge_id (UUID) does not. */
             JSON_AGG(s.score        ORDER BY ej.judge_number) AS judge_scores`,
            "JSON_AGG(s.id           ORDER BY ej.judge_number) AS score_ids",
            "JSON_AGG(ej.judge_number ORDER BY ej.judge_number) AS judge_numbers",
          ],
          extraJoins: [
            "JOIN users u ON s.competitor_id = u.id",
            "JOIN organisations o ON u.org_id = o.id",
            "LEFT JOIN clubs cl ON cl.id = u.club_id",
            "LEFT JOIN users pu ON pu.id = cdl.partner_id",
            "LEFT JOIN organisations po ON po.id = pu.org_id",
            "LEFT JOIN teams t ON t.id = cdl.team_id",
          ],
          groupBy: [
            "u.full_name", "o.country_code", "cl.name", "cl.short_code",
            "pu.full_name", "po.country_code", "t.name", "t.short_code",
            "s.competitor_id", "s.event_id", "s.round_number",
            "d.dive_code", "d.position", "d.dd", "d.description",
          ],
        })}
         ORDER BY s.round_number ASC, u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[History Error]", err.message);
      res.status(500).json([]);
    }
  });

  return router;
};

function clampAuditLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 12;
  return Math.min(50, Math.max(1, n));
}
