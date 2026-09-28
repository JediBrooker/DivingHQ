// Guardian link requests (migration 083): who sees them, who decides,
// and who gets told.
//
// A parent asks to be linked to a child so they can pay the child's fees
// (routes/users.js). Under a real federation (claim_state 'claimed') the
// org admins decide, same as they always have. In a country the clubs
// started themselves there are no org admins, so the child's club
// decides: the admins of the club the child belongs to (users.club_id),
// or of the region that club is in, and the sysadmin when neither has
// anybody live. That's the ladder role requests climb, and the routing is
// literally theirs (nearestReviewers in lib/role-requests.js).
//
// The child's club, not the parent's. A parent often isn't in any club,
// and the child's club is the one that knows who their family is.
//
// Nobody decides a request they're part of. A club admin who is the
// parent (or the child) doesn't see it in their queue and can't approve
// it; it goes to a co-admin, the region or DivingHQ. Org admins review
// the way they did before this, the rule only covers the club levels.
//
// Scope, for the club levels: a club admin only sees and decides
// requests for children in a club they run, a region admin for children
// in the clubs of their region, and never in another org. It follows the
// child, so a child who moves club takes their request to the new club.
//
// routes/users.js (the list + review API) is the only caller today. The
// notices go out in-app and by email through lib/notices.js, in English
// like the other admin notices.

const notices = require("./notices");
const { nearestReviewers, DELEGATE_SCOPE } = require("./role-requests");

// What a reviewer needs to recognise the family: both names, the child's
// age (not the birthday) and club. Org admins also get dependent_dob,
// which User Manager already showed them.
const COLUMNS = `
  g.id, g.status, g.requested_at, g.org_id,
  gu.id AS guardian_id, gu.full_name AS guardian_name, gu.username AS guardian_username,
  du.id AS dependent_id, du.full_name AS dependent_name, du.username AS dependent_username,
  date_part('year', age(du.date_of_birth))::int AS dependent_age,
  c.name AS club_name`;

// Pending links in the caller's org, every org for the sysadmin.
async function listForOrgAdmin(db, user) {
  const r = await db.query(
    `SELECT ${COLUMNS}, du.date_of_birth AS dependent_dob
       FROM guardians g
       JOIN users gu     ON gu.id = g.guardian_user_id
       JOIN users du     ON du.id = g.dependent_user_id
       LEFT JOIN clubs c ON c.id = du.club_id
      WHERE g.status = 'pending' AND ($2::boolean OR g.org_id = $1)
      ORDER BY g.requested_at ASC`,
    [user.org_id, !!user.is_system_admin],
  );
  return r.rows;
}

// Pending links a club or region admin decides: children in a club they
// run (or in their region), unclaimed org, their own org, and not a
// request they're part of.
async function listForDelegate(db, user) {
  const r = await db.query(
    `SELECT ${COLUMNS}
       FROM guardians g
       JOIN organisations o ON o.id = g.org_id AND o.claim_state = 'unclaimed'
       JOIN users du        ON du.id = g.dependent_user_id AND du.org_id = g.org_id
       JOIN clubs c         ON c.id = du.club_id AND c.org_id = g.org_id AND c.status = 'active'
       JOIN users gu        ON gu.id = g.guardian_user_id
      WHERE g.status = 'pending' AND g.org_id = $2
        AND g.guardian_user_id <> $1 AND g.dependent_user_id <> $1
        AND ${DELEGATE_SCOPE}
      ORDER BY g.requested_at ASC`,
    [user.id, user.org_id],
  );
  return r.rows;
}

// Can this club or region admin decide this one? link is a guardians
// row. Same conditions as listForDelegate, checked against where the
// child is now rather than when the parent asked.
async function delegateCanReview(db, user, link) {
  if (!link || !user) return false;
  if (link.guardian_user_id === user.id || link.dependent_user_id === user.id) return false;
  if (link.org_id !== user.org_id) return false;
  const r = await db.query(
    `SELECT 1
       FROM users du
       JOIN organisations o ON o.id = $2 AND o.claim_state = 'unclaimed'
       JOIN clubs c         ON c.id = du.club_id AND c.org_id = o.id AND c.status = 'active'
      WHERE du.id = $3 AND du.org_id = o.id AND ${DELEGATE_SCOPE}`,
    [user.id, link.org_id, link.dependent_user_id],
  );
  return r.rows.length > 0;
}

