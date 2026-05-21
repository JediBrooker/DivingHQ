// Competitor self-service routes — diver submits their own
// dive list before a meet. Synchro events also resolve the
// partner here.
//
//   POST /api/competitor/submit-list
//
// Gated by:
//   * requireOrgRole(["diver"])     — only divers can self-submit
//   * loadEventForEntries           — event must still be Upcoming
//                                     and entries_close_at not yet
//                                     reached. Late additions are
//                                     a manager-only flow via the
//                                     Control Room late-entry add.
//   * bulkWriteLimiter              — caps abuse on the bulk write
//
// Mounted via:
//   app.use(require('./routes/competitor')({ … }))

const express = require("express");

module.exports = function createCompetitorRouter({
  pool,
  verifyToken,
  requireOrgRole,
  bulkWriteLimiter,
  loadEventForEntries,
  push, // optional — when present, drives synchro consent notifications
}) {
  if (!pool) throw new Error("createCompetitorRouter requires { pool, … }");
  const router = express.Router();
  const submitDiveList = require("../lib/dive-list-submit");
  const { writeSynchroBothSides } = submitDiveList;

  router.post(
    "/api/competitor/submit-list",
    bulkWriteLimiter,
    requireOrgRole(["diver"]),
    async (req, res) => {
      const { event_id, dives, partner_id, actor_local_time } = req.body || {};
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Confirm the event exists and is still accepting entries.
        // Passes actor_local_time so the gate can return a
        // late_review verdict instead of 409 when the outbox
        // client claims pre-deadline submission (DEC-04).
        const gate = await loadEventForEntries(client, event_id, {
          actorLocalTime: actor_local_time,
        });
        if (gate.error) {
          await client.query("ROLLBACK");
          return res.status(gate.status).json({ error: gate.error });
        }

        // All validation + insert lives in lib/dive-list-submit.js
        // so the coach-on-behalf-of endpoint can reuse it.
        const result = await submitDiveList({
          client,
          event: gate.event,
          actor: {
            id: req.user.id,
            org_id: req.user.org_id,
            is_system_admin: req.user.is_system_admin,
            full_name: req.user.full_name,
          },
          competitorId:    req.user.id,
          competitorOrgId: req.user.org_id,
          partnerId:       partner_id,
          dives,
          push,
          actorLocalTime: actor_local_time,
          lateReview:     gate.lateReview,
        });

        await client.query("COMMIT");
        // Synchro consent (migration 051) — surface the
        // pending/auto-confirmed status so the SPA can switch
        // between "Submitted" and "Waiting for partner" toasts.
        if (result?.pairing?.status === "pending") {
          return res.json({
            message: "Pairing request sent — waiting for partner",
            pairing: result.pairing,
            late_review: gate.lateReview,
          });
        }
        if (result?.pairing?.status === "auto_confirmed") {
          return res.json({
            message: "Synchro pairing confirmed",
            pairing: result.pairing,
            late_review: gate.lateReview,
          });
        }
        // late_review=true on the response tells the SPA to show a
        // "submitted, but flagged for referee review" toast instead
        // of the plain success one.
        res.json({
          message: gate.lateReview
            ? "Dive list submitted — flagged for referee review (arrived after the entry deadline; the meet manager will confirm or deny)"
            : "Dive list submitted",
          late_review: gate.lateReview,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.status) {
          // Validation error from the shared helper — return its
          // structured shape with optional `violations`.
          const body = { error: err.message };
          if (err.violations) body.violations = err.violations;
          return res.status(err.status).json(body);
        }
        console.error("[Submit List Error]", err.message);
        res
          .status(500)
          .json({ error: err.detail || "Failed to submit dive list" });
      } finally {
        client.release();
      }
    },
  );

  // -------------------------------------------------------------
  // GET /api/events/:id/me-meet-day
  //
  // The diver's competition-day "now" view. Composes data the
  // operator surfaces and the spectator scoreboard already have
  // — dive list + queue + standings + catch-up math — into a
  // single payload for a focused phone-deck experience:
  //
  //   { event, next_dive, queue, standing, targets }
  //
  // Auth: caller must hold a competitor_dive_lists row for this
  // event. That implicitly covers host org + every participating
  // org because the entry endpoint already gated on that.
  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // POST /api/competitor/confirm-list
  //
  // Migration 041 — when a diver advances to a new stage, their
  // dive list inherits from the parent event. The diver portal
  // surfaces a "Confirm or edit" prompt; this endpoint is the
  // "Confirm" path: the diver explicitly says "ride with the
  // inherited list, don't change anything".
  //
  // Stamps confirmed_at = NOW() on every row this diver has in
  // the event, so the operator can audit who actively responded
  // before the post-advance lock.
  //
  // Idempotent — safe to re-run; just re-stamps the timestamp.
  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // GET /api/competitor/list-status?event_id=…
  //
  // Returns the caller's status in the given event:
  //   { entered, is_reserve, reserve_position, confirmed_at,
  //     dive_list_locks_at }
  //
  // Used by the diver portal to render the "You're a reserve"
  // banner + the post-advance lock messaging. Cheap query, one
  // event at a time.
  // -------------------------------------------------------------
  router.get("/api/competitor/list-status", verifyToken, async (req, res) => {
    const eventId = req.query.event_id;
    if (!eventId) {
      return res.status(400).json({ error: "event_id query param required" });
    }
    try {
      const [meta, divesRes] = await Promise.all([
        pool.query(
          `SELECT BOOL_OR(cdl.is_reserve)            AS is_reserve,
                  MIN(cdl.reserve_position)          AS reserve_position,
                  MAX(cdl.confirmed_at)              AS confirmed_at,
                  MAX(e.dive_list_locks_at)          AS dive_list_locks_at,
                  COUNT(*)                           AS row_count
             FROM competitor_dive_lists cdl
             JOIN events e ON e.id = cdl.event_id
            WHERE cdl.event_id = $1
              AND cdl.competitor_id = $2
              AND cdl.withdrawn_at IS NULL`,
          [eventId, req.user.id],
        ),
        // Diver's own dives by round, joined with the dive
        // directory so the diver portal can pre-fill their
        // existing list (whether they self-submitted earlier
        // or it was inherited from a prior stage).
        pool.query(
          `SELECT cdl.round_number,
                  cdl.dive_id,
                  d.dive_code, d.position, d.dd, d.description,
                  d.height AS dive_height
             FROM competitor_dive_lists cdl
             LEFT JOIN dive_directory d ON d.id = cdl.dive_id
            WHERE cdl.event_id = $1
              AND cdl.competitor_id = $2
              AND cdl.withdrawn_at IS NULL
            ORDER BY cdl.round_number ASC`,
          [eventId, req.user.id],
        ),
      ]);
      const row = meta.rows[0];
      res.json({
        entered:            Number(row.row_count) > 0,
        is_reserve:         !!row.is_reserve,
        reserve_position:   row.reserve_position,
        confirmed_at:       row.confirmed_at,
        dive_list_locks_at: row.dive_list_locks_at,
        dives:              divesRes.rows,
      });
    } catch (err) {
      console.error("[List Status Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/competitor/confirm-list", verifyToken, async (req, res) => {
    const { event_id } = req.body || {};
    if (!event_id) {
      return res.status(400).json({ error: "event_id required" });
    }
    try {
      const r = await pool.query(
        `UPDATE competitor_dive_lists
            SET confirmed_at = NOW()
          WHERE event_id = $1 AND competitor_id = $2
          RETURNING round_number`,
        [event_id, req.user.id],
      );
      if (!r.rows.length) {
        return res.status(404).json({ error: "You're not entered in this event" });
      }
      res.json({ confirmed: true, rounds: r.rows.length });
    } catch (err) {
      console.error("[Confirm List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/events/:id/me-meet-day", verifyToken, async (req, res) => {
    const eventId = req.params.id;
    const userId = req.user.id;
    try {
      // 1. Verify the caller is in this event AND pull the event.
      const evRes = await pool.query(
        `SELECT e.id, e.name, e.status, e.event_type::text AS event_type,
                e.height, e.total_rounds, e.number_of_judges,
                o.name AS org_name, o.country_code
           FROM events e
           JOIN organisations o ON o.id = e.org_id
          WHERE e.id = $1`,
        [eventId],
      );
      if (!evRes.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const event = evRes.rows[0];
      const isMine = await pool.query(
        `SELECT 1 FROM competitor_dive_lists
          WHERE event_id = $1 AND competitor_id = $2 AND withdrawn_at IS NULL
          LIMIT 1`,
        [eventId, userId],
      );
      if (!isMine.rows.length) {
        return res.status(403).json({
          error: "You're not entered in this event",
        });
      }

      // 2. My dive list, joined to directory, with completion flag.
      const myDivesRes = await pool.query(
        `SELECT cdl.round_number, cdl.dive_id,
                d.dive_code, d.position::text AS position,
                d.dd, d.description, d.height::text AS dive_height,
                COALESCE(score_count.n, 0)::int AS judges_in,
                $3::int AS judges_needed
           FROM competitor_dive_lists cdl
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS n
               FROM scores s
              WHERE s.event_id = cdl.event_id
                AND s.competitor_id = cdl.competitor_id
                AND s.round_number = cdl.round_number
           ) score_count ON true
          WHERE cdl.event_id = $1 AND cdl.competitor_id = $2
            AND cdl.withdrawn_at IS NULL
          ORDER BY cdl.round_number ASC`,
        [eventId, userId, parseInt(event.number_of_judges) || 5],
      );
      const myDives = myDivesRes.rows.map(r => ({
        round_number: r.round_number,
        dive_code: r.dive_code,
        position: r.position,
        dd: r.dd != null ? Number(r.dd) : null,
        description: r.description,
        dive_height: r.dive_height,
        completed: r.judges_in >= r.judges_needed,
      }));
      const nextDive = myDives.find(d => !d.completed) || null;
      const remainingDives = myDives.filter(d => !d.completed).length;

      // 3. Standings — same per-dive math as the public scoreboard,
      //    rolled up per competitor. Rank ties share (World Aquatics practice).
      const standRes = await pool.query(
        `WITH per_dive AS (
           SELECT s.competitor_id, s.round_number,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score        ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS dive_points
             FROM scores s
             JOIN events e ON e.id = s.event_id
             LEFT JOIN event_judges ej
               ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
             LEFT JOIN competitor_dive_lists cdl
               ON cdl.event_id = s.event_id
              AND cdl.competitor_id = s.competitor_id
              AND cdl.round_number = s.round_number
             LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
            WHERE s.event_id = $1
            GROUP BY s.competitor_id, s.round_number,
                     e.number_of_judges, e.event_type
         ), totals AS (
           SELECT competitor_id, SUM(dive_points)::numeric AS total
             FROM per_dive
            GROUP BY competitor_id
         )
         SELECT competitor_id, total::float AS total
           FROM totals
          ORDER BY total DESC NULLS LAST`,
        [eventId],
      );
      const standings = standRes.rows;
      // Ties share rank (World Aquatics practice).
      const ranked = standings.map((s, i) => ({ ...s, _idx: i }));
      let prevTotal = null;
      let prevRank  = 0;
      for (const s of ranked) {
        if (prevTotal !== null && Math.abs(s.total - prevTotal) < 1e-9) {
          s.rank = prevRank;
        } else {
          s.rank = s._idx + 1;
          prevRank  = s.rank;
          prevTotal = s.total;
        }
      }
      const meRow = ranked.find(s => s.competitor_id === userId);
      const myRank  = meRow ? meRow.rank  : null;
      const myTotal = meRow ? Number(meRow.total) : 0;
      const totalCompetitors = ranked.length;
      const leaderTotal = ranked[0] ? Number(ranked[0].total) : 0;

      // Top three distinct totals — these are the gold/silver/
      // bronze targets. Tied scores at the cut share the medal so
      // the diver-facing math stays accurate even at podium edges.
      const distinctTotals = [];
      for (const s of ranked) {
        if (!distinctTotals.includes(Number(s.total))) {
          distinctTotals.push(Number(s.total));
          if (distinctTotals.length >= 3) break;
        }
      }
      const goldTotal   = distinctTotals[0] ?? null;
      const silverTotal = distinctTotals[1] ?? null;
      const bronzeTotal = distinctTotals[2] ?? null;

      // 4. Catch-up math — mirrors ScoreboardView's
      //    activeProjection. The DD proxy is the diver's NEXT
      //    dive (we know it; the public scoreboard had to use the
      //    active diver's dive as a proxy).
      const numJudges = parseInt(event.number_of_judges) || 5;
      const isSynchro = event.event_type === "synchro_pair";
      // Trim count: 5j drop 1+1, 7j drop 2+2, 9j drop 2+2, 11j drop 3+3.
      function trimCount(n) {
        if (n >= 11) return 3;
        if (n >= 7)  return 2;
        if (n >= 5)  return 1;
        return 0;
      }
      function panelMultiplier(j, sync) {
        if (sync) return 9;
        const drop = trimCount(j);
        return Math.max(1, j - 2 * drop);
      }
      const mult = panelMultiplier(numJudges, isSynchro);
      const ddProxy = nextDive ? nextDive.dd : null;
      const remaining = remainingDives;

      function targetFor(targetTotal) {
        if (targetTotal == null || myTotal >= targetTotal) {
          return { gap: 0, needs_avg: 0, possible: true, achieved: true };
        }
        const gap = targetTotal - myTotal;
        if (!remaining || !ddProxy) {
          return { gap, needs_avg: null, possible: null, achieved: false };
        }
        const raw = gap / (mult * ddProxy * remaining);
        const rounded = Math.ceil(raw * 2) / 2;
        return {
          gap: Number(gap.toFixed(2)),
          needs_avg: rounded,
          possible: raw <= 10,
          achieved: false,
        };
      }

      const targets = {
        gold:   targetFor(goldTotal),
        silver: targetFor(silverTotal),
        bronze: targetFor(bronzeTotal),
      };

      // 5. Queue — who's on the board now + how many divers until
      //    me. Pull the live state row + the dive order around me.
      const liveRes = await pool.query(
        "SELECT active_diver_payload FROM event_live_state WHERE event_id = $1",
        [eventId],
      );
      const active = liveRes.rows[0]?.active_diver_payload || null;
      let activeName = null;
      let activeRound = null;
      if (active) {
        activeName  = active.full_name || active.diverName || null;
        activeRound = active.round_number != null ? parseInt(active.round_number) : null;
      }
      // How many divers in nextDive's round are ahead of me by
      // display_order. Without an active diver we report null —
      // the SPA renders "Pre-event" instead of a misleading 0.
      let diversUntilMe = null;
      let myPositionInRound = null;
      if (nextDive) {
        const meOrderRes = await pool.query(
          `SELECT display_order
             FROM competitor_dive_lists
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [eventId, userId, nextDive.round_number],
        );
        const myOrder = meOrderRes.rows[0]?.display_order;
        if (myOrder != null) {
          myPositionInRound = myOrder;
          if (active && activeRound === nextDive.round_number) {
            const activeId = active.competitor_id || active.id;
            if (activeId) {
              const activeOrderRes = await pool.query(
                `SELECT display_order FROM competitor_dive_lists
                  WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
                [eventId, activeId, nextDive.round_number],
              );
              const activeOrder = activeOrderRes.rows[0]?.display_order;
              if (activeOrder != null) {
                diversUntilMe = Math.max(0, myOrder - activeOrder);
              }
            }
          } else if (activeRound != null && activeRound < nextDive.round_number) {
            // Active is in a prior round — the count of remaining
            // divers in this round is just my position.
            diversUntilMe = myOrder;
          }
        }
      }

      res.json({
        event: {
          id: event.id,
          name: event.name,
          status: event.status,
          event_type: event.event_type,
          height: event.height,
          total_rounds: event.total_rounds,
          number_of_judges: event.number_of_judges,
          org_name: event.org_name,
          country_code: event.country_code,
        },
        me: {
          competitor_id: userId,
          full_name: req.user.full_name,
        },
        next_dive: nextDive ? {
          round_number:    nextDive.round_number,
          dive_code:       nextDive.dive_code,
          position:        nextDive.position,
          dd:              nextDive.dd,
          description:     nextDive.description,
          dive_height:     nextDive.dive_height,
        } : null,
        remaining_dives: remaining,
        completed_dives: myDives.length - remaining,
        total_dives:     myDives.length,
        queue: {
          active_diver_name:  activeName,
          active_round:       activeRound,
          divers_until_me:    diversUntilMe,
          my_position_in_round: myPositionInRound,
        },
        standing: {
          rank:               myRank,
          total:              myTotal,
          total_competitors:  totalCompetitors,
          behind_leader:      leaderTotal - myTotal,
        },
        targets,
      });
    } catch (err) {
      console.error("[Meet Day Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // SYNCHRO PARTNER CONSENT ENDPOINTS (migration 051)
  //
  // The synchro submit path defers competitor_dive_lists writes
  // until both divers agree. These three endpoints surface the
  // pending state to the invitee and let them respond.
  // -------------------------------------------------------------

  // GET /api/competitor/pending-pairings
  // Pending synchro invites where the caller is the invitee.
  router.get(
    "/api/competitor/pending-pairings",
    verifyToken,
    async (req, res) => {
      try {
        const r = await pool.query(
          `SELECT p.id,
                  p.event_id,
                  p.requester_id,
                  p.created_at,
                  u.full_name AS requester_name,
                  e.name      AS event_name,
                  e.event_type::text AS event_type,
                  e.height    AS event_height
             FROM pending_partner_pairings p
             JOIN users  u ON u.id = p.requester_id
             JOIN events e ON e.id = p.event_id
            WHERE p.partner_id = $1
              AND p.status     = 'pending'
            ORDER BY p.created_at DESC`,
          [req.user.id],
        );
        res.json(r.rows);
      } catch (err) {
        console.error("[Pending Pairings Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // POST /api/competitor/pairings/:id/accept
  // Invitee accepts. Inserts competitor_dive_lists rows for BOTH
  // divers using the requester's stored proposal.
  router.post(
    "/api/competitor/pairings/:id/accept",
    verifyToken,
    requireOrgRole(["diver"]),
    async (req, res) => {
      const pairingId = req.params.id;
      const client    = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query(
          `SELECT id, event_id, requester_id, partner_id, status, dives
             FROM pending_partner_pairings
            WHERE id = $1
            FOR UPDATE`,
          [pairingId],
        );
        if (!r.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Pairing not found" });
        }
        const pairing = r.rows[0];
        // Only the invitee may accept.
        if (pairing.partner_id !== req.user.id) {
          await client.query("ROLLBACK");
          return res
            .status(403)
            .json({ error: "Only the invited diver can accept this pairing" });
        }
        if (pairing.status !== "pending") {
          await client.query("ROLLBACK");
          return res
            .status(409)
            .json({ error: `Pairing already ${pairing.status}` });
        }

        // Flip the row and write both sides in one transaction.
        await client.query(
          `UPDATE pending_partner_pairings
              SET status       = 'accepted',
                  responded_at = NOW()
            WHERE id = $1`,
          [pairingId],
        );
        await writeSynchroBothSides(client, {
          eventId:     pairing.event_id,
          requesterId: pairing.requester_id,
          partnerId:   pairing.partner_id,
          dives:       pairing.dives || [],
        });

        await client.query("COMMIT");

        if (push && typeof push.sendNotification === "function") {
          push.sendNotification([pairing.requester_id], {
            category: "synchro.partner_invite",
            title: "Synchro partner confirmed",
            body: `${req.user.full_name || "Your partner"} accepted your pairing request`,
            data: {
              event_id:   pairing.event_id,
              pairing_id: pairing.id,
              kind:       "accepted",
            },
          }).catch((err) =>
            console.error("[synchro] accept push failed", err.message),
          );
        }

        res.json({ ok: true, pairing_id: pairing.id, status: "accepted" });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        if (err.status) {
          return res.status(err.status).json({ error: err.message });
        }
        console.error("[Pairing Accept Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // POST /api/competitor/pairings/:id/decline
  // Invitee declines. No competitor_dive_lists writes; just flip
  // the row's status so the requester can be notified.
  router.post(
    "/api/competitor/pairings/:id/decline",
    verifyToken,
    requireOrgRole(["diver"]),
    async (req, res) => {
      const pairingId = req.params.id;
      try {
        const r = await pool.query(
          `SELECT id, event_id, requester_id, partner_id, status
             FROM pending_partner_pairings
            WHERE id = $1`,
          [pairingId],
        );
        if (!r.rows.length) {
          return res.status(404).json({ error: "Pairing not found" });
        }
        const pairing = r.rows[0];
        if (pairing.partner_id !== req.user.id) {
          return res
            .status(403)
            .json({ error: "Only the invited diver can decline this pairing" });
        }
        if (pairing.status !== "pending") {
          return res
            .status(409)
            .json({ error: `Pairing already ${pairing.status}` });
        }

        await pool.query(
          `UPDATE pending_partner_pairings
              SET status       = 'declined',
                  responded_at = NOW()
            WHERE id = $1`,
          [pairingId],
        );

        if (push && typeof push.sendNotification === "function") {
          push.sendNotification([pairing.requester_id], {
            category: "synchro.partner_invite",
            title: "Synchro pairing declined",
            body: `${req.user.full_name || "Your partner"} declined the pairing`,
            data: {
              event_id:   pairing.event_id,
              pairing_id: pairing.id,
              kind:       "declined",
            },
          }).catch((err) =>
            console.error("[synchro] decline push failed", err.message),
          );
        }

        res.json({ ok: true, pairing_id: pairing.id, status: "declined" });
      } catch (err) {
        console.error("[Pairing Decline Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
};
