// Team routes, the parallel grouping to clubs used for World Aquatics
// Team Event entries. A diver can belong to multiple teams over
// time, and a team enrols in events via event_teams.
//
//   GET    /api/orgs/:id/teams                              list with member counts
//   POST   /api/orgs/:id/teams                              create
//   PUT    /api/teams/:id                                   rename / re-code
//   DELETE /api/teams/:id                                   non-destructive
//   GET    /api/teams/:id/events                            events the team is in
//   POST   /api/teams/:teamId/dive-lists                    bulk dive list
//   GET    /api/teams/:teamId/events/:eventId/dive-list     read for editor
//   GET    /api/teams/:id/members                           list members
//   POST   /api/teams/:id/members                           add member
//   DELETE /api/teams/:id/members/:userId                   remove member
//   GET    /api/events/:id/teams                            teams in an event
//   POST   /api/events/:id/teams                            enrol team
//   DELETE /api/events/:id/teams/:teamId                    detach
//
// Mounted via:
//   app.use(require('./routes/teams')({ … }))

const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");

module.exports = function createTeamsRouter({
  pool,
  requireMeetEditor,
  requireEventManager,
  bulkWriteLimiter,
  ensureEventOrgGate,
  isInSameOrg,
  loadEventForEntries,
}) {
  if (!pool) throw new Error("createTeamsRouter requires { pool, … }");
  const router = express.Router();

  function httpErr(status, message, violations = null) {
    const err = new Error(message);
    err.status = status;
    if (violations) err.violations = violations;
    return err;
  }

  async function ensureTeamEligibleForEvent(client, event, teamOrgId, actor) {
    if (actor.is_system_admin || event.org_id === teamOrgId) return;
    const part = await client.query(
      `SELECT 1 FROM event_participating_orgs
        WHERE event_id = $1 AND org_id = $2`,
      [event.id, teamOrgId],
    );
    if (!part.rows.length) {
      throw httpErr(403, "This team's federation isn't on the event's participating list");
    }
  }

  async function validateTeamDivesForEvent(client, event, rawDives) {
    const totalRounds = Number(event.total_rounds) || null;
    const rows = [];
    const seenByCompetitor = new Map();
    for (const raw of rawDives) {
      const rn = Number(raw?.round_number);
      if (!Number.isInteger(rn) || rn < 1) {
        throw httpErr(400, "Each dive needs an integer round_number ≥ 1");
      }
      if (totalRounds && rn > totalRounds) {
        throw httpErr(400, `round_number ${rn} exceeds total_rounds ${totalRounds}`);
      }
      if (!raw?.dive_id) {
        throw httpErr(400, "Each dive needs a dive_id");
      }
      const key = raw.competitor_id;
      if (!seenByCompetitor.has(key)) seenByCompetitor.set(key, new Set());
      const seenRounds = seenByCompetitor.get(key);
      if (seenRounds.has(rn)) {
        throw httpErr(400, `Duplicate round_number ${rn} for one team member`);
      }
      seenRounds.add(rn);
      rows.push({ ...raw, round_number: rn });
    }

    const ids = [...new Set(rows.map((d) => d.dive_id))];
    const heightVal = event.height ? parseFloat(event.height) : null;
    const validIds = await client.query(
      `SELECT id, dive_code, dd, height FROM dive_directory
       WHERE id = ANY($1::uuid[])
         AND ($2::numeric IS NULL OR height = $2)`,
      [ids, heightVal],
    );
    const okMap = new Map(validIds.rows.map((row) => [row.id, row]));
    for (const d of rows) {
      if (!okMap.has(d.dive_id)) {
        throw httpErr(400, `dive_id ${d.dive_id} is not in the dive directory at this event's height`);
      }
    }

    const prescribed = await client.query(
      `SELECT round_number, dive_id, height
         FROM event_round_dives
        WHERE event_id = $1`,
      [event.id],
    );
    if (prescribed.rows.length) {
      const byRound = new Map(prescribed.rows.map((slot) => [slot.round_number, slot]));
      const violations = [];
      for (const d of rows) {
        const slot = byRound.get(d.round_number);
        if (!slot) continue;
        if (slot.dive_id && slot.dive_id !== d.dive_id) {
          violations.push(`Round ${d.round_number} is operator-prescribed; submit the assigned dive only`);
          continue;
        }
        if (!slot.dive_id && slot.height != null) {
          const dir = okMap.get(d.dive_id);
          if (dir && Number(dir.height) !== Number(slot.height)) {
            violations.push(`Round ${d.round_number} requires a ${slot.height}m board dive`);
          }
        }
      }
      if (violations.length) {
        throw httpErr(400, "Dive list violates the event's prescribed dives", violations);
      }
    }

    if (event.round_rules) {
      const { validateDiveList } = require("../lib/round-rules");
      const grouped = new Map();
      for (const d of rows) {
        if (!grouped.has(d.competitor_id)) grouped.set(d.competitor_id, []);
        grouped.get(d.competitor_id).push(d);
      }
      for (const list of grouped.values()) {
        const enriched = list.map((d) => {
          const dir = okMap.get(d.dive_id);
          return {
            round_number: d.round_number,
            dive_id: d.dive_id,
            dive_code: dir?.dive_code,
            dd: dir?.dd,
          };
        });
        const check = validateDiveList(event.round_rules, enriched);
        if (!check.valid) {
          throw httpErr(400, "Dive list violates the event's round rules", check.errors);
        }
      }
    }

    if (event.event_type === "synchro_pair") {
      const partnersByCompetitor = new Map();
      for (const d of rows) {
        if (!d.partner_id || d.partner_id === d.competitor_id) {
          throw httpErr(400, "A different partner is required for synchronised events");
        }
        const prior = partnersByCompetitor.get(d.competitor_id);
        if (prior && prior !== d.partner_id) {
          throw httpErr(400, "Synchro partner must be consistent across a diver's rounds");
        }
        partnersByCompetitor.set(d.competitor_id, d.partner_id);
      }
    }

    return rows;
  }

  // Teams in an org with member counts.
  router.get("/api/orgs/:id/teams", requireMeetEditor, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot list teams in other organisations" });
    }
    try {
      const r = await pool.query(
        `SELECT t.id, t.name, t.short_code, t.created_at,
                COALESCE(stat.member_count, 0)::int AS member_count
         FROM teams t
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS member_count FROM team_members WHERE team_id = t.id
         ) stat ON true
         WHERE t.org_id = $1
         ORDER BY t.name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Teams List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.post("/api/orgs/:id/teams", requireMeetEditor, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot create teams in other organisations" });
    }
    const { name, short_code } = req.body || {};
    if (!name || !name.trim())
      return res.status(400).json({ error: "Team name is required" });
    try {
      const r = await pool.query(
        `INSERT INTO teams (org_id, name, short_code)
         VALUES ($1, $2, $3)
         RETURNING id, name, short_code`,
        [req.params.id, name.trim(), short_code?.trim() || null],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Create Team Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/teams/:id", requireMeetEditor, async (req, res) => {
    const { name, short_code } = req.body || {};
    if (!name || !name.trim())
      return res.status(400).json({ error: "Team name is required" });
    try {
      const target = await pool.query(
        "SELECT org_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Team not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot edit teams in other organisations" });
      }
      const r = await pool.query(
        `UPDATE teams SET name = $1, short_code = $2 WHERE id = $3
         RETURNING id, name, short_code`,
        [name.trim(), short_code?.trim() || null, req.params.id],
      );
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Update Team Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/teams/:id", requireMeetEditor, async (req, res) => {
    try {
      const target = await pool.query(
        "SELECT id, org_id, name, short_code FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Team not found" });
      const team = target.rows[0];
      if (
        !req.user.is_system_admin &&
        team.org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot delete teams in other organisations" });
      }
      // Impact summary before deletion so the client can show
      // what it just severed.
      const impact = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM team_members WHERE team_id = $1) AS members,
           (SELECT COUNT(*)::int FROM event_teams  WHERE team_id = $1) AS events,
           (SELECT COUNT(*)::int FROM competitor_dive_lists WHERE team_id = $1) AS dives`,
        [req.params.id],
      );
      await pool.query("DELETE FROM teams WHERE id = $1", [req.params.id]);
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id:      team.org_id,
        entity_type: "team",
        entity_id:   team.id,
        entity_name: team.name,
        action:      "team.deleted",
        metadata: {
          short_code:        team.short_code,
          members_unbound:   impact.rows[0].members,
          events_detached:   impact.rows[0].events,
          dives_unattributed: impact.rows[0].dives,
        },
      });
      res.json({
        message: "Team deleted",
        ...impact.rows[0],
      });
    } catch (err) {
      console.error("[Delete Team Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Events the team is currently entered in. Drives the "Edit
  // dive list" links inside the TeamsView drawer.
  router.get("/api/teams/:id/events", requireMeetEditor, async (req, res) => {
    try {
      // Cross-org IDOR plug. requireMeetEditor only confirms the
      // caller has org_admin / meet_manager somewhere; the team
      // UUID came from the URL with no guarantee it belongs to
      // their org. Mirror the rename / delete check above.
      const team = await pool.query(
        "SELECT org_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!team.rows.length) return res.status(404).json({ error: "Team not found" });
      if (!req.user.is_system_admin && team.rows[0].org_id !== req.user.org_id) {
        return res.status(403).json({ error: "Cannot read teams in other organisations" });
      }
      const r = await pool.query(
        `SELECT e.id, e.name, e.gender, e.height, e.event_type::text AS event_type,
                e.total_rounds, e.number_of_judges, e.status,
                et.added_at
         FROM event_teams et
         JOIN events e ON e.id = et.event_id
         WHERE et.team_id = $1
         ORDER BY e.created_at DESC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json([]);
    }
  });

  // Bulk-set a team's dive list for one event. Each row can be
  // individual (no partner_id) or synchro (partner_id pointing at
  // another team member). Replaces any existing rows for that
  // (team, event) pair.
  router.post(
    "/api/teams/:teamId/dive-lists",
    bulkWriteLimiter,
    requireMeetEditor,
    async (req, res) => {
      const { event_id, dives } = req.body || {};
      if (!event_id || !Array.isArray(dives) || !dives.length) {
        return res.status(400).json({ error: "event_id and dives[] required" });
      }
      const client = await pool.connect();
      try {
        const target = await client.query(
          "SELECT org_id FROM teams WHERE id = $1",
          [req.params.teamId],
        );
        if (!target.rows.length)
          return res.status(404).json({ error: "Team not found" });
        const teamOrgId = target.rows[0].org_id;
        if (
          !req.user.is_system_admin &&
          teamOrgId !== req.user.org_id
        ) {
          return res
            .status(403)
            .json({ error: "Cannot manage teams in other organisations" });
        }

        // Gate on event lifecycle / entries deadline, same rule as the
        // individual-diver submit endpoint. Heads up: once the event
        // has gone Live or the manager-set deadline has passed, the
        // team's dive list is locked. Late additions go through the
        // controller's late-entry feature instead.
        const gate = await loadEventForEntries(client, event_id);
        if (gate.error) {
          return res.status(gate.status).json({ error: gate.error });
        }
        try {
          await ensureTeamEligibleForEvent(client, gate.event, teamOrgId, req.user);
        } catch (err) {
          return res.status(err.status || 500).json({ error: err.message });
        }

        // All competitor_id and partner_id values must belong to
        // this team. Pull the membership once.
        const m = await client.query(
          "SELECT user_id FROM team_members WHERE team_id = $1",
          [req.params.teamId],
        );
        const memberIds = new Set(m.rows.map((row) => row.user_id));
        for (const d of dives) {
          if (!d.competitor_id || !memberIds.has(d.competitor_id)) {
            return res
              .status(400)
              .json({ error: "Every dive must be assigned to a team member" });
          }
          if (d.partner_id && !memberIds.has(d.partner_id)) {
            return res
              .status(400)
              .json({ error: "Synchro partners must also be team members" });
          }
          if (d.partner_id && d.partner_id === d.competitor_id) {
            return res
              .status(400)
              .json({ error: "A diver can't pair with themselves" });
          }
          if (!d.dive_id || !d.round_number) {
            return res
              .status(400)
              .json({ error: "Each dive needs a dive_id and round_number" });
          }
        }
        let validatedDives;
        try {
          validatedDives = await validateTeamDivesForEvent(client, gate.event, dives);
        } catch (err) {
          const body = { error: err.message };
          if (err.violations) body.violations = err.violations;
          return res.status(err.status || 500).json(body);
        }

        // The UNIQUE (event_id, competitor_id, round_number)
        // constraint spans team AND individual entries: a member
        // who already self-entered this event (team_id IS NULL),
        // or who sits on another team's list, collides with the
        // rows below, and the DELETE in the transaction only clears
        // THIS team's rows. Surface the collision as a 409 naming
        // the diver + round (same contract as the claim-flow merge
        // conflict in routes/users.js) instead of a generic constraint 500.
        const conflict = await client.query(
          `SELECT u.full_name, cdl.competitor_id, cdl.round_number
             FROM competitor_dive_lists cdl
             JOIN UNNEST($2::uuid[], $3::int[]) AS d(competitor_id, round_number)
               ON d.competitor_id = cdl.competitor_id
              AND d.round_number  = cdl.round_number
             JOIN users u ON u.id = cdl.competitor_id
            WHERE cdl.event_id = $1
              AND (cdl.team_id IS NULL OR cdl.team_id <> $4)
            ORDER BY u.full_name, cdl.round_number
            LIMIT 1`,
          [
            event_id,
            validatedDives.map((d) => d.competitor_id),
            validatedDives.map((d) => Number(d.round_number)),
            req.params.teamId,
          ],
        );
        if (conflict.rows.length) {
          const c = conflict.rows[0];
          return res.status(409).json({
            error:
              `Cannot save: ${c.full_name} already has an entry for round ` +
              `${c.round_number} of this event outside this team. Withdraw ` +
              `that entry first, then re-save the team list.`,
            competitor_id: c.competitor_id,
            round_number: c.round_number,
          });
        }

        await client.query("BEGIN");
        // Replace existing rows for this (team, event)
        await client.query(
          `DELETE FROM competitor_dive_lists
           WHERE team_id = $1 AND event_id = $2`,
          [req.params.teamId, event_id],
        );
        for (const d of validatedDives) {
          await client.query(
            `INSERT INTO competitor_dive_lists
               (event_id, competitor_id, partner_id, team_id, dive_id, round_number)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              event_id,
              d.competitor_id,
              d.partner_id || null,
              req.params.teamId,
              d.dive_id,
              d.round_number,
            ],
          );
        }
        // Make sure the team is enrolled in the event
        await client.query(
          `INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [event_id, req.params.teamId],
        );
        await client.query("COMMIT");
        res.json({ message: "Team dive list saved", count: dives.length });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        // Backstop for the race the pre-check can't close: a row
        // landed between the SELECT above and the the INSERTs (e.g.
        // the diver self-submitted concurrently). Same 409
        // contract, just without the diver lookup.
        if (err.code === "23505") {
          return res.status(409).json({
            error:
              "A diver on this team already has an entry for one of these " +
              "rounds in this event outside this team. Withdraw that entry " +
              "first, then re-save the team list.",
          });
        }
        console.error("[Team Dive List Error]", err);
        res.status(500).json({ error: "Failed to save team dive list" });
      } finally {
        client.release();
      }
    },
  );

  // Read the current team dive list for one event so the editor
  // can pre-populate.
  router.get(
    "/api/teams/:teamId/events/:eventId/dive-list",
    requireMeetEditor,
    async (req, res) => {
      try {
        // IDOR plug: both the team and the event must belong to
        // the caller's org. requireMeetEditor only checks that the
        // caller holds the role somewhere, not which org.
        const team = await pool.query(
          "SELECT org_id FROM teams WHERE id = $1",
          [req.params.teamId],
        );
        if (!team.rows.length) return res.status(404).json({ error: "Team not found" });
        if (!req.user.is_system_admin && team.rows[0].org_id !== req.user.org_id) {
          return res.status(403).json({ error: "Cannot read teams in other organisations" });
        }
        const r = await pool.query(
          `SELECT cdl.round_number, cdl.competitor_id, cdl.partner_id, cdl.dive_id,
                  u.full_name AS competitor_name,
                  pu.full_name AS partner_name,
                  d.dive_code, d.position, d.height, d.dd, d.description
           FROM competitor_dive_lists cdl
           JOIN users u ON u.id = cdl.competitor_id
           LEFT JOIN users pu ON pu.id = cdl.partner_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.team_id = $1 AND cdl.event_id = $2
           ORDER BY cdl.round_number ASC`,
          [req.params.teamId, req.params.eventId],
        );
        res.json(r.rows);
      } catch (err) {
        res.status(500).json([]);
      }
    },
  );

  router.get("/api/teams/:id/members", requireMeetEditor, async (req, res) => {
    try {
      const target = await pool.query(
        "SELECT org_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Team not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot view teams in other organisations" });
      }
      const r = await pool.query(
        `SELECT u.id, u.username, u.full_name, tm.added_at
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1
         ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json([]);
    }
  });

  router.post("/api/teams/:id/members", requireMeetEditor, async (req, res) => {
    const { user_id } = req.body || {};
    try {
      const target = await pool.query(
        "SELECT org_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Team not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot modify teams in other organisations" });
      }
      // Member must be a user in the same org as the team
      const u = await pool.query(
        "SELECT 1 FROM users WHERE id = $1 AND org_id = $2",
        [user_id, target.rows[0].org_id],
      );
      if (!u.rows.length)
        return res
          .status(400)
          .json({ error: "User must belong to the team's organisation" });
      await pool.query(
        `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.id, user_id],
      );
      res.json({ message: "Member added" });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete(
    "/api/teams/:id/members/:userId",
    requireMeetEditor,
    async (req, res) => {
      try {
        const target = await pool.query(
          "SELECT org_id FROM teams WHERE id = $1",
          [req.params.id],
        );
        if (!target.rows.length)
          return res.status(404).json({ error: "Team not found" });
        if (
          !req.user.is_system_admin &&
          target.rows[0].org_id !== req.user.org_id
        ) {
          return res
            .status(403)
            .json({ error: "Cannot modify teams in other organisations" });
        }
        await pool.query(
          "DELETE FROM team_members WHERE team_id = $1 AND user_id = $2",
          [req.params.id, req.params.userId],
        );
        res.json({ message: "Member removed" });
      } catch (err) {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // -------- Teams ↔ Events --------
  router.get("/api/events/:id/teams", requireMeetEditor, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const r = await pool.query(
        `SELECT t.id, t.name, t.short_code, et.added_at
         FROM event_teams et
         JOIN teams t ON t.id = et.team_id
         WHERE et.event_id = $1
         ORDER BY t.name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json([]);
    }
  });

  router.post("/api/events/:id/teams", requireEventManager(), async (req, res) => {
    const { team_id } = req.body || {};
    try {
      if (!(await isInSameOrg(pool, req.event.org_id, team_id, "teams"))) {
        return res.status(400).json({ error: "Team is not in this event's organisation" });
      }
      await pool.query(
        `INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.id, team_id],
      );
      res.json({ message: "Team added to event" });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove a team from an event. Doesn't touch competitor_dive_lists,
  // since the FK is ON DELETE SET NULL so historical dives stay. The
  // team just isn't an active enrolment any more.
  router.delete(
    "/api/events/:id/teams/:teamId",
    requireEventManager(),
    async (req, res) => {
      try {
        await pool.query(
          "DELETE FROM event_teams WHERE event_id = $1 AND team_id = $2",
          [req.params.id, req.params.teamId],
        );
        res.json({ message: "Team removed from event" });
      } catch (err) {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
};
