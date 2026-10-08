// Device-independent exercise of share transport, hostile input and identity
// races. OS sheet presentation itself is covered by the device acceptance run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const modules = Promise.all([import('../src/lib/native-integrations.mjs'), import('../src/lib/native-files.mjs')]);
const origin = 'https://divinghq.app';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(extra = {}) {
  const [{ createNativeIntegrations }] = await modules;
  const shares = [], writes = [], deleted = [], requests = [];
  const api = createNativeIntegrations({
    apiOrigin: origin, localBase: 'capacitor://localhost/', reportError: error => { throw error; },
    filesystem: { rmdir: async opts => deleted.push(opts), deleteFile: async opts => deleted.push(opts), writeFile: async opts => { writes.push(opts); return { uri: `file:///private/${opts.path}` }; } },
    browser: { open: async () => {}, close: async () => {} },
    share: { share: async opts => { shares.push(opts); } },
    encode: async () => 'ZmlsZQ==', schedule: () => {},
    request: async (path, options) => { requests.push({ path, options }); return new Response('file', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="results.pdf"' } }); },
    ...extra,
  });
  return { api, shares, writes, deleted, requests };
}
test('native downloads use private cache and the credentialed no-redirect fetch boundary', async () => {
  const { api, shares, writes, requests } = await fixture();
  await api.download('/api/events/id/results.pdf');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.redirect, 'error');
  assert.match(writes[0].path, /^divinghq-exports\/[a-f\d-]+\/results.pdf$/);
  assert.deepEqual(shares[0].files, [`file:///private/${writes[0].path}`]);
});
test('logout while response body is being read never writes or shares previous account bytes', async () => {
  const body = deferred(), started = deferred();
  const { api, shares, writes } = await fixture({ request: async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: () => { started.resolve(); return body.promise; } }) });
  const download = api.download('/api/results.pdf');
  await started.promise;
  await api.clearSession();
  body.resolve(new Blob(['old user'], { type: 'application/pdf' }));
  await assert.rejects(download, /Account changed/);
  assert.equal(writes.length, 0); assert.equal(shares.length, 0);
});
test('logout during file encoding never writes or shares the old document', async () => {
  const data = deferred(), started = deferred();
  const { api, writes, shares } = await fixture({ encode: () => { started.resolve(); return data.promise; } });
  const exportTask = api.shareBlob(new Blob(['private'], { type: 'text/csv' }), 'members.csv');
  await started.promise; await api.clearSession(); data.resolve('cHJpdmF0ZQ==');
  await assert.rejects(exportTask, /Account changed/);
  assert.equal(writes.length, 0); assert.equal(shares.length, 0);
});
test('failed downloads and unexpected HTML never become shared files', async () => {
  for (const response of [new Response('{"error":"Denied"}', { status: 403 }), new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })]) {
    const { api, shares, writes } = await fixture({ request: async () => response });
    await assert.rejects(api.download('/api/results.pdf'));
    assert.equal(shares.length, 0); assert.equal(writes.length, 0);
  }
});
test('export path/filename restrictions reject external and encoded file traversal', async () => {
  const [, { exportRequestPath, safeExportName, safeExternalUrl }] = await modules;
  for (const value of ['https://evil.test/api/results.pdf', '/api/a%2fresults.pdf', '/api/%2e%2e/results.pdf', '/api/auth/me', '/api\\results.pdf', '//evil.test/api/results.pdf']) {
    assert.equal(exportRequestPath(value, 'capacitor://localhost/', origin), null, value);
  }
  assert.equal(exportRequestPath('/api/reports?format=csv', 'capacitor://localhost/', origin), '/api/reports?format=csv');
  assert.equal(safeExportName('../../sensitive.html', 'application/pdf'), '______sensitive.pdf');
  assert.throws(() => safeExportName('file.html', 'text/html'));
  for (const value of ['javascript:alert(1)', 'http://example.test', 'https://user:pass@example.test']) assert.throws(() => safeExternalUrl(value, origin));
});
test('verified app association endpoints return JSON without redirect or SPA fallback', async () => {
  const express = require('express');
  const { installAppAssociations, appleAssociation, androidAssociation } = require('../lib/app-associations');
  const app = express(); installAppAssociations(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const [path, expected] of [['apple-app-site-association', appleAssociation], ['assetlinks.json', androidAssociation]]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/.well-known/${path}`);
      assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /application\/json/); assert.deepEqual(await res.json(), expected);
    }
    assert.equal(appleAssociation.applinks.details[0].paths.some(path => path.startsWith('/api')), false);
    assert.ok(appleAssociation.applinks.details[0].paths.includes('/settings'), 'Settings links match the exact screen, not only descendants');
    assert.equal(androidAssociation[0].target.sha256_cert_fingerprints[0], '31:91:94:E5:72:A2:43:76:8D:C3:27:73:21:0A:55:8D:B8:C7:E3:FE:7B:1D:80:61:62:4C:0E:46:35:56:ED:2F');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('failed share presentation still schedules private export cleanup', async () => {
  const scheduled = [];
  const { api, deleted } = await fixture({ share: { share: async () => { throw new Error('Chooser unavailable'); } }, schedule: (run, delay) => scheduled.push({ run, delay }) });
  await assert.rejects(api.shareBlob(new Blob(['private'], { type: 'application/pdf' }), 'private.pdf'), /Chooser unavailable/);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 60 * 60 * 1000);
  await scheduled[0].run();
  assert.match(deleted.at(-1).path, /^divinghq-exports\/[a-f\d-]+$/);
});
test('logout during an admitted cache write drains and deletes it before the next identity', async () => {
  const writing = deferred(), started = deferred();
  const deleted = [];
  const { api, shares } = await fixture({ filesystem: {
    rmdir: async opts => deleted.push(opts), deleteFile: async opts => deleted.push(opts),
    writeFile: () => { started.resolve(); return writing.promise; },
  } });
  const task = api.shareBlob(new Blob(['private'], { type: 'application/pdf' }), 'private.pdf');
  await started.promise;
  const logout = api.clearSession();
  writing.resolve({ uri: 'file:///private/test.pdf' });
  await assert.rejects(task, /Account changed/); await logout;
  assert.equal(shares.length, 0); assert.ok(deleted.length >= 2);
});
test('warm links reject unknown/API/external targets and cold links clear on identity change', async () => {
  const navigated = [], listeners = [];
  const { api } = await fixture({ eventDocument: { addEventListener: (name, handler) => listeners.push(handler) } });
  assert.equal(await api.openLink('/control?event=abc'), true);
  await api.clearSession();
  api.install({ resolve: path => ({ matched: [{ path: path.startsWith('/control') ? '/control' : '/:pathMatch(.*)*' }] }), push: async path => navigated.push(path) });
  await Promise.resolve();
  assert.deepEqual(navigated, []);
  assert.equal(await api.openLink('/control?event=abc'), true);
  for (const target of ['/nonsense', '/api/auth/me', 'https://evil.test/control', 'https://divinghq.app/%2e%2e/control', '/\\evil.test/control']) assert.equal(await api.openLink(target), false, target);
  assert.deepEqual(navigated, ['/control?event=abc']);
  let prevented = false;
  listeners[0]({ button: 0, target: { closest: () => ({ getAttribute: () => 'https://[' }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});
