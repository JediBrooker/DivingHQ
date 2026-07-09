// Super-Final synchro reserve + merged-rankings routes.
//
// Three routes grouped here because they all read the H2H +
// SF + Final hierarchy as a single chain (per Appendix 3):
//
//   GET  /api/events/:id/synchro-reserve-pool
//        (Appendix 3 §5.1): prioritised list of synchro divers
//        eligible to replace a withdrawn Top-12 individual.
//
//   POST /api/events/:id/replace-from-synchro
//        Promote a synchro diver into the H2H field after a
//        withdrawal. Enforces the 2-per-federation cap.
//
//   GET  /api/events/:id/super-final/rankings
//        Merged H2H winners + SF cumulative totals + Final
//        totals for the merged-rankings UI. Uses the two helpers
//        in lib/super-final-helpers.js.
//
// Mounted from routes/events/index.js via:
//   router.use(require('./super-final-bridge')({ pool, requireEventManager }))
//
// Extracted out of routes/events.js as part of the Phase-5 split,
// once the file crossed 4,000 lines. Shares helpers with the
// seed-semi / seed-final POST handlers that remain in index.js:
// loadH2hPairResults + loadSfCumulative live in
// lib/super-final-helpers.js for that reason.

const express = require("express");
const { recordAudit, auditFromReq } = require("../../lib/audit");
const {
  loadH2hPairResults,
  loadSfCumulative,
} = require("../../lib/super-final-helpers");
const { perDivePointsCte } = require("../../lib/scoring-sql");

// World Aquatics Art 4.1.5 / Diving World Cup §3.1.2: within a Super-
// Final tier (finalists at positions 1-4, SF non-finalists 5-6, H2H
// losers 7-12) competitors on an equal total SHARE a placing, and
// split any prize for that position. Assign standard competition ranks
// ("1, 2, 2, 4") offset by the tier's base position; `rows` must be
// sorted by total descending. Returns { row, rank, is_tied } per entry.
// Tiers are structural pools, so the caller advances the next tier's
// base by rows.length, a shared placing still consumes a slot.
function assignSharedTierRanks(rows, base, getTotal) {
  let prevTotal = null;
  let prevRank = base;
  const ranked = rows.map((row, i) => {
    const total = Number(getTotal(row));
    const rank = prevTotal !== null && Math.abs(total - prevTotal) < 1e-9
      ? prevRank
      : base + i;
    prevTotal = total;
    prevRank = rank;
    return { row, rank };
  });
  const counts = new Map();
  for (const r of ranked) counts.set(r.rank, (counts.get(r.rank) || 0) + 1);
  return ranked.map((r) => ({ ...r, is_tied: counts.get(r.rank) > 1 }));
}

