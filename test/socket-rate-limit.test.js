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
      socketRequireRole: (socket) => !!socket.userId,
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
      leave: (room) => { rooms.delete(room); },
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

// The handshake only takes a session whose id is a UUID (isSessionClaims
// in lib/middleware), so a test's user gets a stable one made from its
// label.
const uid = (label) => {
  const h = require("node:crypto").createHash("md5").update(label).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const token = (label) => jwt.sign({ id: uid(label), org_id: "org-1", org_roles: ["meet_manager"] }, "test-secret");

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

test("a DB error in the Control Room authz check answers server_error instead of throwing", async () => {
  const h = makeHarness({ canManage: () => { throw new Error("sorry, too many clients already"); } });
  const c = await h.connect("198.51.100.22", token("user-dbdown"));
  for (const ev of ["set_active_diver", "meet_hold", "meet_resume", "announce_score",
    "referee_failed_dive", "referee_cap_scores", "referee_redive"]) {
    assert.deepEqual(await c.ask(ev, { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1 }),
      { ok: false, error: "server_error" }, ev);
  }
  // claim_event_control has no ack; it just mustn't reject.
  await c.fire("claim_event_control", { event_id: VALID_ID });
  // A junk id never reaches the lookup at all.
  assert.deepEqual(await c.ask("meet_hold", { event_id: "not-a-uuid" }), { ok: false, error: "unauthorized" });
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

// The handshake asks lib/middleware's isSessionClaims, the test
// verifyToken runs, rather than a copy of it. Only a typeless token with
// a UUID id is a session; the purpose tokens (2FA step-up, reset, verify)
// share the secret and connect as spectators.
test("the socket handshake takes the same sessions verifyToken does", async () => {
  const h = makeHarness();
  const sign = (p) => jwt.sign(p, "test-secret");
  const id = uid("handshake");
  const cases = [
    [{ id, org_id: "org-1", org_roles: ["judge"] }, id],
    [{ id, type: "totp_pending", org_id: "org-1" }, undefined],
    [{ sub: id, type: "password_reset" }, undefined],
    [{ id: "not-a-uuid", org_id: "org-1" }, undefined],
  ];
  for (const [payload, want] of cases) {
    const c = await h.connect("198.51.100.43", sign(payload));
    assert.equal(c.socket.userId, want, JSON.stringify(payload));
  }
});

test("submit_score acks server_error when the revocation lookup throws", async () => {
  const h = makeHarness({
    deps: { isTokenVersionCurrent: async (id) => { if (id === uid("judge-db-down")) throw new Error("db down"); return true; } },
  });
  const judgeToken = jwt.sign({ id: uid("judge-db-down"), org_id: "org-1", org_roles: ["judge"], tv: 1 }, "test-secret");
  // The handshake's own check throws too, so it connects anonymous; set
  // the identity by hand to get to the per-submit re-check.
  const c = await h.connect("198.51.100.32", judgeToken);
  Object.assign(c.socket, { userId: uid("judge-db-down"), userOrgRoles: ["judge"], userTokenVersion: 1 });
  const reply = await c.ask("submit_score", { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, score: 7 });
  assert.deepEqual(reply, { ok: false, error: "server_error" });
});

// A pool just capable enough for submit_score and the referee actions:
// the judge sits on the panel, the event has `status`, and every write
// works. `writes` records the SQL so a test can see what ran.
function scoringPool({ status = "Live" } = {}) {
  const writes = [];
  const calls = [];
  const answer = async (sql, params) => {
    writes.push(sql);
    calls.push({ sql, params });
    if (/FROM event_judges ej\s+JOIN events e/.test(sql)) return { rows: [{ judge_number: 1, event_status: status }] };
    if (/SELECT judge_number FROM event_judges/.test(sql)) return { rows: [{ judge_number: 1 }] };
    if (/SELECT status FROM events/.test(sql)) return { rows: [{ status }] };
    if (/INSERT INTO scores/.test(sql)) return { rows: [{ id: "score-1" }] };
    return { rows: [], rowCount: 0 };
  };
  return {
    writes,
    calls,
    query: answer,
    connect: async () => ({ query: answer, release() {} }),
  };
}
const judgeToken = (label) => jwt.sign({ id: uid(label), org_id: "org-1", org_roles: ["judge"] }, "test-secret");

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

// Behind one proxy (Cloudflare) the client can put anything in
// X-Forwarded-For and the edge appends the real address last. clientIp
// took the entry one further left than Express does, i.e. the client's
// own, so audit rows recorded a made-up IP and rotating the header
// dodged the per-IP connection cap.
test("the socket's client IP is the one Express would pick, not a spoofed XFF entry", async () => {
  const h = makeHarness({ maxPerIp: 1 });
  const a = await h.connect("x", null, { headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.9" }, address: "127.0.0.1" });
  const b = await h.connect("x", null, { headers: { "x-forwarded-for": "7.7.7.7, 10.0.0.9" }, address: "127.0.0.1" });
  assert.ok(!a.isDisconnected());
  assert.ok(b.isDisconnected(), "same real client (10.0.0.9), so the cap of 1 applies");

  // With the app's own trust setting handed in (server.js passes
  // app.get("trust proxy fn")), no proxy trusted means the peer address.
  const direct = makeHarness({ maxPerIp: 1, deps: { trustProxy: () => false } });
  const c = await direct.connect("x", null, { headers: { "x-forwarded-for": "6.6.6.6" }, address: "203.0.113.9" });
  const d = await direct.connect("x", null, { headers: { "x-forwarded-for": "7.7.7.7" }, address: "203.0.113.9" });
  assert.ok(!c.isDisconnected() && d.isDisconnected());
});

// subscribe_event / get_active_diver / get_meet_hold joined a room named
// after whatever string came in, for anyone, with no limit. One
// anonymous socket looping unique ids added 200 MB of rooms in seconds.
test("event rooms: only UUIDs, and a cap per socket", async () => {
  const h = makeHarness();
  const c = await h.connect("198.51.100.35");
  for (const bad of ["x".repeat(200), "not-a-uuid", 42, { a: 1 }]) {
    await c.fire("subscribe_event", { event_id: bad });
    await c.fire("get_active_diver", { event_id: bad });
    await c.fire("get_meet_hold", { event_id: bad });
  }
  const eventRooms = () => [...c.rooms].filter((r) => r.startsWith("event:"));
  assert.deepEqual(eventRooms(), [], "junk ids join nothing");
  const ev = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  for (let i = 0; i < 200; i++) {
    await c.fire("subscribe_event", { event_id: ev(i) });
  }
  assert.equal(eventRooms().length, 50);
  // Past the cap the stalest room makes way, so the newest joins still
  // land (a long-lived SPA socket browsing a big meet keeps getting live
  // updates for whatever it opened last).
  assert.ok(c.rooms.has(`event:${ev(199)}`) && !c.rooms.has(`event:${ev(149)}`));
  // A rejoin counts as a touch: 150 is now the oldest, so the next new
  // event pushes out 151 instead of the one just asked about.
  await c.fire("get_active_diver", { event_id: ev(150) });
  await c.fire("subscribe_event", { event_id: ev(500) });
  assert.equal(eventRooms().length, 50);
  assert.ok(c.rooms.has(`event:${ev(150)}`) && c.rooms.has(`event:${ev(500)}`));
  assert.ok(!c.rooms.has(`event:${ev(151)}`));
  // And one that had been dropped can come back.
  await c.fire("get_meet_hold", { event_id: ev(0) });
  assert.ok(c.rooms.has(`event:${ev(0)}`));
  assert.equal(eventRooms().length, 50);
});

// Every new socket, anonymous ones included, used to get a state_update
// for every event with an active diver, across every org (rehearsals and
// deleted events too). A judge reconnecting on venue Wi-Fi had the
// keypad jump to some other event's diver. The connect replay is only
// for a signed-in socket's own events now (integration tests cover
// those); a spectator asks for its event with get_active_diver.
test("an anonymous connect gets no live-state replay; get_active_diver answers for its own event", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  const activeDivers = {
    [VALID_ID]: { event_id: VALID_ID, diverName: "Mine" },
    [other]: { event_id: other, diverName: "Someone else's rehearsal" },
  };
  const h = makeHarness({ deps: { activeDivers } });
  const c = await h.connect("198.51.100.36");
  assert.deepEqual(c.emitted.filter((e) => e.name === "state_update"), []);
  await c.fire("get_active_diver", { event_id: VALID_ID });
  assert.deepEqual(c.emitted.filter((e) => e.name === "state_update").map((e) => e.payload.diverName), ["Mine"]);
});

// submit_score refuses anything but a Live event so finished results
// can't move, but the referee actions never looked: any org referee could
// zero or cap every score of a dive in a finalised event.
test("referee actions only touch a Live event, and a cap of 0 is reported as 0", async () => {
  const data = { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1 };
  const done = scoringPool({ status: "Completed" });
  const h = makeHarness({ canManage: () => true, deps: { pool: done } });
  const c = await h.connect("198.51.100.37", token("ref-finished"));
  for (const [ev, extra] of [["referee_failed_dive", {}], ["referee_cap_scores", { cap_value: 0 }], ["referee_redive", {}]]) {
    assert.deepEqual(await c.ask(ev, { ...data, ...extra }), { ok: false, error: "event_not_live" }, ev);
  }
  assert.ok(!done.writes.some((sql) => /UPDATE scores/.test(sql)), "no score was touched");
  assert.equal(h.broadcasts.length, 0);

  const live = makeHarness({ canManage: () => true, deps: { pool: scoringPool({ status: "Live" }) } });
  const r = await live.connect("198.51.100.38", token("ref-live"));
  assert.deepEqual(await r.ask("referee_cap_scores", { ...data, cap_value: 0, junk: { deep: 1 } }), { ok: true });
  const corrected = live.broadcasts.find((b) => b.name === "score_corrected");
  assert.equal(corrected.payload.reason, "referee:cap(0)");
  // The room hears the dive and the cap that was applied (the screens
  // showing the old awards hold them to it), not an echo of the caller's
  // object.
  const cap = live.broadcasts.find((b) => b.name === "referee_action_cap");
  assert.deepEqual(cap.payload, { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, cap_value: 0 });
  assert.deepEqual(await r.ask("referee_failed_dive", { ...data, round_number: "1", junk: 1 }), { ok: true });
  const failed = live.broadcasts.find((b) => b.name === "referee_action_failed");
  assert.deepEqual(failed.payload, { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1 });
  assert.deepEqual(await r.ask("referee_failed_dive", { ...data, competitor_id: "not-an-id" }),
    { ok: false, error: "action_failed" });
});

// The socket half of the blank-score bug: score:null used to be stored as
// 0.0 while the room was told null.
test("submit_score refuses a null or empty score instead of storing 0", async () => {
  const { isValidScore } = require("../lib/score-audit");
  const pool = scoringPool();
  const h = makeHarness({ deps: { pool, isValidScore } });
  const c = await h.connect("198.51.100.39", judgeToken("judge-null"));
  for (const score of [null, "", false]) {
    const reply = await c.ask("submit_score", { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, score });
    assert.equal(reply.error, "bad_score", JSON.stringify(score));
  }
  assert.ok(!pool.writes.some((sql) => /INSERT INTO scores/.test(sql)));
});

// actor_local_time goes into a timestamptz column and back out on the
// conflict broadcast. A keypad always sends an ISO string; anything else
// (an object, nested however deep) is dropped rather than handed to pg
// or the room encoder.
test("submit_score only keeps a string actor_local_time", async () => {
  const pool = scoringPool();
  const h = makeHarness({ deps: { pool } });
  const c = await h.connect("198.51.100.40", judgeToken("judge-clock"));
  const reply = await c.ask("submit_score", {
    event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, score: 7, actor_local_time: { a: [[[1]]] },
  });
  assert.equal(reply.ok, true);
  const insert = pool.calls.find((q) => /INSERT INTO scores/.test(q.sql));
  assert.equal(insert.params[6], null);
});

// Ids off the wire are checked one way everywhere in routes/socket.js: a
// string that's a UUID. Some handlers used String(x), which turns an
// array holding one UUID into that UUID. The Control Room gate happened
// to catch it later (socketCanManageEvent checks the type), submit_score
// sent it on into the cast and answered server_error, and judge_signal
// echoed whatever competitor_id it got to the whole room.
test("an array holding a UUID isn't an id on any socket event", async () => {
  const wrapped = [VALID_ID];
  const pool = scoringPool();
  const h = makeHarness({ canManage: () => true, deps: { pool } });
  const m = await h.connect("198.51.100.41", token("mgr-array"));
  for (const ev of ["set_active_diver", "meet_hold", "announce_score", "referee_redive"]) {
    assert.deepEqual(await m.ask(ev, { event_id: wrapped, competitor_id: VALID_ID, round_number: 1 }),
      { ok: false, error: ev === "announce_score" ? "not authorised" : "unauthorized" }, ev);
  }
  assert.ok(m.emitted.every((e) => e.name !== "unauthorized" || e.payload.reason === "bad_event_id"));
  await m.fire("subscribe_venue", { event_id: wrapped });
  assert.equal(h.emits(), 0, "no venue snapshot for a wrapped id");

  const j = await h.connect("198.51.100.42", judgeToken("judge-array"));
  for (const bad of [{ event_id: wrapped, competitor_id: VALID_ID }, { event_id: VALID_ID, competitor_id: wrapped }]) {
    const reply = await j.ask("submit_score", { ...bad, round_number: 1, score: 7 });
    assert.equal(reply.error, "bad_payload", JSON.stringify(bad));
  }
  for (const competitor_id of [wrapped, { a: 1 }, "x".repeat(1000)]) {
    await j.fire("judge_signal", { event_id: VALID_ID, competitor_id, round_number: 1, signaled: true });
  }
  assert.equal(h.broadcasts.length, 0, "nothing junk reaches the room");
  // A real one still goes out.
  await j.fire("judge_signal", { event_id: VALID_ID, competitor_id: VALID_ID, round_number: 1, signaled: true });
  assert.deepEqual(h.broadcasts.map((b) => b.name), ["judge_signal"]);
  assert.ok(!pool.writes.some((sql) => /INSERT INTO scores/.test(sql)));
});
