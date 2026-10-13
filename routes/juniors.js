// Junior profiles (migration 107): divers under 13 that adults look after.
// lib/juniors.js has the rules (who may add, see, manage and confirm);
// this is the HTTP side.
//
//   GET    /api/juniors                  the juniors I look after, coach or run
//   GET    /api/juniors/options          clubs I can add one to, and as what
//   POST   /api/juniors                  add one
//   PUT    /api/juniors/:id              edit name, birthday, gender, club
//   DELETE /api/juniors/:id              remove one (or withdraw a pending one)
//   GET    /api/juniors/pending          the confirm queue: juniors + parent links
//   POST   /api/juniors/:id/review       confirm or turn down
//   POST   /api/juniors/:id/parents      add a parent by username
//   DELETE /api/juniors/:id/parents/:linkId
//   POST   /api/juniors/:id/handover     email a 13-year-old a link to take over
//   DELETE /api/juniors/:id/handover     cancel that link
//   GET    /api/junior-handover/:token   public: whose profile the link is for
//   POST   /api/junior-handover          public: take it over
//
// A parent link added later is decided through the guardian review route
// (POST /api/guardian-requests/:id/review, routes/users.js), the same row
// and the same rules; this file only lists those for juniors.
//
// Mounted via app.use(require('./routes/juniors')({ ... })) in server.js.

const express = require("express");
const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const juniors = require("../lib/juniors");
const notices = require("../lib/notices");
const { withTx } = require("../lib/club-approvals");
const { DELEGATE_SCOPE } = require("../lib/role-requests");
const { recordAudit, auditFromReq } = require("../lib/audit");
const { isUuid, requireUuidParam } = require("../lib/uuid");
const { isKnownUnderMinimumAge, requireAgeDeclaration, MINIMUM_DIRECT_USE_AGE } = require("../lib/direct-use-age");
const { EMAIL_RE, USERNAME_RE, validatePassword, safeText } = require("../lib/account-rules");

const NOOP = (_req, _res, next) => next();
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A real calendar date, not in the future. Returns the YYYY-MM-DD back, or
// null.
function cleanDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null;
  if (v > new Date().toISOString().slice(0, 10)) return null;
  return v;
}

const isOrgAdmin = (user) => (user.org_roles || []).includes("org_admin");

