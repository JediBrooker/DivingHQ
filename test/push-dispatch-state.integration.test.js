// A device can acknowledge an alert before delivery accounting finishes.
// Force that ordering against PostgreSQL without external providers or sleeps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const webpush = require('web-push');
const { applyTestDbDefault, assertTestDatabase } = require('./support/test-db');
applyTestDbDefault();
require('dotenv').config({ quiet: true });
assertTestDatabase();
const createPushEngine = require('../lib/push');
const { createNativePush } = require('../lib/native-push');

test('dispatch completion cannot undo an acknowledgement or retirement', async t => {
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
    host: process.env.DB_HOST || process.env.PGHOST, user: process.env.DB_USER || process.env.PGUSER,
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD, database: process.env.DB_DATABASE || process.env.PGDATABASE,
    port: Number(process.env.DB_PORT || process.env.PGPORT || 5432), connectionTimeoutMillis: 2000,
  });
  let client;
  try { client = await pool.connect(); } catch { await pool.end(); t.skip('test Postgres unavailable'); return; }
  const previousKeys = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  const keys = webpush.generateVAPIDKeys();
  // Never contact a delivery provider. SQL and the notification engine are real.
  let providerFails = false;
  t.mock.method(webpush, 'sendNotification', async () => {
    if (providerFails) throw Object.assign(new Error('fixture provider failure'), { statusCode: 503 });
    return { statusCode: 201 };
  });
  try {
    await client.query('BEGIN');
    const suffix = randomUUID();
    const orgId = (await client.query("INSERT INTO organisations(name,slug,country_code,status) VALUES($1,$1,'TST','active') RETURNING id", [`dispatch-${suffix}`])).rows[0].id;
    const userId = (await client.query("INSERT INTO users(username,password,full_name,org_id,token_version) VALUES($1,'x','Dispatch fixture',$2,0) RETURNING id", [`dispatch-${suffix}`, orgId])).rows[0].id;
    for (const channel of ['socket-only', 'no-subscriptions', 'provider-success', 'provider-failure']) {
      for (const beforeCompletion of ['acknowledged', 'expired', 'pending']) {
        await t.test(`${channel} preserves ${beforeCompletion}`, async () => {
          await client.query('DELETE FROM push_subscriptions WHERE user_id=$1', [userId]);
          const configured = channel !== 'socket-only';
          process.env.VAPID_PUBLIC_KEY = configured ? keys.publicKey : '';
          process.env.VAPID_PRIVATE_KEY = configured ? keys.privateKey : '';
          providerFails = channel === 'provider-failure';
          if (channel.startsWith('provider-')) {
            await client.query('INSERT INTO push_subscriptions(user_id,endpoint,p256dh_key,auth_key) VALUES($1,$2,$3,$4)',
              [userId, `https://push.example.invalid/${randomUUID()}`, 'fixture', 'fixture']);
          }
          let engine, intervened = false, emittedId;
          const interceptedPool = { query: async (sql, params) => {
            // Deliberately interleave the user's acknowledgement (or sign-off
            // retirement) after socket delivery and before its SQL rollup.
            // This models a slow provider/DB completion without timing sleeps.
            if (!intervened && /UPDATE notifications\s+SET status = '(sent|failed)'/.test(sql)) {
              intervened = true;
              assert.equal(params[0], emittedId);
              if (beforeCompletion === 'acknowledged') await engine.acknowledgeNotification(emittedId, userId);
              if (beforeCompletion === 'expired') await client.query("UPDATE notifications SET status='expired' WHERE id=$1", [emittedId]);
            }
            return client.query(sql, params);
          } };
          engine = createPushEngine({ pool: interceptedPool, io: { to: () => ({ emit: (_name, row) => { emittedId = row.id; } }) } });
          t.mock.method(engine.native, 'deliver', async () => ({ accepted: 0, failed: 0 }));
          const result = await engine.sendNotification([userId], { category: 'event_live', title: 'Fixture live' });
          assert.equal(intervened, true, 'the dispatch completion ran after the competing state change');
          assert.deepEqual(result.notification_ids, [emittedId]);
          const row = (await client.query('SELECT status,acknowledged_at,sent_at,failure_reason FROM notifications WHERE id=$1', [emittedId])).rows[0];
          const expected = beforeCompletion === 'pending' ? (providerFails ? 'failed' : 'sent') : beforeCompletion;
          assert.equal(row.status, expected);
          assert.equal(!!row.acknowledged_at, beforeCompletion === 'acknowledged');
          if (beforeCompletion !== 'pending') {
            assert.equal(row.sent_at, null);
            assert.equal(row.failure_reason, null);
          }
          assert.equal(result.failed, providerFails ? 1 : 0, 'provider failure accounting is retained');
          const inbox = await engine.listForUser(userId);
          if (beforeCompletion === 'expired') assert.equal(inbox.some(n => n.id === emittedId), false, 'retired banners never return to the inbox');
        });
      }
    }
    for (const accepted of [true, false]) {
      for (const beforeCompletion of ['acknowledged', 'expired', 'pending']) {
        await t.test(`native test delivery accepted=${accepted} preserves ${beforeCompletion}`, async () => {
          const deviceId = randomUUID();
          await client.query(`INSERT INTO native_push_devices(id,user_id,platform,environment,token,revoke_hash,token_version,session_expires_at,revision)
            VALUES($1,$2,'ios','production',$3,$3,0,now()+interval '1 hour',1)`, [deviceId, userId, deviceId.replaceAll('-', '').repeat(2)]);
          let notificationId;
          const native = createNativePush({ pool: client, provider: {
            configured: { ios: true, android: false },
            send: async (_device, notification) => {
              notificationId = notification.id;
              // The real device can open the alert before the provider reply.
              if (beforeCompletion === 'acknowledged') await client.query("UPDATE notifications SET status='acknowledged',acknowledged_at=now() WHERE id=$1", [notificationId]);
              if (beforeCompletion === 'expired') await client.query("UPDATE notifications SET status='expired' WHERE id=$1", [notificationId]);
              return { accepted, reason: accepted ? null : 'fixture_failure' };
            },
          } });
          if (accepted) assert.equal((await native.test({ id: userId }, deviceId)).accepted, true);
          else await assert.rejects(native.test({ id: userId }, deviceId), { status: 503 });
          assert.ok(notificationId, 'the provider observed the real notification');
          const row = (await client.query('SELECT status,acknowledged_at,sent_at FROM notifications WHERE id=$1', [notificationId])).rows[0];
          assert.equal(row.status, beforeCompletion === 'pending' ? (accepted ? 'sent' : 'failed') : beforeCompletion);
          assert.equal(!!row.acknowledged_at, beforeCompletion === 'acknowledged');
          assert.equal(!!row.sent_at, beforeCompletion === 'pending' && accepted);
        });
      }
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
    for (const [i, key] of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'].entries()) {
      if (previousKeys[i] === undefined) delete process.env[key]; else process.env[key] = previousKeys[i];
    }
  }
});
