// Taking someone off a club's or region's admin list without ever
// leaving it with nobody alive to run it.
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

module.exports = { removeAdmin, liveAdminCount };
