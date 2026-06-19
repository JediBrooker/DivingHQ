// Rate-limit / connection-cap / input-validation guards on the
// anonymous socket surface (security audit F2 + connection-cap
// follow-up).
//
// subscribe_venue is unauthenticated (hardware bridges + public clients)
// and triggers emitVenueState, which runs the multi-CTE leaderboard
// build — the most expensive query in the app. The per-(action,user)
// limiter no-ops for anonymous clients (userId null), so these tests
// pin the IP-keyed throttle, the UUID guard, and the per-IP concurrent
// connection cap that stop a single client from exhausting the server.
//
// DB-free: emitVenueState is stubbed on the cached module, so no pool
// work happens. Belongs in test:safe.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const attachSocket = require("../routes/socket");
const venueState = require("../lib/venue-state");

const VALID_ID = "11111111-1111-1111-1111-111111111111";
let seq = 0;

// Build a minimal io/socket harness, attach the real handlers, and
// return a driver that can connect fake sockets and fire events.
// opts.maxPerIp overrides MAX_SOCKETS_PER_IP (read at attach time).
function makeHarness(opts = {}) {
  let emitCount = 0;
  venueState.emitVenueState = async () => { emitCount += 1; };

  const captured = { use: null, connection: null };
  const io = {
    use: (fn) => { captured.use = fn; },
    on: (event, fn) => { if (event === "connection") captured.connection = fn; },
    to: () => ({ emit: () => {} }),
    sockets: { adapter: { rooms: new Map() } },
  };

  const prevEnv = process.env.MAX_SOCKETS_PER_IP;
  if (opts.maxPerIp !== undefined) {
    process.env.MAX_SOCKETS_PER_IP = String(opts.maxPerIp);
  }
  try {
    attachSocket({
      io,
      pool: { query: async () => ({ rows: [] }) },
      JWT_SECRET: "test-secret",
      socketRequireRole: () => {},
      socketCanManageEvent: async () => false,
      isValidScore: () => true,
      isTokenVersionCurrent: async () => true,
      checkAndApplyRecords: async () => {},
      activeDivers: {},
      meetHolds: {},
      persistActiveDiver: () => {},
      persistMeetHold: () => {},
      persistClearMeetHold: () => {},
      scoreboardCache: null,
      metrics: null,
      push: null,
    });
  } finally {
    if (prevEnv === undefined) delete process.env.MAX_SOCKETS_PER_IP;
    else process.env.MAX_SOCKETS_PER_IP = prevEnv;
  }

  // Connect an anonymous socket from `ip`, returning a driver.
  // onHandlers maps event → array of listeners, because the production
  // connection handler registers two `disconnect` listeners and real
  // socket.io fires both (a single-slot map would drop the decrement).
  function connect(ip) {
    const onHandlers = new Map();
    const listeners = (event) => onHandlers.get(event) || [];
    let disconnected = false;
    const socket = {
      id: `sock-${ip}-${++seq}`,
      handshake: { auth: {}, headers: { "x-forwarded-for": ip }, address: ip },
      join: () => {},
      emit: () => {},
      on: (event, fn) => { onHandlers.set(event, [...listeners(event), fn]); },
      disconnect: () => { disconnected = true; },
    };
    captured.use(socket, () => {});   // soft handshake (no token → anon)
    captured.connection(socket);
    return {
      fire: (event, data) => listeners(event).reduce((_, fn) => fn(data), undefined),
      triggerDisconnect: () => listeners("disconnect").forEach((fn) => fn()),
      isDisconnected: () => disconnected,
      isWired: () => listeners("subscribe_venue").length > 0,
    };
  }

  return { connect, emits: () => emitCount };
}

test("subscribe_venue caps anonymous snapshots per IP", async () => {
  const h = makeHarness();
  const c = h.connect("198.51.100.7");
  for (let i = 0; i < 100; i++) {
    await c.fire("subscribe_venue", { event_id: VALID_ID });
  }
  // 30 = SOCKET_IP_LIMITS.subscribe_venue.limit; the loop tries 100.
  assert.equal(h.emits(), 30, "throttle should cap snapshots at the per-IP limit");
});

test("subscribe_venue rejects non-UUID event ids without a snapshot or budget cost", async () => {
  const h = makeHarness();
  const c = h.connect("198.51.100.8");
  for (const bad of [undefined, null, "", "not-a-uuid", "12345", "../../etc", VALID_ID + "x"]) {
    await c.fire("subscribe_venue", { event_id: bad });
  }
  assert.equal(h.emits(), 0, "malformed ids must not trigger emitVenueState");

  // ...and the rejected calls must not have consumed the rate budget.
  await c.fire("subscribe_venue", { event_id: VALID_ID });
  assert.equal(h.emits(), 1, "a valid id after junk should still emit");
});

test("the per-IP snapshot limit is isolated per client IP", async () => {
  const h = makeHarness();
  const a = h.connect("203.0.113.1");
  const b = h.connect("203.0.113.2");
  for (let i = 0; i < 40; i++) await a.fire("subscribe_venue", { event_id: VALID_ID });
  for (let i = 0; i < 5; i++) await b.fire("subscribe_venue", { event_id: VALID_ID });
  // A is capped at 30; B's 5 are well under its own limit → 35 total.
  assert.equal(h.emits(), 35, "one IP hitting the cap must not starve another");
});

test("caps concurrent sockets per IP and frees a slot on disconnect", () => {
  const h = makeHarness({ maxPerIp: 3 });
  const conns = Array.from({ length: 5 }, () => h.connect("192.0.2.50"));
  assert.equal(conns.filter((c) => c.isWired()).length, 3, "first 3 admitted");
  assert.equal(conns.filter((c) => c.isDisconnected()).length, 2, "overflow rejected");

  // Freeing one accepted slot admits a new connection again.
  conns[0].triggerDisconnect();
  const extra = h.connect("192.0.2.50");
  assert.ok(extra.isWired() && !extra.isDisconnected(), "slot reclaimed after disconnect");
});

test("the connection cap is isolated per client IP", () => {
  const h = makeHarness({ maxPerIp: 2 });
  const a = Array.from({ length: 3 }, () => h.connect("192.0.2.60"));
  const b = Array.from({ length: 2 }, () => h.connect("192.0.2.61"));
  assert.equal(a.filter((c) => c.isDisconnected()).length, 1, "IP A overflow rejected");
  assert.equal(b.filter((c) => c.isDisconnected()).length, 0, "IP B unaffected by A");
});
