// Junior profiles (migration 107): divers under 13 that adults look after.
//
// Accounts are for 13 and up (lib/direct-use-age.js). A younger diver still
// competes, so a parent, a coach or a club admin adds a junior profile for
// them: a users row with no password and no email that nobody signs in to.
// routes/juniors.js is the API; this file has the rules both it and
// lib/push.js / the profile routes lean on.
//
// Who confirms a new junior is whoever confirms that club's divers, the
// ladder role requests climb (lib/role-requests.js nearestReviewers): the
// federation's admins under a federation, otherwise the club's admins, its
// region's, then DivingHQ. A junior added by someone already on that rung,
// in their admin capacity ('club' or 'org'), starts active. One added as a
// parent or a coach always goes to somebody else, so nobody vouches for
// their own family.
//
// Until it's confirmed a junior has no diver role, so it can't be entered
// in anything (eligible-divers wants the role). Confirming grants the role,
// approves the parent's guardian link and links the coach who added it.
//
// "Manage" (edit, add a parent, hand over at 13, remove) is the junior's
// approved guardians, the admins of their club or its region, the
// federation's admins and the sysadmin. A linked coach sees the junior and
// enters them in meets through the coach screens, but doesn't edit them.
//
// Under 13 by date of birth, a profile is results only: the name shows on
// scoreboards and results like anyone's, but the profile pages and the
// diver search leave it out unless the viewer is one of the people above.

const crypto = require("node:crypto");
const notices = require("./notices");
const { nearestReviewers } = require("./role-requests");
const { MINIMUM_DIRECT_USE_AGE } = require("./direct-use-age");

// users.gender is free text, these are what the forms offer
// (record_gender in migration 094 reads 'male' / 'female').
const GENDERS = ["female", "male", "other"];
const RELATIONS = ["parent", "coach", "club", "org"];

// A handover link is good for a week. It goes to an address an adult typed
// in, so it shouldn't sit in a mailbox forever.
const HANDOVER_TTL_DAYS = 7;

// Under the direct-use age by date of birth, as SQL. Same calendar rule as
// isKnownUnderMinimumAge: today's UTC date minus 13 years. alias is the
// users row.
function underAgeSql(alias = "u") {
  return `(${alias}.date_of_birth IS NOT NULL AND ${alias}.date_of_birth > `
    + `((now() AT TIME ZONE 'UTC')::date - interval '${MINIMUM_DIRECT_USE_AGE} years'))`;
}

// Somebody who can't read their own notifications: a junior profile still
// looked after by adults, or an older account whose date of birth says
// under 13 (lib/direct-use-age.js locks those out). lib/push.js and the
// event emails send theirs to the parents instead.
function lookedAfterSql(userAlias = "u", juniorAlias = "jp") {
  return `(${juniorAlias}.status IN ('pending', 'active') OR ${underAgeSql(userAlias)})`;
}

// Whole years between a YYYY-MM-DD birthday and today (UTC).
function ageFrom(dob, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || ""));
  if (!m) return null;
  let age = now.getUTCFullYear() - Number(m[1]);
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  if (md < Number(m[2]) * 100 + Number(m[3])) age--;
  return age;
}

function isOrgAdminOf(user, orgId) {
  return !!user && (user.org_roles || []).includes("org_admin") && user.org_id === orgId;
}

// The club someone is adding a junior to, with what they are to it.
async function clubContext(db, user, clubId) {
  const r = await db.query(
    `SELECT c.id, c.name, c.org_id, c.status, o.claim_state, o.status AS org_status,
            (EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $2)
             OR EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = c.region_id AND ra.user_id = $2)) AS club_admin
       FROM clubs c
       JOIN organisations o ON o.id = c.org_id
      WHERE c.id = $1`,
    [clubId, user.id],
  );
  return r.rows[0] || null;
}

// How this person may add a junior to this club. Parent and coach need to
// be in the club's country account, because the guardian link and the
// coach link are both org-scoped. 'club' is for the club's (or region's)
// admins, 'org' for the federation's admins and the sysadmin.
function relationsFor(user, club) {
  if (!user || !club) return [];
  const sameOrg = user.org_id === club.org_id;
  const roles = user.org_roles || [];
  const out = [];
  if (sameOrg) out.push("parent");
  if (sameOrg && roles.includes("coach")) out.push("coach");
  if (club.club_admin) out.push("club");
  if (user.is_system_admin || (isOrgAdminOf(user, club.org_id) && club.claim_state === "claimed")) out.push("org");
  return out;
}

