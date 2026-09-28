// Rate-limit / connection-cap / input-validation guards on the
// anonymous socket surface (security audit F2 + connection-cap
// follow-up), plus the crash and gate guards from the 2026-09 bug
// sweep further down (bad cookies, handler errors, deep payloads,
// maintenance, referee actions on finished events, room caps).
//
// subscribe_venue is unauthenticated (hardware bridges + public clients)
// and triggers emitVenueState, which runs the multi-CTE leaderboard
// build, the most expensive query in the app. The per-(action,user)
// limiter no-ops for anonymous clients (userId null), so these tests
// pin the IP-keyed throttle, the UUID guard, and the per-IP concurrent
// connection cap that stop a single client from exhausting the server.
//
// DB-free: emitVenueState is stubbed on the cached module, so no pool
// work happens. Belongs in test:safe.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const attachSocket = require("../routes/socket");
const venueState = require("../lib/venue-state");

const VALID_ID = "11111111-1111-1111-1111-111111111111";
let seq = 0;

// Builds a minimal io/socket harness, attaches the real handlers, and
// returns a driver that can connect fake sockets and fire events.
// FYI opts.maxPerIp overrides MAX_SOCKETS_PER_IP, read at attach time.
// opts.canManage is what socketCanManageEvent answers (a function so a
// test can flip it midway).
function makeHarness(opts = {}) {
  let emitCount = 0;
  const venueCalls = [];
  venueState.emitVenueState = async (args) => { emitCount += 1; venueCalls.push(args); };
  const canManage = opts.canManage || (() => false);

  const captured = { use: null, connection: null };
  // Room broadcasts, so a test can look at what went out.
  const broadcasts = [];
  const io = {
    use: (fn) => { captured.use = fn; },
    on: (event, fn) => { if (event === "connection") captured.connection = fn; },
    to: (room) => ({ emit: (name, payload) => broadcasts.push({ room, name, payload }) }),
    sockets: { adapter: { rooms: new Map() }, sockets: new Map() },
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
      socketRequireRole: () => true,
      socketCanManageEvent: async () => canManage(),
      isValidScore: () => true,
      isTokenVersionCurrent: async () => true,
      checkAndApplyRecords: async () => {},
      activeDivers: {},
      meetHolds: opts.meetHolds || {},
      persistActiveDiver: () => {},
      persistMeetHold: () => {},
      persistClearMeetHold: () => {},
      scoreboardCache: null,
      metrics: null,
      push: null,
      // Anything a test wants to swap (a pool that answers, the real
      // score validator, a gate that throws).
      ...(opts.deps || {}),
    });
  } finally {
    if (prevEnv === undefined) delete process.env.MAX_SOCKETS_PER_IP;
    else process.env.MAX_SOCKETS_PER_IP = prevEnv;
  }

  // Connects an anonymous socket from `ip` and returns a driver.
  // onHandlers maps event → array of listeners, like real socket.io,
  // so a handler registering a second listener for the same event can't
  // silently replace the first (the disconnect decrement, say).
  async function connect(ip, token, extra = {}) {
    const onHandlers = new Map();
    const listeners = (event) => onHandlers.get(event) || [];
    let disconnected = false;
    const emitted = [];
    const rooms = new Set();
    const socket = {
      id: `sock-${ip}-${++seq}`,
      handshake: {
        auth: token ? { token } : {},
        headers: { "x-forwarded-for": ip, ...(extra.headers || {}) },
        address: extra.address || ip,
      },
      join: (room) => { rooms.add(room); },
      emit: (name, payload) => { emitted.push({ name, payload }); },
      on: (event, fn) => { onHandlers.set(event, [...listeners(event), fn]); },
      disconnect: () => { disconnected = true; },
    };
    // Soft handshake: no token means anonymous. It's async (it checks
    // the token version), so wait for next() before connecting. A
    // rejected handshake fails the test here instead of going unhandled.
    await new Promise((resolve, reject) => {
      const p = captured.use(socket, resolve);
      if (p && typeof p.catch === "function") p.catch(reject);
    });
    captured.connection(socket);
    return {
      socket,
      emitted,
      rooms,
      fire: (event, data, ack) => listeners(event).reduce((_, fn) => fn(data, ack), undefined),
      // Fires and resolves with whatever the handler acked.
      ask: async (event, data) => {
        let reply;
        await listeners(event).reduce((_, fn) => fn(data, (r) => { reply = r; }), undefined);
        return reply;
      },
      triggerDisconnect: () => listeners("disconnect").forEach((fn) => fn()),
      isDisconnected: () => disconnected,
      isWired: () => listeners("subscribe_venue").length > 0,
    };
  }

  return { connect, emits: () => emitCount, venueCalls, broadcasts };
}

