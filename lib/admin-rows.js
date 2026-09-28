// Who runs a club, a region or an org, and who to tell about it. Plus
// taking someone off a club's or region's admin list without ever leaving
// it with nobody alive to run it.
//
// In a country with no federation (claim_state 'unclaimed') a club's
// admins, and a region's, appoint and remove each other. Nobody above
// them can step in except the sysadmin, so "never the last one" is the
// only thing keeping a club or region from going orphaned. Two details
// used to let it through:
//
//   * the count included soft-deleted and suspended accounts, whose rows
//     stay behind, so "2 admins" could really be one live person and a
//     tombstone;
//   * it was a separate count then delete, so two co-admins removing
//     each other at the same moment both saw 2 and both succeeded.
//
// So the admin rows are locked (FOR UPDATE) inside one transaction and
// only live accounts count. A second remover blocks on the lock, and
// when it gets the rows back the first removal is already gone from
// them. Removing a dead account's row is always fine, it was never
// running anything.
//
// The org admin and the sysadmin aren't held to the rule
// (keepOneLive: false): a federation can clear a club's admins and
// appoint new ones, and the sysadmin is the fallback anyway.
//
// A federation gets the same rule for its org admins (orgAdminHold
// below), for the same reason one level up: nobody in the org can appoint
// an org admin except another org admin, so the last one walking away
// leaves the whole federation with only DivingHQ to run it.

const { ADMIN_ORG_ID } = require("./admin-org");
const { supportContact } = require("./support");

// Is this user an org admin of that org, or the sysadmin? The one test
// behind every "the federation decides" gate: club approvals, region and
// club setup, club changes, member edits. Reads the JWT's claims only,
// no query. requireOrgAdmin lets any org's admin through, so a route
// still has to ask this about the org it's actually touching.
function isOrgAdminOf(user, orgId) {
  if (!user) return false;
  if (user.is_system_admin) return true;
  return (user.org_roles || []).includes("org_admin") && user.org_id === orgId;
}

const SCOPES = {
  club:   { table: "club_admins",   column: "club_id" },
  region: { table: "region_admins", column: "region_id" },
};