// Does a junior added this way start confirmed? Only when the person is
// the one who'd confirm it anyway and is acting as that: a club admin
// where there's no federation, a federation admin, the sysadmin.
function startsActive(club, as) {
  if (as === "org") return true;
  if (as === "club") return club.claim_state === "unclaimed";
  return false;
}

// One junior and what this person is to them. null when there's no such
// junior (or it's been handed over, it's an ordinary account then).
async function juniorFor(db, user, juniorId) {
  const r = await db.query(
    `SELECT u.id, u.full_name, u.org_id, u.club_id, u.gender,
            to_char(u.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
            jp.status, jp.created_by, jp.created_as, jp.handover_email,
            o.claim_state, c.name AS club_name, c.status AS club_status,
            (EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $2)
             OR EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = c.region_id AND ra.user_id = $2)) AS club_admin,
            (SELECT g.status FROM guardians g
              WHERE g.dependent_user_id = u.id AND g.guardian_user_id = $2
                AND g.status IN ('approved', 'pending')
              ORDER BY (g.status = 'approved') DESC LIMIT 1) AS guardian,
            EXISTS (SELECT 1 FROM coach_diver_links l WHERE l.diver_id = u.id AND l.coach_id = $2) AS coach
       FROM junior_profiles jp
       JOIN users u         ON u.id = jp.user_id AND u.deleted_at IS NULL
       JOIN organisations o ON o.id = u.org_id
       LEFT JOIN clubs c    ON c.id = u.club_id
      WHERE jp.user_id = $1 AND jp.status IN ('pending', 'active')`,
    [juniorId, user.id],
  );
  const row = r.rows[0];
  return row ? { ...row, rights: rightsFor(user, row) } : null;
}

function rightsFor(user, row) {
  const sysadmin = !!user.is_system_admin;
  const orgAdmin = isOrgAdminOf(user, row.org_id);
  // A club that's still waiting on its federation runs nothing
  // (lib/club-approvals.js), its admin rows included.
  const clubAdmin = !!row.club_admin && row.club_status === "active";
  const guardian = row.guardian === "approved";
  const creator = row.created_by === user.id;
  const manage = sysadmin || orgAdmin || clubAdmin || guardian;
  // Confirming follows the diver-request ladder. Under a federation its
  // admins, where the clubs run things the club's or region's admins, but
  // never the person who added it.
  const review = row.status === "pending" && (sysadmin
    || (row.claim_state === "claimed" ? orgAdmin : (clubAdmin && !creator)));
  return {
    manage,
    review,
    see: manage || !!row.coach || creator || row.guardian === "pending",
    // A pending one can be withdrawn by whoever added it.
    remove: manage || (creator && row.status === "pending"),
    handOver: manage && row.status === "active" && (ageFrom(row.date_of_birth) ?? 0) >= MINIMUM_DIRECT_USE_AGE,
  };
}

// Confirm a junior: the diver role, the parent link of whoever added them
// as a parent, and a coach link for whoever added them as a coach. Runs
// inside the caller's transaction.
async function activate(client, junior, actorId) {
  await client.query(
    `INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1, $2, 'diver', $3)
     ON CONFLICT (user_id, org_id, role) DO NOTHING`,
    [junior.id, junior.org_id, actorId],
  );
  await client.query(
    `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id, note)
     VALUES ($1, $2, 'diver', 'granted', $3, 'Junior profile confirmed')`,
    [junior.id, junior.org_id, actorId],
  );
  if (junior.created_by && junior.created_as === "parent") {
    await client.query(
      `UPDATE guardians SET status = 'approved', reviewed_by = $3, reviewed_at = now()
        WHERE dependent_user_id = $1 AND guardian_user_id = $2 AND status = 'pending'`,
      [junior.id, junior.created_by, actorId],
    );
  }
  if (junior.created_by && junior.created_as === "coach") {
    await client.query(
      `INSERT INTO coach_diver_links (coach_id, diver_id, org_id, note)
       VALUES ($1, $2, $3, 'Added this junior')
       ON CONFLICT (coach_id, diver_id) DO NOTHING`,
      [junior.created_by, junior.id, junior.org_id],
    );
  }
}

