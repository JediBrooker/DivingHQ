// Super Final seeding, Diving World Cup 2026 Appendix 3: the H2H seed
// (and its preview), the pair-by-pair H2H results, and the semi and
// final seeds that follow. The rest of the Super Final lives next door:
// dive-offs.js (tie-breaks), super-final-bridge.js (synchro reserves,
// merged rankings).
//
// Mounted from routes/events/index.js, just before the dive-offs
// sub-router like these routes were, via:
//   router.use(require('./super-final-seeding')({ pool, push, requireEventManager }))
//
// Moved out of index.js as is. The helpers it shares with the ordinary
// advance flow (stampDiveListLock, refuseIfScoresExist, the roster
// insert) are in stage-helpers.js.

const express = require("express");
const { recordAudit, auditFromReq } = require("../../lib/audit");
const {
  loadH2hPairResults,
  loadSfCumulative,
  loadResolvedDiveOffs,
  compareSfFinalists,
  diveOffPairKey,
  sameTotal,
} = require("../../lib/super-final-helpers");
const { perDivePointsCte } = require("../../lib/scoring-sql");
const {
  parseLockMinutes,
  insertDiveListRows,
  loadStop1Lists,
  stampDiveListLock,
  refuseIfScoresExist,
} = require("./stage-helpers");

