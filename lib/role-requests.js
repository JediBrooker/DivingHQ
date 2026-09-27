// Who reviews a role request, in one place.
//
// Under a real federation (claim_state 'claimed') it's the org admins,
// same as it's always been. In a country the clubs started themselves
// ('unclaimed', migration 087) there are no org admins, so a request
// goes to the admins of the requester's own club. They can hand out the
// everyday roles only: diver, judge, referee. Nothing org-wide like
// meet_manager, which isn't requestable there anyway. A requester with
// no club, or whose club has no admin, falls through to the sysadmin.
//
// Nobody approves themselves as an official. A founder is their own
// club's admin, so without this they could make themselves a judge or
// referee. Self-approving 'diver' is fine, it's their own club.
//
// routes/users.js (the list + review API), routes/dashboard.js (the
// pending feed) and lib/email.js (who gets told) all read from here so
// the three can't disagree about who's allowed to see what.

const CLUB_GRANTABLE_ROLES = ["diver", "judge", "referee"];

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

// Pending requests from members of clubs this user admins, in
// unclaimed orgs, for the roles a club may grant.
async function listForClubAdmin(db, userId) {
  const r = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM role_requests rr
       JOIN users u         ON rr.user_id = u.id
       JOIN organisations o ON rr.org_id = o.id
       JOIN clubs c         ON c.id = u.club_id AND c.org_id = rr.org_id
       JOIN club_admins ca  ON ca.club_id = c.id AND ca.user_id = $1
      WHERE rr.status = 'pending'
        AND o.claim_state = 'unclaimed'
        AND rr.requested_role::text = ANY($2::text[])
        AND (rr.user_id <> $1 OR rr.requested_role = 'diver')
      ORDER BY rr.created_at ASC`,
    [userId, CLUB_GRANTABLE_ROLES],
  );
  return r.rows;
}

// Can this club admin decide this particular request? rq is a
// role_requests row. Same conditions as listForClubAdmin, for one row.
async function clubAdminCanReview(db, userId, rq) {
  if (!CLUB_GRANTABLE_ROLES.includes(rq.requested_role)) return false;
  if (rq.user_id === userId && rq.requested_role !== "diver") return false;
  const r = await db.query(
    `SELECT 1
       FROM users u
       JOIN organisations o ON o.id = $2 AND o.claim_state = 'unclaimed'
       JOIN clubs c         ON c.id = u.club_id AND c.org_id = o.id
       JOIN club_admins ca  ON ca.club_id = c.id AND ca.user_id = $3
      WHERE u.id = $1`,
    [rq.user_id, rq.org_id, userId],
  );
  return r.rows.length > 0;
}

// Everyone who should hear about a new request, and by which route:
// { via: 'org' | 'club' | 'sysadmin', recipients: [{ email, full_name }] }.
// `via` decides which page the email links to.
async function reviewersFor(db, requesterId, orgId, role) {
  const org = await db.query("SELECT claim_state FROM organisations WHERE id = $1", [orgId]);
  if (org.rows[0]?.claim_state !== "unclaimed") {
    const r = await db.query(
      `SELECT u.email, u.full_name
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id
        WHERE u.org_id = $1 AND r.role = 'org_admin' AND u.email IS NOT NULL`,
      [orgId],
    );
    return { via: "org", recipients: r.rows };
  }
  if (CLUB_GRANTABLE_ROLES.includes(role)) {
    const club = await db.query(
      `SELECT a.email, a.full_name
         FROM users requester
         JOIN club_admins ca ON ca.club_id = requester.club_id
         JOIN users a        ON a.id = ca.user_id
        WHERE requester.id = $1 AND a.email IS NOT NULL AND a.deleted_at IS NULL
          AND (a.id <> requester.id OR $2 = 'diver')`,
      [requesterId, role],
    );
    if (club.rows.length) return { via: "club", recipients: club.rows };
  }
  const sys = await db.query(
    "SELECT email, full_name FROM users WHERE is_system_admin = true AND email IS NOT NULL",
  );
  return { via: "sysadmin", recipients: sys.rows };
}

module.exports = {
  CLUB_GRANTABLE_ROLES,
  listForOrgAdmin,
  listForClubAdmin,
  clubAdminCanReview,
  reviewersFor,
};
