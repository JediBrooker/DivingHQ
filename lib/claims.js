// Claims: a national federation taking over its country's account, or a
// state body taking over its region (migration 089, phase 3 of
// docs/club-first-onboarding.md §8).
//
// The whole lifecycle lives here so routes/claims.js, the register-org
// flow, email verification and the sweep all agree on the rules:
//
//   open      register-org finds the country (or region) already started
//             by clubs and opens a claim instead of a second account. The
//             approver and the voters are fixed there and then.
//   activate  nothing is visible, and nobody's notified, until the
//             claimant verifies their email. That starts the clock.
//   vote      clubs (or claimed regions) vote. Any objection escalates to
//             the sysadmin; enough approvals passes it on the spot.
//   decide    a region claim under a federation is the federation's call;
//             the sysadmin can decide anything open or escalated.
//   sweep     hourly: expired votes resolve (an approval and no
//             objections passes, anything else escalates), claims nobody
//             verified are withdrawn after a week.
//   revoke    the sysadmin can undo an approved claim at any time.
//
// Notifications are in-app only for now (push.sendNotification).

const settingsLib = require("./platform-settings");
const { recordAudit } = require("./audit");
const { countryByCode } = require("./countries");

const UNVERIFIED_TTL_DAYS = 7;

class ClaimError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// Who counts as a voter (§8.2), evaluated when the claim opens.
// ---------------------------------------------------------------------

// Clubs old enough, active enough (a hosted meet or enough verified
// members), with an admin to cast the vote, none of whom is the claimant.
async function eligibleClubs(db, { orgId, regionId, claimantId, settings }) {
  const r = await db.query(
    `SELECT c.id FROM clubs c
      WHERE c.org_id = $1
        AND ($2::uuid IS NULL OR c.region_id = $2)
        AND c.created_at <= now() - make_interval(days => $3::int)
        AND (
          EXISTS (SELECT 1 FROM meets m WHERE m.host_club_id = c.id)
          OR (SELECT count(*) FROM users u
               WHERE u.club_id = c.id AND u.email_verified_at IS NOT NULL
                 AND u.deleted_at IS NULL) >= $4
        )
        AND EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $5)`,
    [orgId, regionId || null, settings.claim_voter_min_age_days, settings.claim_voter_min_members, claimantId],
  );
  return r.rows.map((row) => row.id);
}

// Regions that are already claimed (a state body runs them) and have an
// admin who isn't the claimant. They vote on a national claim.
async function eligibleRegions(db, { orgId, claimantId }) {
  const r = await db.query(
    `SELECT rg.id FROM regions rg
      WHERE rg.org_id = $1 AND rg.claim_state = 'claimed'
        AND EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = rg.id)
        AND NOT EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = rg.id AND ra.user_id = $2)`,
    [orgId, claimantId],
  );
  return r.rows.map((row) => row.id);
}

// Trust signal only (§8.6), never an auto-approve: does the claimant's
// email domain belong to the website they gave?
function domainMatches(email, website) {
  if (typeof email !== "string" || typeof website !== "string" || !website.trim()) return false;
  const emailDomain = email.split("@")[1]?.toLowerCase();
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^www\./, "");
  if (!emailDomain || !host) return false;
  return emailDomain === host || emailDomain.endsWith(`.${host}`);
}

// ---------------------------------------------------------------------
// Open (§8.1)
// ---------------------------------------------------------------------