// Where each rung decides, for the notice link and the email wording.
const PLACES = {
  club:     { path: "/club",   where: "on your club page (My club)" },
  region:   { path: "/region", where: "on your region page (My region)" },
  org:      { path: "/users",  where: "in the User Manager, on the Pending tab" },
  sysadmin: { path: "/users",  where: "in the User Manager, on the Pending tab" },
};

const AS_WORDS = {
  parent: "as their parent or guardian",
  coach: "as their coach",
  club: "for the club",
  org: "for the federation",
};

async function namesOf(db, juniorId, adderId) {
  const r = await db.query(
    `SELECT u.full_name, to_char(u.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, c.name AS club_name,
            a.full_name AS adder_name, a.username AS adder_username
       FROM users u
       LEFT JOIN clubs c ON c.id = u.club_id
       LEFT JOIN users a ON a.id = $2
      WHERE u.id = $1`,
    [juniorId, adderId || null],
  );
  return r.rows[0] || {};
}

// A junior waiting to be confirmed: tell the nearest rung with someone
// live, leaving out whoever added it. English, like the other admin
// notices (lib/notices.js).
async function notifyReviewers(db, deps, junior) {
  const { via, recipients } = await nearestReviewers(db, {
    orgId: junior.org_id, memberId: junior.id, except: [junior.created_by].filter(Boolean),
  });
  if (!recipients.length) return { via, notified: 0 };
  const n = await namesOf(db, junior.id, junior.created_by);
  const child = n.full_name || "A junior diver";
  const adder = n.adder_name || "Someone";
  const age = ageFrom(n.date_of_birth);
  const place = PLACES[via] || PLACES.org;
  const body = [
    `${adder}${n.adder_username ? ` (@${n.adder_username})` : ""} added ${child}`
      + `${age != null ? `, aged ${age},` : ""} to ${n.club_name || "a club"} on DivingHQ ${AS_WORDS[junior.created_as] || ""}.`,
    "",
    "A junior profile is for a diver under 13. Nobody signs in to it: the adults looking after the diver "
      + "enter them in meets, and their results show like anyone else's.",
    ...(junior.created_as === "parent"
      ? ["", `Once you confirm it, ${adder} is linked to ${child} as their parent and gets ${child}'s meet notifications.`]
      : []),
    "",
    `Confirm it only if you know ${child} dives with ${n.club_name || "the club"} and ${adder} is who they say they are.`,
    "",
    `You can confirm or turn it down ${place.where}.`,
  ].join("\n");
  await notices.deliver(deps || {}, [{
    userIds: recipients.map((x) => x.id),
    category: "junior_request",
    title: `${adder} added ${child} as a junior diver`,
    body: "Confirm it only if you know the family.",
    action_url: place.path,
    data: { junior_user_id: junior.id },
    email: { subject: `Junior diver to confirm: ${child}`, body },
  }], { tag: "juniors" });
  return { via, notified: recipients.length };
}

// Whoever added it hears how it went.
async function notifyDecision(db, deps, junior, decision, childName) {
  if (!junior.created_by) return;
  const child = childName || "your junior diver";
  const approved = decision === "approved";
  await notices.deliver(deps || {}, [{
    userIds: [junior.created_by],
    category: "junior_decision",
    title: approved ? `${child}'s junior profile is confirmed` : `${child}'s junior profile wasn't confirmed`,
    body: approved
      ? `${child} can be entered in meets now.`
      : `If you think that's a mistake, get in touch with ${child}'s club.`,
    action_url: "/juniors",
    data: { junior_user_id: junior.id, decision },
    email: false,
  }], { tag: "juniors" });
}

