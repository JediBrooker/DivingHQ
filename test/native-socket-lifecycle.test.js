// Deterministic native lifecycle tests: no device, real network or sleeping.
// Exercise the production retry/auth helpers with a controlled socket and clock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const helpers = import('../src/lib/native-socket.mjs');

async function harness() {
  const { createNativeSocketRecovery } = await helpers;
  const socket = new EventEmitter();
  let connects = 0;
  let expired = 0;
  let current = true;
  let paused = false;
  let sequence = 0;
  const timers = new Map();
  socket.connect = () => { connects += 1; };
  const recovery = createNativeSocketRecovery({
    socket, isCurrent: () => current, isPaused: () => paused,
    onSessionExpired: () => { expired += 1; },
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return {
    socket, recovery, timers,
    get connects() { return connects; },
    get expired() { return expired; },
    set current(value) { current = value; },
    set paused(value) { paused = value; },
    fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.fn();
      return timer.delay;
    },
  };
}

test('temporary ticket refusal retries with a fresh request and recovers the socket', async () => {
  const { createSocketTicketAuth } = await helpers;
  const h = await harness();
  let requests = 0;
  let attempt;
  const admissions = [];
  const auth = createSocketTicketAuth({
    userId: 'judge-a',
    requestTicket: async () => {
      requests += 1;
      return requests === 1
        ? new Response('{"error":"temporary outage"}', { status: 503 })
        : new Response(JSON.stringify({ user_id: 'judge-a', ticket: `fresh-${requests}` }));
    },
    onSessionExpired() { assert.fail('503 must not end the session'); },
  });
  h.socket.connect = () => {
    attempt = auth((payload) => {
      admissions.push(payload.ticket);
      h.socket.emit(payload.ticket === 'invalid' ? 'connect_error' : 'connect');
    });
  };
  h.socket.connect();
  await attempt;
  assert.equal(h.timers.size, 1);
  assert.equal(h.fire(), 1000);
  await attempt;
  assert.deepEqual(admissions, ['invalid', 'fresh-2']);
  assert.equal(h.timers.size, 0);
  h.socket.connect();
  await attempt;
  assert.deepEqual(admissions, ['invalid', 'fresh-2', 'fresh-3']);
  h.recovery.dispose();
});

test('retry backoff is bounded, duplicate errors share one timer, success resets delay', async () => {
  const h = await harness();
  for (const expected of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    h.socket.emit('connect_error');
    h.socket.emit('connect_error');
    assert.equal(h.timers.size, 1);
    assert.equal(h.fire(), expected);
  }
  h.socket.emit('connect');
  h.socket.emit('connect_error');
  assert.equal(h.fire(), 1000);
  h.recovery.dispose();
});

test('a released lease cancels retries and cannot be revived by a late callback', async () => {
  const h = await harness();
  h.socket.emit('connect_error');
  const late = [...h.timers.values()][0].fn;
  h.recovery.dispose();
  assert.equal(h.timers.size, 0);
  late();
  h.socket.emit('connect_error');
  h.socket.emit('disconnect', 'io server disconnect');
  assert.equal(h.connects, 0);
  assert.equal(h.expired, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.socket.listenerCount('connect_error'), 0);
});

test('a paused or replaced lease cannot reconnect or refresh another session', async () => {
  const h = await harness();
  h.socket.emit('connect_error');
  const late = [...h.timers.values()][0].fn;
  h.paused = true;
  h.recovery.cancel();
  late();
  h.socket.emit('connect_error');
  h.socket.emit('disconnect', 'io server disconnect');
  assert.equal(h.timers.size, 0);
  assert.equal(h.connects, 0);
  assert.equal(h.expired, 0);
  h.paused = false;
  h.current = false;
  h.socket.emit('connect_error');
  h.socket.emit('disconnect', 'io server disconnect');
  assert.equal(h.timers.size, 0);
  assert.equal(h.expired, 0);
  h.current = true;
  h.socket.emit('disconnect', 'io server disconnect');
  assert.equal(h.expired, 1);
  assert.equal(h.timers.size, 1);
  h.recovery.dispose();
});

test('ticket auth rejects account mismatch and reports only terminal session refusals', async () => {
  const { createSocketTicketAuth } = await helpers;
  const answers = [
    new Response(JSON.stringify({ user_id: 'judge-b', ticket: 'other-account' })),
    new Response('{"error":"expired"}', { status: 401 }),
    new Response('{"error":"missing"}', { status: 403 }),
    new Response('{"error":"unavailable"}', { status: 503 }),
  ];
  let expired = 0;
  const auth = createSocketTicketAuth({
    userId: 'judge-a', requestTicket: async () => answers.shift(),
    onSessionExpired: () => { expired += 1; },
  });
  for (let i = 0; i < 4; i += 1) {
    let result;
    await auth((value) => { result = value; });
    assert.deepEqual(result, { ticket: 'invalid' });
  }
  assert.equal(expired, 2);
});