const token = (id) => jwt.sign({ id, org_id: "org-1", org_roles: ["meet_manager"] }, "test-secret");

test("subscribe_venue caps anonymous snapshots per IP", async () => {
  const h = makeHarness();
  const c = await h.connect("198.51.100.7");
  for (let i = 0; i < 100; i++) {
    await c.fire("subscribe_venue", { event_id: VALID_ID });
  }
  // 30 = SOCKET_IP_LIMITS.subscribe_venue.limit; the loop tries 100.
  assert.equal(h.emits(), 30, "throttle should cap snapshots at the per-IP limit");
});

test("subscribe_venue rejects non-UUID event ids without a snapshot or budget cost", async () => {
  const h = makeHarness();
  const c = await h.connect("198.51.100.8");
  for (const bad of [undefined, null, "", "not-a-uuid", "12345", "../../etc", VALID_ID + "x"]) {
    await c.fire("subscribe_venue", { event_id: bad });
  }
  assert.equal(h.emits(), 0, "malformed ids must not trigger emitVenueState");

  // ...and the rejected calls must not have consumed teh rate budget.
  await c.fire("subscribe_venue", { event_id: VALID_ID });
  assert.equal(h.emits(), 1, "a valid id after junk should still emit");
});

test("the per-IP snapshot limit is isolated per client IP", async () => {
  const h = makeHarness();
  const a = await h.connect("203.0.113.1");
  const b = await h.connect("203.0.113.2");
  for (let i = 0; i < 40; i++) await a.fire("subscribe_venue", { event_id: VALID_ID });
  for (let i = 0; i < 5; i++) await b.fire("subscribe_venue", { event_id: VALID_ID });
  // A is capped at 30; B's 5 are well under its own limit → 35 total.
  assert.equal(h.emits(), 35, "one IP hitting the cap must not starve another");
});

test("caps concurrent sockets per IP and frees a slot on disconnect", async () => {
  const h = makeHarness({ maxPerIp: 3 });
  const conns = [];
  for (let i = 0; i < 5; i++) conns.push(await h.connect("192.0.2.50"));
  assert.equal(conns.filter((c) => c.isWired()).length, 3, "first 3 admitted");
  assert.equal(conns.filter((c) => c.isDisconnected()).length, 2, "overflow rejected");

  // Freeing one accepted slot admits a new connection again.
  conns[0].triggerDisconnect();
  const extra = await h.connect("192.0.2.50");
  assert.ok(extra.isWired() && !extra.isDisconnected(), "slot reclaimed after disconnect");
});

test("the connection cap is isolated per client IP", async () => {
  const h = makeHarness({ maxPerIp: 2 });
  const a = [];
  const b = [];
  for (let i = 0; i < 3; i++) a.push(await h.connect("192.0.2.60"));
  for (let i = 0; i < 2; i++) b.push(await h.connect("192.0.2.61"));
  assert.equal(a.filter((c) => c.isDisconnected()).length, 1, "IP A overflow rejected");
  assert.equal(b.filter((c) => c.isDisconnected()).length, 0, "IP B unaffected by A");
});