module.exports = function createSuperFinalBridgeRoutes({ pool, requireEventManager }) {
  if (!pool || !requireEventManager) {
    throw new Error("createSuperFinalBridgeRoutes requires { pool, requireEventManager }");
  }
  const router = express.Router();

  // -------------------------------------------------------------
  // SUPER FINAL: Synchro reserve pool (Appendix 3 §5.1).
  //
  // If a Top-12 individual diver withdraws after the Team
  // Leaders Meeting (i.e. once the H2H is seeded), they may be
  // replaced by a synchro diver from the same meet. Priority is
  // determined by the synchro events' rankings at the meet, and
  // a federation that already has 2 individual divers in the
  // H2H is ineligible.
  // -------------------------------------------------------------

  // GET /api/events/:id/synchro-reserve-pool: read-only.
  // :id is the H2H event. Returns the prioritised list of
  // federations + their eligible synchro divers.
  router.get(
    "/api/events/:id/synchro-reserve-pool",
    requireEventManager(),
    async (req, res) => {
      const eventId = req.params.id;
      const client = await pool.connect();
      try {
        const evRes = await client.query(
          `SELECT id, event_format, meet_id, gender FROM events WHERE id = $1`,
          [eventId],
        );
        if (!evRes.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        const ev = evRes.rows[0];
        if (ev.event_format !== "super_final_h2h") {
          return res.status(400).json({
            error: "Synchro reserve pool only meaningful on super_final_h2h events",
          });
        }
        if (!ev.meet_id) {
          return res.status(400).json({
            error: "H2H event has no meet_id — synchro pool requires meet membership",
          });
        }

        // 1. Find synchro events at the same meet. The H2H
        //    event's gender carries through: a Female H2H must
        //    not pull a Male synchro diver, per Appendix 3 §1
        //    (Super Final is gender-split; M=6 dives, W=5).
        //
        //    AUDIT FIX (Strong-5): the previous code commented
        //    "Match the H2H event's gender + height/board if
        //    possible" but didn't actually filter, so synchroRes
        //    returned every synchro_pair event at the meet,
        //    regardless of gender. A Female H2H could pull a
        //    Male synchro replacement; replace-from-synchro
        //    further down only checked the diver was on a
        //    synchro_pair event, not that the event matched the
        //    H2H's gender. Mixed-gender Super Final isn't
        //    supported anyway (seed-semi 400s on Mixed), so we
        //    can require an exact gender match here.
        const synchroRes = await client.query(
          `SELECT id, name, gender, height, status, total_rounds
             FROM events
            WHERE meet_id = $1
              AND event_type = 'synchro_pair'
              AND gender    = $2
            ORDER BY scheduled_at ASC NULLS LAST, name ASC`,
          [ev.meet_id, ev.gender],
        );
        const synchroEvents = synchroRes.rows;

        // 2. Build the rank-by-org table from synchro events.
        //    For each synchro event, compute the team standings
        //    (per-pair total) and rank within that event. Then
        //    associate each pair with its federation (the org of
        //    the lead diver, since synchro pairs are same-federation).
        // We pick the BEST synchro rank an org has across the
        // synchro events at the meet.
        const orgRanks = new Map(); // org_id → { best_synchro_rank, best_synchro_event_id, pair_competitor_ids }
        for (const sev of synchroEvents) {
          const standings = await client.query(
            `WITH ${perDivePointsCte({
               // Pair-level keys come from cdl (the synchro list
               // row), but grouping still includes s.round_number
               // so the UDF runs once per dive.
               select:  ["cdl.competitor_id", "cdl.partner_id"],
               groupBy: ["cdl.competitor_id", "cdl.partner_id", "s.round_number"],
             })},
             totals AS (
               SELECT competitor_id, partner_id,
                      SUM(dive_points) AS total
                 FROM per_dive
                GROUP BY competitor_id, partner_id
             )
             SELECT t.competitor_id, t.partner_id, t.total,
                    u.org_id, u.full_name AS lead_name,
                    o.country_code, o.name AS org_name,
                    pu.full_name AS partner_name,
                    RANK() OVER (ORDER BY t.total DESC) AS rnk
               FROM totals t
               JOIN users u ON u.id = t.competitor_id
               JOIN organisations o ON o.id = u.org_id
               LEFT JOIN users pu ON pu.id = t.partner_id`,
            [sev.id],
          );
          for (const r of standings.rows) {
            const orgId = r.org_id;
            const cur = orgRanks.get(orgId);
            const candidate = {
              best_synchro_rank:    Number(r.rnk),
              best_synchro_event_id: sev.id,
              best_synchro_total:   Number(r.total),
              org_name:             r.org_name,
              country_code:         r.country_code,
              pair_competitor_ids:  [r.competitor_id, r.partner_id].filter(Boolean),
              lead_name:            r.lead_name,
              partner_name:         r.partner_name,
            };
            if (!cur || candidate.best_synchro_rank < cur.best_synchro_rank) {
              orgRanks.set(orgId, candidate);
            }
          }
        }

        // 3. Count each federation's current individuals in the
        //    H2H roster. Any fed already at 2 is ineligible.
        const indCountRes = await client.query(
          `SELECT u.org_id, COUNT(DISTINCT cdl.competitor_id) AS ind_count
             FROM competitor_dive_lists cdl
             JOIN users u ON u.id = cdl.competitor_id
            WHERE cdl.event_id = $1
              AND cdl.is_reserve = FALSE
              AND cdl.withdrawn_at IS NULL
            GROUP BY u.org_id`,
          [eventId],
        );
        const indCountByOrg = new Map(
          indCountRes.rows.map((r) => [r.org_id, Number(r.ind_count)]),
        );

        // 4. Eligibility: org must have a synchro rank AND fewer
        //    than 2 individuals in the H2H.
        const pool_ = [];
        for (const [orgId, info] of orgRanks.entries()) {
          const indCount = indCountByOrg.get(orgId) || 0;
          if (indCount >= 2) continue; // ineligible
          pool_.push({
            org_id:               orgId,
            org_name:             info.org_name,
            country_code:         info.country_code,
            synchro_rank:         info.best_synchro_rank,
            synchro_event_id:     info.best_synchro_event_id,
            synchro_total:        info.best_synchro_total,
            current_individual_count: indCount,
            eligible_divers: info.pair_competitor_ids.map((cid, i) => ({
              competitor_id: cid,
              full_name:     i === 0 ? info.lead_name : info.partner_name,
            })).filter((d) => d.full_name),
          });
        }
        pool_.sort((a, b) => a.synchro_rank - b.synchro_rank);

        res.json({
          h2h_event_id:    eventId,
          meet_id:         ev.meet_id,
          synchro_events:  synchroEvents.map((s) => ({
            id: s.id, name: s.name, gender: s.gender, height: s.height,
            status: s.status,
          })),
          reserve_pool:    pool_,
        });
      } catch (err) {
        console.error("[Synchro Reserve Pool Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // POST /api/events/:id/replace-from-synchro
  // :id is the H2H event. Operator swaps a Top-12 diver who
  // withdrew before H2H begins for a synchro reserve. The
  // replacement uses their own most recent submitted dive list
  // (we don't pretend to know the withdrawn diver's list better
  // than the synchro diver does).
  //
  // Body: { withdraw_competitor_id, replacement_competitor_id }
  //
  // Validation:
  //   * H2H must be Upcoming (Appendix 3 §5.1: replacement
  //     valid pre-H2H only).
  //   * Replacement must be in the synchro reserve pool.
  //   * Replacement's federation must not exceed 2 individuals
  //     after the swap.
  router.post(
    "/api/events/:id/replace-from-synchro",
    requireEventManager(),
    async (req, res) => {
      const eventId = req.params.id;
      const { withdraw_competitor_id, replacement_competitor_id } = req.body || {};
      if (!withdraw_competitor_id || !replacement_competitor_id) {
        return res.status(400).json({
          error: "withdraw_competitor_id + replacement_competitor_id required",
        });
      }
      if (withdraw_competitor_id === replacement_competitor_id) {
        return res.status(400).json({
          error: "withdraw and replacement must be different users",
        });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const evRes = await client.query(
          `SELECT id, event_format, status, meet_id FROM events WHERE id = $1`,
          [eventId],
        );
        if (!evRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        const ev = evRes.rows[0];
        if (ev.event_format !== "super_final_h2h") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Endpoint expects the H2H event id (event_format=super_final_h2h)",
          });
        }
        if (ev.status !== "Upcoming") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "H2H must still be Upcoming for synchro replacement (Appendix 3 §5.1)",
          });
        }

        // Verify the withdrawn diver is on the roster AND still
        // active (withdrawn_at IS NULL).
        //
        // AUDIT FIX (Strong-4): the previous lookup omitted
        // `AND withdrawn_at IS NULL`. Gotcha: if an operator double
        // clicked the swap button (or replayed the request by
        // mistake), the second call would still find the
        // already-withdrawn rows, re-stamp `withdrawn_at = NOW()`
        // on them, and insert a SECOND replacement into the same
        // (group_number, display_order) slot, two divers
        // occupying one H2H slot. Filtering on withdrawn_at IS
        // NULL makes the second call a clean 404.
        const withdrawRowsRes = await client.query(
          `SELECT round_number, dive_id, group_number, MIN(display_order) OVER () AS first_order,
                  MIN(display_order) AS d_order
             FROM competitor_dive_lists
            WHERE event_id = $1
              AND competitor_id = $2
              AND is_reserve = FALSE
              AND withdrawn_at IS NULL
            GROUP BY round_number, dive_id, group_number, display_order
            ORDER BY round_number`,
          [eventId, withdraw_competitor_id],
        );
        if (!withdrawRowsRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            error: "Withdraw competitor not found on the active H2H roster (already withdrawn or never on it)",
          });
        }
        const withdrawSlot = {
          group_number:  withdrawRowsRes.rows[0].group_number,
          display_order: withdrawRowsRes.rows[0].d_order,
        };

        // Verify the replacement org's individual count, and a
        // quick sanity check that the replacement isn't already
        // on the roster.
        const replOrgRes = await client.query(
          `SELECT id, org_id FROM users WHERE id = $1`,
          [replacement_competitor_id],
        );
        if (!replOrgRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Replacement user not found" });
        }
        const replOrgId = replOrgRes.rows[0].org_id;

        const onRosterRes = await client.query(
          `SELECT 1 FROM competitor_dive_lists
            WHERE event_id = $1 AND competitor_id = $2 LIMIT 1`,
          [eventId, replacement_competitor_id],
        );
        if (onRosterRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Replacement is already on the H2H roster",
          });
        }

        // Count current individuals from the replacement's org.
        const indRes = await client.query(
          `SELECT COUNT(DISTINCT cdl.competitor_id) AS ind_count
             FROM competitor_dive_lists cdl
             JOIN users u ON u.id = cdl.competitor_id
            WHERE cdl.event_id = $1
              AND cdl.is_reserve = FALSE
              AND cdl.withdrawn_at IS NULL
              AND u.org_id = $2`,
          [eventId, replOrgId],
        );
        const indCount = Number(indRes.rows[0].ind_count);
        // Withdrawn diver counts ABOVE (we haven't withdrawn
        // yet); but if they're from the same org, the swap-in is
        // 1-for-1, net unchanged. If not, we add 1.
        const withdrawSameOrgRes = await client.query(
          `SELECT u.org_id FROM users u WHERE u.id = $1`,
          [withdraw_competitor_id],
        );
        const sameOrg = withdrawSameOrgRes.rows[0]?.org_id === replOrgId;
        const projectedCount = sameOrg ? indCount : indCount + 1;
        if (projectedCount > 2) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `Replacement's federation would have ${projectedCount} individuals after the swap — cap is 2 (Appendix 3 §5.1)`,
          });
        }

        // Verify replacement is in the meet's synchro pool. We
        // do this by checking they're on a synchro_pair event
        // at the same meet.
        if (!ev.meet_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "H2H event has no meet_id — cannot validate synchro pool",
          });
        }
        const synchroCheckRes = await client.query(
          `SELECT 1
             FROM competitor_dive_lists cdl
             JOIN events e ON e.id = cdl.event_id
            WHERE e.meet_id = $1
              AND e.event_type = 'synchro_pair'
              AND cdl.competitor_id = $2
            LIMIT 1`,
          [ev.meet_id, replacement_competitor_id],
        );
        if (!synchroCheckRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Replacement is not on any synchro_pair event at this meet",
          });
        }

        // Mark withdrawn diver's roster rows as withdrawn.
        await client.query(
          `UPDATE competitor_dive_lists
              SET withdrawn_at = NOW()
            WHERE event_id = $1
              AND competitor_id = $2`,
          [eventId, withdraw_competitor_id],
        );

        // Pull the replacement's most recent dive list (their
        // own submitted list, we don't try to copy the withdrawn
        // diver's because the spec is ambiguous and the simplest
        // interpretation is "diver brings their own dives"). We
        // look in any event the replacement has a dive list for,
        // ordered by event created_at desc, and pick the first
        // non-empty 3-round list. Falls back to NULL dive_ids if
        // nothing is found, the diver will need to submit before
        // the lock.
        const replListRes = await client.query(
          `SELECT cdl.round_number, cdl.dive_id
             FROM competitor_dive_lists cdl
             JOIN events e ON e.id = cdl.event_id
            WHERE cdl.competitor_id = $1
              AND cdl.dive_id IS NOT NULL
              AND e.id <> $2
            ORDER BY e.created_at DESC, cdl.round_number ASC
            LIMIT 12`,
          [replacement_competitor_id, eventId],
        );
        const replByRound = new Map();
        for (const r of replListRes.rows) {
          // Only keep the FIRST dive_id we see per round (since
          // ORDER BY most-recent-event first, that's the most
          // recent submission).
          if (!replByRound.has(Number(r.round_number))) {
            replByRound.set(Number(r.round_number), r.dive_id);
          }
        }

        // Insert the replacement's 3 H2H rows in the same slot
        // (group_number + display_order) as the withdrawn diver.
        for (let r = 1; r <= 3; r++) {
          await client.query(
            `INSERT INTO competitor_dive_lists
                (event_id, competitor_id, dive_id, round_number,
                 display_order, group_number, is_reserve)
              VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
            [
              eventId,
              replacement_competitor_id,
              replByRound.get(r) || null,
              r,
              withdrawSlot.display_order,
              withdrawSlot.group_number,
            ],
          );
        }

        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   eventId,
          entity_name: null,
          action:      "event.synchro_replacement",
          metadata: {
            withdraw_competitor_id,
            replacement_competitor_id,
            replacement_org_id: replOrgId,
            slot: withdrawSlot,
          },
        });

        await client.query("COMMIT");

        res.json({
          replaced:    true,
          slot:        withdrawSlot,
          replacement_competitor_id,
          withdraw_competitor_id,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Synchro Replacement Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // GET /api/events/:id/super-final/rankings: public read.
  //
  // :id is the F event. Returns the merged 1-12 official ranking
  // per Appendix 3 §7:
  //
  //   Positions 1-4 : top 4 from F stage scores (no carry).
  //   Positions 5-6 : the 2 SF non-finalists (1 per SF group)
  //                   ranked by H2H + SF cumulative.
  //   Positions 7-12: the 6 H2H non-advancers (one per pair)
  //                   ranked by H2H total only.
  //
  // Cross-tier ties are impossible by construction (a position-1
  // diver can't tie a position-7 diver, they're in different pools).
  // Within a tier, equal totals SHARE a placing per World Aquatics
  // Art 4.1.5 (and split any prize for that position, WC §3.1.2):
  // assignSharedTierRanks gives standard "1, 2, 2, 4" competition
  // ranks offset by the tier's base, and each row carries an is_tied
  // flag for the UI.
  router.get(
    "/api/events/:id/super-final/rankings",
    async (req, res) => {
      const client = await pool.connect();
      try {
        const fRes = await client.query(
          `SELECT id, event_format, parent_event_id FROM events WHERE id = $1`,
          [req.params.id],
        );
        if (!fRes.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        if (fRes.rows[0].event_format !== "super_final_final") {
          return res.status(400).json({
            error: "Endpoint expects the F event id (event_format=super_final_final)",
          });
        }
        const sfId = fRes.rows[0].parent_event_id;
        if (!sfId) {
          return res.status(400).json({ error: "F has no parent SF stage" });
        }
        const sfMetaRes = await client.query(
          `SELECT id, parent_event_id FROM events WHERE id = $1`,
          [sfId],
        );
        const h2hId = sfMetaRes.rows[0]?.parent_event_id;
        if (!h2hId) {
          return res.status(400).json({ error: "SF has no parent H2H stage" });
        }

        // Tier 1 (positions 1-4): F stage standings, no carry.
        // BUG-FIX: pre-aggregate per-competitor totals into a
        // dedicated CTE before joining onto cdl. The previous
        // shape joined an N-rows-per-competitor `per_dive` against
        // an N-rows-per-competitor cdl on competitor_id only, so a
        // Cartesian explosion meant SUM came out N× the real
        // value (where N = total_rounds, so 5× for women / 6×
        // for men). Tests only checked rank ordering (which the
        // uniform inflation preserved), so the bug shipped green.
        const fTier = await client.query(
          `WITH ${perDivePointsCte()},
           per_competitor AS (
             SELECT competitor_id,
                    COALESCE(SUM(dive_points), 0) AS total
               FROM per_dive
              GROUP BY competitor_id
           )
           SELECT cdl.competitor_id, u.full_name, o.country_code, cl.name AS club_name,
                  COALESCE(MAX(pc.total), 0) AS total
             FROM competitor_dive_lists cdl
             JOIN users u ON u.id = cdl.competitor_id
             JOIN organisations o ON o.id = u.org_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
             LEFT JOIN per_competitor pc ON pc.competitor_id = cdl.competitor_id
            WHERE cdl.event_id = $1
              AND cdl.withdrawn_at IS NULL
              AND cdl.is_reserve = FALSE
            GROUP BY cdl.competitor_id, u.full_name, o.country_code, cl.name
            ORDER BY COALESCE(MAX(pc.total), 0) DESC, u.full_name ASC`,
          [req.params.id],
        );
        const finalistIds = new Set(fTier.rows.map((r) => r.competitor_id));

        // Tier 2 (positions 5-6): SF non-finalists, ranked by
        // SF cumulative (which already includes H2H carry).
        const sfRows = await loadSfCumulative(client, sfId);
        const sfMissed = sfRows
          .filter((r) => !finalistIds.has(r.competitor_id))
          .sort((a, b) => b.cumulative_total - a.cumulative_total);
        const sfTier = sfMissed.slice(0, 2); // exactly 2 in a clean run

        // Tier 3 (positions 7-12): H2H non-advancers (loser of
        // each pair), ranked by H2H total only.
        //
        // AUDIT FIX (Strong-3): if any H2H pair is still tied
        // when we get here (winner_id is null), refuse with 400
        // rather than silently skip the pair. The earlier code
        // dropped tied pairs and returned 11 entries instead of
        // 12 with no signal, so spectators (and the meet manager)
        // had no way to spot that the rankings were incomplete.
        // The dive-off endpoint (Appendix 3 §6) exists precisely
        // to resolve these; the operator must run it before
        // requesting the merged rankings.
        const h2hPairs = await loadH2hPairResults(client, h2hId);
        const tiedPairs = h2hPairs.filter((p) => !p.winner_id);
        if (tiedPairs.length) {
          return res.status(400).json({
            error: `Cannot publish 1-12 rankings while ${tiedPairs.length} H2H pair${tiedPairs.length === 1 ? "" : "s"} ${tiedPairs.length === 1 ? "is" : "are"} still tied. Resolve via the dive-off endpoint first (Appendix 3 §6).`,
            tied_pair_ids: tiedPairs.map((p) => ({
              competitor_a_id: p.competitor_a.id,
              competitor_b_id: p.competitor_b.id,
            })),
          });
        }
        const h2hLosers = [];
        for (const p of h2hPairs) {
          const loser = p.winner_id === p.competitor_a.id ? p.competitor_b : p.competitor_a;
          h2hLosers.push({
            competitor_id: loser.id,
            full_name:     loser.full_name,
            total:         loser.total,
          });
        }
        // Hydrate country_code/club_name for the H2H losers via
        // a single batched lookup.
        const loserIds = h2hLosers.map((l) => l.competitor_id);
        let loserMeta = new Map();
        if (loserIds.length) {
          const metaRes = await client.query(
            `SELECT u.id, o.country_code, cl.name AS club_name
               FROM users u
               JOIN organisations o ON o.id = u.org_id
               LEFT JOIN clubs cl ON cl.id = u.club_id
              WHERE u.id = ANY($1::uuid[])`,
            [loserIds],
          );
          loserMeta = new Map(metaRes.rows.map((r) => [r.id, r]));
        }
        const h2hTier = h2hLosers
          .sort((a, b) => b.total - a.total)
          .slice(0, 6);

        // Build merged rankings. Each tier shares placings on equal
        // totals (assignSharedTierRanks) and the next tier's base
        // advances by the tier's competitor count, a shared placing
        // still consumes a slot, so the tier boundaries stay 1-4 / 5-6
        // / 7-12 in a clean run.
        const rankings = [];
        let base = 1;

        const fRanked = assignSharedTierRanks(fTier.rows.slice(0, 4), base, (r) => r.total);
        for (const { row: r, rank, is_tied } of fRanked) {
          rankings.push({
            rank, is_tied,
            source:        "final",
            competitor_id: r.competitor_id,
            full_name:     r.full_name,
            country_code:  r.country_code,
            club_name:     r.club_name,
            total:         Number(r.total),
          });
        }
        base += fRanked.length;

        const sfRanked = assignSharedTierRanks(sfTier, base, (r) => r.cumulative_total);
        for (const { row: r, rank, is_tied } of sfRanked) {
          rankings.push({
            rank, is_tied,
            source:        "h2h+semi",
            competitor_id: r.competitor_id,
            full_name:     r.full_name,
            country_code:  r.country_code,
            club_name:     null,
            total:         r.cumulative_total,
          });
        }
        base += sfRanked.length;

        const h2hRanked = assignSharedTierRanks(h2hTier, base, (r) => r.total);
        for (const { row: r, rank, is_tied } of h2hRanked) {
          const meta = loserMeta.get(r.competitor_id);
          rankings.push({
            rank, is_tied,
            source:        "h2h",
            competitor_id: r.competitor_id,
            full_name:     r.full_name,
            country_code:  meta?.country_code || null,
            club_name:     meta?.club_name || null,
            total:         r.total,
          });
        }

        res.json({ rankings });
      } catch (err) {
        console.error("[Super Final Rankings Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  return router;
};

// Exported for unit testing of the within-tier shared-place ranking.
module.exports.assignSharedTierRanks = assignSharedTierRanks;