// Who to tell about a new request: { via, recipients }. The parent and
// the child are both left out, so a founder asking to pay for their own
// kid goes to a co-admin, the region or DivingHQ.
function reviewersFor(db, link) {
  return nearestReviewers(db, {
    orgId: link.org_id,
    memberId: link.dependent_user_id,
    except: [link.guardian_user_id, link.dependent_user_id],
  });
}

// Where each level decides, for the notice link and the email wording.
const PLACES = {
  club:     { path: "/club",   where: "on your club page (My club)" },
  region:   { path: "/region", where: "on your region page (My region)" },
  org:      { path: "/users",  where: "in the User Manager, on the Pending tab" },
  sysadmin: { path: "/users",  where: "in the User Manager, on the Pending tab" },
};

async function names(db, link) {
  const r = await db.query(
    `SELECT gu.full_name AS guardian_name, gu.username AS guardian_username,
            du.full_name AS dependent_name, c.name AS club_name
       FROM users du
       JOIN users gu     ON gu.id = $1
       LEFT JOIN clubs c ON c.id = du.club_id AND c.status = 'active'
      WHERE du.id = $2`,
    [link.guardian_user_id, link.dependent_user_id],
  );
  return r.rows[0] || {};
}

// A new request: tell the nearest level with someone live. Returns which
// level that was and how many heard, for the logs and the tests.
//
// Once a day per parent and child. Otherwise withdrawing and asking again
// would email a club admin as often as the parent felt like it, and the
// first notice already points at the queue the new request sits in.
async function notifyReviewers(db, deps, link) {
  const again = await db.query(
    `SELECT 1 FROM guardians
      WHERE org_id = $1 AND guardian_user_id = $2 AND dependent_user_id = $3
        AND id <> $4 AND requested_at > now() - interval '24 hours'
      LIMIT 1`,
    [link.org_id, link.guardian_user_id, link.dependent_user_id, link.id],
  );
  if (again.rows.length) return { via: null, notified: 0 };
  const { via, recipients } = await reviewersFor(db, link);
  if (!recipients.length) return { via, notified: 0 };
  const n = await names(db, link);
  const parent = n.guardian_name || "Someone";
  const child = n.dependent_name || "a member";
  const place = PLACES[via] || PLACES.org;
  const body = [
    `${parent}${n.guardian_username ? ` (@${n.guardian_username})` : ""} asked to be linked to ${child}`
      + `${n.club_name ? `, a member of ${n.club_name},` : ""} as their parent or guardian on DivingHQ.`,
    "",
    `Once linked, ${parent} can pay ${child}'s entry fees, membership and other charges, and see what ${child} owes and has paid. `
      + `Only approve it if you know ${parent} really is ${child}'s parent or guardian.`,
    "",
    `You can approve or reject it ${place.where}.`,
  ].join("\n");
  await notices.deliver(deps || {}, [{
    userIds: recipients.map((x) => x.id),
    category: "guardian_request",
    title: `${parent} asked to be ${child}'s guardian`,
    body: `Approve it only if you know they're ${child}'s parent or guardian.`,
    action_url: place.path,
    data: { guardian_link_id: link.id, dependent_user_id: link.dependent_user_id },
    email: { subject: `Guardian link request: ${parent} for ${child}`, body },
  }], { tag: "guardian requests" });
  return { via, notified: recipients.length };
}

// The parent hears how it went, so they aren't left refreshing
// /guardians to find out.
async function notifyDecision(db, deps, link, decision) {
  const n = await names(db, link);
  const child = n.dependent_name || "your dependent";
  const approved = decision === "approved";
  await notices.deliver(deps || {}, [{
    userIds: [link.guardian_user_id],
    category: "guardian_decision",
    title: approved
      ? `You're now linked to ${child}`
      : `Your request to be linked to ${child} was turned down`,
    body: approved
      ? `You can pay for ${child} now: pick them under "Paying for" on Membership or Charges.`
      : `If you think that's a mistake, get in touch with ${child}'s club.`,
    action_url: "/guardians",
    data: { guardian_link_id: link.id, dependent_user_id: link.dependent_user_id, decision },
  }], { tag: "guardian requests" });
}

module.exports = {
  listForOrgAdmin,
  listForDelegate,
  delegateCanReview,
  reviewersFor,
  notifyReviewers,
  notifyDecision,
};
