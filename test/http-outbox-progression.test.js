// Run the actual shared sender and durable outbox together. Simulated
// transport boundaries prove that stale progression never reaches either
// transport while real judge/referee work continues to drain on any page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

async function harness({ connected = true } = {}) {
  const { createOutbox, createMemoryBackend } = await import('../src/lib/outbox.js');
  const backend = createMemoryBackend();
  const outbox = createOutbox({ backend, userFingerprint: 'operator-a', maxAttempts: 1 });
  const sent = [], warnings = [], listeners = new Map(), timers = new Map();
  let timerId = 0;
  const socket = {
    connected,
    on(name, callback) { listeners.set(name, callback); },
    emit(name, payload, ack) { sent.push({ transport: 'socket', name, payload }); ack({ ok: true }); },
  };
  const auth = { user: { id: 'operator-a' } };
  const bindings = {
    useAuthStore: () => auth,
    useSocket: () => socket,
    getOutbox: () => outbox,
    showWarning: (message) => warnings.push(message),
    i18n: { global: { t: (key) => key.split('.').reduce((value, part) => value[part], require('../src/locales/en.json')) } },
    fetch: async (url, options) => {
      sent.push({ transport: 'http', url, options });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const bindingKey = `__httpOutbox_${randomUUID().replaceAll('-', '')}`;
  globalThis[bindingKey] = bindings;
  // Only replace module imports; the complete production sender executes.
  const source = fs.readFileSync(require.resolve('../src/composables/useHttpOutbox.js'), 'utf8')
    .replace(/^import .*$/gm, '');
  const names = Object.keys(bindings).join(',');
  let module;
  try {
    module = await import(`data:text/javascript,${encodeURIComponent(`const {${names}} = globalThis.${bindingKey};\n${source}`)}`);
  } finally {
    delete globalThis[bindingKey];
  }
  return {
    module, auth, socket, outbox, backend, sent, warnings,
    async start() { module.armOutboxDrain(auth, socket); await this.flush(); },
    async flush() { await new Promise((resolve) => setImmediate(resolve)); },
    async connect() { socket.connected = true; listeners.get('connect')?.(); await this.flush(); },
    stop() { module.disarmOutboxDrain(); },
  };
}

const eventId = 'f1111111-1111-4111-8111-111111111111';
const cursor = { event_id: eventId, competitor_id: 'diver-one', round_number: 1 };
const status = (value = 'Completed') => ({
  method: 'PUT', url: `/api/events/${eventId}/status`, body: { status: value },
});

test('app-wide startup rejects old progression and drains judge/referee/hold work without mounting Control Room', async () => {
  const h = await harness();
  const obsolete = [
    await h.outbox.push('socket:set_active_diver', cursor),
    await h.outbox.push('event_status_flip', status()),
    await h.outbox.push('event_status_flip', status('Live')),
  ];
  const scores = await h.outbox.push('submit_score', { ...cursor, score: 7.5 });
  const referee = await h.outbox.push('socket:referee_cap_scores', { ...cursor, cap_value: 2 });
  const hold = await h.outbox.push('socket:meet_hold', { event_id: eventId });
  const correction = await h.outbox.push('score_correction', {
    method: 'PUT', url: '/api/scores/score-one', body: { score: 8 },
  });
  await h.start();
  for (const key of obsolete) {
    const row = await h.outbox.getEntry(key);
    assert.equal(row.status, 'rejected');
    assert.match(row.last_error, /take control/);
  }
  for (const key of [scores, referee, hold, correction]) assert.equal((await h.outbox.getEntry(key)).status, 'synced');
  assert.deepEqual(h.sent.map((call) => call.name || call.url), [
    'submit_score', 'referee_cap_scores', 'meet_hold', '/api/scores/score-one',
  ]);
  assert.equal(h.warnings.length, 1, 'one explanation for the batch, not a toast per old entry');
  h.stop();
});

test('reconnect rejects obsolete entries before an offline socket can park them for later', async () => {
  const h = await harness({ connected: false });
  const key = await h.outbox.push('socket:set_active_diver', cursor);
  await h.start();
  h.module.drainOutboxNow();
  await h.flush();
  assert.equal((await h.outbox.getEntry(key)).status, 'rejected');
  await h.connect();
  assert.equal(h.sent.length, 0);
  assert.equal(h.warnings.length, 1);
  h.stop();
});

test('failed manual Retry and stale inflight recovery cannot replay old control actions', async () => {
  const h = await harness();
  const failed = await h.outbox.push('socket:set_active_diver', cursor);
  await h.outbox.drain({ send: async () => { throw new Error('legacy disconnected send'); } });
  assert.equal((await h.outbox.getEntry(failed)).status, 'failed');
  const inflight = await h.outbox.push('event_status_flip', status());
  const row = await h.outbox.getEntry(inflight);
  await h.backend.put({ ...row, status: 'inflight', last_attempt_at: '2026-01-01T00:00:00Z' });
  await h.start();
  assert.equal((await h.outbox.getEntry(inflight)).status, 'rejected');
  assert.equal(await h.module.retryFailedActions(), 1);
  await h.flush();
  assert.equal((await h.outbox.getEntry(failed)).status, 'rejected');
  assert.equal(await h.module.retryFailedActions(), 0);
  assert.equal(h.sent.length, 0);
  h.stop();
});

test('conflict Retry and a different HTTP action label cannot bypass the progression fence', async () => {
  const h = await harness();
  const key = await h.outbox.push('legacy_status', {
    ...status(), url: `https://divinghq.app/api/events/${eventId}/status?legacy=1`,
  });
  await h.outbox.drain({ send: async () => {
    const err = new Error('old control conflict'); err.kind = 'conflict'; throw err;
  } });
  assert.equal((await h.outbox.getEntry(key)).status, 'conflict');
  await h.outbox.resolveConflict(key, 'retry');
  await h.start();
  assert.equal((await h.outbox.getEntry(key)).status, 'rejected');
  assert.equal(h.sent.length, 0);
  h.stop();
});

test('new progression is refused before persistence, including its ownership token', async () => {
  const h = await harness({ connected: false });
  const sender = h.module.useHttpOutbox();
  await assert.rejects(sender.queueSocketAction('set_active_diver', {
    ...cursor, control_token: 'must-not-be-persisted',
  }), /take control/);
  await assert.rejects(sender.queueAction({
    ...status(), body: { status: 'Completed', control_token: 'must-not-be-persisted' }, actionType: 'event_status_flip',
  }), /take control/);
  assert.deepEqual(await h.outbox.list({}), []);
  assert.equal(h.sent.length, 0);
  h.stop();
});
