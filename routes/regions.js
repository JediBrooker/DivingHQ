// Regions (states, provinces, home nations): migration 088, phase 2 of
// docs/club-first-onboarding.md.
//
//   GET    /api/countries/:code/regions     public, the built-in list for a
//                                           country nobody's started yet
//   GET    /api/orgs/:id/regions            public, an org's regions (signup)
//   POST   /api/orgs/:id/regions/seed       org_admin / sysadmin: set up the
//                                           built-in regions for a federation
//   PUT    /api/clubs/:id/region            which region a club is in (or,
//                                           for a claimed region, ask to join)
//   DELETE /api/clubs/:id/region-request    withdraw / decline that ask
//   GET    /api/regions/:id/overview        region admins + org admins: its
//                                           clubs, who admins them, who's asking
//   GET    /api/regions/:id/admins          admins + candidates
//   POST   /api/regions/:id/admins          appoint
//   DELETE /api/regions/:id/admins/:userId  remove
//
// Who appoints region admins: the federation's org admin, or the
// sysadmin. In a country the clubs started there's no org admin, so a
// region's own admins (usually the state body whose claim passed) add
// and remove their co-admins there, the same way club admins do for a
// club: people from the region's clubs only, and never down to no live
// admin. If a region does end up with nobody (the sysadmin removed them,
// or every admin deleted their account) it can be claimed again, see
// register-org in routes/auth.js.

