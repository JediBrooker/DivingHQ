// Exercise lease generations and the real socket progression gate without a DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createEventControl, LEASE_MS } = require('../lib/event-control');
const attachSocket = require('../routes/socket');
const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function harness({ now, query = async () => ({ rows: [] }), statusQuery = async () => ({ rows: [{ status: "Live" }] }) } = {}) {
  const control = createEventControl({ now });
  const active = {}, holds = {}, broadcasts = [];
  let handshake, connection;
  const io = {
    use(fn) { handshake = fn; }, on(_, fn) { connection = fn; },
    to(room) { return { emit: (name, data) => broadcasts.push({ room, name, data }) }; },
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  };
  attachSocket({ io, pool: { query: (sql, params) => sql === "SELECT status FROM events WHERE id = $1" ? statusQuery(sql, params) : query(sql, params) }, JWT_SECRET: 'test-event-control',
    socketRequireRole: s => !!s.userId && !s.maintenance,
    socketCanManageEvent: async s => !s.denied,
    isTokenVersionCurrent: async () => true,
    eventControl: control, activeDivers: active, meetHolds: holds,
  });
  async function connect(id, { authenticated = true } = {}) {
    const handlers = new Map(), emitted = [];
    const socket = { id, disconnected: false, denied: false,
      handshake: { auth: authenticated ? { token: jwt.sign({ id: USER }, 'test-event-control') } : {}, headers: {}, address: id },
      on: (name, fn) => handlers.set(name, fn),
      emit: (name, data) => emitted.push({ name, data }),
      join() {}, leave() {}, disconnect() { socket.disconnected = true; handlers.get('disconnect')?.(); },
    };
    await new Promise(resolve => handshake(socket, resolve)); connection(socket);
    async function ask(name, data) {
      let reply;
      await handlers.get(name)(data, r => { reply = r; });
      return reply;
    }
    return { socket, ask, emitted };
  }
  return { control, active, holds, broadcasts, connect };
}
const claim = (s, event = EVENT, extra = {}) => s.ask('claim_event_control', { event_id: event, protocol: 2, ...extra });
const advance = (s, token, event = EVENT, extra = {}) => s.ask('set_active_diver', { event_id: event, competitor_id: USER, round_number: 1, control_token: token, ...extra });

test('same-account sockets cannot both drive an event; independent events remain independent', async () => {
  const h = harness(); const a = await h.connect('a'), b = await h.connect('b');
  const one = await claim(a), two = await claim(b, OTHER);
  assert.equal(one.ok, true); assert.equal(two.ok, true);
  assert.equal((await claim(b)).error, 'control_conflict');
  assert.equal((await advance(b, one.control_token)).error, 'control_lost');
  assert.equal((await advance(a, one.control_token)).ok, true);
  assert.equal((await advance(b, two.control_token, OTHER)).ok, true);
  assert.equal(h.active[EVENT].control_token, undefined);
  assert.equal(h.broadcasts.find(x => x.name === 'state_update').data.control_token, undefined);
});

test('explicit takeover fences stale tokens, renewal and release including same user HTTP ownership', async () => {
  const h = harness(); const a = await h.connect('a'), b = await h.connect('b');
  const first = await claim(a); const next = await claim(b, EVENT, { takeover: true });
  assert.equal(next.ok, true);
  assert.notEqual(first.control_token, next.control_token);
  assert.equal((await advance(a, first.control_token)).error, 'control_lost');
  assert.equal((await a.ask('renew_event_control', { event_id: EVENT, control_token: first.control_token })).ok, false);
  assert.equal((await a.ask('release_event_control', { event_id: EVENT, control_token: first.control_token })).ok, false);
  assert.equal(h.control.ownsHttp(EVENT, { userId: USER }), false);
  assert.equal(h.control.ownsHttp(EVENT, { userId: USER, token: first.control_token }), false);
  assert.equal(h.control.ownsHttp(EVENT, { userId: USER, token: next.control_token }), true);
});

test('expiry and disconnect free ownership without allowing old token replay', async () => {
  let time = 1; const h = harness({ now: () => time });
  const a = await h.connect('a'), b = await h.connect('b'); const first = await claim(a);
  time += LEASE_MS;
  assert.equal((await advance(a, first.control_token)).error, 'control_lost');
  assert.equal((await claim(b)).ok, true);
  b.socket.disconnect(); await h.control.run(EVENT, () => {});
  assert.equal((await claim(a)).ok, true);
});