// The Control Room events share one guard (routes/socket.js
// guardControl). These pin what it has to keep doing for all of them.

test("Control Room events refuse a caller who can't drive the event, each in its own words", async () => {
  const h = makeHarness({ canManage: () => false });
  const c = await h.connect("198.51.100.20", token("user-refused"));
  const data = { event_id: VALID_ID, competitor_id: "c", round_number: 1 };
  for (const ev of ["set_active_diver", "meet_hold", "meet_resume",
    "referee_failed_dive", "referee_cap_scores", "referee_redive"]) {
    assert.deepEqual(await c.ask(ev, data), { ok: false, error: "unauthorized" }, ev);
  }
  // announce_score has always said it differently; clients match on it.
  assert.deepEqual(await c.ask("announce_score", data), { ok: false, error: "not authorised" });
  assert.equal(h.emits(), 0, "nothing reaches the venue board");
});

test("a refused caller spends no rate budget; an allowed one is capped per action", async () => {
  let allowed = false;
  const h = makeHarness({ canManage: () => allowed });
  const c = await h.connect("198.51.100.21", token("user-budget"));
  const data = { event_id: VALID_ID };
  for (let i = 0; i < 25; i++) await c.ask("meet_hold", data);
  allowed = true;
  const holds = [];
  for (let i = 0; i < 12; i++) holds.push((await c.ask("meet_hold", data)).error || "ok");
  // 10 = SOCKET_ACTION_LIMITS.meet_hold.limit
  assert.deepEqual(holds, [...Array(10).fill("ok"), "rate_limited", "rate_limited"]);
  // Each action has its own bucket, and announce_score its own wording.
  const announces = [];
  for (let i = 0; i < 31; i++) announces.push((await c.ask("announce_score", data)).error || "ok");
  assert.equal(announces.filter((a) => a === "ok").length, 30);
  assert.equal(announces[30], "rate limited");
});

test("meet_hold and meet_resume send the hold state to the venue board", async () => {
  const meetHolds = {};
  const h = makeHarness({ canManage: () => true, meetHolds });
  const c = await h.connect("198.51.100.22", token("user-venue"));
  assert.deepEqual(await c.ask("meet_hold", { event_id: VALID_ID, reason: "Lightning" }), { ok: true });
  assert.equal(h.venueCalls.at(-1).eventId, VALID_ID);
  assert.equal(h.venueCalls.at(-1).onHoldReason, "Lightning");
  assert.deepEqual(await c.ask("meet_resume", { event_id: VALID_ID }), { ok: true });
  assert.equal(h.venueCalls.at(-1).onHoldReason, null);
  assert.equal(meetHolds[VALID_ID], undefined);
});

// A session cookie with a broken %-escape used to throw out of the
// handshake middleware. socket.io doesn't await that promise, so the
// rejection went unhandled and took the whole process down, no
// account needed.
test("a malformed session cookie on the handshake connects as anonymous", async () => {
  const h = makeHarness();
  const c = await h.connect("198.51.100.30", null, { headers: { cookie: "dhq_session=%E0%A4%A" } });
  assert.equal(c.socket.userId, undefined);
  assert.ok(c.isWired(), "the socket still gets its handlers");
});

// Every socket handler is async and socket.io never awaits it. A throw
// from a DB call (a bad id, a dropped connection) used to become an
// unhandled rejection that killed the process. The handlers answer with
// server_error instead.
test("a Control Room gate that throws acks server_error instead of rejecting", async () => {
  const h = makeHarness({
    deps: { socketCanManageEvent: async () => { throw new Error("boom: invalid input syntax for type uuid"); } },
  });
  const c = await h.connect("198.51.100.31", token("user-throws"));
  for (const ev of ["set_active_diver", "meet_hold", "meet_resume", "announce_score",
    "referee_failed_dive", "referee_cap_scores", "referee_redive"]) {
    assert.deepEqual(await c.ask(ev, { event_id: "not-a-uuid" }), { ok: false, error: "server_error" }, ev);
  }
  // claim_event_control has no ack; it just mustn't reject.
  await c.fire("claim_event_control", { event_id: "not-a-uuid" });
});