async function openClaim(client, { targetKind, targetId, orgId, claimantId, claimantEmail, bodyName, website }) {
  const settings = await settingsLib.getAll(client);
  let approver = "sysadmin";
  let voters = [];

  if (targetKind === "region") {
    const org = await client.query("SELECT claim_state FROM organisations WHERE id = $1", [orgId]);
    if (org.rows[0]?.claim_state === "claimed") {
      approver = "parent";
    } else {
      const clubs = await eligibleClubs(client, { orgId, regionId: targetId, claimantId, settings });
      if (clubs.length >= settings.claim_quorum_min) {
        approver = "clubs";
        voters = clubs.map((id) => ({ kind: "club", id }));
      }
    }
  } else {
    const regions = await eligibleRegions(client, { orgId, claimantId });
    if (regions.length >= settings.claim_quorum_min) {
      approver = "regions";
      voters = regions.map((id) => ({ kind: "region", id }));
    } else {
      const clubs = await eligibleClubs(client, { orgId, regionId: null, claimantId, settings });
      if (clubs.length >= settings.claim_quorum_min) {
        approver = "clubs";
        voters = clubs.map((id) => ({ kind: "club", id }));
      }
    }
  }

  let claim;
  try {
    claim = (await client.query(
      `INSERT INTO claims (target_kind, target_id, org_id, claimant_id, body_name, website, domain_verified, approver)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [targetKind, targetId, orgId, claimantId, bodyName, website || null,
       domainMatches(claimantEmail, website), approver],
    )).rows[0];
  } catch (err) {
    if (err.constraint === "claims_one_live") {
      throw new ClaimError(409, "Someone has already claimed this and it's being decided. Contact support if that's wrong.", "claim_in_progress");
    }
    throw err;
  }
  for (const v of voters) {
    await client.query(
      "INSERT INTO claim_voters (claim_id, voter_kind, voter_id) VALUES ($1, $2, $3)",
      [claim.id, v.kind, v.id],
    );
  }
  await recordAudit(client, {
    org_id: orgId, actor_id: claimantId, entity_type: "claim", entity_id: claim.id,
    entity_name: bodyName, action: "claim.opened",
    metadata: { target_kind: targetKind, target_id: targetId, approver, voters: voters.length },
  });
  return claim;
}

// ---------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------

async function targetName(db, claim) {
  const table = claim.target_kind === "org" ? "organisations" : "regions";
  const r = await db.query(`SELECT name FROM ${table} WHERE id = $1`, [claim.target_id]);
  return r.rows[0]?.name || "an account";
}

async function sysadminIds(db) {
  return (await db.query("SELECT id FROM users WHERE is_system_admin = true")).rows.map((r) => r.id);
}

// Who has to act on an activated claim: the voters' admins, the parent
// org's admins, or the sysadmins.
async function actorIds(db, claim) {
  if (claim.approver === "clubs") {
    return (await db.query(
      `SELECT DISTINCT ca.user_id FROM claim_voters cv
         JOIN club_admins ca ON ca.club_id = cv.voter_id
        WHERE cv.claim_id = $1 AND cv.voter_kind = 'club'`,
      [claim.id],
    )).rows.map((r) => r.user_id);
  }
  if (claim.approver === "regions") {
    return (await db.query(
      `SELECT DISTINCT ra.user_id FROM claim_voters cv
         JOIN region_admins ra ON ra.region_id = cv.voter_id
        WHERE cv.claim_id = $1 AND cv.voter_kind = 'region'`,
      [claim.id],
    )).rows.map((r) => r.user_id);
  }
  if (claim.approver === "parent") {
    return (await db.query(
      `SELECT DISTINCT r.user_id FROM user_org_roles r
        WHERE r.org_id = $1 AND r.role = 'org_admin'`,
      [claim.org_id],
    )).rows.map((r) => r.user_id);
  }
  return sysadminIds(db);
}

// Everyone affected once it's decided: the claimant plus every club admin
// in scope (the whole org, or the region's clubs).
async function scopeIds(db, claim) {
  const r = claim.target_kind === "org"
    ? await db.query(
        "SELECT DISTINCT ca.user_id FROM club_admins ca WHERE ca.org_id = $1",
        [claim.org_id],
      )
    : await db.query(
        `SELECT DISTINCT ca.user_id FROM club_admins ca
           JOIN clubs c ON c.id = ca.club_id WHERE c.region_id = $1`,
        [claim.target_id],
      );
  return [...new Set([claim.claimant_id, ...r.rows.map((row) => row.user_id)])];
}

async function notify(push, userIds, payload) {
  if (!push || typeof push.sendNotification !== "function" || !userIds.length) return;
  try {
    await push.sendNotification(userIds, { action_url: "/claims", ...payload });
  } catch (err) {
    console.error("[claims notify]", err.message);
  }
}

// ---------------------------------------------------------------------
// Activate: the claimant verified their email.
// ---------------------------------------------------------------------

async function activateForUser(pool, userId, { push } = {}) {
  const settings = await settingsLib.getAll(pool);
  const r = await pool.query(
    `UPDATE claims
        SET activated_at = now(),
            closes_at = now() + make_interval(days => $2::int)
      WHERE claimant_id = $1 AND status = 'open' AND activated_at IS NULL
      RETURNING *`,
    [userId, settings.claim_timeout_days],
  );
  for (const claim of r.rows) {
    const name = await targetName(pool, claim);
    const voting = claim.approver === "clubs" || claim.approver === "regions";
    await notify(push, await actorIds(pool, claim), {
      category: voting ? "claim_vote" : "claim_review",
      title: `${claim.body_name} wants to run ${name}`,
      body: voting
        ? "Your vote decides whether they take over. Objecting sends it to DivingHQ to review."
        : "They're waiting on your decision.",
      data: { claim_id: claim.id },
    });
  }
  return r.rows.length;
}

// ---------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------

async function tally(db, claimId) {
  const r = await db.query(
    `SELECT
       (SELECT count(*)::int FROM claim_voters WHERE claim_id = $1) AS eligible,
       (SELECT count(*)::int FROM claim_votes WHERE claim_id = $1 AND vote = 'approve') AS approvals,
       (SELECT count(*)::int FROM claim_votes WHERE claim_id = $1 AND vote = 'object') AS objections`,
    [claimId],
  );
  return r.rows[0];
}

// Make it so. Runs inside the caller's transaction; notifications are
// handed back to send after COMMIT.
async function applyApproval(client, claim, { deciderId, bumpTokenVersion }) {
  if (claim.target_kind === "org") {
    await client.query(
      `UPDATE organisations SET claim_state = 'claimed', claimed_at = now(), name = $2 WHERE id = $1`,
      [claim.target_id, claim.body_name],
    );
    await client.query(
      `INSERT INTO user_org_roles (user_id, org_id, role, granted_by)
       VALUES ($1, $2, 'org_admin', $3) ON CONFLICT DO NOTHING`,
      [claim.claimant_id, claim.target_id, deciderId || null],
    );
    // New role: their next request re-authenticates and picks it up.
    if (bumpTokenVersion) await bumpTokenVersion(client, claim.claimant_id);
  } else {
    await client.query(
      `UPDATE regions SET claim_state = 'claimed', claimed_at = now(), claimed_name = $2 WHERE id = $1`,
      [claim.target_id, claim.body_name],
    );
    await client.query(
      `INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)
       ON CONFLICT (region_id, user_id) DO NOTHING`,
      [claim.target_id, claim.claimant_id, claim.org_id],
    );
  }
  await client.query(
    "UPDATE claims SET status = 'approved', decided_at = now(), decided_by = $2 WHERE id = $1",
    [claim.id, deciderId || null],
  );
  await recordAudit(client, {
    org_id: claim.org_id, actor_id: deciderId || null, entity_type: "claim", entity_id: claim.id,
    entity_name: claim.body_name, action: "claim.approved",
    metadata: { target_kind: claim.target_kind, target_id: claim.target_id, approver: claim.approver },
  });
  const name = claim.target_kind === "org" ? claim.body_name : await targetName(client, claim);
  return {
    userIds: await scopeIds(client, claim),
    payload: {
      category: "claim_decided",
      title: `${claim.body_name} now runs ${name}`,
      body: "They take over from here. If this looks wrong, contact DivingHQ.",
      data: { claim_id: claim.id },
    },
  };
}

async function escalate(client, claim, reason) {
  await client.query(
    "UPDATE claims SET status = 'escalated', status_reason = $2 WHERE id = $1",
    [claim.id, reason],
  );
  await recordAudit(client, {
    org_id: claim.org_id, entity_type: "claim", entity_id: claim.id,
    entity_name: claim.body_name, action: "claim.escalated", metadata: { reason },
  });
  return {
    userIds: await sysadminIds(client),
    payload: {
      category: "claim_review",
      title: `Claim by ${claim.body_name} needs a decision`,
      body: reason,
      data: { claim_id: claim.id },
    },
  };
}

// After a vote: does it resolve now (§8.3)?
async function evaluate(client, claim, settings, deps) {
  const t = await tally(client, claim.id);
  if (t.objections > 0) {
    return escalate(client, claim, "A voter objected.");
  }
  if (t.approvals >= settings.claim_quorum_min && t.approvals > settings.claim_majority * t.eligible) {
    return applyApproval(client, claim, { deciderId: null, ...deps });
  }
  return null;
}

// ---------------------------------------------------------------------
// Vote / decide / revoke
// ---------------------------------------------------------------------

async function lockClaim(client, claimId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(claimId))) throw new ClaimError(404, "Claim not found");
  const r = await client.query("SELECT * FROM claims WHERE id = $1 FOR UPDATE", [claimId]);
  if (!r.rows.length) throw new ClaimError(404, "Claim not found");
  return r.rows[0];
}

// The voter entities (club / region) this user can vote for on a claim.
async function voterEntitiesFor(db, claimId, userId) {
  const r = await db.query(
    `SELECT cv.voter_kind, cv.voter_id,
            COALESCE(c.name, rg.name) AS name,
            v.vote
       FROM claim_voters cv
       LEFT JOIN clubs c    ON cv.voter_kind = 'club'   AND c.id = cv.voter_id
       LEFT JOIN regions rg ON cv.voter_kind = 'region' AND rg.id = cv.voter_id
       LEFT JOIN claim_votes v ON v.claim_id = cv.claim_id
                              AND v.voter_kind = cv.voter_kind AND v.voter_id = cv.voter_id
      WHERE cv.claim_id = $1
        AND ((cv.voter_kind = 'club' AND EXISTS (
               SELECT 1 FROM club_admins ca WHERE ca.club_id = cv.voter_id AND ca.user_id = $2))
          OR (cv.voter_kind = 'region' AND EXISTS (
               SELECT 1 FROM region_admins ra WHERE ra.region_id = cv.voter_id AND ra.user_id = $2)))`,
    [claimId, userId],
  );
  return r.rows;
}

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function castVote(pool, { claimId, user, vote, reason, voterId }, { push, bumpTokenVersion } = {}) {
  if (!["approve", "object"].includes(vote)) throw new ClaimError(400, "vote must be 'approve' or 'object'");
  const cleanReason = typeof reason === "string" ? reason.trim().slice(0, 1000) : null;
  if (vote === "object" && !cleanReason) {
    throw new ClaimError(400, "Say why you object, it goes to DivingHQ with the claim");
  }
  const note = await withTx(pool, async (client) => {
    const claim = await lockClaim(client, claimId);
    if (claim.status !== "open" || !claim.activated_at || !["clubs", "regions"].includes(claim.approver)) {
      throw new ClaimError(409, "This claim isn't open for voting");
    }
    if (claim.claimant_id === user.id) throw new ClaimError(403, "You can't vote on your own claim");
    const mine = (await voterEntitiesFor(client, claim.id, user.id)).filter((v) => !v.vote);
    const entity = voterId ? mine.find((v) => v.voter_id === voterId) : (mine.length === 1 ? mine[0] : null);
    if (!entity) {
      throw new ClaimError(mine.length > 1 ? 400 : 403,
        mine.length > 1 ? "Say which of your clubs this vote is for" : "You don't have a vote on this claim (or it's been cast)");
    }
    await client.query(
      `INSERT INTO claim_votes (claim_id, voter_kind, voter_id, user_id, vote, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [claim.id, entity.voter_kind, entity.voter_id, user.id, vote, cleanReason],
    );
    await recordAudit(client, {
      org_id: claim.org_id, actor_id: user.id, entity_type: "claim", entity_id: claim.id,
      entity_name: claim.body_name, action: "claim.vote",
      metadata: { vote, voter_kind: entity.voter_kind, voter_id: entity.voter_id },
    });
    const settings = await settingsLib.getAll(client);
    return evaluate(client, claim, settings, { bumpTokenVersion });
  });
  if (note) await notify(push, note.userIds, note.payload);
  return (await pool.query("SELECT status FROM claims WHERE id = $1", [claimId])).rows[0].status;
}

