// Native transport boundary contracts without an emulator or a real account.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const origin = 'https://staging.example.test';
const modules = Promise.all([
  import('../src/lib/native-boundary.mjs'), import('../src/lib/native-fetch.mjs'),
]);

test('native API origins require explicit HTTPS with no credentials, path or query', async () => {
  const [{ validateApiOrigin }] = await modules;
  assert.equal(validateApiOrigin(origin + '/'), origin);
  for (const bad of [undefined, '', 'http://localhost:3000', 'https://user:pass@example.test', origin + '/api', origin + '?secret=x']) {
    assert.throws(() => validateApiOrigin(bad));
  }
});

test('both native shell schemes resolve API URLs without admitting unrelated opaque origins', async () => {
  const [{ nativeApiUrl }] = await modules;
  for (const base of ['capacitor://localhost/dashboard', 'https://localhost/dashboard']) {
    assert.equal(nativeApiUrl('/api/auth/me', base, origin), origin + '/api/auth/me');
    assert.equal(nativeApiUrl(origin + '/api/events?q=a', base, origin), origin + '/api/events?q=a');
    assert.equal(nativeApiUrl('capacitor://evil/api/auth/me', base, origin), null);
    assert.equal(nativeApiUrl('https://evil.example/api/auth/me', base, origin), null);
    assert.equal(nativeApiUrl('/assets/app.js', base, origin), null);
  }
});

test('deep links admit only the exact API HTTPS origin and no API or encoded path tricks', async () => {
  const [{ nativeLinkPath }] = await modules;
  assert.equal(nativeLinkPath(origin + '/control?event=abc#notice', origin), '/control?event=abc#notice');
  for (const url of ['javascript:alert(1)', 'https://evil.test/control', origin + '/api/auth/me',
    origin + '/socket.io', origin + '//evil.test', origin + '/%2f%2fevil.test']) {
    assert.equal(nativeLinkPath(url, origin), null);
  }
});

async function adapter(overrides = {}) {
  const [, { createNativeFetch }] = await modules;
  const calls = [];
  const fetch = createNativeFetch({
    apiOrigin: origin, localBase: 'capacitor://localhost/',
    fallbackFetch: async (request, options) => { calls.push({ fallback: request.url, ...options }); return new Response('asset'); },
    httpRequest: async (options) => {
      calls.push(options);
      return { status: 200, url: options.url, data: { ok: true },
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'credential', 'set-cookie2': 'credential2' } };
    },
    clearCookies: async () => {}, ...overrides,
  });
  return { fetch, calls };
}

test('native request preserves JSON and disables redirects, while cookie response headers stay private', async () => {
  const { fetch, calls } = await adapter();
  const response = await fetch('/api/auth/login', { method: 'POST', body: '{"username":"a"}', headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(response.headers.has('set-cookie2'), false);
  assert.equal(calls[0].url, origin + '/api/auth/login');
  assert.equal(calls[0].data, '{"username":"a"}');
  assert.equal(calls[0].disableRedirects, true);
  assert.equal(calls[0].headers['X-DivingHQ-Native'], '1');
});

test('non API fetches cannot carry ambient cookies or explicit credentials', async () => {
  const { fetch, calls } = await adapter();
  await fetch('https://outside.test/avatar.png');
  assert.equal(calls[0].credentials, 'omit');
  await assert.rejects(fetch('https://outside.test/api/data', { headers: { Authorization: 'Bearer secret' } }));
  assert.equal(calls.length, 1);
});

test('native adapter handles PDF bytes, JSON null and empty responses', async () => {
  for (const [status, data, type, expected] of [
    [200, Buffer.from('%PDF-1.7').toString('base64'), 'application/pdf', '%PDF-1.7'],
    [200, null, 'application/json', 'null'], [204, '', 'text/plain', ''],
  ]) {
    const { fetch } = await adapter({ httpRequest: async () => ({ status, data, headers: { 'content-type': type } }) });
    assert.equal(await (await fetch('/api/export')).text(), expected);
  }
});

test('native adapter refuses redirects and unsupported multipart before sending malformed data', async () => {
  const { fetch } = await adapter({ httpRequest: async () => ({ status: 302, headers: {}, data: '' }) });
  await assert.rejects(fetch('/api/redirect'), /redirect/);
  const form = new FormData(); form.append('file', 'content');
  await assert.rejects(fetch('/api/upload', { method: 'POST', body: form }), /File uploads/);
});

test('offline native logout drains previously admitted refreshes, clears cookies, then admits new login', async () => {
  let finishFirst;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const order = [];
  const { fetch } = await adapter({
    httpRequest: async ({ url }) => {
      order.push(url.endsWith('/refresh') ? 'refresh' : 'login');
      if (url.endsWith('/refresh')) await first;
      return { status: 200, data: {}, headers: { 'content-type': 'application/json' } };
    },
    clearCookies: async () => { order.push('clear'); },
  });
  const refresh = fetch('/api/refresh');
  const refused = assert.rejects(refresh, /Session changed/);
  const logout = fetch('/api/auth/logout', { method: 'POST' });
  const login = fetch('/api/auth/login', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['refresh']);
  finishFirst();
  await Promise.all([refused, logout, login]);
  assert.deepEqual(order, ['refresh', 'clear', 'login']);
});
