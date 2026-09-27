// Claims: a national federation taking over its country's account, or a
// state body taking over its region (migration 089, phase 3 of
// docs/club-first-onboarding.md §8).
//
// The whole lifecycle lives here so routes/claims.js, the register-org
// flow, email verification and the sweep all agree on the rules:
//
//   open      register-org finds the country (or region) the clubs started,
//             or starts it itself when nobody from there is on DivingHQ yet
//             (migration 093), and opens a claim instead of a second
//             account. The approver and the voters are fixed there and then.
//             A club or region whose admin looks like the claimant (same
//             address, or the same organisation's domain) doesn't get a
//             vote. A newer claim replaces one that was never verified.
//   activate  nothing is visible, and nobody's notified, until the
//             claimant verifies their email. That starts the clock. Only
//             one claim per target can be live; a later one is withdrawn.
//   vote      clubs (or claimed regions) vote. Any objection escalates to
//             the sysadmin; enough approvals (a majority, and at least
//             claim_quorum_min) passes it on the spot.
//   decide    a region claim under a federation is the federation's call;
//             the sysadmin can decide anything live, open or escalated.
//   sweep     hourly: an expired vote that didn't reach that bar goes to
//             the sysadmin, it never passes on the clock alone. Claims
//             nobody verified are withdrawn after a week.
//   revoke    the sysadmin can undo an approved claim at any time, which
//             also takes back what was handed out under it.
//
// Nothing is ever approved for a claimant who has since deleted their
// account (withdrawn) or been suspended (escalated instead).
//
// Every notice goes out in-app (push) and by email (sendClaimEmail), through
// lib/notices.js.

const settingsLib = require("./platform-settings");
const { recordAudit } = require("./audit");
const { countryByCode } = require("./countries");
const { liveAdminCount } = require("./admin-rows");
const { supportEmail, supportContact } = require("./support");
const notices = require("./notices");
const clubApprovals = require("./club-approvals");

const UNVERIFIED_TTL_DAYS = 7;

// status_reason text, shown as-is on /claims.
const REASON = {
  unverified: "The email address wasn't verified within a week.",
  superseded: "A newer claim on the same account replaced it before this one was verified.",
  beaten: "Another claim on the same account went live first.",
  taken: "It already has its body on DivingHQ.",
  claimantDeleted: "The claimant deleted their account.",
  claimantSuspended: "The claimant's account is suspended.",
  replaced: "Replaced by a newer approved claim on the same region.",
};

class ClaimError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// Is this voter really the claimant under another account?
// ---------------------------------------------------------------------

// Webmail and big ISPs: sharing one of these says nothing about who
// you are, so only the exact address counts there.
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.io", "fastmail.com", "hey.com",
  "zoho.com", "mail.com", "email.com", "gmx.com", "gmx.net", "gmx.de", "web.de", "t-online.de",
  "freenet.de", "yandex.ru", "yandex.com", "mail.ru", "rambler.ru", "bk.ru", "list.ru", "inbox.ru",
  "qq.com", "163.com", "126.com", "sina.com", "sohu.com", "naver.com", "daum.net", "hanmail.net",
  "libero.it", "virgilio.it", "tiscali.it", "orange.fr", "free.fr", "laposte.net", "sfr.fr",
  "wanadoo.fr", "seznam.cz", "centrum.cz", "wp.pl", "o2.pl", "onet.pl", "interia.pl",
  "rediffmail.com", "btinternet.com", "sky.com", "virginmedia.com", "bigpond.com", "optusnet.com.au",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "shaw.ca", "rogers.com",
  "sympatico.ca", "telus.net", "xtra.co.nz", "uol.com.br", "bol.com.br", "terra.com.br",
]);
// ...and their country editions (yahoo.co.uk, hotmail.fr, live.com.au).
const FREEMAIL_BRAND = /^(yahoo|ymail|hotmail|outlook|live|msn|gmx|yandex|aol)\.(com|net|org|co|[a-z]{2})(\.[a-z]{2})?$/;

function isFreemail(domain) {
  return FREEMAIL.has(domain) || FREEMAIL_BRAND.test(domain);
}

