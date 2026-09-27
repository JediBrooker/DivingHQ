// Who reviews a role request, in one place.
//
// Under a real federation (claim_state 'claimed') it's the org admins,
// same as it's always been. In a country the clubs started themselves
// ('unclaimed', migration 087) there are no org admins, so a request
// goes to the admins of the requester's own club (or of the region that
// club is in, migration 088). They can hand out the everyday roles
// only: diver, judge and coach. A coach's reach is their own divers
// (coach_diver_links) and their own club's classes, never anyone's meet.
//
// Referee isn't one of them. user_org_roles is org-wide and referee is
// a controller role (socketCanManageEvent, and every
// requireRoleOrEventDelegate(['org_admin','meet_manager','referee'])
// gate only checks the event is in the same org), so a referee minted
// by one club could drive every other club's live meets in the country.
// Anyone can found a club there without approval, which made that a
// self-serve route into the neighbours' Control Rooms. So referee
// requests in an unclaimed country go to the sysadmin, like anything
// else a club can't grant. Judge is fine: a judge only scores events
// whose panel they sit on (event_judges), and the host picks the panel.
//
// A requester with no club, or no club or region admin to ask, falls
// through to the sysadmin too. So does one whose club is still waiting on
// its federation (clubs.status 'pending', migration 096): nobody runs an
// unapproved club, whatever club_admins rows might say.
//
// Nobody approves themselves as an official. A founder is their own
// club's admin, so without this they could make themselves a judge or
// coach. Self-approving 'diver' is fine, it's their own club.
//
// routes/users.js (the list + review API), routes/dashboard.js (the
// pending feed) and lib/email.js (who gets told) all read from here so
// the three can't disagree about who's allowed to see what.

const CLUB_GRANTABLE_ROLES = ["diver", "judge", "coach"];

// What someone can ask for, at signup or later from their profile. Never
// org_admin (that's a claim, or the sysadmin) or spectator (everyone
// has it). An unclaimed country has no org-wide meet managers, clubs
// appoint per-meet managers there instead.
const REQUESTABLE_ROLES = ["diver", "coach", "judge", "referee", "meet_manager"];

function requestableRoles(claimState) {
  return claimState === "unclaimed"
    ? REQUESTABLE_ROLES.filter((r) => r !== "meet_manager")
    : REQUESTABLE_ROLES.slice();
}

const SELECT_COLUMNS = `
  rr.id, rr.requested_role, rr.status, rr.note, rr.created_at,
  rr.org_id, o.name AS org_name, o.country_code,
  u.id AS user_id, u.username, u.full_name,
  c.name AS club_name`;

// Pending requests an org admin (or sysadmin, across every org) reviews.
async function listForOrgAdmin(db, user) {
  const r = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM role_requests rr
       JOIN users u         ON rr.user_id = u.id
       JOIN organisations o ON rr.org_id = o.id
       LEFT JOIN clubs c    ON c.id = u.club_id
      WHERE rr.status = 'pending' AND ($2::boolean OR rr.org_id = $1)
      ORDER BY o.name ASC, rr.created_at ASC`,
    [user.org_id, !!user.is_system_admin],
  );
  return r.rows;
}

// Pending requests a club or region admin reviews: from members of a
// club they admin, or of any club in a region they admin, in unclaimed
// orgs, for the roles a club may grant. A region admin sees their clubs'
// requests even where the club has its own admins, one level up can
// always act.
const DELEGATE_SCOPE = `
  (EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $1)
   OR EXISTS (SELECT 1 FROM region_admins ra WHERE ra.region_id = c.region_id AND ra.user_id = $1))`;

async function listForDelegate(db, userId) {
  const r = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM role_requests rr
       JOIN users u         ON rr.user_id = u.id
       JOIN organisations o ON rr.org_id = o.id
       JOIN clubs c         ON c.id = u.club_id AND c.org_id = rr.org_id AND c.status = 'active'
      WHERE rr.status = 'pending'
        AND o.claim_state = 'unclaimed'
        AND rr.requested_role::text = ANY($2::text[])
        AND (rr.user_id <> $1 OR rr.requested_role = 'diver')
        AND ${DELEGATE_SCOPE}
      ORDER BY rr.created_at ASC`,
    [userId, CLUB_GRANTABLE_ROLES],
  );
  return r.rows;
}