test("submit_score acks server_error when the revocation lookup throws", async () => {
  const h = makeHarness({
    deps: { isTokenVersionCurrent: async (id) => { if (id === "judge-db-down") throw new Error("db down"); return true; } },
  });
  const judgeToken = jwt.sign({ id: "judge-db-down", org_id: "org-1", org_roles: ["judge"], tv: 1 }, "test-secret");
  // The handshake's own check throws too, so it connects anonymous; set
  // the identity by hand to get to the per-submit re-check.
  const c = await h.connect("198.51.100.32", judgeToken);
  Object.assign(c.socket, { userId: "judge-db-down", userOrgRoles: ["judge"], userTokenVersion: 1 });
  const reply = await c.ask("submit_score", { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, score: 7 });
  assert.deepEqual(reply, { ok: false, error: "server_error" });
});

// A pool just capable enough for submit_score and the referee actions:
// the judge sits on the panel, the event has `status`, and every write
// works. `writes` records the SQL so a test can see what ran.
function scoringPool({ status = "Live" } = {}) {
  const writes = [];
  const answer = async (sql) => {
    writes.push(sql);
    if (/FROM event_judges ej\s+JOIN events e/.test(sql)) return { rows: [{ judge_number: 1, event_status: status }] };
    if (/SELECT status FROM events/.test(sql)) return { rows: [{ status }] };
    if (/INSERT INTO scores/.test(sql)) return { rows: [{ id: "score-1" }] };
    return { rows: [], rowCount: 0 };
  };
  return {
    writes,
    query: answer,
    connect: async () => ({ query: answer, release() {} }),
  };
}
const judgeToken = (id) => jwt.sign({ id, org_id: "org-1", org_roles: ["judge"] }, "test-secret");

// hashPayload used to canonicalise the whole client object, recursively,
// before any try. A 20k-deep array in an extra field blew the stack and,
// the handler being un-awaited, killed the process. The room broadcast
// spread the same object, which socket.io's encoder walks recursively too.
test("submit_score only hashes and rebroadcasts the fields that define a submission", async () => {
  let deep = [];
  for (let i = 0; i < 20000; i++) deep = [deep];
  const pool = scoringPool();
  const h = makeHarness({ deps: { pool } });
  const c = await h.connect("198.51.100.33", judgeToken("judge-deep"));
  const reply = await c.ask("submit_score", {
    event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, score: 7,
    idempotency_key: "2b1e4f1c-3a52-4d7e-9c1a-0f6e5d4c3b2a", x: deep,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply).slice(0, 200));
  const sent = h.broadcasts.find((b) => b.name === "score_received");
  assert.ok(sent, "the score still goes out to the room");
  assert.deepEqual(Object.keys(sent.payload).sort(),
    ["competitor_id", "event_id", "judge_id", "judge_number", "round_number", "score"]);
});

// The socket half of maintenance mode. socketRequireRole holds the check
// (lib/middleware.js); submit_score and judge_signal never called it.
test("maintenance mode stops judges scoring and signalling over the socket", async () => {
  const createMiddleware = require("../lib/middleware");
  const { socketRequireRole } = createMiddleware({
    pool: { query: async () => ({ rows: [] }) }, JWT_SECRET: "test-secret", isMaintenance: () => true,
  });
  const pool = scoringPool();
  const h = makeHarness({ deps: { pool, socketRequireRole } });
  const c = await h.connect("198.51.100.34", judgeToken("judge-maint"));
  const reply = await c.ask("submit_score", { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, score: 7 });
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "maintenance");
  await c.fire("judge_signal", { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, signaled: true });
  assert.equal(h.broadcasts.length, 0, "nothing reaches the room");
  assert.ok(!pool.writes.some((sql) => /INSERT INTO scores/.test(sql)));
});
