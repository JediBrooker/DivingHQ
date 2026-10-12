const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const createAuthRouter = require('../routes/auth');
const { isKnownUnderMinimumAge } = require('../lib/direct-use-age');

const now = new Date('2026-10-13T00:00:00Z');
test('minimum age uses the thirteenth calendar birthday in UTC', () => {
  assert.equal(isKnownUnderMinimumAge('2013-10-14', now), true);
  assert.equal(isKnownUnderMinimumAge('2013-10-13', now), false);
  assert.equal(isKnownUnderMinimumAge('2013-10-12', now), false);
  assert.equal(isKnownUnderMinimumAge('2012-02-29', new Date('2025-02-28T23:59:59Z')), true);
  assert.equal(isKnownUnderMinimumAge('2012-02-29', new Date('2025-03-01T00:00:00Z')), false);
  for (const value of [null, undefined, '', 'bad', '2013-02-30', '13-10-2013']) {
    assert.equal(isKnownUnderMinimumAge(value, now), false, String(value));
  }
});

async function withServer(t, { row, signups = true } = {}) {
  let queries = 0;
  const pass = (_req, _res, next) => next();
  const pool = { async query() { queries++; return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }; } };
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter({ pool, features: { enabled: () => signups }, authLimiter: pass,
    verifyToken: pass, optionalAuth: pass, JWT_SECRET: 'age-test-secret', JWT_EXPIRY: '1h',
    buildTokenPayload: async () => ({ id: row.id }),
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { queryCount: () => queries, async post(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() };
  } };
}

test('both public registration APIs refuse missing or non-boolean declarations before database writes', async t => {
  const app = await withServer(t);
  for (const path of ['/api/auth/register', '/api/auth/register-org']) {
    for (const value of [undefined, false, null, 1, 'true', [], {}]) {
      const response = await app.post(path, { age_13_or_older: value });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'age_confirmation_required');
      assert.equal(response.cookie, null);
    }
    const valid = await app.post(path, { age_13_or_older: true });
    assert.equal(valid.status, 400); // subsequent required account fields
    assert.notEqual(valid.body.code, 'age_confirmation_required');
  }
  assert.equal(app.queryCount(), 0);
});

test('disabled registration still fails closed before age validation', async t => {
  const app = await withServer(t, { signups: false });
  for (const path of ['/api/auth/register', '/api/auth/register-org']) {
    assert.equal((await app.post(path, {})).body.code, 'signups_disabled');
  }
});

test('known under-13 login refuses a session even with a valid password and 2FA enabled', async t => {
  const row = { id: '11111111-1111-1111-1111-111111111111', password: await bcrypt.hash('test-password', 4),
    date_of_birth: new Date().toISOString().slice(0, 10), email_verified_at: new Date(), totp_enabled_at: new Date(), org_status: 'active' };
  const app = await withServer(t, { row });
  const wrong = await app.post('/api/auth/login', { username: 'junior', password: 'wrong' });
  assert.equal(wrong.status, 401);
  assert.notEqual(wrong.body.code, 'minimum_age');
  const response = await app.post('/api/auth/login', { username: 'junior', password: 'test-password' });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'minimum_age');
  assert.equal(response.body.totp_token, undefined);
  assert.equal(response.cookie, null);
});


test('a valid earlier 2FA challenge cannot mint a session after DOB establishes under-13 age', async t => {
  const secret = speakeasy.generateSecret().base32;
  const row = { id: '11111111-1111-1111-1111-111111111111',
    date_of_birth: new Date().toISOString().slice(0, 10), totp_enabled_at: new Date(), totp_secret: secret };
  const app = await withServer(t, { row });
  const response = await app.post('/api/auth/login/totp', {
    totp_token: jwt.sign({ sub: row.id, type: 'totp_pending' }, 'age-test-secret', { expiresIn: '5m' }),
    code: speakeasy.totp({ secret, encoding: 'base32' }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'minimum_age');
  assert.equal(response.cookie, null);
});