// A parent added to a junior after the fact, or a parent who tried to add
// a child that was already here (selfRequest), waiting for the same people.
async function notifyParentLink(db, deps, junior, link) {
  const { via, recipients } = await nearestReviewers(db, {
    orgId: junior.org_id, memberId: junior.id, except: [link.guardian_user_id, link.added_by].filter(Boolean),
  });
  if (!recipients.length) return { via, notified: 0 };
  const n = await namesOf(db, junior.id, link.guardian_user_id);
  const place = PLACES[via] || PLACES.org;
  await notices.deliver(deps || {}, [{
    userIds: recipients.map((x) => x.id),
    category: "guardian_request",
    title: link.selfRequest
      ? `${n.adder_name || "Someone"} asked to be linked to ${n.full_name || "a junior"} as their parent`
      : `${n.adder_name || "Someone"} was added as ${n.full_name || "a junior"}'s parent`,
    body: "Approve it only if you know they're the diver's parent or guardian.",
    action_url: place.path,
    data: { guardian_link_id: link.id, dependent_user_id: junior.id },
    email: {
      subject: `Parent to confirm for ${n.full_name || "a junior diver"}`,
      body: `${n.adder_name || "Someone"}${n.adder_username ? ` (@${n.adder_username})` : ""} was added as `
        + `${n.full_name || "a junior diver"}'s parent or guardian. Once approved they get the diver's meet notifications `
        + `and can look after their profile.\n\nApprove it only if you know they're the diver's parent or guardian. `
        + `You can decide ${place.where}.`,
    },
  }], { tag: "juniors" });
  return { via, notified: recipients.length };
}

// Handover links. The token goes in the email; only its hash is stored.
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function newHandoverToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

// For lib/push.js: of these ids, which belong to someone who can't read
// their own notifications, and which approved, live guardians read them
// instead. Map of junior id -> { name, guardianIds }.
async function noticeRedirects(db, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const r = await db.query(
    `SELECT u.id, u.full_name,
            COALESCE(array_agg(g.guardian_user_id) FILTER (WHERE gu.id IS NOT NULL), '{}') AS guardian_ids
       FROM users u
       LEFT JOIN junior_profiles jp ON jp.user_id = u.id
       LEFT JOIN guardians g        ON g.dependent_user_id = u.id AND g.status = 'approved'
       LEFT JOIN users gu           ON gu.id = g.guardian_user_id
                                   AND gu.deleted_at IS NULL AND gu.suspended_at IS NULL
      WHERE u.id = ANY($1::uuid[]) AND ${lookedAfterSql("u", "jp")}
      GROUP BY u.id, u.full_name`,
    [ids],
  );
  return new Map(r.rows.map((row) => [row.id, { name: row.full_name, guardianIds: row.guardian_ids }]));
}

// May this viewer open an under-13 diver's profile page? Anyone may when
// the diver is 13 or over. Otherwise only the diver's own people (the ones
// who manage or coach them) and the sysadmin.
async function profileHiddenFrom(db, viewer, diverId) {
  const r = await db.query(
    `SELECT u.org_id, ${underAgeSql("u")} AS under_age,
            (EXISTS (SELECT 1 FROM guardians g WHERE g.dependent_user_id = u.id AND g.guardian_user_id = $2
                      AND g.status = 'approved')
             OR EXISTS (SELECT 1 FROM coach_diver_links l WHERE l.diver_id = u.id AND l.coach_id = $2)
             OR EXISTS (SELECT 1 FROM clubs c
                         WHERE c.id = u.club_id AND c.status = 'active'
                           AND (EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $2)
                                OR EXISTS (SELECT 1 FROM region_admins ra
                                            WHERE ra.region_id = c.region_id AND ra.user_id = $2)))) AS theirs
       FROM users u WHERE u.id = $1`,
    [diverId, viewer?.id || null],
  );
  const row = r.rows[0];
  if (!row || !row.under_age) return false;
  if (!viewer) return true;
  if (viewer.is_system_admin || viewer.id === diverId || isOrgAdminOf(viewer, row.org_id)) return false;
  return !row.theirs;
}

module.exports = {
  GENDERS,
  RELATIONS,
  HANDOVER_TTL_DAYS,
  underAgeSql,
  lookedAfterSql,
  ageFrom,
  clubContext,
  relationsFor,
  startsActive,
  juniorFor,
  rightsFor,
  activate,
  notifyReviewers,
  notifyDecision,
  notifyParentLink,
  hashToken,
  newHandoverToken,
  noticeRedirects,
  profileHiddenFrom,
};