// Can this club or region admin decide this particular request? rq is a
// role_requests row. Same conditions as listForDelegate, for one row.
async function delegateCanReview(db, userId, rq) {
  if (!CLUB_GRANTABLE_ROLES.includes(rq.requested_role)) return false;
  if (rq.user_id === userId && rq.requested_role !== "diver") return false;
  const r = await db.query(
    `SELECT 1
       FROM users u
       JOIN organisations o ON o.id = $2 AND o.claim_state = 'unclaimed'
       JOIN clubs c         ON c.id = u.club_id AND c.org_id = o.id AND c.status = 'active'
      WHERE u.id = $3 AND ${DELEGATE_SCOPE}`,
    [userId, rq.org_id, rq.user_id],
  );
  return r.rows.length > 0;
}

// Everyone who should hear about a new request, and by which route:
// { via: 'org' | 'club' | 'region' | 'sysadmin', recipients: [{ email, full_name }] }.
// Nearest level first: the club's admins, then its region's, then the
// sysadmin. `via` decides which page the email links to.
async function reviewersFor(db, requesterId, orgId, role) {
  const org = await db.query("SELECT claim_state FROM organisations WHERE id = $1", [orgId]);
  if (org.rows[0]?.claim_state !== "unclaimed") {
    // Live org admins only. A federation whose only admin has deleted
    // their account (or been suspended) stays claimed with nobody to
    // read the mail, so it falls through to DivingHQ below, the way
    // club approvals do (lib/club-approvals.js reviewerIds).
    const r = await db.query(
      `SELECT u.email, u.full_name
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id
        WHERE u.org_id = $1 AND r.role = 'org_admin' AND u.email IS NOT NULL
          AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
      [orgId],
    );
    if (r.rows.length) return { via: "org", recipients: r.rows };
  } else if (CLUB_GRANTABLE_ROLES.includes(role)) {
    const club = await db.query(
      `SELECT a.email, a.full_name
         FROM users requester
         JOIN clubs c        ON c.id = requester.club_id AND c.status = 'active'
         JOIN club_admins ca ON ca.club_id = c.id
         JOIN users a        ON a.id = ca.user_id
        WHERE requester.id = $1 AND a.email IS NOT NULL AND a.deleted_at IS NULL
          AND (a.id <> requester.id OR $2 = 'diver')`,
      [requesterId, role],
    );
    if (club.rows.length) return { via: "club", recipients: club.rows };
    const region = await db.query(
      `SELECT a.email, a.full_name
         FROM users requester
         JOIN clubs c         ON c.id = requester.club_id AND c.status = 'active'
         JOIN region_admins ra ON ra.region_id = c.region_id
         JOIN users a         ON a.id = ra.user_id
        WHERE requester.id = $1 AND a.email IS NOT NULL AND a.deleted_at IS NULL
          AND (a.id <> requester.id OR $2 = 'diver')`,
      [requesterId, role],
    );
    if (region.rows.length) return { via: "region", recipients: region.rows };
  }
  const sys = await db.query(
    "SELECT email, full_name FROM users WHERE is_system_admin = true AND email IS NOT NULL",
  );
  return { via: "sysadmin", recipients: sys.rows };
}

module.exports = {
  CLUB_GRANTABLE_ROLES,
  REQUESTABLE_ROLES,
  requestableRoles,
  listForOrgAdmin,
  listForDelegate,
  delegateCanReview,
  reviewersFor,
};