const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");
const { catalogFor, materializeRegions } = require("../lib/regions");
const { removeAdmin } = require("../lib/admin-rows");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = function createRegionsRouter({ pool, verifyToken, isInSameOrg }) {
  if (!pool || !verifyToken) throw new Error("createRegionsRouter requires { pool, verifyToken }");
  const router = express.Router();

  const isOrgAdminOf = (user, orgId) =>
    !!user.is_system_admin
    || ((user.org_roles || []).includes("org_admin") && user.org_id === orgId);

  // A region admin looking after their own co-admins, which only happens
  // where there's no federation to do it.
  const viaRegionAdmin = (region) =>
    region.org_claim_state === "unclaimed" && region.caller_is_admin;

  // Region row + its org's claim state, or null after writing a 404.
  async function loadRegion(req, res) {
    if (!UUID_RE.test(String(req.params.id))) {
      res.status(404).json({ error: "Region not found" });
      return null;
    }
    const r = await pool.query(
      `SELECT rg.id, rg.org_id, rg.name, rg.short_code, rg.claim_state, rg.claimed_name,
              o.claim_state AS org_claim_state, o.region_label,
              EXISTS (SELECT 1 FROM region_admins ra
                       WHERE ra.region_id = rg.id AND ra.user_id = $2) AS caller_is_admin
         FROM regions rg JOIN organisations o ON o.id = rg.org_id
        WHERE rg.id = $1`,
      [req.params.id, req.user?.id || null],
    );
    if (!r.rows.length) {
      res.status(404).json({ error: "Region not found" });
      return null;
    }
    return r.rows[0];
  }

  router.get("/api/countries/:code/regions", (req, res) => {
    const cat = catalogFor(req.params.code);
    if (!cat) return res.json({ label: null, regions: [] });
    res.json({
      label: cat.label,
      regions: cat.regions.map((r) => ({ short_code: r.code, name: r.name })),
    });
  });

  router.get("/api/orgs/:id/regions", async (req, res) => {
    if (!UUID_RE.test(String(req.params.id))) return res.json({ label: null, regions: [] });
    try {
      const org = await pool.query("SELECT region_label FROM organisations WHERE id = $1", [req.params.id]);
      const r = await pool.query(
        `SELECT rg.id, rg.name, rg.short_code, rg.claim_state, rg.claimed_name,
                (SELECT count(*)::int FROM clubs c WHERE c.region_id = rg.id) AS club_count,
                -- My club locks the picker for a claimed region, but only
                -- while it still has someone running it (PUT below).
                EXISTS (SELECT 1 FROM region_admins ra JOIN users u ON u.id = ra.user_id
                         WHERE ra.region_id = rg.id
                           AND u.deleted_at IS NULL AND u.suspended_at IS NULL) AS has_live_admin
           FROM regions rg WHERE rg.org_id = $1
          ORDER BY rg.name`,
        [req.params.id],
      );
      res.json({ label: org.rows[0]?.region_label || null, regions: r.rows });
    } catch (err) {
      console.error("[Org Regions Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/orgs/:id/regions/seed", verifyToken, async (req, res) => {
    if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: "Organisation not found" });
    if (!isOrgAdminOf(req.user, req.params.id)) return res.status(403).json({ error: "Forbidden" });
    try {
      const org = await pool.query("SELECT id, name, country_code FROM organisations WHERE id = $1", [req.params.id]);
      if (!org.rows.length) return res.status(404).json({ error: "Organisation not found" });
      if (!catalogFor(org.rows[0].country_code)) {
        return res.status(400).json({ error: "DivingHQ doesn't have a list of regions for this country yet" });
      }
      const added = await materializeRegions(pool, org.rows[0].id, org.rows[0].country_code);
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id: org.rows[0].id, entity_type: "org", entity_id: org.rows[0].id,
        entity_name: org.rows[0].name, action: "org.regions_seeded", metadata: { added },
      });
      res.json({ added });
    } catch (err) {
      console.error("[Seed Regions Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Inbox notice, best effort: a failed insert never undoes a move.
  // 'region_request' is a club asking, for the region to act on;
  // 'region_decision' tells the club how it went. Same split as
  // role_request / role_decision, so only the asks sit under Action.
  async function notifyUsers(userIds, { title, body, action_url, data, category }) {
    for (const id of userIds) {
      try {
        await pool.query(
          `INSERT INTO notifications (user_id, category, title, body, data, action_url, status)
           VALUES ($1, $6, $2, $3, $4::jsonb, $5, 'sent')`,
          [id, String(title).slice(0, 160), body || null, JSON.stringify(data || {}), action_url || null, category],
        );
      } catch (err) {
        console.error("[region-request] notify failed:", err.message);
      }
    }
  }

  // Live admins of a club or region, less whoever is acting.
  async function liveAdminIds(scope, id, exceptId) {
    const [table, column] = scope === "club" ? ["club_admins", "club_id"] : ["region_admins", "region_id"];
    const r = await pool.query(
      `SELECT a.user_id FROM ${table} a JOIN users u ON u.id = a.user_id
        WHERE a.${column} = $1 AND a.user_id <> $2
          AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
      [id, exceptId],
    );
    return r.rows.map((row) => row.user_id);
  }

  const regionName = (rg) => rg?.claimed_name || rg?.name || "no region";

  // Put a club in a region (or take it out with region_id: null). The
  // federation decides under a federation. Where the clubs started the
  // country themselves, which region a club sits in decides who runs its
  // meets alongside it (isEventDelegate follows clubs.region_id), who
  // reviews its members' role requests and who can appoint or remove its
  // admins. So:
  //
  //   * no claimed region on either side: the club's own admin picks,
  //     same as always;
  //   * leaving a claimed region: that region's admin lets it go (a club
  //     admin walking out mid-season would cut the state body out of a
  //     meet that's already running);
  //   * joining a claimed region takes both of them. The club's admin
  //     asks (202, requested_region_id), the region's admin accepts with
  //     the same PUT. Otherwise a state body could annex any club in the
  //     country and take over its meets and its admin list.
  router.put("/api/clubs/:id/region", verifyToken, async (req, res) => {
    if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: "Club not found" });
    const raw = req.body?.region_id ?? null;
    if (raw !== null && !UUID_RE.test(String(raw))) {
      return res.status(400).json({ error: "region_id must be a region id or null" });
    }
    // pg hands uuids back lower-case, so compare like with like.
    const regionId = raw === null ? null : String(raw).toLowerCase();
    try {
      const c = await pool.query(
        `SELECT c.id, c.org_id, c.name, c.region_id, c.requested_region_id, o.claim_state,
                EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $2) AS caller_is_admin
           FROM clubs c JOIN organisations o ON o.id = c.org_id
          WHERE c.id = $1`,
        [req.params.id, req.user.id],
      );
      if (!c.rows.length) return res.status(404).json({ error: "Club not found" });
      const club = c.rows[0];
      if (regionId) {
        const rg = await pool.query("SELECT 1 FROM regions WHERE id = $1 AND org_id = $2", [regionId, club.org_id]);
        if (!rg.rows.length) return res.status(400).json({ error: "That region isn't in this club's organisation" });
      }
      const moving = (club.region_id || null) !== regionId;
      const sides = (await pool.query(
        `SELECT rg.id, rg.name, rg.claimed_name, rg.claim_state,
                EXISTS (SELECT 1 FROM region_admins ra
                         WHERE ra.region_id = rg.id AND ra.user_id = $2) AS caller_is_admin,
                EXISTS (SELECT 1 FROM region_admins ra JOIN users u ON u.id = ra.user_id
                         WHERE ra.region_id = rg.id
                           AND u.deleted_at IS NULL AND u.suspended_at IS NULL) AS has_live_admin
           FROM regions rg WHERE rg.id = ANY($1::uuid[])`,
        [[club.region_id, regionId].filter(Boolean), req.user.id],
      )).rows;
      const from = sides.find((r) => r.id === club.region_id) || null;
      const to = sides.find((r) => r.id === regionId) || null;

      if (!isOrgAdminOf(req.user, club.org_id)) {
        if (club.claim_state !== "unclaimed") return res.status(403).json({ error: "Forbidden" });
        // A claimed region only gets a say while someone is alive to use
        // it. Once every admin has gone it's up for claiming again (see
        // register-org), and until then its clubs shouldn't be stuck
        // waiting on a deleted account to let them leave.
        const fromClaimed = from?.claim_state === "claimed" && from.has_live_admin;
        const toClaimed = to?.claim_state === "claimed" && to.has_live_admin;
        if (!moving) {
          if (!club.caller_is_admin && !from?.caller_is_admin) return res.status(403).json({ error: "Forbidden" });
          return res.json({ ok: true });
        }
        if (fromClaimed && !from.caller_is_admin) {
          return res.status(403).json({
            error: `${regionName(from)} decides which clubs leave it. Ask its admins to take the club out.`,
            code: "region_admin_required",
          });
        }
        if (toClaimed) {
          if (!to.caller_is_admin) {
            if (!club.caller_is_admin) return res.status(403).json({ error: "Forbidden" });
            // The club asks. A new ask replaces an older one.
            await pool.query(
              "UPDATE clubs SET requested_region_id = $1, region_requested_at = now() WHERE id = $2",
              [to.id, club.id],
            );
            await recordAudit(pool, {
              ...auditFromReq(req),
              org_id: club.org_id, entity_type: "club", entity_id: club.id, entity_name: club.name,
              action: "club.region_requested", metadata: { from: club.region_id, to: to.id },
            });
            await notifyUsers(await liveAdminIds("region", to.id, req.user.id), {
              category: "region_request",
              title: `${club.name} wants to join ${regionName(to)}`,
              body: "Accept or decline it on your region page.",
              action_url: "/region",
              data: { club_id: club.id, region_id: to.id },
            });
            return res.status(202).json({ ok: true, requested: true });
          }
          // The region accepts, which it can only do once the club has
          // asked (or when the person accepting runs the club too).
          if (!club.caller_is_admin && club.requested_region_id !== to.id) {
            return res.status(403).json({
              error: "The club's admin has to ask to join first.",
              code: "club_request_required",
            });
          }
        } else if (!club.caller_is_admin && !(fromClaimed && regionId === null)) {
          // Nothing claimed on the receiving end, so it's the club's call.
          // A claimed region's admin can let a club go, not pick where it
          // lands.
          return res.status(403).json({ error: "Forbidden" });
        }
      }
      if (!moving) return res.json({ ok: true });
      await pool.query(
        "UPDATE clubs SET region_id = $1, requested_region_id = NULL, region_requested_at = NULL WHERE id = $2",
        [regionId, club.id],
      );
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id: club.org_id, entity_type: "club", entity_id: club.id, entity_name: club.name,
        action: "club.region_changed", metadata: { from: club.region_id, to: regionId },
      });
      // Someone other than the club moved it (a region accepting or
      // letting go, or the federation), so the club hears about it.
      if (!club.caller_is_admin) {
        await notifyUsers(await liveAdminIds("club", club.id, req.user.id), {
          category: "region_decision",
          title: to ? `${club.name} is now in ${regionName(to)}` : `${club.name} was taken out of ${regionName(from)}`,
          body: null,
          action_url: "/club",
          data: { club_id: club.id, region_id: regionId },
        });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Club Region Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Withdraw a club's ask to join a region (its admin), or turn it down
  // (the region's admin, or the federation).
  router.delete("/api/clubs/:id/region-request", verifyToken, async (req, res) => {
    if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: "Club not found" });
    try {
      const c = await pool.query(
        `SELECT c.id, c.org_id, c.name, c.requested_region_id, rg.name AS region_name, rg.claimed_name,
                EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $2) AS caller_is_admin,
                EXISTS (SELECT 1 FROM region_admins ra
                         WHERE ra.region_id = c.requested_region_id AND ra.user_id = $2) AS caller_is_region_admin
           FROM clubs c LEFT JOIN regions rg ON rg.id = c.requested_region_id
          WHERE c.id = $1`,
        [req.params.id, req.user.id],
      );
      const club = c.rows[0];
      if (!club) return res.status(404).json({ error: "Club not found" });
      if (!club.caller_is_admin && !club.caller_is_region_admin && !isOrgAdminOf(req.user, club.org_id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!club.requested_region_id) return res.status(404).json({ error: "This club hasn't asked to join a region" });
      await pool.query(
        "UPDATE clubs SET requested_region_id = NULL, region_requested_at = NULL WHERE id = $1 AND requested_region_id = $2",
        [club.id, club.requested_region_id],
      );
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id: club.org_id, entity_type: "club", entity_id: club.id, entity_name: club.name,
        action: club.caller_is_admin ? "club.region_request_withdrawn" : "club.region_request_declined",
        metadata: { region_id: club.requested_region_id },
      });
      if (!club.caller_is_admin) {
        await notifyUsers(await liveAdminIds("club", club.id, req.user.id), {
          category: "region_decision",
          title: `${club.claimed_name || club.region_name} declined ${club.name}'s request to join`,
          body: null,
          action_url: "/club",
          data: { club_id: club.id, region_id: club.requested_region_id },
        });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Club Region Request Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // What a region admin (or the org admin) sees for one region: its
  // clubs with member counts and their admins, and clubs asking to join.
  router.get("/api/regions/:id/overview", verifyToken, async (req, res) => {
    try {
      const region = await loadRegion(req, res);
      if (!region) return;
      if (!region.caller_is_admin && !isOrgAdminOf(req.user, region.org_id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const clubs = await pool.query(
        `SELECT c.id, c.name, c.short_code,
                (SELECT count(*)::int FROM users u WHERE u.club_id = c.id AND u.deleted_at IS NULL) AS member_count,
                COALESCE((SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name) ORDER BY u.full_name)
                            FROM club_admins ca JOIN users u ON u.id = ca.user_id
                           WHERE ca.club_id = c.id AND u.deleted_at IS NULL), '[]'::json) AS admins
           FROM clubs c WHERE c.region_id = $1
          ORDER BY lower(c.name)`,
        [region.id],
      );
      // Clubs that have asked to join (PUT /api/clubs/:id/region), for
      // the region's admins to accept or turn down.
      const asking = await pool.query(
        `SELECT c.id, c.name, c.short_code, c.region_requested_at AS requested_at,
                cur.name AS current_region_name,
                (SELECT count(*)::int FROM users u WHERE u.club_id = c.id AND u.deleted_at IS NULL) AS member_count
           FROM clubs c LEFT JOIN regions cur ON cur.id = c.region_id
          WHERE c.requested_region_id = $1
          ORDER BY c.region_requested_at`,
        [region.id],
      );
      res.json({
        region: {
          id: region.id, name: region.name, short_code: region.short_code,
          claim_state: region.claim_state, claimed_name: region.claimed_name,
          label: region.region_label, org_id: region.org_id,
        },
        clubs: clubs.rows,
        join_requests: asking.rows,
      });
    } catch (err) {
      console.error("[Region Overview Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/regions/:id/admins", verifyToken, async (req, res) => {
    try {
      const region = await loadRegion(req, res);
      if (!region) return;
      const canManage = isOrgAdminOf(req.user, region.org_id) || viaRegionAdmin(region);
      if (!canManage && !region.caller_is_admin) return res.status(403).json({ error: "Forbidden" });
      const admins = await pool.query(
        `SELECT u.id, u.full_name, u.username, ra.created_at
           FROM region_admins ra JOIN users u ON u.id = ra.user_id
          WHERE ra.region_id = $1 AND u.deleted_at IS NULL
          ORDER BY lower(u.full_name)`,
        [region.id],
      );
      // Only people who can appoint get the picker list.
      const candidates = canManage
        ? (await pool.query(
            `SELECT u.id, u.full_name, u.username, c.name AS club_name
               FROM users u JOIN clubs c ON c.id = u.club_id
              WHERE c.region_id = $1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL
              ORDER BY lower(u.full_name)`,
            [region.id],
          )).rows
        : [];
      res.json({ admins: admins.rows, candidates, can_manage: canManage });
    } catch (err) {
      console.error("[Region Admins Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/regions/:id/admins", verifyToken, async (req, res) => {
    const userId = req.body?.user_id;
    if (typeof userId !== "string" || !UUID_RE.test(userId)) {
      return res.status(400).json({ error: "user_id is required" });
    }
    try {
      const region = await loadRegion(req, res);
      if (!region) return;
      const asOrgAdmin = isOrgAdminOf(req.user, region.org_id);
      if (!asOrgAdmin && !viaRegionAdmin(region)) return res.status(403).json({ error: "Forbidden" });
      if (!(await isInSameOrg(pool, region.org_id, userId, "users"))) {
        return res.status(400).json({ error: "That user isn't in this region's organisation" });
      }
      // Same limit a club admin has: their own people, here meaning a
      // live member of one of the region's clubs, not anyone in the country.
      if (!asOrgAdmin) {
        const m = await pool.query(
          `SELECT 1 FROM users u JOIN clubs c ON c.id = u.club_id
            WHERE u.id = $1 AND c.region_id = $2
              AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
          [userId, region.id],
        );
        if (!m.rows.length) {
          return res.status(400).json({ error: "Only members of this region's clubs can be its admins" });
        }
      }
      const ins = await pool.query(
        `INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)
         ON CONFLICT (region_id, user_id) DO NOTHING RETURNING id`,
        [region.id, userId, region.org_id],
      );
      if (ins.rows.length) {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id: region.org_id, entity_type: "region", entity_id: region.id,
          entity_name: region.name, action: "region.admin_added", metadata: { user_id: userId },
        });
      }
      res.status(ins.rows.length ? 201 : 200).json({ ok: true });
    } catch (err) {
      console.error("[Region Admin Grant Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/regions/:id/admins/:userId", verifyToken, async (req, res) => {
    try {
      const region = await loadRegion(req, res);
      if (!region) return;
      const asOrgAdmin = isOrgAdminOf(req.user, region.org_id);
      if (!asOrgAdmin && !viaRegionAdmin(region)) return res.status(403).json({ error: "Forbidden" });
      if (!UUID_RE.test(String(req.params.userId))) return res.status(404).json({ error: "Not a region admin" });
      const out = await removeAdmin(pool, {
        scope: "region",
        scopeId: region.id,
        userId: req.params.userId,
        keepOneLive: !asOrgAdmin,
      });
      if (out.status === 404) return res.status(404).json({ error: "Not a region admin" });
      if (out.status === 409) {
        return res.status(409).json({ error: "A region needs at least one admin. Add someone else first." });
      }
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id: region.org_id, entity_type: "region", entity_id: region.id,
        entity_name: region.name, action: "region.admin_removed", metadata: { user_id: req.params.userId },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Region Admin Revoke Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