module.exports = function createJuniorsRouter({
  pool,
  verifyToken,
  authLimiter,
  bulkWriteLimiter,
  // The 2FA gate the org admin's review routes use (server.js), for the
  // confirm queue. Optional so a test harness can leave it out.
  requireTotpForPrivilegedRoles,
  push,
  sendNoticeEmail,
  sendJuniorHandoverEmail,
}) {
  if (!pool) throw new Error("createJuniorsRouter requires { pool, ... }");
  const router = express.Router();
  router.param("id", requireUuidParam);
  router.param("linkId", requireUuidParam);
  const writeLimiter = bulkWriteLimiter || NOOP;
  const publicLimiter = authLimiter || NOOP;
  const totpGate = requireTotpForPrivilegedRoles || NOOP;
  const noticeDeps = {
    push,
    email: typeof sendNoticeEmail === "function" ? { sendNoticeEmail } : null,
  };

  // One junior the caller may see, or the 404 already sent.
  async function load(req, res) {
    const j = await juniors.juniorFor(pool, req.user, req.params.id);
    if (!j || !j.rights.see) {
      res.status(404).json({ error: "Junior not found" });
      return null;
    }
    return j;
  }

  function shape(row, user) {
    const rights = juniors.rightsFor(user, row);
    return {
      id: row.id,
      full_name: row.full_name,
      date_of_birth: rights.manage ? row.date_of_birth : null,
      age: juniors.ageFrom(row.date_of_birth),
      gender: row.gender,
      club_id: row.club_id,
      club_name: row.club_name,
      status: row.status,
      created_as: row.created_as,
      created_at: row.created_at,
      parents: row.parents || [],
      you: {
        guardian: row.guardian || null,
        coach: !!row.coach,
        club_admin: !!row.club_admin && row.club_status === "active",
        added: row.created_by === user.id,
      },
      can: { manage: rights.manage, remove: rights.remove, hand_over: rights.handOver },
      handover: rights.manage && row.handover_email
        ? { email: row.handover_email, sent_at: row.handover_sent_at, expires_at: row.handover_expires_at }
        : null,
    };
  }

  // ---------------------------------------------------------------
  // GET /api/juniors: the ones I added, am a parent of, coach, or run
  // the club (or region) of, and every one in my federation for its
  // admins. Handed-over ones are ordinary accounts and drop off.
  // ---------------------------------------------------------------
  router.get("/api/juniors", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `WITH mine AS (
           SELECT jp.user_id FROM junior_profiles jp WHERE jp.created_by = $1
           UNION SELECT g.dependent_user_id FROM guardians g
                  WHERE g.guardian_user_id = $1 AND g.status IN ('approved', 'pending')
           UNION SELECT l.diver_id FROM coach_diver_links l WHERE l.coach_id = $1
           UNION SELECT u.id FROM users u JOIN clubs c ON c.id = u.club_id AND c.status = 'active'
                  WHERE ${DELEGATE_SCOPE}
           UNION SELECT u.id FROM users u WHERE $2::boolean AND u.org_id = $3
         )
         SELECT u.id, u.full_name, to_char(u.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, u.gender,
                u.club_id, c.name AS club_name, c.status AS club_status, u.org_id, o.claim_state,
                jp.status, jp.created_as, jp.created_by, jp.created_at,
                jp.handover_email, jp.handover_sent_at, jp.handover_expires_at,
                (EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $1)
                 OR EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = c.region_id AND ra.user_id = $1)) AS club_admin,
                (SELECT g.status FROM guardians g
                  WHERE g.dependent_user_id = u.id AND g.guardian_user_id = $1
                    AND g.status IN ('approved', 'pending')
                  ORDER BY (g.status = 'approved') DESC LIMIT 1) AS guardian,
                EXISTS (SELECT 1 FROM coach_diver_links l WHERE l.diver_id = u.id AND l.coach_id = $1) AS coach,
                COALESCE((
                  SELECT json_agg(json_build_object(
                           'link_id', g.id, 'user_id', gu.id, 'full_name', gu.full_name,
                           'username', gu.username, 'status', g.status) ORDER BY gu.full_name)
                    FROM guardians g JOIN users gu ON gu.id = g.guardian_user_id AND gu.deleted_at IS NULL
                   WHERE g.dependent_user_id = u.id AND g.status IN ('approved', 'pending')), '[]') AS parents
           FROM mine
           JOIN junior_profiles jp ON jp.user_id = mine.user_id AND jp.status IN ('pending', 'active')
           JOIN users u            ON u.id = jp.user_id AND u.deleted_at IS NULL
           JOIN organisations o    ON o.id = u.org_id
           LEFT JOIN clubs c       ON c.id = u.club_id
          ORDER BY u.full_name
          LIMIT 500`,
        [req.user.id, isOrgAdmin(req.user), req.user.org_id],
      );
      res.json(r.rows.map((row) => shape(row, req.user)));
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------------------------------------------------------------
  // GET /api/juniors/options: the clubs in my federation a junior can go
  // in, plus any other club I run, each with how I may add one there.
  // ---------------------------------------------------------------
  router.get("/api/juniors/options", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT c.id, c.name, c.org_id, o.claim_state,
                (EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $1)
                 OR EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = c.region_id AND ra.user_id = $1)) AS club_admin
           FROM clubs c
           JOIN organisations o ON o.id = c.org_id AND o.status = 'active'
          WHERE c.status = 'active'
            AND (c.org_id = $2
                 OR EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $1)
                 OR EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = c.region_id AND ra.user_id = $1))
          ORDER BY c.name
          LIMIT 1000`,
        [req.user.id, req.user.org_id],
      );
      const clubs = r.rows
        .map((c) => ({
          id: c.id,
          name: c.name,
          as: juniors.relationsFor(req.user, c),
          // Which of those would be confirmed straight away.
          confirmed_as: juniors.relationsFor(req.user, c).filter((a) => juniors.startsActive(c, a)),
        }))
        .filter((c) => c.as.length);
      res.json({ clubs, genders: juniors.GENDERS, minimum_age: MINIMUM_DIRECT_USE_AGE });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------------------------------------------------------------
  // POST /api/juniors { full_name, date_of_birth, gender, club_id, as,
  //                     consent: true }
  // ---------------------------------------------------------------
  router.post("/api/juniors", writeLimiter, verifyToken, async (req, res) => {
    const body = req.body || {};
    const fullName = safeText(body.full_name, 100);
    const dob = cleanDate(body.date_of_birth);
    const gender = typeof body.gender === "string" ? body.gender.toLowerCase() : "";
    const as = body.as;
    if (!fullName || fullName.length < 2) return res.status(400).json({ error: "Enter the diver's full name" });
    if (!dob) return res.status(400).json({ error: "Enter a valid date of birth" });
    if (!isKnownUnderMinimumAge(dob)) {
      return res.status(400).json({
        error: `Divers ${MINIMUM_DIRECT_USE_AGE} and over sign up for an account of their own.`,
        code: "not_junior",
      });
    }
    if (!juniors.GENDERS.includes(gender)) return res.status(400).json({ error: "Pick the diver's gender" });
    if (!juniors.RELATIONS.includes(as)) return res.status(400).json({ error: "Say how you know the diver" });
    if (body.consent !== true) {
      return res.status(400).json({
        error: "Confirm that a parent or guardian has agreed to this.",
        code: "consent_required",
      });
    }
    if (!isUuid(body.club_id)) return res.status(400).json({ error: "Pick the diver's club" });
    try {
      const club = await juniors.clubContext(pool, req.user, body.club_id);
      if (!club || club.status !== "active" || club.org_status !== "active") {
        return res.status(400).json({ error: "Pick the diver's club" });
      }
      if (!juniors.relationsFor(req.user, club).includes(as)) {
        return res.status(403).json({ error: "You can't add a junior to that club that way", code: "relation_not_allowed" });
      }
      const active = juniors.startsActive(club, as);
      // Already here? Same club, same name, same birthday: a junior profile,
      // or an older account from before accounts were 13+. Anyone who knows
      // all three is most likely the other parent, so a parent's attempt
      // turns into a request to be linked to the one that exists, decided by
      // the same people as any parent link. It says nothing they didn't type.
      const dup = (await pool.query(
        `SELECT u.id FROM users u
          WHERE u.deleted_at IS NULL AND u.club_id = $1
            AND lower(btrim(u.full_name)) = lower($2) AND u.date_of_birth = $3::date
          ORDER BY u.created_at LIMIT 1`,
        [club.id, fullName, dob],
      )).rows[0];
      if (dup && as === "parent") {
        let link;
        try {
          link = (await pool.query(
            `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id)
             VALUES ($1, $2, $3) RETURNING id, guardian_user_id`,
            [club.org_id, req.user.id, dup.id],
          )).rows[0];
        } catch (err) {
          if (err.code !== "23505") throw err;
          return res.status(409).json({
            error: `You're already linked to ${fullName}, or have already asked to be.`,
            code: "already_linked",
          });
        }
        await recordAudit(pool, {
          ...auditFromReq(req), org_id: club.org_id, entity_type: "user", entity_id: dup.id,
          entity_name: fullName, action: "junior.parent_requested",
        });
        await juniors.notifyParentLink(pool, noticeDeps, { id: dup.id, org_id: club.org_id },
          { ...link, added_by: req.user.id, selfRequest: true })
          .catch((err) => console.error("[Juniors] notify", err.message));
        return res.status(202).json({ id: null, status: "link_requested", club_name: club.name });
      }
      if (dup) {
        return res.status(409).json({
          error: `${fullName} is already on DivingHQ with ${club.name}.`,
          code: "junior_exists",
        });
      }
      const junior = await withTx(pool, async (client) => {
        // Nobody signs in to it, so the username is only there because the
        // column wants one. Never shown.
        const username = `junior-${crypto.randomBytes(6).toString("hex")}`;
        const u = (await client.query(
          `INSERT INTO users (username, full_name, org_id, club_id, date_of_birth, gender)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [username, fullName, club.org_id, club.id, dob, gender],
        )).rows[0];
        const row = {
          id: u.id, org_id: club.org_id, created_by: req.user.id, created_as: as,
        };
        await client.query(
          `INSERT INTO junior_profiles
             (user_id, org_id, status, created_by, created_as, consent_by, reviewed_by, reviewed_at)
           VALUES ($1, $2, $3, $4, $5, $4, $6, $7)`,
          [u.id, club.org_id, active ? "active" : "pending", req.user.id, as,
            active ? req.user.id : null, active ? new Date() : null],
        );
        if (as === "parent") {
          await client.query(
            `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id) VALUES ($1, $2, $3)`,
            [club.org_id, req.user.id, u.id],
          );
        }
        if (active) await juniors.activate(client, row, req.user.id);
        await recordAudit(client, {
          ...auditFromReq(req), org_id: club.org_id, entity_type: "user", entity_id: u.id,
          entity_name: fullName, action: "junior.created",
          metadata: { created_as: as, status: active ? "active" : "pending", club_id: club.id },
        });
        return row;
      });
      let notified = null;
      if (!active) {
        notified = await juniors.notifyReviewers(pool, noticeDeps, junior)
          .catch((err) => { console.error("[Juniors] notify", err.message); return null; });
      }
      res.status(201).json({ id: junior.id, status: active ? "active" : "pending", reviewed_by: notified?.via || null });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------------------------------------------------------------
  // PUT /api/juniors/:id { full_name?, date_of_birth?, gender?, club_id? }
  // Whoever manages them. Moving club takes the federation's admins, or
  // someone who runs both clubs.
  // ---------------------------------------------------------------
  router.put("/api/juniors/:id", writeLimiter, verifyToken, async (req, res) => {
    try {
      const j = await load(req, res);
      if (!j) return;
      if (!j.rights.manage) return res.status(403).json({ error: "Only the diver's parents and club can change this" });
      const body = req.body || {};
      const sets = [];
      const vals = [];
      if (body.full_name !== undefined) {
        const name = safeText(body.full_name, 100);
        if (!name || name.length < 2) return res.status(400).json({ error: "Enter the diver's full name" });
        vals.push(name); sets.push(`full_name = $${vals.length}`);
      }
      if (body.date_of_birth !== undefined) {
        const dob = cleanDate(body.date_of_birth);
        if (!dob) return res.status(400).json({ error: "Enter a valid date of birth" });
        vals.push(dob); sets.push(`date_of_birth = $${vals.length}`);
      }
      if (body.gender !== undefined) {
        const g = typeof body.gender === "string" ? body.gender.toLowerCase() : "";
        if (!juniors.GENDERS.includes(g)) return res.status(400).json({ error: "Pick the diver's gender" });
        vals.push(g); sets.push(`gender = $${vals.length}`);
      }
      if (body.club_id !== undefined && body.club_id !== j.club_id) {
        if (!isUuid(body.club_id)) return res.status(400).json({ error: "Pick the diver's club" });
        const club = await juniors.clubContext(pool, req.user, body.club_id);
        if (!club || club.status !== "active" || club.org_id !== j.org_id) {
          return res.status(400).json({ error: "Pick a club in the same country" });
        }
        const fedAdmin = req.user.is_system_admin || (isOrgAdmin(req.user) && req.user.org_id === j.org_id);
        if (!fedAdmin && !(j.rights.manage && j.club_admin && club.club_admin)) {
          return res.status(403).json({ error: "Moving a diver to another club is up to the federation, or someone who runs both clubs" });
        }
        vals.push(club.id); sets.push(`club_id = $${vals.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: "Nothing to change" });
      vals.push(j.id);
      await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: j.org_id, entity_type: "user", entity_id: j.id,
        entity_name: j.full_name, action: "junior.updated",
        metadata: { fields: Object.keys(body).filter((k) => ["full_name", "date_of_birth", "gender", "club_id"].includes(k)) },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------------------------------------------------------------
  // DELETE /api/juniors/:id
  //
  // A pending one, or one that never competed, goes completely. One with
  // results keeps its name on them (the sporting record), the same as an
  // account deleting itself (routes/users.js /api/users/me/delete): the
  // birthday and the links to other people go, and the profile with them.
  // ---------------------------------------------------------------
  router.delete("/api/juniors/:id", writeLimiter, verifyToken, async (req, res) => {
    try {
      const j = await load(req, res);
      if (!j) return;
      if (!j.rights.remove) return res.status(403).json({ error: "Only the diver's parents and club can remove this" });
      const competed = (await pool.query(
        `SELECT EXISTS (SELECT 1 FROM competitor_dive_lists WHERE competitor_id = $1 OR partner_id = $1) AS any`,
        [j.id],
      )).rows[0].any;
      await withTx(pool, async (client) => {
        if (j.status === "pending" || !competed) {
          await client.query("DELETE FROM users WHERE id = $1", [j.id]);
        } else {
          await client.query(
            `UPDATE users SET date_of_birth = NULL, gender = NULL, nationality = NULL,
                    public_slug = 'deleted-' || left(id::text, 8),
                    username    = 'deleted-' || left(id::text, 8),
                    deleted_at  = now(), token_version = token_version + 1
              WHERE id = $1`,
            [j.id],
          );
          await client.query("DELETE FROM user_org_roles WHERE user_id = $1", [j.id]);
          await client.query("DELETE FROM coach_diver_links WHERE diver_id = $1", [j.id]);
          await client.query(
            `UPDATE guardians SET status = 'revoked', reviewed_by = $2, reviewed_at = now()
              WHERE dependent_user_id = $1 AND status IN ('pending', 'approved')`,
            [j.id, req.user.id],
          );
          await client.query("DELETE FROM junior_profiles WHERE user_id = $1", [j.id]);
        }
        await recordAudit(client, {
          ...auditFromReq(req), org_id: j.org_id, entity_type: "user", entity_id: j.id,
          entity_name: null, action: "junior.removed",
          metadata: { status: j.status, kept_results: j.status !== "pending" && competed },
        });
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------------------------------------------------------------
  // GET /api/juniors/pending: what the caller confirms. Juniors waiting,
  // and parents added to an existing junior. A parent added along with a
  // new junior isn't listed separately, confirming the junior approves it.
  //
  // Same ladder as role requests: the federation's admins under a
  // federation, the club's or region's admins where the clubs run things,
  // and the sysadmin everywhere. Nobody gets something they're part of.
  // ---------------------------------------------------------------
  router.get("/api/juniors/pending", verifyToken, totpGate, async (req, res) => {
    const sys = !!req.user.is_system_admin;
    const scope = (who) => `(
        $2::boolean
        OR (o.claim_state = 'claimed' AND $3::boolean AND u.org_id = $4)
        OR (o.claim_state = 'unclaimed' AND c.status = 'active' AND ${DELEGATE_SCOPE}
            AND ${who} IS DISTINCT FROM $1))`;
    const params = [req.user.id, sys, isOrgAdmin(req.user), req.user.org_id];
    try {
      const pending = await pool.query(
        `SELECT u.id, u.full_name, u.gender, to_char(u.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
                c.name AS club_name, jp.created_as, jp.created_at,
                a.full_name AS added_by_name, a.username AS added_by_username,
                EXISTS (SELECT 1 FROM junior_profiles jp2 JOIN users u2 ON u2.id = jp2.user_id AND u2.deleted_at IS NULL
                         WHERE jp2.user_id <> u.id AND jp2.status IN ('pending', 'active')
                           AND u2.club_id = u.club_id AND lower(u2.full_name) = lower(u.full_name)
                           AND u2.date_of_birth = u.date_of_birth) AS possible_duplicate
           FROM junior_profiles jp
           JOIN users u         ON u.id = jp.user_id AND u.deleted_at IS NULL
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs c    ON c.id = u.club_id
           LEFT JOIN users a    ON a.id = jp.created_by
          WHERE jp.status = 'pending' AND ${scope("jp.created_by")}
          ORDER BY jp.created_at
          LIMIT 200`,
        params,
      );
      const links = await pool.query(
        `SELECT g.id, g.requested_at, u.id AS junior_id, u.full_name AS junior_name,
                to_char(u.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, c.name AS club_name,
                gu.full_name AS parent_name, gu.username AS parent_username
           FROM guardians g
           JOIN junior_profiles jp ON jp.user_id = g.dependent_user_id AND jp.status IN ('pending', 'active')
           JOIN users u            ON u.id = g.dependent_user_id AND u.deleted_at IS NULL
           JOIN users gu           ON gu.id = g.guardian_user_id AND gu.deleted_at IS NULL
           JOIN organisations o    ON o.id = u.org_id
           LEFT JOIN clubs c       ON c.id = u.club_id
          WHERE g.status = 'pending'
            AND NOT (jp.status = 'pending' AND g.guardian_user_id = jp.created_by)
            AND ${scope("g.guardian_user_id")}
          ORDER BY g.requested_at
          LIMIT 200`,
        params,
      );
      res.json({
        juniors: pending.rows.map((r) => ({
          id: r.id, full_name: r.full_name, gender: r.gender, age: juniors.ageFrom(r.date_of_birth),
          club_name: r.club_name, created_as: r.created_as, created_at: r.created_at,
          added_by: { full_name: r.added_by_name, username: r.added_by_username },
          possible_duplicate: r.possible_duplicate,
        })),
        parent_links: links.rows.map((r) => ({
          id: r.id, requested_at: r.requested_at, junior_id: r.junior_id, junior_name: r.junior_name,
          age: juniors.ageFrom(r.date_of_birth), club_name: r.club_name,
          parent: { full_name: r.parent_name, username: r.parent_username },
        })),
      });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------------------------------------------------------------
  // POST /api/juniors/:id/review { decision: 'approved' | 'rejected' }
  // Confirming grants the diver role and the adder's links. Turning it
  // down removes the profile: it never competed and nobody vouched for it.
  // ---------------------------------------------------------------
  router.post("/api/juniors/:id/review", verifyToken, totpGate, async (req, res) => {
    const { decision } = req.body || {};
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    }
    try {
      const j = await juniors.juniorFor(pool, req.user, req.params.id);
      // Someone with no part in it gets the same answer as for a junior
      // that doesn't exist, so the queue can't be probed by id.
      if (!j || (!j.rights.see && !j.rights.review)) return res.status(404).json({ error: "Junior not found" });
      if (j.status !== "pending") {
        return res.status(409).json({ error: "This has already been decided", code: "already_decided" });
      }
      if (!j.rights.review) return res.status(403).json({ error: "You don't confirm this club's divers" });
      const decided = await withTx(pool, async (client) => {
        // Only a pending row changes, so two admins deciding at once can't
        // both win.
        const lock = await client.query(
          "SELECT user_id FROM junior_profiles WHERE user_id = $1 AND status = 'pending' FOR UPDATE",
          [j.id],
        );
        if (!lock.rowCount) return false;
        if (decision === "approved") {
          await client.query(
            `UPDATE junior_profiles SET status = 'active', reviewed_by = $2, reviewed_at = now()
              WHERE user_id = $1`,
            [j.id, req.user.id],
          );
          await juniors.activate(client, j, req.user.id);
        } else {
          await client.query("DELETE FROM users WHERE id = $1", [j.id]);
        }
        await recordAudit(client, {
          ...auditFromReq(req), org_id: j.org_id, entity_type: "user", entity_id: j.id,
          entity_name: decision === "approved" ? j.full_name : null,
          action: decision === "approved" ? "junior.confirmed" : "junior.rejected",
          metadata: { created_as: j.created_as },
        });
        return true;
      });
      if (!decided) return res.status(409).json({ error: "This has already been decided", code: "already_decided" });
      await juniors.notifyDecision(pool, noticeDeps, j, decision, j.full_name)
        .catch((err) => console.error("[Juniors] notify", err.message));
      res.json({ ok: true, status: decision === "approved" ? "active" : "removed" });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------------------------------------------------------------
  // POST /api/juniors/:id/parents { username }
  // A parent the club (or the other parent) adds. They share their
  // username; there's no searching for children by name. Approved at once
  // when the person adding them is the one who'd confirm it, otherwise it
  // waits in the same queue as the juniors.
  // ---------------------------------------------------------------
  router.post("/api/juniors/:id/parents", writeLimiter, verifyToken, async (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim().replace(/^@/, "") : "";
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Enter the parent's DivingHQ username" });
    try {
      const j = await load(req, res);
      if (!j) return;
      if (!j.rights.manage) return res.status(403).json({ error: "Only the diver's parents and club can add a parent" });
      const p = (await pool.query(
        `SELECT u.id, u.org_id, u.full_name, to_char(u.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
                EXISTS (SELECT 1 FROM junior_profiles jp WHERE jp.user_id = u.id AND jp.status IN ('pending', 'active')) AS is_junior
           FROM users u
          WHERE lower(u.username) = lower($1) AND u.deleted_at IS NULL`,
        [username],
      )).rows[0];
      if (!p || p.org_id !== j.org_id || p.id === j.id) {
        return res.status(404).json({ error: "No one with that username in this country", code: "parent_not_found" });
      }
      if (p.is_junior || isKnownUnderMinimumAge(p.date_of_birth)) {
        return res.status(400).json({ error: "A parent needs an account of their own" });
      }
      // Same test as confirming a junior, minus "it's still pending", and
      // nobody approves themselves as a parent.
      const approver = p.id !== req.user.id && (req.user.is_system_admin
        || (j.claim_state === "claimed" ? isOrgAdmin(req.user) && req.user.org_id === j.org_id
          : !!j.club_admin && j.club_status === "active"));
      const link = (await pool.query(
        `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, guardian_user_id`,
        [j.org_id, p.id, j.id, approver ? "approved" : "pending",
          approver ? req.user.id : null, approver ? new Date() : null],
      )).rows[0];
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: j.org_id, entity_type: "user", entity_id: j.id,
        entity_name: j.full_name, action: "junior.parent_added",
        metadata: { parent_id: p.id, status: approver ? "approved" : "pending" },
      });
      if (!approver) {
        await juniors.notifyParentLink(pool, noticeDeps, j, { ...link, added_by: req.user.id })
          .catch((err) => console.error("[Juniors] notify", err.message));
      }
      res.status(201).json({ link_id: link.id, status: approver ? "approved" : "pending" });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "They're already linked to this diver", code: "already_linked" });
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/juniors/:id/parents/:linkId: the parent themselves, or
  // anyone who manages the junior.
  router.delete("/api/juniors/:id/parents/:linkId", writeLimiter, verifyToken, async (req, res) => {
    try {
      const j = await load(req, res);
      if (!j) return;
      const link = (await pool.query(
        `SELECT id, guardian_user_id FROM guardians
          WHERE id = $1 AND dependent_user_id = $2 AND status IN ('pending', 'approved')`,
        [req.params.linkId, j.id],
      )).rows[0];
      if (!link) return res.status(404).json({ error: "Link not found" });
      if (link.guardian_user_id !== req.user.id && !j.rights.manage) return res.status(403).json({ error: "Forbidden" });
      await pool.query(
        `UPDATE guardians SET status = 'revoked', reviewed_by = $2, reviewed_at = now()
          WHERE id = $1 AND status IN ('pending', 'approved')`,
        [link.id, req.user.id],
      );
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: j.org_id, entity_type: "user", entity_id: j.id,
        entity_name: j.full_name, action: "junior.parent_removed",
        metadata: { parent_id: link.guardian_user_id },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------------------------------------------------------------
  // Stage 2: handing a profile over at 13.
  //
  // POST /api/juniors/:id/handover { email } mails the diver a link that
  // lasts a week; sending again replaces the old one. The diver opens it,
  // picks a username and password, and from then on it's an ordinary
  // account with every result still on it. Parents stay linked (they can
  // remove themselves later), the profile is just the diver's now.
  // ---------------------------------------------------------------
  router.post("/api/juniors/:id/handover", writeLimiter, verifyToken, async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Enter the diver's email address" });
    }
    try {
      const j = await load(req, res);
      if (!j) return;
      if (!j.rights.manage) return res.status(403).json({ error: "Only the diver's parents and club can do this" });
      if (!j.rights.handOver) {
        return res.status(400).json({
          error: `${j.full_name} can take over their profile once they're ${MINIMUM_DIRECT_USE_AGE}.`,
          code: "too_young",
        });
      }
      if (typeof sendJuniorHandoverEmail !== "function") {
        return res.status(503).json({ error: "Email isn't set up on this server", code: "email_unavailable" });
      }
      const { token, hash } = juniors.newHandoverToken();
      const expiresAt = new Date(Date.now() + juniors.HANDOVER_TTL_DAYS * 86400000);
      await pool.query(
        `UPDATE junior_profiles
            SET handover_email = $2, handover_token_hash = $3, handover_sent_by = $4,
                handover_sent_at = now(), handover_expires_at = $5
          WHERE user_id = $1 AND status = 'active'`,
        [j.id, email, hash, req.user.id, expiresAt],
      );
      const sent = await sendJuniorHandoverEmail({
        to: email, juniorName: j.full_name, clubName: j.club_name,
        senderName: req.user.full_name, token, expiresAt,
      });
      if (!sent?.sent) {
        // Nothing went out, so a link nobody received shouldn't be live.
        await pool.query(
          `UPDATE junior_profiles SET handover_token_hash = NULL, handover_email = NULL,
                  handover_sent_at = NULL, handover_expires_at = NULL, handover_sent_by = NULL
            WHERE user_id = $1 AND handover_token_hash = $2`,
          [j.id, hash],
        );
        return res.status(503).json({ error: "The email couldn't be sent. Try again later.", code: "email_unavailable" });
      }
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: j.org_id, entity_type: "user", entity_id: j.id,
        entity_name: j.full_name, action: "junior.handover_sent",
      });
      res.json({ email, expires_at: expiresAt.toISOString() });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/juniors/:id/handover", writeLimiter, verifyToken, async (req, res) => {
    try {
      const j = await load(req, res);
      if (!j) return;
      if (!j.rights.manage) return res.status(403).json({ error: "Forbidden" });
      await pool.query(
        `UPDATE junior_profiles SET handover_token_hash = NULL, handover_email = NULL,
                handover_sent_at = NULL, handover_expires_at = NULL, handover_sent_by = NULL
          WHERE user_id = $1`,
        [j.id],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // The link's profile, if the link still works. A link for someone whose
  // birthday got corrected to under 13 since stops working too.
  async function handoverTarget(db, token, { lock = false } = {}) {
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
    const r = await db.query(
      `SELECT u.id, u.full_name, u.org_id, to_char(u.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
              c.name AS club_name, o.name AS org_name, jp.handover_email, jp.handover_expires_at
         FROM junior_profiles jp
         JOIN users u         ON u.id = jp.user_id AND u.deleted_at IS NULL
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs c    ON c.id = u.club_id
        WHERE jp.handover_token_hash = $1 AND jp.status = 'active' AND jp.handover_expires_at > now()
        ${lock ? "FOR UPDATE OF jp" : ""}`,
      [juniors.hashToken(token)],
    );
    const row = r.rows[0];
    if (!row || isKnownUnderMinimumAge(row.date_of_birth)) return null;
    return row;
  }

  const LINK_GONE = {
    error: "This link has expired or has already been used. Ask your parent or club to send a new one.",
    code: "link_invalid",
  };

  router.get("/api/junior-handover/:token", publicLimiter, async (req, res) => {
    try {
      const t = await handoverTarget(pool, req.params.token);
      if (!t) return res.status(404).json(LINK_GONE);
      res.json({
        full_name: t.full_name, club_name: t.club_name, org_name: t.org_name,
        email: t.handover_email, expires_at: t.handover_expires_at,
      });
    } catch (err) {
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/junior-handover { token, username, password, age_13_or_older }
  // The email address is the one the link went to: getting the link proves
  // it, so the account starts verified and can sign in straight away.
  router.post("/api/junior-handover", publicLimiter, requireAgeDeclaration, async (req, res) => {
    const { token, password } = req.body || {};
    const username = safeText(req.body?.username, 50);
    if (!username || !USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: "Username must be 2–50 characters of letters, digits, dot, underscore, or hyphen",
      });
    }
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    try {
      const hash = await bcrypt.hash(password, 12);
      const done = await withTx(pool, async (client) => {
        const t = await handoverTarget(client, token, { lock: true });
        if (!t) return null;
        await client.query(
          `UPDATE users SET username = $2, password = $3, email = $4, email_verified_at = now(),
                  token_version = token_version + 1
            WHERE id = $1`,
          [t.id, username, hash, t.handover_email],
        );
        await client.query(
          `UPDATE junior_profiles SET status = 'handed_over', handed_over_at = now(), handover_token_hash = NULL
            WHERE user_id = $1`,
          [t.id],
        );
        await recordAudit(client, {
          ...auditFromReq(req), actor_id: t.id, org_id: t.org_id, entity_type: "user", entity_id: t.id,
          entity_name: t.full_name, action: "junior.handed_over",
        });
        const parents = (await client.query(
          "SELECT guardian_user_id FROM guardians WHERE dependent_user_id = $1 AND status = 'approved'",
          [t.id],
        )).rows.map((r) => r.guardian_user_id);
        return { ...t, parents };
      });
      if (!done) return res.status(404).json(LINK_GONE);
      if (done.parents.length) {
        await notices.deliver(noticeDeps, [{
          userIds: done.parents,
          category: "junior_decision",
          title: `${done.full_name} has their own DivingHQ account now`,
          body: "Their notifications go to them from now on.",
          action_url: "/juniors",
          data: { junior_user_id: done.id },
          email: false,
        }], { tag: "juniors" }).catch(() => {});
      }
      res.json({ ok: true, username });
    } catch (err) {
      if (err.code === "23505" && err.constraint === "users_username_key") {
        return res.status(409).json({ error: "That username is taken. Pick another one.", code: "username_taken" });
      }
      console.error("[Juniors]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