// One mailbox, one spelling: lower case, no +tag, and Gmail ignores dots
// (and answers to googlemail.com too).
function normaliseEmail(email) {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return null;
  let local = e.slice(0, at).split("+")[0];
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local ? `${local}@${domain}` : null;
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

// Same mailbox, or (off webmail) the same organisation's domain, either
// way round so diving.org.au and nsw.diving.org.au count as one. Every
// claimant is a brand new account, so the user id never matches; this is
// what actually stops a club admin voting their own second account in.
function sharesIdentity(emailA, emailB) {
  const a = normaliseEmail(emailA);
  const b = normaliseEmail(emailB);
  if (!a || !b) return false;
  if (a === b) return true;
  const da = a.split("@")[1];
  const db = b.split("@")[1];
  if (isFreemail(da) || isFreemail(db)) return false;
  return domainMatches(a, db) || domainMatches(b, da);
}

// ---------------------------------------------------------------------
// Who counts as a voter (§8.2), evaluated when the claim opens.
// ---------------------------------------------------------------------

// rows: { id, emails[], claimant_is_admin, can_vote } per club or region.
function splitVoters(rows, claimantEmail) {
  const ids = [];
  let excluded = 0;
  for (const row of rows) {
    if (!row.can_vote) continue;
    if (row.claimant_is_admin || (row.emails || []).some((e) => sharesIdentity(claimantEmail, e))) {
      excluded += 1;
      continue;
    }
    ids.push(row.id);
  }
  return { ids, excluded };
}

// Clubs old enough, active enough (a hosted meet or enough verified
// members), with a live admin to cast the vote, none of whom is (or looks
// like) the claimant. Deleted admins don't count for anything; suspended
// ones still count against the claimant but can't carry the vote.
//
// Only approved clubs (migration 096). A pending one only exists under a
// claimed federation, where there's nothing to claim, but this is the
// backstop if one ever turns up elsewhere. Age runs from approval, since
// a club that sat in a queue for months wasn't a club all that time.
async function eligibleClubs(db, { orgId, regionId, claimantId, claimantEmail, settings }) {
  const r = await db.query(
    `SELECT c.id,
            array_agg(u.email) FILTER (WHERE u.email IS NOT NULL) AS emails,
            bool_or(u.id = $5::uuid) AS claimant_is_admin,
            bool_or(u.suspended_at IS NULL) AS can_vote
       FROM clubs c
       JOIN club_admins ca ON ca.club_id = c.id
       JOIN users u ON u.id = ca.user_id AND u.deleted_at IS NULL
      WHERE c.org_id = $1
        AND c.status = 'active'
        AND ($2::uuid IS NULL OR c.region_id = $2)
        AND COALESCE(c.approved_at, c.created_at) <= now() - make_interval(days => $3::int)
        AND (
          EXISTS (SELECT 1 FROM meets m WHERE m.host_club_id = c.id)
          OR (SELECT count(*) FROM users mu
               WHERE mu.club_id = c.id AND mu.email_verified_at IS NOT NULL
                 AND mu.deleted_at IS NULL) >= $4
        )
      GROUP BY c.id`,
    [orgId, regionId || null, settings.claim_voter_min_age_days, settings.claim_voter_min_members, claimantId],
  );
  return splitVoters(r.rows, claimantEmail);
}

// Regions that are already claimed (a state body runs them), with the
// same admin rules as clubs. They vote on a national claim.
async function eligibleRegions(db, { orgId, claimantId, claimantEmail }) {
  const r = await db.query(
    `SELECT rg.id,
            array_agg(u.email) FILTER (WHERE u.email IS NOT NULL) AS emails,
            bool_or(u.id = $2::uuid) AS claimant_is_admin,
            bool_or(u.suspended_at IS NULL) AS can_vote
       FROM regions rg
       JOIN region_admins ra ON ra.region_id = rg.id
       JOIN users u ON u.id = ra.user_id AND u.deleted_at IS NULL
      WHERE rg.org_id = $1 AND rg.claim_state = 'claimed'
      GROUP BY rg.id`,
    [orgId, claimantId],
  );
  return splitVoters(r.rows, claimantEmail);
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

// Live users only, out of whatever id list a query produced.
async function liveOnly(db, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const r = await db.query(
    "SELECT id FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [unique],
  );
  return r.rows.map((row) => row.id);
}

// The admins of the clubs / regions that have a vote on this claim.
async function voterAdminIds(db, claim) {
  const r = await db.query(
    `SELECT ca.user_id FROM claim_voters cv
       JOIN club_admins ca ON ca.club_id = cv.voter_id
      WHERE cv.claim_id = $1 AND cv.voter_kind = 'club'
     UNION
     SELECT ra.user_id FROM claim_voters cv
       JOIN region_admins ra ON ra.region_id = cv.voter_id
      WHERE cv.claim_id = $1 AND cv.voter_kind = 'region'`,
    [claim.id],
  );
  return liveOnly(db, r.rows.map((row) => row.user_id));
}

async function orgAdminIds(db, orgId) {
  const r = await db.query(
    "SELECT user_id FROM user_org_roles WHERE org_id = $1 AND role = 'org_admin'", [orgId],
  );
  return liveOnly(db, r.rows.map((row) => row.user_id));
}

// Who has to act on a live claim: the voters' admins, the parent org's
// admins, or the sysadmins.
async function actorIds(db, claim) {
  if (claim.approver === "clubs" || claim.approver === "regions") return voterAdminIds(db, claim);
  if (claim.approver === "parent") return orgAdminIds(db, claim.org_id);
  return sysadminIds(db);
}

// Everyone with a stake once it's decided (not counting the claimant):
// whoever had a vote, plus for a national claim every club and region
// admin in the country, and for a region claim its clubs' admins, its
// own admins and the federation above it, if there is one.
async function outcomeAudience(db, claim) {
  const r = claim.target_kind === "org"
    ? await db.query(
        `SELECT user_id FROM club_admins WHERE org_id = $1
         UNION SELECT user_id FROM region_admins WHERE org_id = $1`,
        [claim.target_id],
      )
    : await db.query(
        `SELECT ca.user_id FROM club_admins ca JOIN clubs c ON c.id = ca.club_id WHERE c.region_id = $1
         UNION SELECT user_id FROM region_admins WHERE region_id = $1
         UNION SELECT user_id FROM user_org_roles WHERE org_id = $2 AND role = 'org_admin'`,
        [claim.target_id, claim.org_id],
      );
  const ids = await liveOnly(db, [...r.rows.map((row) => row.user_id), ...await voterAdminIds(db, claim)]);
  return ids.filter((id) => id !== claim.claimant_id);
}

// Readable date for emails: "11 October 2026".
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
}

// "Samoa", or "Ontario (Canada)" for a region, for sentences.
async function describeTarget(db, claim) {
  const name = await targetName(db, claim);
  if (claim.target_kind === "org") return name;
  const org = (await db.query("SELECT name FROM organisations WHERE id = $1", [claim.org_id])).rows[0];
  return org ? `${name} (${org.name})` : name;
}

// Each notice goes out in-app and by email, to the same people, through
// lib/notices (shared with club approvals). A note is { userIds, category,
// title, body, email: { subject, body } }, and every one links to /claims.
//
// Claim mail keeps its own wording ("See the claim on DivingHQ"), so it
// goes through sendClaimEmail rather than the generic sendNoticeEmail.
// Plenty of callers (and the tests) only ever hand over sendClaimEmail.
function notify({ push, email } = {}, notes) {
  const mail = email && typeof email.sendClaimEmail === "function"
    ? { sendNoticeEmail: (ids, { subject, body }) => email.sendClaimEmail(ids, { subject, body }) }
    : email;
  return notices.deliver({ push, email: mail }, notes, { path: "/claims", tag: "claims notify" });
}

// A function, not a constant: the support address is read from the env on
// every call (lib/support.js).
const talkItThrough = () => `Reply to this email, or write to ${supportEmail()}, if you'd like to talk it through.`;

// ---------------------------------------------------------------------
// Small state changes shared by several paths
// ---------------------------------------------------------------------

async function targetIsClaimed(db, claim) {
  const table = claim.target_kind === "org" ? "organisations" : "regions";
  const r = await db.query(`SELECT claim_state FROM ${table} WHERE id = $1`, [claim.target_id]);
  if (r.rows[0]?.claim_state !== "claimed") return false;
  // A claimed region with nobody left running it is open to a fresh
  // claim (register-org lets one through), so don't bin that claim here.
  if (claim.target_kind === "region") return (await liveAdminCount(db, "region", claim.target_id)) > 0;
  return true;
}

// Take a claim off the table. The claimant hears why, unless they're the
// reason it's gone. If it had gone live, whoever was asked to act on it
// hears too, so it doesn't just vanish from their list.
async function withdraw(client, claim, reason, { actorId = null } = {}) {
  await client.query(
    "UPDATE claims SET status = 'withdrawn', status_reason = $2 WHERE id = $1",
    [claim.id, reason],
  );
  await recordAudit(client, {
    org_id: claim.org_id, actor_id: actorId, entity_type: "claim", entity_id: claim.id,
    entity_name: claim.body_name, action: "claim.withdrawn", metadata: { reason },
  });
  const target = await describeTarget(client, claim);
  const notes = [];
  if (reason !== REASON.claimantDeleted) {
    notes.push({
      userIds: [claim.claimant_id],
      category: "claim_decided",
      title: `Your claim on ${target} was withdrawn`,
      body: reason,
      data: { claim_id: claim.id },
      email: {
        subject: `Your claim on ${target} was withdrawn`,
        body: `Your claim as ${claim.body_name} on ${target} has been withdrawn. ${reason}\n\n${talkItThrough()}`,
      },
    });
  }
  if (claim.activated_at) {
    const involved = (await actorIds(client, claim)).filter((id) => id !== claim.claimant_id);
    notes.push({
      userIds: involved,
      category: "claim_decided",
      title: `${claim.body_name}'s claim on ${target} was withdrawn`,
      body: `${reason} There's nothing more for you to do.`,
      data: { claim_id: claim.id },
      email: {
        subject: `${claim.body_name}'s claim on ${target} was withdrawn`,
        body: `${claim.body_name}'s claim on ${target} has been withdrawn, so there's nothing more for you to do. ${reason}`,
      },
    });
  }
  return notes;
}

// Never-verified claims on the same target stop mattering once another
// one is approved: withdraw them before one of them tries to go live on
// an account that's already claimed.
async function withdrawPending(client, claim, reason) {
  const r = await client.query(
    `SELECT * FROM claims
      WHERE target_kind = $1 AND target_id = $2 AND id <> $3
        AND status = 'open' AND activated_at IS NULL
      FOR UPDATE`,
    [claim.target_kind, claim.target_id, claim.id],
  );
  const notes = [];
  for (const other of r.rows) notes.push(...await withdraw(client, other, reason));
  return notes;
}

// ---------------------------------------------------------------------
// Open (§8.1)
// ---------------------------------------------------------------------

// Runs inside register-org's transaction. The returned row carries
// .notices (for claims this one replaced), to hand to deliver() once
// that transaction has committed.
async function openClaim(client, { targetKind, targetId, orgId, claimantId, claimantEmail, bodyName, website }) {
  // A live claim gets decided first. Unverified ones don't hold anything.
  const live = await client.query(
    `SELECT 1 FROM claims
      WHERE target_kind = $1 AND target_id = $2
        AND status IN ('open', 'escalated') AND activated_at IS NOT NULL`,
    [targetKind, targetId],
  );
  if (live.rows.length) {
    throw new ClaimError(409, `Someone has already claimed this and it's being decided. If that's wrong, contact ${supportContact()}.`, "claim_in_progress");
  }

  const settings = await settingsLib.getAll(client);
  let approver = "sysadmin";
  let voters = [];
  let excluded = 0;
  const who = { claimantId, claimantEmail, settings };

  if (targetKind === "region") {
    const org = await client.query("SELECT claim_state FROM organisations WHERE id = $1", [orgId]);
    if (org.rows[0]?.claim_state === "claimed") {
      approver = "parent";
    } else {
      const clubs = await eligibleClubs(client, { ...who, orgId, regionId: targetId });
      excluded = clubs.excluded;
      if (clubs.ids.length >= settings.claim_quorum_min) {
        approver = "clubs";
        voters = clubs.ids.map((id) => ({ kind: "club", id }));
      }
    }
  } else {
    const regions = await eligibleRegions(client, { ...who, orgId });
    if (regions.ids.length >= settings.claim_quorum_min) {
      approver = "regions";
      excluded = regions.excluded;
      voters = regions.ids.map((id) => ({ kind: "region", id }));
    } else {
      const clubs = await eligibleClubs(client, { ...who, orgId, regionId: null });
      excluded = clubs.excluded;
      if (clubs.ids.length >= settings.claim_quorum_min) {
        approver = "clubs";
        voters = clubs.ids.map((id) => ({ kind: "club", id }));
      }
    }
  }

  // A claim nobody verified (a typo'd address, or one sent to block the
  // target) gives way to the newest. Its claimant is told, in case the
  // newer one isn't theirs.
  const stale = await client.query(
    `SELECT * FROM claims
      WHERE target_kind = $1 AND target_id = $2 AND status = 'open' AND activated_at IS NULL
      FOR UPDATE`,
    [targetKind, targetId],
  );
  const notices = [];
  for (const old of stale.rows) notices.push(...await withdraw(client, old, REASON.superseded));

  const claim = (await client.query(
    `INSERT INTO claims (target_kind, target_id, org_id, claimant_id, body_name, website, domain_verified, approver)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [targetKind, targetId, orgId, claimantId, bodyName, website || null,
     domainMatches(claimantEmail, website), approver],
  )).rows[0];
  for (const v of voters) {
    await client.query(
      "INSERT INTO claim_voters (claim_id, voter_kind, voter_id) VALUES ($1, $2, $3)",
      [claim.id, v.kind, v.id],
    );
  }
  await recordAudit(client, {
    org_id: orgId, actor_id: claimantId, entity_type: "claim", entity_id: claim.id,
    entity_name: bodyName, action: "claim.opened",
    metadata: {
      target_kind: targetKind, target_id: targetId, approver, voters: voters.length,
      excluded_voters: excluded, replaced: stale.rows.map((r) => r.id),
    },
  });
  claim.notices = notices;
  return claim;
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

// §8.3: more than claim_majority of the voters, and never fewer than
// claim_quorum_min. The same bar on the spot and when voting closes, so
// one approval and a quiet fortnight can't hand anyone a country.
function passes(t, settings) {
  return t.objections === 0
    && t.approvals >= settings.claim_quorum_min
    && t.approvals > settings.claim_majority * t.eligible;
}

// The smallest number of approvals that passes, for the emails.
function approvalsNeeded(eligible, settings) {
  return Math.max(settings.claim_quorum_min, Math.floor(settings.claim_majority * eligible) + 1);
}

// Is the claimant still someone we'd hand an account to?
async function claimantHold(db, claim) {
  const u = (await db.query(
    "SELECT deleted_at, suspended_at FROM users WHERE id = $1", [claim.claimant_id],
  )).rows[0];
  if (!u || u.deleted_at) return "deleted";
  if (u.suspended_at) return "suspended";
  return null;
}

// Make it so. Runs inside the caller's transaction; notifications are
// handed back to send after COMMIT. decidedBy is 'votes', 'parent' or
// 'sysadmin', for the wording.
async function applyApproval(client, claim, { deciderId, decidedBy, bumpTokenVersion }) {
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
    const before = (await client.query(
      "SELECT claim_state FROM regions WHERE id = $1 FOR UPDATE", [claim.target_id],
    )).rows[0];
    // A claimed region whose admins have all gone can be claimed again
    // (register-org lets that through). The old claim can't stay
    // 'approved' next to this one: it'd still offer a Revoke, and
    // revoking it would unwind this one too, since the new claimant's
    // row is one of "the rows made since that approval".
    const replaced = (await client.query(
      `UPDATE claims SET status = 'revoked', status_reason = $3, decided_at = now(), decided_by = $4
        WHERE target_kind = 'region' AND target_id = $1 AND status = 'approved' AND id <> $2
        RETURNING id, body_name`,
      [claim.target_id, claim.id, REASON.replaced, deciderId || null],
    )).rows;
    // Every old admin row is dead (that's what let this claim in). Clear
    // them, or reactivating one of those accounts later would hand it a
    // region somebody else runs now.
    const stale = before?.claim_state === "claimed" ? (await client.query(
      `DELETE FROM region_admins ra USING users u
        WHERE u.id = ra.user_id AND ra.region_id = $1
          AND (u.deleted_at IS NOT NULL OR u.suspended_at IS NOT NULL)
        RETURNING ra.user_id`,
      [claim.target_id],
    )).rows.map((r) => r.user_id) : [];
    for (const old of replaced) {
      await recordAudit(client, {
        org_id: claim.org_id, actor_id: deciderId || null, entity_type: "claim", entity_id: old.id,
        entity_name: old.body_name, action: "claim.revoked",
        metadata: { reason: REASON.replaced, replaced_by: claim.id, removed: { region_admins: stale } },
      });
    }
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
    metadata: { target_kind: claim.target_kind, target_id: claim.target_id, approver: claim.approver, decided_by: decidedBy },
  });
  const leftovers = await withdrawPending(client, claim, REASON.taken);

  const target = await describeTarget(client, claim);
  const others = (await outcomeAudience(client, claim)).filter((id) => id !== deciderId);
  const how = {
    votes: claim.approver === "regions" ? "The states and provinces voted it through." : "The clubs voted it through.",
    parent: "The federation approved it.",
    sysadmin: "DivingHQ approved it.",
  }[decidedBy] || "";
  // Under a federation, role requests stay with the federation
  // (lib/role-requests only lets a region review them while the country
  // is unclaimed), so don't promise the state body more than it gets.
  let what = "Role requests and club admins are theirs to manage from here.";
  if (claim.target_kind === "region") {
    const org = (await client.query(
      "SELECT name, claim_state FROM organisations WHERE id = $1", [claim.org_id],
    )).rows[0];
    what = org?.claim_state === "claimed"
      ? `They can now run the state's meets. Role requests from its clubs still go to ${org.name}.`
      : "They can now run the state's meets and review role requests from its clubs.";
  }
  return [{
    userIds: [claim.claimant_id],
    category: "claim_decided",
    title: `Your claim on ${target} was approved`,
    body: "Sign in again to pick up your new access.",
    data: { claim_id: claim.id },
    email: {
      subject: `Your claim on ${target} was approved`,
      body: `${claim.body_name} now runs ${target} on DivingHQ. ${how} Sign out and back in to pick up your new `
        + (claim.target_kind === "org" ? "federation admin access" : "state admin access")
        + ". Everyone affected has been told."
        // From here on the country's new clubs wait for them (migration
        // 096), which is news to someone who's only ever seen clubs join
        // by themselves.
        + (claim.target_kind === "org"
          ? "\n\nNew clubs that sign up from now on wait for your approval on the Clubs page. If you'd rather "
            + "they joined straight away, switch \"New clubs from signup\" to join automatically there. "
            + "The clubs already on DivingHQ stay as they are."
          : ""),
    },
  }, {
    userIds: others,
    category: "claim_decided",
    title: `${claim.body_name} now runs ${target}`,
    body: `${how} If this looks wrong, contact ${supportContact()}.`,
    data: { claim_id: claim.id },
    email: {
      subject: `${claim.body_name} now runs ${target} on DivingHQ`,
      body: `${claim.body_name}'s claim on ${target} has been approved, so they now run it on DivingHQ. ${how} ${what}`
        + `\n\nIf this looks wrong, reply to this email or contact ${supportContact()}.`,
    },
  }, ...leftovers];
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
  const target = await describeTarget(client, claim);
  const objections = (await client.query(
    "SELECT reason FROM claim_votes WHERE claim_id = $1 AND vote = 'object' AND reason IS NOT NULL",
    [claim.id],
  )).rows.map((r) => `  - "${r.reason}"`);
  const sys = await sysadminIds(client);
  // Voters (or the federation) who were asked to act: it's off their plate
  // now, and a vote from here on would only get a bare 409.
  const involved = (await actorIds(client, claim))
    .filter((id) => id !== claim.claimant_id && !sys.includes(id));
  return [{
    userIds: sys,
    category: "claim_review",
    title: `Claim by ${claim.body_name} needs a decision`,
    body: reason,
    data: { claim_id: claim.id },
    email: {
      subject: `Claim needs a decision: ${claim.body_name} on ${target}`,
      body: `${claim.body_name}'s claim on ${target} has come to you: ${reason}`
        + (objections.length ? `\n\nObjections:\n${objections.join("\n")}` : ""),
    },
  }, {
    userIds: [claim.claimant_id],
    category: "claim_decided",
    title: `Your claim on ${target} has gone to DivingHQ`,
    body: `${reason} DivingHQ decides it from here.`,
    data: { claim_id: claim.id },
    email: {
      subject: `Your claim on ${target} has gone to DivingHQ`,
      body: `Your claim as ${claim.body_name} on ${target} has gone to DivingHQ to decide. ${reason}`
        + "\n\nWe'll email you when it's decided.",
    },
  }, {
    userIds: involved,
    category: "claim_decided",
    title: `${claim.body_name}'s claim on ${target} has gone to DivingHQ`,
    body: `${reason} There's nothing more for you to do; you'll hear when it's decided.`,
    data: { claim_id: claim.id },
    email: {
      subject: `${claim.body_name}'s claim on ${target} has gone to DivingHQ`,
      body: `${claim.body_name}'s claim on ${target} has gone to DivingHQ to decide. ${reason}`
        + "\n\nThere's nothing more for you to do. You'll hear when it's decided.",
    },
  }];
}

// Approve, unless the claimant has gone (withdraw) or been suspended
// (escalate) since the claim opened. The vote and sweep paths; decide()
// makes the same checks itself so it can tell the decider.
async function approveUnlessHeld(client, claim, opts) {
  const hold = await claimantHold(client, claim);
  if (hold === "deleted") return withdraw(client, claim, REASON.claimantDeleted);
  if (hold === "suspended") return escalate(client, claim, REASON.claimantSuspended);
  return applyApproval(client, claim, opts);
}

// After a vote: does it resolve now (§8.3)?
async function evaluate(client, claim, settings, deps) {
  const t = await tally(client, claim.id);
  if (t.objections > 0) {
    return escalate(client, claim, "A voter objected.");
  }
  if (passes(t, settings)) {
    return approveUnlessHeld(client, claim, { deciderId: null, decidedBy: "votes", ...deps });
  }
  return null;
}

// ---------------------------------------------------------------------
// Activate: the claimant verified their email.
// ---------------------------------------------------------------------

async function activationNotes(db, claim, settings) {
  const target = await describeTarget(db, claim);
  const claimant = (await db.query("SELECT full_name FROM users WHERE id = $1", [claim.claimant_id])).rows[0];
  const voting = claim.approver === "clubs" || claim.approver === "regions";
  const closes = fmtDate(claim.closes_at);
  const eligible = voting ? (await tally(db, claim.id)).eligible : 0;
  const voterNoun = claim.approver === "clubs" ? "clubs" : "states and provinces";
  const site = claim.website
    ? `Their website: ${claim.website} (${claim.domain_verified
        ? "the claimant's email address is on the same domain"
        : "the claimant's email address isn't on that domain, which isn't unusual but worth a look"}).`
    : "They didn't give a website.";
  const who = `${claimant?.full_name || "Someone"} has asked for ${claim.body_name} to take over ${target} on DivingHQ.`;
  // The sysadmin is the last stop, so their copy mustn't say "if nobody
  // decides, it goes to DivingHQ".
  let actor;
  if (voting) {
    actor = {
      body: "Your vote decides whether they take over. Objecting sends it to DivingHQ to review.",
      email: `${who}\n\n${site}\n\n`
        + `Your ${claim.approver === "clubs" ? "club" : "state"} has a vote. Approve if they are who they say they are; `
        + "object if not, and say why, and DivingHQ will review it.\n\n"
        + `Voting closes on ${closes}. It passes as soon as ${approvalsNeeded(eligible, settings)} of the ${eligible} `
        + `${voterNoun} approve. If anyone objects, or voting closes short of that, DivingHQ decides.`,
    };
  } else if (claim.approver === "parent") {
    actor = {
      body: `They're waiting on your decision. If nobody decides by ${closes}, it goes to DivingHQ.`,
      email: `${who}\n\n${site}\n\nIt's waiting on your decision. If nobody decides by ${closes}, it goes to DivingHQ.`,
    };
  } else {
    actor = {
      body: "Too few established clubs or states to vote on it, so it's yours to decide.",
      email: `${who}\n\n${site}\n\nThere aren't enough established clubs or states there to vote on it, so it's yours to decide.`,
    };
  }
  return [{
    userIds: await actorIds(db, claim),
    category: voting ? "claim_vote" : "claim_review",
    title: `${claim.body_name} wants to run ${target}`,
    body: actor.body,
    data: { claim_id: claim.id },
    email: {
      subject: `${claim.body_name} wants to run ${target} on DivingHQ`,
      body: actor.email,
    },
  }, {
    // The claimant hears the clock has started. claim_decided is the
    // informational category ("Claim" in the inbox).
    userIds: [claim.claimant_id],
    category: "claim_decided",
    title: `Your claim on ${target} is open`,
    body: {
      clubs: `The clubs vote until ${closes}.`,
      regions: `The states and provinces vote until ${closes}.`,
      parent: `The federation decides, by ${closes}.`,
      sysadmin: "DivingHQ reviews it.",
    }[claim.approver],
    data: { claim_id: claim.id },
    email: {
      subject: `Your claim on ${target} is open`,
      body: {
        clubs: `The clubs on DivingHQ in ${target} now vote on it, until ${closes}. If any of them object, or not enough approve, DivingHQ reviews it.`,
        regions: `The states and provinces on DivingHQ now vote on it, until ${closes}. If any of them object, or not enough approve, DivingHQ reviews it.`,
        parent: `The federation that runs this country on DivingHQ decides it. If they haven't by ${closes}, DivingHQ does.`,
        sysadmin: "There aren't enough established clubs there to vote yet, so DivingHQ reviews it.",
      }[claim.approver] + "\n\nWe'll email you when it's decided.",
    },
  }];
}

// Returns how many of the user's claims went live. Each claim gets its
// own transaction: the claims_one_live index is what settles two claims
// on one target verifying at the same moment, and the loser is withdrawn
// (and told) rather than failing the verification.
async function activateForUser(pool, userId, deps = {}) {
  const settings = await settingsLib.getAll(pool);
  const pending = await pool.query(
    "SELECT id FROM claims WHERE claimant_id = $1 AND status = 'open' AND activated_at IS NULL",
    [userId],
  );
  let opened = 0;
  for (const { id } of pending.rows) {
    const out = await withTx(pool, async (client) => {
      const claim = await lockClaim(client, id);
      if (claim.status !== "open" || claim.activated_at) return { notes: null };
      if (await targetIsClaimed(client, claim)) return { notes: await withdraw(client, claim, REASON.taken) };
      await client.query("SAVEPOINT claim_activate");
      let live;
      try {
        live = (await client.query(
          `UPDATE claims
              SET activated_at = now(),
                  closes_at = now() + make_interval(days => $2::int)
            WHERE id = $1
            RETURNING *`,
          [claim.id, settings.claim_timeout_days],
        )).rows[0];
      } catch (err) {
        if (err.constraint !== "claims_one_live") throw err;
        await client.query("ROLLBACK TO SAVEPOINT claim_activate");
        return { notes: await withdraw(client, claim, REASON.beaten) };
      }
      return { live: true, notes: await activationNotes(client, live, settings) };
    });
    if (out.live) opened += 1;
    await notify(deps, out.notes);
  }
  return opened;
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

async function castVote(pool, { claimId, user, vote, reason, voterId }, deps = {}) {
  const { bumpTokenVersion } = deps;
  if (!["approve", "object"].includes(vote)) throw new ClaimError(400, "vote must be 'approve' or 'object'");
  const cleanReason = typeof reason === "string" ? reason.trim().slice(0, 1000) : null;
  if (vote === "object" && !cleanReason) {
    throw new ClaimError(400, "Say why you object, it goes to DivingHQ with the claim");
  }
  const notes = await withTx(pool, async (client) => {
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
    // The voter list was checked when the claim opened, but an admin can be
    // added to a voting club afterwards. Same test, at the moment it counts.
    // Only after the has-a-vote check, or anyone with a claim id could
    // poke at it to learn what the claimant's address looks like.
    const emails = (await client.query(
      "SELECT id, email FROM users WHERE id = ANY($1::uuid[])", [[claim.claimant_id, user.id]],
    )).rows;
    const claimantEmail = emails.find((u) => u.id === claim.claimant_id)?.email;
    const voterEmail = emails.find((u) => u.id === user.id)?.email;
    if (sharesIdentity(claimantEmail, voterEmail)) {
      throw new ClaimError(403, "Your email address matches the claimant's, so you can't vote on this claim");
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
  await notify(deps, notes);
  return (await pool.query("SELECT status FROM claims WHERE id = $1", [claimId])).rows[0].status;
}

// Approve or reject a live claim: the sysadmin (open or escalated), or
// the parent org's admin for a region claim under a federation.
async function decide(pool, { claimId, user, decision, reason }, deps = {}) {
  const { bumpTokenVersion } = deps;
  if (!["approve", "reject"].includes(decision)) throw new ClaimError(400, "decision must be 'approve' or 'reject'");
  const out = await withTx(pool, async (client) => {
    const claim = await lockClaim(client, claimId);
    const isSys = !!user.is_system_admin;
    // The claimant's account sits in the federation's org, so it could be
    // handed org_admin there; it still doesn't get to wave its own claim
    // through, same as a vote.
    const isParent = claim.approver === "parent" && claim.status === "open"
      && user.org_id === claim.org_id && (user.org_roles || []).includes("org_admin")
      && claim.claimant_id !== user.id;
    if (!isSys && !isParent) throw new ClaimError(403, "You can't decide this claim");
    if (!["open", "escalated"].includes(claim.status)) throw new ClaimError(409, "This claim has already been decided");
    // Until the claimant proves the inbox, nobody knows the claim is
    // really from that body. The page hides these; the API has to agree.
    if (!claim.activated_at) {
      throw new ClaimError(409, "This claim isn't live yet: the claimant hasn't verified their email address.", "claim_not_live");
    }
    if (decision === "approve") {
      const hold = await claimantHold(client, claim);
      if (hold === "deleted") {
        return {
          notes: await withdraw(client, claim, REASON.claimantDeleted, { actorId: user.id }),
          error: new ClaimError(409, "The claimant has deleted their account, so the claim has been withdrawn.", "claimant_gone"),
        };
      }
      if (hold === "suspended") {
        if (isSys) {
          throw new ClaimError(409, "The claimant's account is suspended. Lift the suspension before approving, or reject the claim.", "claimant_suspended");
        }
        return {
          notes: await escalate(client, claim, REASON.claimantSuspended),
          error: new ClaimError(409, "The claimant's account is suspended, so the claim has gone to DivingHQ to decide.", "claimant_suspended"),
        };
      }
      return {
        notes: await applyApproval(client, claim, {
          deciderId: user.id, decidedBy: isSys ? "sysadmin" : "parent", bumpTokenVersion,
        }),
      };
    }
    const cleanReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 1000) : null;
    await client.query(
      "UPDATE claims SET status = 'rejected', status_reason = $2, decided_at = now(), decided_by = $3 WHERE id = $1",
      [claim.id, cleanReason, user.id],
    );
    await recordAudit(client, {
      org_id: claim.org_id, actor_id: user.id, entity_type: "claim", entity_id: claim.id,
      entity_name: claim.body_name, action: "claim.rejected", metadata: { reason: cleanReason },
    });
    const target = await describeTarget(client, claim);
    const others = (await outcomeAudience(client, claim)).filter((id) => id !== user.id);
    return {
      notes: [{
        userIds: [claim.claimant_id],
        category: "claim_decided",
        title: `Your claim on ${target} wasn't approved`,
        body: cleanReason || `Contact ${supportContact()} if you'd like to talk it through.`,
        data: { claim_id: claim.id },
        email: {
          subject: `Your claim on ${target} wasn't approved`,
          body: `Your claim as ${claim.body_name} on ${target} wasn't approved.`
            + (cleanReason ? `\n\nThe reason given: ${cleanReason}` : "")
            + `\n\n${talkItThrough()}`,
        },
      }, {
        // The reason stays between the decider and the claimant.
        userIds: others,
        category: "claim_decided",
        title: `${claim.body_name}'s claim on ${target} wasn't approved`,
        body: `${isSys ? "DivingHQ" : "The federation"} turned it down, so nothing changes.`,
        data: { claim_id: claim.id },
        email: {
          subject: `${claim.body_name}'s claim on ${target} wasn't approved`,
          body: `${isSys ? "DivingHQ" : "The federation"} turned down ${claim.body_name}'s claim on ${target}, `
            + "so nothing changes there on DivingHQ.",
        },
      }],
    };
  });
  await notify(deps, out.notes);
  if (out.error) throw out.error;
}

// A national claim, undone. The phase 1 rule is that an unclaimed
// country has no org_admin and no org-wide meet_manager, so every one of
// those goes, not just the claimant's: while they ran it the claimant
// could hand both out to anyone. Referees they appointed go too (see
// below for why). Club and region admin rows added since
// the approval go too (under a federation only its admins, or DivingHQ,
// can add those), and so do region claims the federation itself approved
// and the event manager seats its people handed out.
//
// Except a founder running their own club. The federation made them its
// admin when it approved the club (lib/club-approvals.js), and in an
// unclaimed country they'd have been its admin from day one, so taking it
// back would leave the club with nobody. Clubs still waiting on the
// federation join now, the same way.
async function unwindOrgClaim(client, claim, user) {
  const orgId = claim.target_id;
  const since = claim.decided_at;
  const org = (await client.query("SELECT country_code FROM organisations WHERE id = $1", [orgId])).rows[0];
  await client.query(
    `UPDATE organisations SET claim_state = 'unclaimed', claimed_at = NULL,
            name = COALESCE($2, name) WHERE id = $1`,
    [orgId, countryByCode(org?.country_code)?.name || null],
  );

  const roles = (await client.query(
    `DELETE FROM user_org_roles r USING users u
      WHERE u.id = r.user_id AND r.org_id = $1 AND r.role IN ('org_admin', 'meet_manager')
      RETURNING r.user_id, u.full_name, r.role::text AS role`,
    [orgId],
  )).rows;
  // Referee reaches every meet in the org too (socketCanManageEvent and
  // the Control Room only check the org), which is why lib/role-requests
  // sends referee asks to DivingHQ while a country is unclaimed. So the
  // ones handed out while the claim stood go as well, plus the
  // claimant's own. A sysadmin's grant stays. PUT /roles restamps
  // granted_at on every edit, so a pre-claim referee the federation
  // touched gets caught here too; they're listed for re-granting.
  // Holders for the seat sweep further down are taken before this: a
  // seat some club admin (who keeps their job) gave a referee is fine.
  const seatHolders = roles.map((r) => r.user_id);
  const referees = (await client.query(
    `DELETE FROM user_org_roles r USING users u
      WHERE u.id = r.user_id AND r.org_id = $1 AND r.role = 'referee'
        AND (r.user_id = $2 OR (r.granted_at >= $3 AND NOT EXISTS (
              SELECT 1 FROM users g WHERE g.id = r.granted_by AND g.is_system_admin)))
      RETURNING r.user_id, u.full_name, r.role::text AS role`,
    [orgId, claim.claimant_id, since],
  )).rows;
  roles.push(...referees);
  // Nobody's left with no role at all in their own org.
  await client.query(
    `INSERT INTO user_org_roles (user_id, org_id, role)
     SELECT u.id, $1, 'spectator' FROM users u
      WHERE u.id = ANY($2::uuid[]) AND u.org_id = $1 AND u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM user_org_roles r WHERE r.user_id = u.id AND r.org_id = $1)
     ON CONFLICT DO NOTHING`,
    [orgId, roles.map((r) => r.user_id)],
  );

  // Region claims decided by the federation's admins (approver 'parent')
  // since it took over. One DivingHQ decided, or the clubs voted in,
  // stands on its own.
  const regionClaims = (await client.query(
    `SELECT cl.* FROM claims cl
      WHERE cl.org_id = $1 AND cl.target_kind = 'region' AND cl.status = 'approved'
        AND cl.approver = 'parent' AND cl.decided_at >= $2
        AND NOT EXISTS (SELECT 1 FROM users su WHERE su.id = cl.decided_by AND su.is_system_admin)
      FOR UPDATE`,
    [orgId, since],
  )).rows;
  const cascade = [];
  for (const rc of regionClaims) {
    const why = `Revoked along with ${claim.body_name}'s claim on the country, which approved it.`;
    await client.query(
      "UPDATE regions SET claim_state = 'unclaimed', claimed_at = NULL, claimed_name = NULL WHERE id = $1",
      [rc.target_id],
    );
    await client.query(
      "UPDATE claims SET status = 'revoked', status_reason = $2, decided_at = now(), decided_by = $3 WHERE id = $1",
      [rc.id, why, user.id],
    );
    await recordAudit(client, {
      org_id: rc.org_id, actor_id: user.id, entity_type: "claim", entity_id: rc.id,
      entity_name: rc.body_name, action: "claim.revoked", metadata: { reason: why, with_claim: claim.id },
    });
    cascade.push(rc);
  }

  // Region claims still waiting on the federation would wait on nobody
  // now. Straight to DivingHQ instead of sitting out the clock.
  const orphans = (await client.query(
    `SELECT * FROM claims
      WHERE org_id = $1 AND target_kind = 'region' AND approver = 'parent'
        AND status = 'open' AND activated_at IS NOT NULL
      FOR UPDATE`,
    [orgId],
  )).rows;
  const notes = [];
  for (const oc of orphans) {
    notes.push(...await escalate(client, oc, "The federation that was to decide it no longer runs the country."));
  }

  // Still-approved region claims keep their claimant's row, whenever
  // it was made.
  const regionAdmins = (await client.query(
    `DELETE FROM region_admins ra USING regions rg, users u
      WHERE rg.id = ra.region_id AND u.id = ra.user_id
        AND ra.org_id = $1 AND ra.created_at >= $2
        AND NOT EXISTS (
          SELECT 1 FROM claims kept
           WHERE kept.target_kind = 'region' AND kept.target_id = ra.region_id
             AND kept.claimant_id = ra.user_id AND kept.status = 'approved')
      RETURNING ra.region_id, rg.name AS region_name, ra.user_id, u.full_name`,
    [orgId, since],
  )).rows;
  const clubAdmins = (await client.query(
    `DELETE FROM club_admins ca USING clubs c, users u
      WHERE c.id = ca.club_id AND u.id = ca.user_id
        AND ca.org_id = $1 AND ca.created_at >= $2
        AND ca.user_id IS DISTINCT FROM c.created_by
      RETURNING ca.club_id, c.name AS club_name, ca.user_id, u.full_name`,
    [orgId, since],
  )).rows;
  // After the delete above, so a founder added here isn't taken straight back.
  const activated = await clubApprovals.activateAllPending(client, orgId, { actorId: user.id });

  // Region claims opened under the federation but not verified yet would
  // go live waiting on it. DivingHQ decides those instead.
  const rerouted = (await client.query(
    `UPDATE claims SET approver = 'sysadmin'
      WHERE org_id = $1 AND target_kind = 'region' AND approver = 'parent'
        AND status = 'open' AND activated_at IS NULL
      RETURNING id`,
    [orgId],
  )).rows.map((r) => r.id);

  // Seats the org admins handed out (to themselves too), or that the
  // people losing a role were holding. Someone who only lost
  // meet_manager could only ever seat themselves, on events they made.
  const grantors = [
    claim.claimant_id,
    ...roles.filter((r) => r.role === "org_admin").map((r) => r.user_id),
    ...clubAdmins.map((r) => r.user_id),
    ...regionAdmins.map((r) => r.user_id),
  ];
  const eventManagers = await dropEventSeats(client, orgId, since, {
    grantors, holders: [...grantors, ...seatHolders],
  });
  return {
    roles, regionAdmins, clubAdmins, eventManagers, cascade, escalated: orphans, rerouted, notes,
    activatedClubs: activated.clubs, clubNotes: activated.notes,
  };
}

// event_managers rows on the org's events added since `since`, by one of
// `grantors` or for one of `holders`. An org admin (or a region admin,
// for its own meets) can seat anyone on an event, themselves included,
// and the seat is its own grant: isEventDelegate honours it long after
// the role that made it possible is gone.
async function dropEventSeats(client, orgId, since, { grantors = [], holders = [] }) {
  const by = [...new Set(grantors.filter(Boolean))];
  const to = [...new Set(holders.filter(Boolean))];
  if (!since || (!by.length && !to.length)) return [];
  return (await client.query(
    `DELETE FROM event_managers em USING events e, users u
      WHERE e.id = em.event_id AND u.id = em.user_id
        AND e.org_id = $1 AND em.added_at >= $2
        AND (em.added_by = ANY($3::uuid[]) OR em.user_id = ANY($4::uuid[]))
      RETURNING em.event_id, e.name AS event_name, em.user_id, u.full_name`,
    [orgId, since, by, to],
  )).rows;
}

// A region claim, undone: the region's admin rows from the approval on,
// the claimant's own whenever it was made, and any event seats they
// handed out meanwhile.
async function unwindRegionClaim(client, claim) {
  await client.query(
    "UPDATE regions SET claim_state = 'unclaimed', claimed_at = NULL, claimed_name = NULL WHERE id = $1",
    [claim.target_id],
  );
  const regionAdmins = (await client.query(
    `DELETE FROM region_admins ra USING regions rg, users u
      WHERE rg.id = ra.region_id AND u.id = ra.user_id
        AND ra.region_id = $1 AND (ra.created_at >= $2 OR ra.user_id = $3)
      RETURNING ra.region_id, rg.name AS region_name, ra.user_id, u.full_name`,
    [claim.target_id, claim.decided_at, claim.claimant_id],
  )).rows;
  // Only seats they gave out (their own included). One the federation
  // gave a state admin on some other event was its call, not theirs.
  const eventManagers = await dropEventSeats(client, claim.org_id, claim.decided_at, {
    grantors: [claim.claimant_id, ...regionAdmins.map((r) => r.user_id)],
  });
  return {
    roles: [], regionAdmins, clubAdmins: [], eventManagers, cascade: [], escalated: [], rerouted: [], notes: [],
    activatedClubs: [], clubNotes: [],
  };
}

// Undo an approved claim (sysadmin only): the target goes back to
// unclaimed, and everything handed out under the claim goes with it.
// Returns what was removed, for the sysadmin to check over (and re-grant
// anything that should have stayed).
async function revoke(pool, { claimId, user, reason }, deps = {}) {
  const { bumpTokenVersion } = deps;
  if (!user.is_system_admin) throw new ClaimError(403, "Only DivingHQ can revoke a claim");
  const cleanReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 1000) : null;
  const out = await withTx(pool, async (client) => {
    const claim = await lockClaim(client, claimId);
    if (claim.status !== "approved") throw new ClaimError(409, "Only an approved claim can be revoked");
    // Two approved claims on one region only happen from before a re-claim
    // retired the old one (applyApproval does now). Unwinding the older
    // would strip whoever runs the region today, so refuse it.
    if (claim.target_kind === "region") {
      const newer = await client.query(
        `SELECT 1 FROM claims WHERE target_kind = 'region' AND target_id = $1 AND status = 'approved'
            AND id <> $2 AND decided_at > $3 LIMIT 1`,
        [claim.target_id, claim.id, claim.decided_at],
      );
      if (newer.rows.length) {
        throw new ClaimError(409, "A newer claim on this region has been approved since, so this one no longer runs it. Revoke that one instead if it needs to go.", "claim_superseded");
      }
    }
    const undone = claim.target_kind === "org"
      ? await unwindOrgClaim(client, claim, user)
      : await unwindRegionClaim(client, claim);

    await client.query(
      "UPDATE claims SET status = 'revoked', status_reason = $2, decided_at = now(), decided_by = $3 WHERE id = $1",
      [claim.id, cleanReason, user.id],
    );
    await recordAudit(client, {
      org_id: claim.org_id, actor_id: user.id, entity_type: "claim", entity_id: claim.id,
      entity_name: claim.body_name, action: "claim.revoked",
      metadata: {
        reason: cleanReason,
        removed: {
          org_roles: undone.roles.map((r) => ({ user_id: r.user_id, role: r.role })),
          club_admins: undone.clubAdmins.map((r) => ({ club_id: r.club_id, user_id: r.user_id })),
          region_admins: undone.regionAdmins.map((r) => ({ region_id: r.region_id, user_id: r.user_id })),
          event_managers: undone.eventManagers.map((r) => ({ event_id: r.event_id, user_id: r.user_id })),
          region_claims: undone.cascade.map((rc) => rc.id),
        },
        escalated: undone.escalated.map((oc) => oc.id),
        rerouted_to_sysadmin: undone.rerouted,
        activated_clubs: undone.activatedClubs.map((c) => c.id),
      },
    });

    // Everyone who lost something signs in again to lose it for real.
    const lost = [...new Set([
      claim.claimant_id,
      ...undone.roles.map((r) => r.user_id),
      ...undone.clubAdmins.map((r) => r.user_id),
      ...undone.regionAdmins.map((r) => r.user_id),
      ...undone.eventManagers.map((r) => r.user_id),
      ...undone.cascade.map((rc) => rc.claimant_id),
    ])];
    if (bumpTokenVersion) {
      for (const id of lost) await bumpTokenVersion(client, id);
    }

    const target = await describeTarget(client, claim);
    const cascadeClaimants = new Set(undone.cascade.map((rc) => rc.claimant_id));
    const appointees = (await liveOnly(client, lost))
      .filter((id) => id !== claim.claimant_id && !cascadeClaimants.has(id));
    const lostSet = new Set(lost);
    const audience = (await outcomeAudience(client, claim)).filter((id) => !lostSet.has(id));
    const notes = [{
      userIds: [claim.claimant_id],
      category: "claim_decided",
      title: `Your claim on ${target} was revoked`,
      body: cleanReason || `Contact ${supportContact()} if you'd like to talk it through.`,
      data: { claim_id: claim.id },
      email: {
        subject: `Your claim on ${target} was revoked`,
        body: `DivingHQ has revoked ${claim.body_name}'s claim on ${target}, so you no longer run it.`
          + (cleanReason ? `\n\nThe reason given: ${cleanReason}` : "")
          + `\n\n${talkItThrough()}`,
      },
    }, {
      userIds: appointees,
      category: "claim_decided",
      title: `Your access in ${target} has changed`,
      body: `DivingHQ revoked ${claim.body_name}'s claim, and the admin access given out under it went with it.`,
      data: { claim_id: claim.id },
      email: {
        subject: `Your access in ${target} has changed`,
        body: `DivingHQ has revoked ${claim.body_name}'s claim on ${target}. The admin, meet manager and referee access `
          + "given out while they ran it has been removed, including yours. Sign in again to carry on with what "
          + `you can still do.\n\n${talkItThrough()}`,
      },
    }, {
      userIds: audience,
      category: "claim_decided",
      title: `${claim.body_name} no longer runs ${target}`,
      body: "DivingHQ revoked their claim, so it's back to how it was before.",
      data: { claim_id: claim.id },
      email: {
        subject: `${claim.body_name} no longer runs ${target} on DivingHQ`,
        body: `DivingHQ has revoked ${claim.body_name}'s claim on ${target}, so it's back to how it was before the claim.`
          + (claim.target_kind === "org"
            ? " Club admins run their clubs' meets and review their members' role requests again."
            : ""),
      },
    }];
    notes.push(...undone.notes);
    for (const rc of undone.cascade) {
      const regionTarget = await describeTarget(client, rc);
      notes.push({
        userIds: [rc.claimant_id],
        category: "claim_decided",
        title: `Your claim on ${regionTarget} was revoked`,
        body: `${claim.body_name} approved it, and DivingHQ has revoked their own claim.`,
        data: { claim_id: rc.id },
        email: {
          subject: `Your claim on ${regionTarget} was revoked`,
          body: `Your claim as ${rc.body_name} on ${regionTarget} was approved by ${claim.body_name}. DivingHQ `
            + "has revoked their claim on the country, and the decisions they made as its federation with it, "
            + `so you no longer run the region.\n\n${talkItThrough()}`,
        },
      });
    }
    return {
      notes,
      removed: {
        org_roles: undone.roles.map((r) => ({ user_id: r.user_id, full_name: r.full_name, role: r.role })),
        club_admins: undone.clubAdmins.map((r) => ({ user_id: r.user_id, full_name: r.full_name, club_id: r.club_id, club_name: r.club_name })),
        region_admins: undone.regionAdmins.map((r) => ({ user_id: r.user_id, full_name: r.full_name, region_id: r.region_id, region_name: r.region_name })),
        event_managers: undone.eventManagers.map((r) => ({ user_id: r.user_id, full_name: r.full_name, event_id: r.event_id, event_name: r.event_name })),
        region_claims: undone.cascade.map((rc) => ({ id: rc.id, body_name: rc.body_name })),
      },
      activatedClubs: undone.activatedClubs.map((c) => ({ id: c.id, name: c.name })),
      clubNotes: undone.clubNotes,
    };
  });
  await notify(deps, out.notes);
  // The founders' notices are about their club, not the claim, so they
  // link to it and go out as club notices.
  await clubApprovals.deliver(deps, out.clubNotes);
  // Not removed, but the sysadmin should see it happened: clubs that were
  // waiting on the federation and now aren't.
  return { ...out.removed, activated_clubs: out.activatedClubs };
}

// POST /api/users/me/delete, inside its transaction: a claimant who's
// gone can't be handed anything, so their open claims end here.
async function withdrawForDeletedUser(client, userId) {
  const r = await client.query(
    `UPDATE claims SET status = 'withdrawn', status_reason = $2
      WHERE claimant_id = $1 AND status IN ('open', 'escalated')
      RETURNING id, org_id, body_name`,
    [userId, REASON.claimantDeleted],
  );
  for (const c of r.rows) {
    await recordAudit(client, {
      org_id: c.org_id, actor_id: userId, entity_type: "claim", entity_id: c.id,
      entity_name: c.body_name, action: "claim.withdrawn", metadata: { reason: REASON.claimantDeleted },
    });
  }
  return r.rows.length;
}

// ---------------------------------------------------------------------
// Sweep (§8.4)
// ---------------------------------------------------------------------

async function sweepOnce({ pool, push = null, email = null, bumpTokenVersion = null }) {
  const deps = { push, email };
  let withdrawn = 0;
  const stale = await pool.query(
    `SELECT id FROM claims
      WHERE status = 'open' AND activated_at IS NULL
        AND created_at < now() - make_interval(days => $1::int)`,
    [UNVERIFIED_TTL_DAYS],
  );
  for (const { id } of stale.rows) {
    try {
      const notes = await withTx(pool, async (client) => {
        const claim = await lockClaim(client, id);
        if (claim.status !== "open" || claim.activated_at) return null;
        return withdraw(client, claim, REASON.unverified);
      });
      if (notes) withdrawn += 1;
      await notify(deps, notes);
    } catch (err) {
      console.error("[claims sweep]", id, err.message);
    }
  }

  const settings = await settingsLib.getAll(pool);
  const due = await pool.query(
    `SELECT id FROM claims
      WHERE status = 'open' AND activated_at IS NOT NULL AND closes_at < now()
        AND approver IN ('clubs', 'regions', 'parent')`,
  );
  let resolved = 0;
  for (const { id } of due.rows) {
    try {
      const notes = await withTx(pool, async (client) => {
        const claim = await lockClaim(client, id);
        if (claim.status !== "open") return null;
        if (claim.approver === "parent") {
          return escalate(client, claim, "The federation didn't decide in time.");
        }
        const t = await tally(client, claim.id);
        if (t.objections > 0) return escalate(client, claim, "A voter objected.");
        // Normally a claim that clears the bar already passed when the
        // deciding vote came in. This catches the settings having been
        // lowered since.
        if (passes(t, settings)) {
          return approveUnlessHeld(client, claim, { deciderId: null, decidedBy: "votes", bumpTokenVersion });
        }
        return escalate(client, claim, t.approvals
          ? `Voting closed with ${t.approvals} of ${t.eligible} approving, short of the ${approvalsNeeded(t.eligible, settings)} needed.`
          : "Voting closed with no approvals.");
      });
      await notify(deps, notes);
      resolved += 1;
    } catch (err) {
      console.error("[claims sweep]", id, err.message);
    }
  }
  return { withdrawn, resolved };
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function start({ pool, push, email, bumpTokenVersion, logger = console }) {
  const run = () => sweepOnce({ pool, push, email, bumpTokenVersion })
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

// Withdrawn claims show to their claimant (so an unverified one doesn't
// just disappear on them) and, if they ever went live, to whoever could
// see them then. One that never went live stays the claimant's business.
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
      WHERE (cl.status <> 'withdrawn' OR cl.claimant_id = $1 OR cl.activated_at IS NOT NULL)
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
      // A national claim renames the org to the body once approved, so
      // name the country instead, or it reads "X -> X".
      target_name: cl.target_kind === "org"
        ? (countryByCode(cl.country_code)?.name || cl.target_name)
        : cl.target_name,
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
      can_decide: (isSys && !!cl.activated_at && ["open", "escalated"].includes(cl.status))
        || (live && cl.approver === "parent" && isOrgAdmin && cl.org_id === user.org_id && cl.claimant_id !== user.id),
      can_revoke: isSys && cl.status === "approved",
    });
  }
  return out;
}

// How many claims are waiting on this user (the dashboard card). One
// query, same rules as can_vote / can_decide in listForUser.
async function countActionable(pool, user) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM claims cl
      WHERE cl.activated_at IS NOT NULL
        AND (
          ($2::boolean AND cl.status IN ('open', 'escalated'))
          OR (cl.status = 'open' AND cl.approver IN ('clubs', 'regions') AND cl.claimant_id <> $1
              AND EXISTS (
                SELECT 1 FROM claim_voters cv
                 WHERE cv.claim_id = cl.id
                   AND NOT EXISTS (SELECT 1 FROM claim_votes v WHERE v.claim_id = cv.claim_id
                                     AND v.voter_kind = cv.voter_kind AND v.voter_id = cv.voter_id)
                   AND ((cv.voter_kind = 'club' AND EXISTS (
                          SELECT 1 FROM club_admins ca WHERE ca.club_id = cv.voter_id AND ca.user_id = $1))
                     OR (cv.voter_kind = 'region' AND EXISTS (
                          SELECT 1 FROM region_admins ra WHERE ra.region_id = cv.voter_id AND ra.user_id = $1)))))
          OR (cl.status = 'open' AND cl.approver = 'parent' AND $3::boolean AND cl.org_id = $4
              AND cl.claimant_id <> $1)
        )`,
    [user.id, !!user.is_system_admin, (user.org_roles || []).includes("org_admin"), user.org_id],
  );
  return r.rows[0].n;
}

// Has this person filed a claim of their own (anything but withdrawn)?
// Rides on the login and /api/auth/me bodies so the SPA shows a claimant
// the Claims page; before this the emailed link was the only way back to
// it. A box that hasn't run migration 089 has no claims table, which just
// means nobody has a claim.
async function hasOwnClaim(pool, userId) {
  try {
    const r = await pool.query(
      "SELECT 1 FROM claims WHERE claimant_id = $1 AND status <> 'withdrawn' LIMIT 1",
      [userId],
    );
    return r.rows.length > 0;
  } catch (err) {
    if (err.code === "42P01") return false;
    throw err;
  }
}

// The claimant's own claims still waiting on a decision, for their
// dashboard chip. Named the way listForUser names them.
async function openForClaimant(pool, userId) {
  const r = await pool.query(
    `SELECT cl.id, cl.target_kind, cl.status, cl.closes_at, cl.approver,
            cl.activated_at IS NOT NULL AS activated,
            CASE WHEN cl.target_kind = 'org' THEN o.name ELSE rg.name END AS target_name,
            o.country_code
       FROM claims cl
       JOIN organisations o ON o.id = cl.org_id
       LEFT JOIN regions rg ON cl.target_kind = 'region' AND rg.id = cl.target_id
      WHERE cl.claimant_id = $1 AND cl.status IN ('open', 'escalated')
      ORDER BY cl.created_at DESC`,
    [userId],
  );
  return r.rows.map((cl) => ({
    id: cl.id,
    target_kind: cl.target_kind,
    target_name: cl.target_kind === "org"
      ? (countryByCode(cl.country_code)?.name || cl.target_name)
      : cl.target_name,
    status: cl.status,
    approver: cl.approver,
    activated: cl.activated,
    closes_at: cl.closes_at,
  }));
}

module.exports = {
  countActionable,
  hasOwnClaim,
  openForClaimant,
  ClaimError,
  domainMatches,
  normaliseEmail,
  sharesIdentity,
  eligibleClubs,
  openClaim,
  activateForUser,
  castVote,
  decide,
  revoke,
  withdrawForDeletedUser,
  sweepOnce,
  start,
  listForUser,
  // Sends notices a caller got back from openClaim once its transaction
  // has committed.
  deliver: notify,
};
