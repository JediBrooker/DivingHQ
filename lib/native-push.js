const { createHash } = require('node:crypto');
const { isUuid } = require('./uuid');
const { createNativePushProvider } = require('./native-push-provider');
const hash = value => createHash('sha256').update(value).digest('hex');
const secretValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
function validateRegistration(body) {
  if (!isUuid(body?.id) || !secretValid(body?.revoke_key) || !Number.isSafeInteger(body?.revision) || body.revision < 0) throw bad('Invalid installation identity');
  if (!['ios', 'android'].includes(body.platform) || !['development', 'production'].includes(body.environment)) throw bad('Invalid platform');
  if (typeof body.token !== 'string' || (body.platform === 'ios' ? !/^[a-fA-F0-9]{32,512}$/.test(body.token) : !/^[\w:.-]{20,4096}$/.test(body.token))) throw bad('Invalid push token');
}
function createNativePush({ pool, provider = createNativePushProvider() }) {
  async function register(user, body) {
    validateRegistration(body);
    if (!provider.configured[body.platform] || (body.platform === 'ios' && provider.environments && !provider.environments.includes(body.environment))) throw bad('Notifications are not configured for this platform yet', 503);
    if (body.user_id !== user.id) throw bad('Account changed during registration', 409);
    if (!Number.isInteger(user.tv) || !Number.isFinite(user.exp)) throw bad('Sign in again before enabling notifications', 401);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The tombstone can precede registration (offline logout racing a slow
      // request). Row locking orders enable/revoke and rejects stale revisions.
      await client.query(`INSERT INTO native_push_installations(id,revoke_hash,revision)
        VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [body.id, hash(body.revoke_key), body.revision]);
      const existing = await client.query('SELECT revoke_hash, revision, revoked FROM native_push_installations WHERE id=$1 FOR UPDATE', [body.id]);
      const installation = existing.rows[0];
      if (installation.revoke_hash !== hash(body.revoke_key)) throw bad('Installation identity mismatch', 403);
      if (Number(installation.revision) > body.revision || (Number(installation.revision) === body.revision && installation.revoked)) throw bad('Registration superseded', 409);
      await client.query('UPDATE native_push_installations SET revision=$2, revoked=false, updated_at=now() WHERE id=$1', [body.id, body.revision]);
      // A freshly installed app can receive the previous OS token. Reassign it
      // atomically; the old installation's revoke key must not disable the new one.
      await client.query('DELETE FROM native_push_devices WHERE platform = $1 AND environment = $2 AND token = $3 AND id <> $4', [body.platform, body.environment, body.token, body.id]);
      await client.query(`INSERT INTO native_push_devices (id,user_id,platform,environment,token,revoke_hash,token_version,session_expires_at,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9) ON CONFLICT(id) DO UPDATE SET
        user_id=EXCLUDED.user_id, platform=EXCLUDED.platform, environment=EXCLUDED.environment, token=EXCLUDED.token,
        revision=EXCLUDED.revision, token_version=EXCLUDED.token_version, session_expires_at=EXCLUDED.session_expires_at,
        enabled=true, revoked_at=NULL, updated_at=now(), last_error=NULL`,
      [body.id, user.id, body.platform, body.environment, body.token, hash(body.revoke_key), user.tv, user.exp, body.revision]);
      await client.query('COMMIT');
      return { enabled: true };
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }
  async function revoke(body) {
    if (!isUuid(body?.id) || !secretValid(body?.revoke_key) || !Number.isSafeInteger(body?.revision) || body.revision < 0) throw bad('Invalid installation identity');
    // Narrow, unguessable revoke-only capability permits offline logout cleanup
    // after the session has gone. It cannot read data or enable notifications.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`INSERT INTO native_push_installations(id,revoke_hash,revision,revoked)
        VALUES($1,$2,$3,true) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision, revoked=true, updated_at=now()
        WHERE native_push_installations.revoke_hash=EXCLUDED.revoke_hash AND native_push_installations.revision<=EXCLUDED.revision RETURNING id`, [body.id, hash(body.revoke_key), body.revision]);
      if (r.rowCount) await client.query('UPDATE native_push_devices SET enabled=false, revoked_at=now(), updated_at=now(), revision=$3 WHERE id=$1 AND revoke_hash=$2 AND revision<=$3', [body.id, hash(body.revoke_key), body.revision]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }

  }
  async function status(userId, id) {
    if (!isUuid(id)) throw bad('Invalid installation identity');
    const r = await pool.query(`SELECT d.platform, d.enabled, d.revoked_at, d.last_accepted_at, d.last_error,
      (d.session_expires_at > now() AND d.token_version=u.token_version AND u.deleted_at IS NULL AND u.suspended_at IS NULL
      AND (u.is_system_admin OR o.status='active')) AS session_active FROM native_push_devices d JOIN users u ON u.id=d.user_id
      LEFT JOIN organisations o ON o.id=u.org_id WHERE d.id=$1 AND d.user_id=$2`, [id, userId]);
    return { configured: provider.configured, environments: provider.environments || ['production', 'development'], device: r.rows[0] || null };
  }
  async function deliver(userId, notification, onlyId = null) {
    const r = await pool.query(`SELECT d.* FROM native_push_devices d JOIN users u ON u.id=d.user_id
      LEFT JOIN organisations o ON o.id=u.org_id
      WHERE d.user_id=$1 AND d.enabled AND d.revoked_at IS NULL AND d.session_expires_at>now()
      AND d.token_version=u.token_version AND u.deleted_at IS NULL AND u.suspended_at IS NULL
      AND (u.is_system_admin OR o.status='active') AND ($2::uuid IS NULL OR d.id=$2)`, [userId, onlyId]);
    let accepted = 0, failed = 0;
    for (const d of r.rows) {
      // Recheck revocation/ownership immediately before submission. Providers may
      // retain an already accepted alert; its payload contains no private content.
      const live = await pool.query('SELECT 1 FROM native_push_devices WHERE id=$1 AND user_id=$2 AND token=$3 AND enabled AND revoked_at IS NULL', [d.id, userId, d.token]);
      if (!live.rowCount) continue;
      let result;
      try { result = await provider.send(d, notification); } catch { result = { accepted: false, reason: 'provider_unreachable' }; }
      if (result.accepted) accepted++; else failed++;
      await pool.query(`UPDATE native_push_devices SET last_accepted_at=CASE WHEN $4 THEN now() ELSE last_accepted_at END,
        last_error=$5, revoked_at=CASE WHEN $6 THEN now() ELSE revoked_at END
        WHERE id=$1 AND user_id=$2 AND token=$3`, [d.id, userId, d.token, result.accepted, result.reason || null, !!result.invalid]);
    }
    return { accepted, failed };
  }
  async function test(user, id) {
    if (!isUuid(id)) throw bad('Invalid installation identity');
    const r = await pool.query(`UPDATE native_push_devices SET last_test_at=now() WHERE id=$1 AND user_id=$2
      AND enabled AND revoked_at IS NULL AND (last_test_at IS NULL OR last_test_at < now()-interval '30 seconds') RETURNING id`, [id, user.id]);
    if (!r.rowCount) throw bad('Enable this device first, or wait 30 seconds before another test', 409);
    const n = await pool.query(`INSERT INTO notifications(user_id,category,title,body,action_url,expires_at)
      VALUES($1,'push_test','Test notification','Notifications are working on this device.','/settings',now()+interval '10 minutes') RETURNING id`, [user.id]);
    const result = await deliver(user.id, { id: n.rows[0].id, ttl_seconds: 600 }, id);
    await pool.query("UPDATE notifications SET status=$2::varchar, sent_at=CASE WHEN $2::varchar='sent' THEN now() ELSE NULL END WHERE id=$1", [n.rows[0].id, result.accepted ? 'sent' : 'failed']);
    if (!result.accepted) throw bad('The notification provider did not accept the test. Try enabling notifications again.', 503);
    return { accepted: true, notification_id: n.rows[0].id };
  }
  async function notification(userId, id) {
    if (!isUuid(id)) throw bad('Notification not found', 404);
    const r = await pool.query(`SELECT id,category,title,body,data,action_url,expires_at,created_at FROM notifications
      WHERE id=$1 AND user_id=$2 AND status <> 'expired' AND (expires_at IS NULL OR expires_at>now())`, [id, userId]);
    if (!r.rowCount) throw bad('Notification not found or expired', 404);
    return r.rows[0];
  }
  return { register, revoke, status, deliver, test, notification, configured: provider.configured };
}
module.exports = { createNativePush, validateRegistration };