module.exports = function createSuperFinalSeedingRoutes({
  pool,
  // Optional: without it the "you've been seeded" notifications are skipped.
  push,
  requireEventManager,
}) {
  if (!pool || !requireEventManager) {
    throw new Error("createSuperFinalSeedingRoutes requires { pool, requireEventManager }");
  }
  const router = express.Router();

  // -------------------------------------------------------------
  // SUPER FINAL: Diving World Cup 2026, Appendix 3.
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
         /* A diver who withdrew from the Stop-1 stage keeps their
            scores but can't be seeded into the H2H, same rule as
            advance. */
         WHERE competitor_id IN (
           SELECT competitor_id FROM competitor_dive_lists
            WHERE event_id = $1 AND withdrawn_at IS NULL AND is_reserve = FALSE)
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
              /* Shown in the bracket preview, so the meet's
                 representation code (migration 090). The per-org cap
                 still keys on org_id. */
              event_rep_code($1, r.competitor_id, o.country_code) AS country_code,
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

  // GET /api/events/:id/seed-h2h/preview: read-only.
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

  // POST /api/events/:id/seed-h2h: commits the H2H bracket.
  //
  // Body (all optional):
  //   max_per_org   default 2  (Appendix 3 §1.1, World Cup cap)
  //   lock_minutes  default 30 (WA Article 6.7.3, change-of-dives)
  //
  // Writes 36 competitor_dive_lists rows (12 divers × 3 rounds),
  // sets group_number 1 or 2, sets display_order so the dive
  // sequence within a group is "Dive 1: divers 12,1; 9,4; 8,5"
  // (Appendix 3 §2.1.2, lower-seeded diver of each pair goes
  // first within the pair, pairs in seed order). Stamps the
  // dive_list_locks_at on the H2H event.
  router.post(
    "/api/events/:id/seed-h2h",
    requireEventManager(),
    async (req, res) => {
      const maxPerOrg = Number.isFinite(parseInt(req.body?.max_per_org))
        ? Math.max(1, Math.min(parseInt(req.body.max_per_org), 12))
        : 2;
      const lockMin = parseLockMinutes(req.body?.lock_minutes);

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

        // Refuse if scores already exist, a re-seed would
        // CASCADE-delete them. See refuseIfScoresExist comment.
        const scoresErrH2h = await refuseIfScoresExist(client, ev.id);
        if (scoresErrH2h) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: scoresErrH2h });
        }

        // Wipe any existing roster on the H2H event, re-seeding
        // (still Upcoming, with no scores) is "redo not append".
        await client.query(
          "DELETE FROM competitor_dive_lists WHERE event_id = $1",
          [ev.id],
        );

        // Build the dive order. Appendix 3 §2.1.2 reads as:
        //
        //   Group 1, Dive 1: Divers 12,1; 9,4; 8,5
        //   Group 1, Dive 2: Same divers
        //   Group 1, Dive 3: Same divers
        //   Group 2, Dive 1: Divers 11,2; 10,3; 7,6
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
        // dive_list_locks_at. Pair by pair, A before B, in one INSERT.
        const seedRows = [];
        function pushDiverRows(competitorId, dives, groupNumber) {
          const byRound = new Map(
            (dives || []).map((d) => [Number(d.round_number), d.dive_id]),
          );
          for (let r = 1; r <= 3; r++) {
            seedRows.push({
              competitor_id: competitorId,
              dive_id: byRound.get(r) || null,
              round_number: r,
              display_order: orderByCompetitor.get(competitorId),
              group_number: groupNumber,
            });
          }
        }
        for (const pair of plan.pairs) {
          pushDiverRows(pair.competitor_a_id, pair.dives_a, pair.group_number);
          pushDiverRows(pair.competitor_b_id, pair.dives_b, pair.group_number);
        }
        await insertDiveListRows(client, ev.id, seedRows);

        // Lock the dive list, see stampDiveListLock for the WA
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

        // Push notifications to the 12 advanced divers, same
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

  // GET /api/events/:id/super-final/h2h-results: public read.
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
        // flow, one algorithm in lib/super-final-helpers.js. Only
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
      const lockMin = parseLockMinutes(req.body?.lock_minutes);

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
        // (Appendix 3 §2.2, "Men: 3 additional dives, Women: 2
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
        // group dives first (Appendix 3 §2.2, "starting order
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
        // the SF in the dive-list sense is the H2H's parent,
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
        const stop1ByCompetitor = await loadStop1Lists(
          client, h2h.parent_event_id, winners.map((w) => w.competitor_id));

        // Refuse if scores already exist, see refuseIfScoresExist.
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
        // submission's round (3 + r), i.e. SF round 1 → Stop-1
        // round 4, SF round 2 → Stop-1 round 5, SF round 3
        // (men only) → Stop-1 round 6. One multi-row INSERT.
        const seedRows = [];
        for (const w of winners) {
          const stop1Map = stop1ByCompetitor.get(w.competitor_id) || new Map();
          for (let r = 1; r <= expectedSfRounds; r++) {
            const stop1Round = 3 + r; // SF r=1 → parent r=4, etc.
            seedRows.push({
              competitor_id: w.competitor_id,
              dive_id: stop1Map.get(stop1Round) || null,
              round_number: r,
              display_order: orderByCompetitor.get(w.competitor_id),
              group_number: w.group_number,
            });
          }
        }
        await insertDiveListRows(client, ev.id, seedRows);

        // Set score_carry_from so standings include H2H
        // (Appendix 3 §3.1, "H2H scores carry forward to SF").
        await client.query(
          "UPDATE events SET score_carry_from = $2 WHERE id = $1",
          [ev.id, h2h.id],
        );

        // Lock window: same WA Article 6.7.3 default as
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
  // F resets scores (Appendix 3 §3.2, score_carry_from=NULL).
  // F.total_rounds = 5 (W) / 6 (M); roster seeds full Stop-1
  // submission rounds 1..5/6.
  //
  // Body: { lock_minutes: 15 } (Appendix 3 §4.1, 15-min break
  // between SF and F, change-of-dives must be made AFTER SF and
  // at LATEST 5 minutes before F → effective lock at NOW() +
  // (lock_minutes - 5)).
  router.post(
    "/api/events/:id/seed-final",
    requireEventManager(),
    async (req, res) => {
      const rawLockMin = parseLockMinutes(req.body?.lock_minutes, { def: 15, min: 5 });
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
        // boundary with no dive-off, refuse, the same gate seed-semi
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
            sameTotal(inGroup[1].cumulative_total, inGroup[2].cumulative_total) &&
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
        const stop1ByCompetitor = await loadStop1Lists(
          client, stop1EventId, finalists.map((f) => f.competitor_id));

        // Reverse rank: highest cumulative dives last (display_order=4).
        // Order finalists by cumulative_total ascending and assign 1..4.
        const ordered = [...finalists].sort((a, b) => a.cumulative_total - b.cumulative_total);
        const orderByCompetitor = new Map();
        ordered.forEach((f, i) => orderByCompetitor.set(f.competitor_id, i + 1));

        // Refuse if scores already exist, see refuseIfScoresExist.
        const scoresErrFinal = await refuseIfScoresExist(client, ev.id);
        if (scoresErrFinal) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: scoresErrFinal });
        }

        await client.query(
          "DELETE FROM competitor_dive_lists WHERE event_id = $1",
          [ev.id],
        );

        // One multi-row INSERT. group_number stays NULL in the F
        // event, groups only exist in the H2H / SF stages.
        const seedRows = [];
        for (const f of finalists) {
          const stop1Map = stop1ByCompetitor.get(f.competitor_id) || new Map();
          for (let r = 1; r <= expectedFRounds; r++) {
            seedRows.push({
              competitor_id: f.competitor_id,
              dive_id: stop1Map.get(r) || null,
              round_number: r,
              display_order: orderByCompetitor.get(f.competitor_id),
            });
          }
        }
        await insertDiveListRows(client, ev.id, seedRows);

        // F resets scores (Appendix 3 §3.2). Make sure
        // score_carry_from is NULL.
        await client.query(
          "UPDATE events SET score_carry_from = NULL WHERE id = $1",
          [ev.id],
        );

        // Lock window: Appendix 3 §4.1, 15-min break between
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

  return router;
};