// Returns { status: 200 } when the row went, 404 when there was no such
// admin, 409 when it would have left no live admin. The caller writes the
// audit row after, so a failed audit insert can't abort the removal.
async function removeAdmin(pool, { scope, scopeId, userId, keepOneLive }) {
  const s = SCOPES[scope];
  if (!s) throw new Error(`removeAdmin: unknown scope ${scope}`);
  // pg hands uuids back lower-case, a URL param might not be.
  const uid = String(userId).toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = (await client.query(
      `SELECT a.user_id, (u.deleted_at IS NULL AND u.suspended_at IS NULL) AS live
         FROM ${s.table} a JOIN users u ON u.id = a.user_id
        WHERE a.${s.column} = $1
        FOR UPDATE OF a`,
      [scopeId],
    )).rows;
    const target = rows.find((r) => r.user_id === uid);
    if (!target) {
      await client.query("ROLLBACK");
      return { status: 404 };
    }
    if (keepOneLive && target.live && !rows.some((r) => r.live && r.user_id !== uid)) {
      await client.query("ROLLBACK");
      return { status: 409 };
    }
    await client.query(`DELETE FROM ${s.table} WHERE ${s.column} = $1 AND user_id = $2`, [scopeId, uid]);
    await client.query("COMMIT");
    return { status: 200 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// How many live admins a club or region has, for "is anyone still
// running this?" outside a removal (a region with nobody left can be
// claimed again).
async function liveAdminCount(db, scope, scopeId) {
  const s = SCOPES[scope];
  if (!s) throw new Error(`liveAdminCount: unknown scope ${scope}`);
  const r = await db.query(
    `SELECT count(*)::int AS n
       FROM ${s.table} a JOIN users u ON u.id = a.user_id
      WHERE a.${s.column} = $1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
    [scopeId],
  );
  return r.rows[0].n;
}

// The live admins of a club or region, less `except` (usually whoever is
// acting). Live means not deleted and not suspended, the same bar as
// liveAdminCount.
async function liveAdminIds(db, scope, scopeId, { except = null } = {}) {
  const s = SCOPES[scope];
  if (!s) throw new Error(`liveAdminIds: unknown scope ${scope}`);
  const r = await db.query(
    `SELECT a.user_id
       FROM ${s.table} a JOIN users u ON u.id = a.user_id
      WHERE a.${s.column} = $1 AND ($2::uuid IS NULL OR a.user_id <> $2)
        AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
    [scopeId, except],
  );
  return r.rows.map((row) => row.user_id);
}

// An org's live org admins. Only people who are still members of it: a
// role row in an org someone has since transferred out of isn't
// authority (the token only carries roles in users.org_id), and counting
// it sent notices to people who couldn't act and kept the sysadmin
// fallback from ever firing.
async function liveOrgAdminIds(db, orgId) {
  const r = await db.query(
    `SELECT r.user_id
       FROM user_org_roles r JOIN users u ON u.id = r.user_id AND u.org_id = r.org_id
      WHERE r.org_id = $1 AND r.role = 'org_admin'
        AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
    [orgId],
  );
  return r.rows.map((row) => row.user_id);
}

// Would userId leaving orgId's org admins (deleting their account, losing
// the role, being suspended or moved out) leave a claimed federation with
// no live one? Returns { org_id, org_name } when it would, null when it's
// fine. Only claimed orgs: an unclaimed country has no org admins by
// design, and the Administration org is DivingHQ's own.
//
// Has to run inside the caller's transaction, before the change. It locks
// the org's admin rows the way removeAdmin does, so two admins leaving at
// once can't both see the other still there: the second waits here, and
// by the time it reads, the first one's row is gone (a role removed or an
// account deleted) or their account row shows them suspended. That's why
// the users rows are locked too. A no-key lock, which doesn't hold up
// inserts that merely reference the user.
//
// Live and a member, the same bar as liveOrgAdminIds: a deleted or
// suspended admin can't run anything, and a role row in an org someone
// has left isn't authority.
async function orgAdminHold(client, orgId, userId) {
  if (!orgId || orgId === ADMIN_ORG_ID) return null;
  // Most callers ask about someone who isn't an org admin at all (any
  // member deleting their account). No need to lock anybody for them.
  const org = (await client.query(
    `SELECT o.id, o.name, o.claim_state FROM organisations o
      WHERE o.id = $1
        AND EXISTS (SELECT 1 FROM user_org_roles r
                     WHERE r.org_id = o.id AND r.user_id = $2 AND r.role = 'org_admin')`,
    [orgId, userId],
  )).rows[0];
  if (!org || org.claim_state !== "claimed") return null;
  const rows = (await client.query(
    `SELECT r.user_id, (u.deleted_at IS NULL AND u.suspended_at IS NULL) AS live
       FROM user_org_roles r JOIN users u ON u.id = r.user_id AND u.org_id = r.org_id
      WHERE r.org_id = $1 AND r.role = 'org_admin'
      ORDER BY r.user_id
        FOR UPDATE OF r
        FOR NO KEY UPDATE OF u`,
    [orgId],
  )).rows;
  const uid = String(userId).toLowerCase();
  const target = rows.find((r) => r.user_id === uid);
  if (!target || !target.live) return null;
  if (rows.some((r) => r.live && r.user_id !== uid)) return null;
  return { org_id: org.id, org_name: org.name };
}

// The 409 body for a refusal from orgAdminHold. `self` is for the admin
// themselves (deleting their account, dropping their own role), otherwise
// it's worded for whoever's doing it to them.
function lastOrgAdminRefusal(hold, { self = false } = {}) {
  const org = hold?.org_name || "this organisation";
  return {
    code: "last_org_admin",
    error: self
      ? `You're the last administrator of ${org}. Appoint another administrator first, or contact ${supportContact()}.`
      : `That would leave ${org} with no administrator. Appoint another administrator first, or contact ${supportContact()}.`,
    org_id: hold?.org_id || null,
    org_name: hold?.org_name || null,
  };
}

// Every sysadmin, with no live filter: the heads-ups that go to them
// (new clubs, new federations, claims) always went to all of them. The
// callers that want only live ones still say so in their own query.
async function sysadminIds(db) {
  const r = await db.query("SELECT id FROM users WHERE is_system_admin = true");
  return r.rows.map((row) => row.id);
}

module.exports = {
  isOrgAdminOf, removeAdmin, liveAdminCount, liveAdminIds, liveOrgAdminIds, sysadminIds,
  orgAdminHold, lastOrgAdminRefusal,
};