// Approve or reject: the sysadmin (open or escalated), or the parent
// org's admin for a region claim under a federation.
async function decide(pool, { claimId, user, decision, reason }, { push, bumpTokenVersion } = {}) {
  if (!["approve", "reject"].includes(decision)) throw new ClaimError(400, "decision must be 'approve' or 'reject'");
  const note = await withTx(pool, async (client) => {
    const claim = await lockClaim(client, claimId);
    const isSys = !!user.is_system_admin;
    const isParent = claim.approver === "parent" && claim.status === "open"
      && user.org_id === claim.org_id && (user.org_roles || []).includes("org_admin");
    if (!isSys && !isParent) throw new ClaimError(403, "You can't decide this claim");
    if (!["open", "escalated"].includes(claim.status)) throw new ClaimError(409, "This claim has already been decided");
    if (decision === "approve") {
      return applyApproval(client, claim, { deciderId: user.id, bumpTokenVersion });
    }
    await client.query(
      "UPDATE claims SET status = 'rejected', status_reason = $2, decided_at = now(), decided_by = $3 WHERE id = $1",
      [claim.id, typeof reason === "string" ? reason.slice(0, 1000) : null, user.id],
    );
    await recordAudit(client, {
      org_id: claim.org_id, actor_id: user.id, entity_type: "claim", entity_id: claim.id,
      entity_name: claim.body_name, action: "claim.rejected", metadata: { reason: reason || null },
    });
    return {
      userIds: [claim.claimant_id],
      payload: {
        category: "claim_decided",
        title: `Your claim as ${claim.body_name} wasn't approved`,
        body: reason || "Contact DivingHQ if you'd like to talk it through.",
        data: { claim_id: claim.id },
      },
    };
  });
  if (note) await notify(push, note.userIds, note.payload);
}

