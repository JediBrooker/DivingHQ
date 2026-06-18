// Socket rate-limit / input-validation guards on the anonymous
// `subscribe_venue` read path (security audit F2).
//
// subscribe_venue is unauthenticated (hardware bridges + curious public
// clients) and triggers emitVenueState, which runs the multi-CTE
// leaderboard build — the most expensive query in the app. The
// per-(action,user) limiter no-ops for anonymous clients (userId null),
// so these tests pin the IP-keyed throttle and the UUID guard that stop
// a single client from spamming fresh snapshots.
//
// DB-free: emitVenueState is stubbed on the cached module, so no pool
// work happens. Belongs in test:safe.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const attachSocket = require("../routes/socket");
const venueState = require("../lib/venue-state");

const VALID_ID = "11111111-1111-1111-1111-111111111111";

// Build a minimal io/socket harness, attach the real handlers, and
// return a driver that can fire connection + events at a fake socket.
function makeHarness() {
  let emitCount = 0;
  venueState.emitVenueState = async () => { emitCount += 1; };

  const captured = { use: null, connection: null };
  const io = {
    use: (fn) => { captured.use = fn; },
    on: (event, fn) => { if (event === "connection") captured.connection = fn; },
    to: () => ({ emit: () => {} }),
    sockets: { adapter: { rooms: new Map() } },
  };

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

  // Connect an anonymous socket from `ip`, returning an emit driver.
  function connect(ip) {
    const onHandlers = new Map();
    const socket = {
      id: `sock-${ip}`,
      handshake: { auth: {}, headers: { "x-forwarded-for": ip }, address: ip },
      join: () => {},
      emit: () => {},
      on: (event, fn) => { onHandlers.set(event, fn); },
    };
    // Soft handshake (no token → anonymous), then connection wiring.
    captured.use(socket, () => {});
    captured.connection(socket);
    return (event, data) => onHandlers.get(event)?.(data);
  }

  return { connect, emits: () => emitCount };
}

test("subscribe_venue caps anonymous snapshots per IP", async () => {
  const h = makeHarness();
  const fire = h.connect("198.51.100.7");
  for (let i = 0; i < 100; i++) {
    await fire("subscribe_venue", { event_id: VALID_ID });
  }
  // 30 = SOCKET_IP_LIMITS.subscribe_venue.limit; the loop tries 100.
  assert.equal(h.emits(), 30, "throttle should cap snapshots at the per-IP limit");
});

test("subscribe_venue rejects non-UUID event ids without a snapshot or budget cost", async () => {
  const h = makeHarness();
  const fire = h.connect("198.51.100.8");
  for (const bad of [undefined, null, "", "not-a-uuid", "12345", "../../etc", VALID_ID + "x"]) {
    await fire("subscribe_venue", { event_id: bad });
  }
  assert.equal(h.emits(), 0, "malformed ids must not trigger emitVenueState");

  // ...and the rejected calls must not have consumed the rate budget.
  await fire("subscribe_venue", { event_id: VALID_ID });
  assert.equal(h.emits(), 1, "a valid id after junk should still emit");
});

test("the per-IP limit is isolated per client IP", async () => {
  const h = makeHarness();
  const a = h.connect("203.0.113.1");
  const b = h.connect("203.0.113.2");
  for (let i = 0; i < 40; i++) await a("subscribe_venue", { event_id: VALID_ID });
  for (let i = 0; i < 5; i++) await b("subscribe_venue", { event_id: VALID_ID });
  // A is capped at 30; B's 5 are well under its own limit → 35 total.
  assert.equal(h.emits(), 35, "one IP hitting the cap must not starve another");
});