test('maintenance, unauthorized and anonymous sockets cannot claim or take over', async () => {
  const h = harness(); const a = await h.connect('a'), b = await h.connect('b'), guest = await h.connect('guest', { authenticated: false });
  const first = await claim(a);
  b.socket.denied = true;
  assert.equal((await claim(b, EVENT, { takeover: true })).ok, false);
  a.socket.maintenance = true;
  assert.equal((await claim(a)).error, 'maintenance');
  assert.equal((await claim(guest)).ok, false);
  assert.equal(h.control.get(EVENT).token, first.control_token);
});

test('legacy cursor requires an explicit claim, cannot steal a modern lease, and needs update for HTTP finalise', async () => {
  const h = harness(); const a = await h.connect('a'), b = await h.connect('b');
  assert.equal((await advance(a, undefined)).error, 'control_lost');
  await a.ask('claim_event_control', { event_id: EVENT });
  assert.equal((await advance(a, undefined)).ok, true);
  assert.equal(h.control.get(EVENT).modern, false);
  assert.equal(h.control.ownsHttp(EVENT, { userId: USER }), false);
  assert.equal((await advance(b, undefined)).error, 'control_lost');
  const next = await claim(b, EVENT, { takeover: true });
  assert.equal((await advance(a, undefined)).error, 'control_lost');
  assert.equal((await advance(b, next.control_token)).ok, true);
});

test('hold during awaited payload lookup stops the cursor write', async () => {
  let release, waiting;
  const entered = new Promise(resolve => { waiting = resolve; });
  const h = harness({ query: async sql => {
    if (sql.includes('SELECT cl.status')) { waiting(); await new Promise(resolve => { release = resolve; }); }
    return { rows: [] };
  } });
  const a = await h.connect('a'); const own = await claim(a);
  const pending = advance(a, own.control_token, EVENT, { club_name: 'Private club' });
  await entered;
  h.holds[EVENT] = { reason: 'Safety' };
  release();
  assert.equal((await pending).error, 'event_held');
  assert.equal(h.active[EVENT], undefined);
});

test('per-event serialization fences takeover behind an admitted operation and permits other events', async () => {
  const control = createEventControl(); let finish;
  const order = [];
  const first = control.run(EVENT, async () => { order.push('start'); await new Promise(resolve => { finish = resolve; }); order.push('finish'); });
  await Promise.resolve();
  const takeover = control.run(EVENT, () => order.push('takeover'));
  await control.run(OTHER, () => order.push('other'));
  assert.deepEqual(order, ['start', 'other']);
  finish(); await Promise.all([first, takeover]);
  assert.deepEqual(order, ['start', 'other', 'finish', 'takeover']);
});

test('queued legacy cursor from before a new claim cannot replay after reconnect', async () => {
  const h = harness(); const a = await h.connect('a');
  await a.ask('claim_event_control', { event_id: EVENT });
  const oldTime = new Date(Date.now() - 60_000).toISOString();
  assert.equal((await advance(a, undefined, EVENT, { actor_local_time: oldTime })).error, 'control_lost');
  assert.equal(h.active[EVENT], undefined);
});

test('uppercase UUID spelling shares the same lease and operation queue', async () => {
  const c = createEventControl();
  const id = 'aabbccdd-1111-4111-8111-aabbccddeeff';
  const first = c.claim(id, { socketId: 'a', userId: USER, modern: true });
  assert.equal(c.claim(id.toUpperCase(), { socketId: 'b', userId: USER, modern: true }).ok, false);
  assert.equal(c.ownsHttp(id.toUpperCase(), { userId: USER, token: first.lease.token }), true);
  c.clear(id.toUpperCase());
  assert.equal(c.get(id), null);
});

test('disconnect during an awaited claim cannot install a dead legacy lease', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const h = harness({ statusQuery: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { rows: [{ status: 'Live' }] }; } });
  const a = await h.connect('a');
  const pending = a.ask('claim_event_control', { event_id: EVENT });
  await waiting;
  a.socket.disconnect();
  release();
  assert.equal((await pending).error, 'control_lost');
  assert.equal(h.control.get(EVENT), null);
});

test('disconnect during an awaited cursor lookup refuses the stale write', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const h = harness({ query: async sql => {
    if (sql.includes('SELECT cl.status')) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { rows: [] };
  } });
  const a = await h.connect('a'); const own = await claim(a);
  const pending = advance(a, own.control_token, EVENT, { club_name: 'Private club' });
  await waiting; a.socket.disconnect(); release();
  assert.equal((await pending).error, 'control_lost');
  assert.equal(h.active[EVENT], undefined);
});