// Undo an approved claim (sysadmin only): the target goes back to
// unclaimed and the claimant loses what the claim gave them.
async function revoke(pool, { claimId, user, reason }, { bumpTokenVersion } = {}) {
  if (!user.is_system_admin) throw new ClaimError(403, "Only DivingHQ can revoke a claim");
  await withTx(pool, async (client) => {
    const claim = await lockClaim(client, claimId);
    if (claim.status !== "approved") throw new ClaimError(409, "Only an approved claim can be revoked");
    if (claim.target_kind === "org") {
      const org = (await client.query("SELECT country_code FROM organisations WHERE id = $1", [claim.target_id])).rows[0];
      const countryName = countryByCode(org?.country_code)?.name;
      await client.query(
        `UPDATE organisations SET claim_state = 'unclaimed', claimed_at = NULL,
                name = COALESCE($2, name) WHERE id = $1`,
        [claim.target_id, countryName || null],
      );
      await client.query(
        "DELETE FROM user_org_roles WHERE user_id = $1 AND org_id = $2 AND role = 'org_admin'",
        [claim.claimant_id, claim.target_id],
      );
      if (bumpTokenVersion) await bumpTokenVersion(client, claim.claimant_id);
    } else {
      await client.query(
        "UPDATE regions SET claim_state = 'unclaimed', claimed_at = NULL, claimed_name = NULL WHERE id = $1",
        [claim.target_id],
      );
      await client.query(
        "DELETE FROM region_admins WHERE region_id = $1 AND user_id = $2",
        [claim.target_id, claim.claimant_id],
      );
    }
    await client.query(
      "UPDATE claims SET status = 'revoked', status_reason = $2, decided_at = now(), decided_by = $3 WHERE id = $1",
      [claim.id, typeof reason === "string" ? reason.slice(0, 1000) : null, user.id],
    );
    await recordAudit(client, {
      org_id: claim.org_id, actor_id: user.id, entity_type: "claim", entity_id: claim.id,
      entity_name: claim.body_name, action: "claim.revoked", metadata: { reason: reason || null },
    });
  });
}

// ---------------------------------------------------------------------
// Sweep (§8.4)
// ---------------------------------------------------------------------

async function sweepOnce({ pool, push = null, bumpTokenVersion = null }) {
  const withdrawn = await pool.query(
    `UPDATE claims SET status = 'withdrawn', status_reason = 'Email never verified'
      WHERE status = 'open' AND activated_at IS NULL
        AND created_at < now() - make_interval(days => $1::int)
      RETURNING id`,
    [UNVERIFIED_TTL_DAYS],
  );
  const due = await pool.query(
    `SELECT id FROM claims
      WHERE status = 'open' AND activated_at IS NOT NULL AND closes_at < now()
        AND approver IN ('clubs', 'regions', 'parent')`,
  );
  let resolved = 0;
  for (const { id } of due.rows) {
    try {
      const note = await withTx(pool, async (client) => {
        const claim = await lockClaim(client, id);
        if (claim.status !== "open") return null;
        if (claim.approver === "parent") {
          return escalate(client, claim, "The federation didn't decide in time.");
        }
        const t = await tally(client, claim.id);
        if (t.approvals >= 1 && t.objections === 0) {
          return applyApproval(client, claim, { deciderId: null, bumpTokenVersion });
        }
        return escalate(client, claim, t.approvals ? "A voter objected." : "Voting closed with no approvals.");
      });
      if (note) await notify(push, note.userIds, note.payload);
      resolved += 1;
    } catch (err) {
      console.error("[claims sweep]", id, err.message);
    }
  }
  return { withdrawn: withdrawn.rows.length, resolved };
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function start({ pool, push, bumpTokenVersion, logger = console }) {
  const run = () => sweepOnce({ pool, push, bumpTokenVersion })
    .then((r) => { if (r.withdrawn || r.resolved) logger.info?.(r, "[claims] sweep"); })
    .catch((err) => logger.warn?.({ err: err.message }, "[claims] sweep failed"));
  const first = setTimeout(run, 45 * 1000);
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ---------------------------------------------------------------------
// Listing for the /claims page
// ---------------------------------------------------------------------

async function listForUser(pool, user) {
  const isSys = !!user.is_system_admin;
  const isOrgAdmin = (user.org_roles || []).includes("org_admin");
  const r = await pool.query(
    `SELECT cl.*,
            CASE WHEN cl.target_kind = 'org' THEN o.name ELSE rg.name END AS target_name,
            rg.short_code AS region_code,
            o.name AS org_name, o.country_code,
            u.full_name AS claimant_name, u.email AS claimant_email, u.created_at AS claimant_since
       FROM claims cl
       JOIN organisations o ON o.id = cl.org_id
       LEFT JOIN regions rg ON cl.target_kind = 'region' AND rg.id = cl.target_id
       JOIN users u ON u.id = cl.claimant_id
      WHERE cl.status <> 'withdrawn'
        AND (
          $2::boolean
          OR cl.claimant_id = $1
          OR (cl.activated_at IS NOT NULL AND (
                EXISTS (SELECT 1 FROM claim_voters cv
                         WHERE cv.claim_id = cl.id
                           AND ((cv.voter_kind = 'club' AND EXISTS (
                                  SELECT 1 FROM club_admins ca WHERE ca.club_id = cv.voter_id AND ca.user_id = $1))
                             OR (cv.voter_kind = 'region' AND EXISTS (
                                  SELECT 1 FROM region_admins ra WHERE ra.region_id = cv.voter_id AND ra.user_id = $1))))
                OR (cl.approver = 'parent' AND $3::boolean AND cl.org_id = $4)))
        )
      ORDER BY (cl.status IN ('open', 'escalated')) DESC, cl.created_at DESC
      LIMIT 200`,
    [user.id, isSys, isOrgAdmin, user.org_id],
  );
  const out = [];
  for (const cl of r.rows) {
    const t = await tally(pool, cl.id);
    const mine = await voterEntitiesFor(pool, cl.id, user.id);
    const objections = (await pool.query(
      "SELECT reason FROM claim_votes WHERE claim_id = $1 AND vote = 'object'", [cl.id],
    )).rows.map((row) => row.reason);
    const live = cl.status === "open" && !!cl.activated_at;
    out.push({
      id: cl.id,
      target_kind: cl.target_kind,
      target_name: cl.target_name,
      region_code: cl.region_code,
      org_name: cl.org_name,
      country_code: cl.country_code,
      body_name: cl.body_name,
      website: cl.website,
      domain_verified: cl.domain_verified,
      claimant_name: cl.claimant_name,
      claimant_since: cl.claimant_since,
      approver: cl.approver,
      status: cl.status,
      status_reason: cl.status_reason,
      activated: !!cl.activated_at,
      closes_at: cl.closes_at,
      created_at: cl.created_at,
      tally: t,
      // Objection reasons go to whoever decides escalations.
      objections: isSys ? objections : [],
      mine: cl.claimant_id === user.id,
      my_votes: mine.map((v) => ({ voter_id: v.voter_id, name: v.name, vote: v.vote })),
      can_vote: live && ["clubs", "regions"].includes(cl.approver)
        && cl.claimant_id !== user.id && mine.some((v) => !v.vote),
      can_decide: (isSys && ["open", "escalated"].includes(cl.status))
        || (live && cl.approver === "parent" && isOrgAdmin && cl.org_id === user.org_id),
      can_revoke: isSys && cl.status === "approved",
    });
  }
  return out;
}

module.exports = {
  ClaimError,
  domainMatches,
  eligibleClubs,
  openClaim,
  activateForUser,
  castVote,
  decide,
  revoke,
  sweepOnce,
  start,
  listForUser,
};
