// Socket engine: every io.on / socket.on handler the app uses.
// Extracted from server.js as part of the Phase-3 split. Factory
// signature mirrors the rest of the route modules: pass in the
// pieces it needs and the function attaches handlers to `io`.
//
// Wires up:
//   * io.use(handshake)          : soft JWT verify, stash userId,
//                                   org_id, roles, sysadmin flag,
//                                   honour token_version (Migration 021)
//   * connection                 : per-IP cap, per-user room,
//                                   register events (no state replay,
//                                   see get_active_diver)
//   * subscribe_event            : explicit room join
//   * set_active_diver           : driven by Control Room
//   * get_active_diver           : on-demand pull for late joiners
//   * submit_score               : judge scoring (transactional)
//   * announce_score             : Control Room "say it on screen"
//   * referee_failed_dive / cap_scores / redive
//   * meet_hold / meet_resume / get_meet_hold
//
// All event-scoped emits use io.to(`event:${id}`) so two
// concurrent meets on the same instance don't cross-leak score
// events to each other's spectators.
//
// Per-event authz comes from socketCanManageEvent, which verifies the
// event belongs to the caller's org or that they have an
// event_managers row. Rate limiting is per-(action, user) so a
// single role-holder can't spam meet_hold cycles.

const jwt = require("jsonwebtoken");
const createIdempotency = require("../lib/idempotency");
const { readSessionCookie } = require("../lib/session-cookie");
const { announceRecords } = require("../lib/records");
const { insertScoreAudit } = require("../lib/score-audit");
// Held as the module object and called through it, never destructured:
// test/socket-rate-limit.test.js swaps emitVenueState on this cached
// module to keep the DB out of the unit tests.
const venueState = require("../lib/venue-state");

// Sliding-window counter, one timestamp list per key. limited() records
// the attempt and says whether the key was already at its limit; a
// refused attempt isn't recorded, so hammering past the cap doesn't push
// the window out. prune() drops lists that have gone quiet, the maps
// would otherwise keep a key for every judge/user/IP ever seen.
function makeWindowLimiter() {
  const windows = new Map();   // key -> [t, ...]
  return {
    limited(key, { limit, windowMs }) {
      const now = Date.now();
      const arr = (windows.get(key) || []).filter((t) => t > now - windowMs);
      windows.set(key, arr);
      if (arr.length >= limit) return true;
      arr.push(now);
      return false;
    },
    prune(windowMs) {
      const cutoff = Date.now() - windowMs;
      for (const [key, arr] of windows) {
        const fresh = arr.filter((t) => t > cutoff);
        if (fresh.length === 0) windows.delete(key);
        else windows.set(key, fresh);
      }
    },
  };
}

// socket.io calls a handler and drops whatever it returns, so an async
// handler that throws (a DB error, a bad id reaching pg) is an unhandled
// rejection, and Node's default for those is to exit. That's how one
// packet from any signed-in user could take every live meet down. Every
// handler goes through this: the error is logged and, when the client
// asked for an ack, it gets server_error.
function guarded(event, handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[socket ${event}]`, err?.message || err);
      const ack = args[args.length - 1];
      if (typeof ack === "function") {
        try { ack({ ok: false, error: "server_error" }); } catch { /* client already gone */ }
      }
    }
  };
}

module.exports = function attachSocket({
  io,
  pool,
  JWT_SECRET,
  // From lib/middleware. submit_score and judge_signal call
  // socketRequireRole(socket) with no roles, which is the signed-in +
  // maintenance-mode check (they do their own role and panel checks).
  // The Control Room events go through socketCanManageEvent, which runs
  // the same maintenance check.
  socketRequireRole,
  socketCanManageEvent,
  isValidScore,
  isTokenVersionCurrent,
  // From lib/records:
  checkAndApplyRecords,
  recomputeRecordKeys,
  // From lib/live-state:
  activeDivers,
  meetHolds,
  // Per-event control lease (advisory; warns on double-driving).
  getEventController,
  setEventController,
  clearEventControllersBySocket,
  // Persistence helpers: fire-and-forget DB writes that mirror
  // the in-memory map mutations so a server restart mid-meet
  // doesn't leak the live state.
  persistActiveDiver,
  persistMeetHold,
  persistClearMeetHold,
  // From lib/scoreboard-cache: optional, invalidated whenever a
  // score commits or a referee action lands so the next
  // /api/scoreboard read rebuilds. Pass null in tests where the
  // cache isn't relevant; the calls below tolerate it.
  scoreboardCache,
  // Optional metrics object (lib/metrics). When supplied we
  // increment the connection gauge + score counters; when null
  // (tests) the calls are no-ops.
  metrics,
  // From server.js: app.get("trust proxy fn"), so clientIp resolves
  // the same address req.ip does. Optional; see clientIp.
  trustProxy,
  // From lib/push: optional. When supplied the connection
  // handler joins per-user rooms (`user:<id>`) so the engine can
  // io.to()` an in-app banner, and adopts a `notification:ack`
  // listener so the SPA's banner click marks the row read.
  push,
}) {
  if (!io || !pool || !JWT_SECRET) {
    throw new Error("attachSocket requires { io, pool, JWT_SECRET, … }");
  }

  // Idempotency layer (migration 054 + lib/idempotency.js).
  // Socket handlers that accept writes call `idem.socketCheck`
  // on the incoming payload's `idempotency_key` and replay the
  // cached response on hit. See docs/offline-p1-design.md §2.
  const idem = createIdempotency({ pool });

  // -----------------------------------------------------------
  // Handshake: soft JWT verify
  // -----------------------------------------------------------
  // We don't reject (spectators connect with no token), but if a
  // valid token is present we stash the user id on the socket so
  // privileged events can be attributed to a verified user.
  io.use(async (socket, next) => {
    // Auth source, in order:
    //   * auth.token === 'spectator' → explicit anonymous opt-out
    //     (a logged-in user viewing a public board), ignore the cookie.
    //   * auth.token === <jwt>       → API clients + the e2e harness.
    //   * else                       → the SPA's httpOnly session cookie,
    //                                   which rides the handshake headers
    //                                   (browser JS can't read it to pass
    //                                   it via auth.token anymore).
    // All of it sits inside the try. socket.io never awaits this
    // function, so anything thrown out of it is an unhandled rejection
    // and Node takes the process down with it (a junk cookie did exactly
    // that). Whatever goes wrong, the socket carries on as a spectator.
    try {
      const authToken = socket.handshake.auth?.token;
      const raw = authToken === "spectator"
        ? null
        : (authToken || readSessionCookie(socket.handshake.headers?.cookie));
      if (raw) {
        const decoded = jwt.verify(raw, JWT_SECRET, { algorithms: ["HS256"] });
        // Validate tv via the same 30s cache the HTTP path uses.
        // A revoked session must lose its socket privileges too.
        const tvOk = await isTokenVersionCurrent(decoded.id, decoded.tv);
        if (tvOk) {
          socket.userId = decoded.id;
          socket.userOrgId = decoded.org_id;
          socket.userIsSystemAdmin = !!decoded.is_system_admin;
          socket.userOrgRoles = decoded.org_roles || [];
          // Stash the token version so socketCanManageEvent can
          // re-check it on every privileged action (catches role
          // revocation / 2FA-bump on a long-lived websocket).
          socket.userTokenVersion = decoded.tv != null ? Number(decoded.tv) : null;
        }
      }
    } catch {
      // Invalid token (or a DB wobble on the tv check), treat as
      // anonymous (spectator).
    }
    next();
  });

  // -----------------------------------------------------------
  // XFF / IP: the same answer Express gives for req.ip, so audit-log
  // IPs and the per-IP limits can't be forged from the header.
  // -----------------------------------------------------------
  // server.js hands in app.get("trust proxy fn"), the exact predicate
  // Express compiled from TRUST_PROXY. Without it (unit tests) the same
  // default server.js uses: trust one hop.
  const isTrustedProxy = typeof trustProxy === "function"
    ? trustProxy
    : (() => {
        const raw = process.env.TRUST_PROXY ?? "1";
        if (raw === "false") return () => false;
        if (raw === "true") return () => true;
        const hops = /^\d+$/.test(raw) ? Number(raw) : 1;
        return (_addr, i) => i < hops;
      })();

  // proxy-addr's walk, which is what Express runs: start at the socket
  // peer, step left through X-Forwarded-For while the address we're on
  // is a trusted proxy, and stop at the first one that isn't. The old
  // version took one entry further left than Express, which behind
  // Cloudflare is whatever the client typed into the header.
  function clientIp(socket) {
    const fwd = socket.handshake.headers["x-forwarded-for"];
    const hops = typeof fwd === "string"
      ? fwd.split(",").map((s) => s.trim()).filter(Boolean).reverse()
      : [];
    const addrs = [socket.handshake.address || null, ...hops];
    for (let i = 0; i < addrs.length - 1; i++) {
      if (!isTrustedProxy(addrs[i], i)) return addrs[i];
    }
    return addrs[addrs.length - 1];
  }

  // -----------------------------------------------------------
  // Rate limiters (per-judge for scores, per-(action,user) for
  // every other privileged event)
  // -----------------------------------------------------------
  const SCORE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
  const scoreWindows = makeWindowLimiter();   // keyed on judgeId

  function judgeIsRateLimited(judgeId) {
    if (!judgeId) return false;
    return scoreWindows.limited(judgeId, SCORE_LIMIT);
  }

  const SOCKET_ACTION_LIMITS = {
    meet_hold:        { limit: 10, windowMs: 60 * 1000 },
    meet_resume:      { limit: 10, windowMs: 60 * 1000 },
    set_active_diver: { limit: 60, windowMs: 60 * 1000 },
    referee_action:   { limit: 30, windowMs: 60 * 1000 },
    announce_score:   { limit: 30, windowMs: 60 * 1000 },
    // judge_signal: 30 toggles/min/judge, generous because a
    // judge might toggle on/off a few times legitimately, but
    // tight enough to stop a malicious client spamming the
    // Control Room with red flashes.
    judge_signal:     { limit: 30, windowMs: 60 * 1000 },
  };
  const actionWindows = makeWindowLimiter();   // keyed `${action}:${userId}`

  function socketActionRateLimited(action, userId) {
    const cfg = SOCKET_ACTION_LIMITS[action];
    if (!cfg || !userId) return false;
    return actionWindows.limited(`${action}:${userId}`, cfg);
  }

  // Per-IP limiter for the unauthenticated, expensive read events.
  // socketActionRateLimited above is keyed on userId and no-ops for
  // anonymous spectators/bridges (userId is null), so the public reads
  // that trigger real DB work need an IP-keyed guard of their own,
  // the socket analogue of server.js's HTTP exportLimiter. Today only
  // subscribe_venue qualifies: it runs the multi-CTE leaderboard build
  // in lib/venue-state.js. Cheap room-join reads (subscribe_event,
  // get_active_diver, get_meet_hold) don't touch the DB, so they're
  // left out, a connection cap is the right control for those.
  const SOCKET_IP_LIMITS = {
    subscribe_venue: { limit: 30, windowMs: 60 * 1000 },
  };
  const ipWindows = makeWindowLimiter();   // keyed `${action}:${ip}`

  function socketIpRateLimited(action, ip) {
    const cfg = SOCKET_IP_LIMITS[action];
    if (!cfg || !ip) return false;     // unknown IP → can't key, fail open
    return ipWindows.limited(`${action}:${ip}`, cfg);
  }

  // What a keypad sends with submit_score, the idempotency hash covers
  // exactly these (see the handler).
  const SUBMISSION_FIELDS = [
    "event_id", "competitor_id", "round_number", "dive_id", "judge_id", "judge_number", "score",
  ];

  // events.id is a UUID; reject anything else before doing DB work.
  // Same lenient shape used for event ids elsewhere (lib/records.js).
  const EVENT_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // How many event rooms one socket may sit in (see joinEvent).
  const MAX_EVENT_ROOMS = 50;

  // Per-IP concurrent connection cap. Defence-in-depth so a single
  // client can't open thousands of sockets to exhaust file descriptors
  // / memory. Generous by default because an entire venue of spectators
  // can share one NAT public IP; tune via MAX_SOCKETS_PER_IP
  // (0 disables the cap).
  const MAX_SOCKETS_PER_IP = (() => {
    const raw = process.env.MAX_SOCKETS_PER_IP;
    if (raw === undefined || raw === "") return 200;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 200;
  })();
  const socketIpConnCounts = new Map();   // ip → live socket count

  // Periodic cleanup so the maps don't grow forever.
  const longestWindow = (limits) => Math.max(...Object.values(limits).map((c) => c.windowMs));
  setInterval(() => {
    scoreWindows.prune(SCORE_LIMIT.windowMs);
    actionWindows.prune(longestWindow(SOCKET_ACTION_LIMITS));
    ipWindows.prune(longestWindow(SOCKET_IP_LIMITS));
  }, 5 * 60 * 1000).unref?.();

  // Who may drive an event from the Control Room. Same list for every
  // privileged event below; socketCanManageEvent only asks whether the
  // caller holds any of them, so order doesn't matter.
  const CONTROL_ROLES = ["meet_manager", "referee", "org_admin"];

  function ackWith(ack, body) {
    if (typeof ack === "function") ack(body);
  }

  // Front door for the Control Room events: can this socket drive the
  // event, and is it inside its rate budget? Authz goes first so someone
  // who can't drive the event never spends budget. Acks the refusal
  // itself, the handler just returns on false. announce_score has always
  // answered in its own words, hence `errors`.
  const GUARD_ERRORS = { unauthorized: "unauthorized", rateLimited: "rate_limited" };
  async function guardControl(socket, data, ack, action, errors = GUARD_ERRORS) {
    if (!(await socketCanManageEvent(socket, data?.event_id, CONTROL_ROLES))) {
      ackWith(ack, { ok: false, error: errors.unauthorized });
      return false;
    }
    if (socketActionRateLimited(action, socket.userId)) {
      ackWith(ack, { ok: false, error: errors.rateLimited });
      return false;
    }
    return true;
  }

  // Push the event's current scoreboard_state to any venue bridge.
  // emitVenueState catches its own build errors, but it's async and most
  // callers don't await it, so a rejection used to go unhandled despite
  // the try/catch around the call. Catching here covers both.
  async function emitVenue(eventId, label) {
    try {
      await venueState.emitVenueState({
        io, pool, eventId,
        activePayload: activeDivers[eventId],
        onHoldReason: meetHolds[eventId]?.reason || null,
      });
    } catch (err) {
      console.error(`[${label}] venue emit failed`, err.message);
    }
  }

  // -----------------------------------------------------------
  // Connection
  // -----------------------------------------------------------
  io.on("connection", (socket) => {
    const on = (event, handler) => socket.on(event, guarded(event, handler));
    // Per-IP concurrent connection cap (defence-in-depth; 0 disables).
    // Count + reject before any wiring so a flood can't accumulate
    // handlers/rooms. The symmetric inc-here / dec-on-disconnect keeps
    // the map self-cleaning (entries drop to 0 and are deleted).
    if (MAX_SOCKETS_PER_IP > 0) {
      const ip = clientIp(socket);
      if (ip) {
        const n = (socketIpConnCounts.get(ip) || 0) + 1;
        if (n > MAX_SOCKETS_PER_IP) {
          socket.disconnect(true);
          return;
        }
        socketIpConnCounts.set(ip, n);
        socket._ipCounted = ip;
      }
    }
    console.log(`[Socket] Connected: ${socket.id}`);
    metrics?.socketConnections.inc();
    socket.on("disconnect", () => {
      metrics?.socketConnections.dec();
      if (socket._ipCounted) {
        const n = (socketIpConnCounts.get(socket._ipCounted) || 1) - 1;
        if (n <= 0) socketIpConnCounts.delete(socket._ipCounted);
        else socketIpConnCounts.set(socket._ipCounted, n);
      }
      // Release any event-control leases this socket held so the events
      // are free for another operator to claim.
      if (typeof clearEventControllersBySocket === "function") {
        clearEventControllersBySocket(socket.id);
      }
      console.log(`[Socket] Disconnected: ${socket.id}`);
    });

    // Per-user room: the push engine `io.to(\`user:<id>\`)` fans
    // an in-app banner out to every open SPA tab the user has.
    // Also doubles as the routing key for any future direct-to-
    // user broadcast (judge calls, dive-on-deck nudges, etc.).
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    // SPA banner click → mark the notifications row 'acknowledged'
    // via the engine. Idempotent; cross-user attempts no-op
    // because the engine scopes the UPDATE to user_id.
    on("notification:ack", async (data) => {
      if (!socket.userId || !data?.id || !push) return;
      try {
        await push.acknowledgeNotification(data.id, socket.userId);
      } catch (err) {
        console.error("[notification:ack]", err.message);
      }
    });

    // Helper: clients join `event:${id}` rooms when they
    // subscribe to an event (via get_active_diver, get_meet_hold,
    // or by explicit `subscribe_event`). Anonymous, so it's fenced: the
    // id has to look like an event id, and one socket gets
    // MAX_EVENT_ROOMS of them. Before, any string made a room, and one
    // socket looping unique ids ate a couple of hundred MB in seconds.
    // A busy Control Room watches a handful of pools, nowhere near it.
    // Returns whether the socket is (now) in the room.
    const joinedEvents = new Set();
    function joinEvent(eventId) {
      if (typeof eventId !== "string" || !EVENT_UUID_RE.test(eventId)) return false;
      if (!joinedEvents.has(eventId)) {
        if (joinedEvents.size >= MAX_EVENT_ROOMS) return false;
        joinedEvents.add(eventId);
      }
      socket.join(`event:${eventId}`);
      return true;
    }
    on("subscribe_event", (data) => { joinEvent(data?.event_id); });

    // Per-event control LEASE (advisory). A Control Room claims control of
    // each event it drives. The lease never BLOCKS an action (a crashed
    // operator must never lock an event), it just warns when a second
    // socket (another operator, or the same operator in another window)
    // is also driving the same event, so set_active_diver clobbering is
    // surfaced instead of silent. First claim wins; the claimant is the
    // one warned. Both sides are notified so neither drives blind.
    on("claim_event_control", async (data) => {
      const eventId = data?.event_id;
      if (!eventId || !socket.userId) return;
      // Only real controllers can hold a lease (same gate as the actions).
      if (!(await socketCanManageEvent(socket, eventId, CONTROL_ROLES))) return;
      if (typeof getEventController !== "function") return;
      const cur = getEventController(eventId);
      const holderLive = cur && io.sockets.sockets.has(cur.socketId);
      if (!cur || !holderLive || cur.socketId === socket.id) {
        // Free (or stale, or already ours) -> grant.
        setEventController(eventId, { socketId: socket.id, userId: socket.userId });
        socket.emit("event_control_granted", { event_id: eventId });
        return;
      }
      // Held by another live socket -> warn both, don't steal.
      const sameUser = String(cur.userId) === String(socket.userId);
      socket.emit("event_control_conflict", { event_id: eventId, sameUser });
      io.to(cur.socketId).emit("event_control_contested", { event_id: eventId, sameUser });
    });

    // Venue bridge subscription. Hardware bridges (Daktronics,
    // Colorado Time Systems, OmegaTiming, etc.) join `venue:<id>`
    // rooms to receive canonical `venue.scoreboard_state` payloads.
    // See lib/venue-state.js for the spec + wire shape.
    //
    // No auth gate here, a bridge runs inside the venue's own LAN
    // and the venue operator chose to install it. Adding a
    // dedicated bridge token would harden against curious public
    // clients but doesn't change the security posture (the same
    // data is on the public scoreboard already).
    function joinVenue(eventId) {
      if (!eventId) return;
      socket.join(`venue:${eventId}`);
    }
    on("subscribe_venue", async (data) => {
      const eventId = data?.event_id;
      // Validate shape before any work: events.id is a UUID, so a
      // malformed id is junk, reject it without joining a room or
      // touching the DB. (Also short-circuits a missing id.)
      if (!EVENT_UUID_RE.test(String(eventId ?? ""))) return;
      // Per-IP throttle. subscribe_venue triggers emitVenueState, which
      // runs the most expensive query in the app (the multi-CTE
      // leaderboard build in lib/venue-state.js). The per-(action,user)
      // limiter no-ops for anonymous bridges, so guard on IP here just
      // like the HTTP exportLimiter guards expensive anonymous reads. A
      // real bridge subscribes a handful of times on (re)connect, far
      // below 30/min/IP; a spam loop is far above it.
      if (socketIpRateLimited("subscribe_venue", clientIp(socket))) return;
      joinVenue(eventId);
      // Immediately emit a fresh snapshot so the bridge has full
      // state to render, important after a bridge restart.
      await emitVenue(eventId, "subscribe_venue");
    });

    // No replay of live state on connect. This used to send every
    // event's active diver (every org, rehearsals, deleted events) to
    // every new socket, anonymous ones too, and a judge's keypad would
    // adopt whichever came last. Late joiners ask for their own event
    // with get_active_diver / get_meet_hold, which replay just that one.

    on("set_active_diver", async (data, ack) => {
      if (!(await guardControl(socket, data, ack, "set_active_diver"))) return;
      if (data.event_id) {
        activeDivers[data.event_id] = data;
        // Write-through to event_live_state so a server
        // restart picks the same diver back up on rehydrate.
        if (typeof persistActiveDiver === "function") {
          persistActiveDiver(data.event_id, data);
        }
      }
      io.to(`event:${data.event_id}`).emit("state_update", data);

      // Fire-and-forget coach alerts. The fan-out helper looks
      // ahead N=dives_ahead slots from this new active diver and
      // pushes "your diver is up next" to coaches whose linked
      // divers land in the window. Per-process in-memory dedupe
      // prevents double-fires when the operator re-emits state.
      // Errors logged but never propagate, score path stays clean.
      if (data.event_id && push) {
        try {
          require("../lib/coach-alerts")
            .maybeNotifyCoachesOfNextDivers({ pool, push }, data.event_id, data);
        } catch (err) {
          console.error("[set_active_diver] coach alert hook failed", err.message);
        }
      }

      // Venue scoreboard state: fan out to any connected
      // hardware bridge in this event's venue room. See
      // lib/venue-state.js for the wire shape. activeDivers now holds
      // `data`, so that's the active payload it sends.
      if (data.event_id) emitVenue(data.event_id, "set_active_diver");
      ackWith(ack, { ok: true });
    });

    on("get_active_diver", (data) => {
      if (!joinEvent(data?.event_id)) return;
      const state = activeDivers[data.event_id];
      if (state) socket.emit("state_update", state);
    });

    // -----------------------------------------------------------
    // submit_score: fully transactional. Prior-row read with
    // FOR UPDATE → upsert → audit insert, all in one txn so the
    // audit row is durable iff the score is. Sysadmin policy:
    // even sysadmins must be on the panel; judge_number always
    // comes from the DB row, never from the wire. dive_id
    // resolved server-side from competitor_dive_lists so a stale
    // client can't smuggle in the wrong dive's DD.
    //
    // Offline-resilience: clients using src/lib/outbox.js include
    // an `idempotency_key` (UUID v4) + `actor_local_time` (ISO
    // string of the judge's tap moment). The idempotency layer
    // caches the response so an outbox retry doesn't double-apply
    // and the audit row records both clocks (migration 054). See
    // docs/offline-p1-design.md §2 for the full design.
    // -----------------------------------------------------------
    on("submit_score", async (data, ack) => {
      // Socket.IO ack callback (3rd argument). When the client
      // uses the outbox drain protocol, it provides a callback to
      // correlate "my submit" with "the server confirmed mine",
      // tuple-matching the room broadcast would be racy when
      // multiple devices submit for the same diver. Legacy clients
      // (no outbox) pass no callback; safeAck is a no-op for them.
      const safeAck = (response) => {
        if (typeof ack === "function") {
          try { ack(response); } catch (err) {
            console.error("[submit_score] ack failed:", err.message);
          }
        }
      };

      // Tiny helper so the metric increment doesn't get
      // forgotten alongside any of the eight rejection paths. The
      // helper also calls safeAck so a single rejection path
      // delivers both the broadcast event and the per-submit ack.
      const reject = (reason, extra) => {
        metrics?.scoresRejected.inc({ reason });
        socket.emit("score_rejected", { reason, ...(extra || {}) });
        safeAck({ ok: false, error: reason, ...(extra || {}) });
      };

      if (!socket.userId) {
        reject("not_authenticated", { message: "You must be signed in to submit scores." });
        return;
      }
      // Maintenance mode freezes writes for everyone but a sysadmin, the
      // socket half of server.js's maintenanceGate.
      if (!socketRequireRole(socket)) {
        reject("maintenance", { message: "DivingHQ is in maintenance mode, scores can't be saved right now." });
        return;
      }
      const judgeId = socket.userId;
      const roles = socket.userOrgRoles || [];
      if (!socket.userIsSystemAdmin
          && !roles.includes("judge")
          && !roles.includes("referee")) {
        reject("insufficient_role");
        return;
      }
      // Re-check revocation on this long-lived socket. The handshake
      // ran once, but a judge whose account is suspended or whose
      // token_version is bumped mid-meet (while still seated on the
      // panel) must lose submit immediately, not at next reconnect.
      // O(1) via the 30s auth-state cache. Mirrors socketCanManageEvent.
      if (typeof socket.userTokenVersion === "number"
          && !(await isTokenVersionCurrent(socket.userId, socket.userTokenVersion))) {
        reject("token_revoked", { message: "Your session was revoked — please sign in again." });
        socket.disconnect(true);
        return;
      }
      if (!data?.event_id || !data?.competitor_id) {
        reject("bad_payload");
        return;
      }
      // Both ids are UUIDs. Anything else is junk that would only make
      // pg throw further down.
      if (!EVENT_UUID_RE.test(String(data.event_id)) || !EVENT_UUID_RE.test(String(data.competitor_id))) {
        reject("bad_payload");
        return;
      }
      const round = Number(data.round_number);
      if (!Number.isInteger(round) || round < 1) {
        reject("bad_round");
        return;
      }
      if (!isValidScore(data.score)) {
        reject("bad_score", { message: "Score must be between 0 and 10 in 0.5 increments." });
        return;
      }
      if (judgeIsRateLimited(judgeId)) {
        console.warn(`[Score] Rate limit exceeded for judge ${judgeId}`);
        reject("rate_limited", { message: "Slow down — too many submissions in the last minute." });
        return;
      }
      const score = Number(data.score);

      // Idempotency check. When the client sends an idempotency_key
      // (outbox mode), look up any cached response BEFORE doing DB
      // work. The hash covers the fields the keypad sends
      // (SUBMISSION_FIELDS) and nothing else, so the key and
      // actor_local_time stay out and a retry with a different
      // wall-clock claim still matches. It used to hash the whole client
      // object, recursively, and a payload nested 20k deep blew the stack.
      // Same fields and values as before for a real keypad, so hashes
      // cached before this change still match.
      const idempotencyKey = data.idempotency_key;
      const actorLocalTime = data.actor_local_time || null;
      let payloadHash = null;
      if (idempotencyKey) {
        const payloadForHash = {};
        for (const k of SUBMISSION_FIELDS) {
          const v = data[k];
          if (v !== undefined && (v === null || typeof v !== "object")) payloadForHash[k] = v;
        }
        payloadHash = idem.hashPayload(payloadForHash);
        const cached = await idem.socketCheck(idempotencyKey, judgeId, payloadHash);
        if (cached?.error) {
          reject(cached.error, { status: cached.status });
          return;
        }
        if (cached) {
          // Cache hit, replay the success ack to THIS socket only.
          // The original room broadcast already fired on the first
          // submission; replaying it would double-broadcast.
          socket.emit("score_received", cached.response_body);
          safeAck({ ok: true, response: cached.response_body, replay: true });
          return;
        }
      }

      const client = await pool.connect();
      let scoreId, judgeNumber, oldScore = null, isInsert = true;
      try {
        await client.query("BEGIN");

        // events.status rides along on the panel lookup so the
        // Live gate below costs no extra round-trip.
        const jnRes = await client.query(
          `SELECT ej.judge_number, e.status AS event_status
           FROM event_judges ej
           JOIN events e ON e.id = ej.event_id
           WHERE ej.event_id = $1 AND ej.judge_id = $2`,
          [data.event_id, judgeId],
        );
        if (!jnRes.rows.length) {
          await client.query("ROLLBACK");
          reject("not_on_panel", { message: "You're not on the judging panel for this event." });
          return;
        }
        // Scores only land while the event is Live. Without this a
        // panel judge could write into an Upcoming event or
        // overwrite a finalised Completed one (stale keypad tab,
        // late outbox replay after finalise).
        if (jnRes.rows[0].event_status !== "Live") {
          await client.query("ROLLBACK");
          reject("event_not_live", { message: "Scores can only be submitted while the event is Live." });
          return;
        }
        judgeNumber = jnRes.rows[0].judge_number;

        const dvRes = await client.query(
          `SELECT dive_id FROM competitor_dive_lists
           WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [data.event_id, data.competitor_id, round],
        );
        // dive_id comes from the server-side dive list ONLY. When
        // the diver has no row for this round, store NULL and let
        // the operator fix the list. Falling back to the wire
        // value would let a stale client smuggle in the wrong
        // dive's DD.
        const resolvedDiveId = dvRes.rows[0]?.dive_id ?? null;

        const prior = await client.query(
          `SELECT id, score, score_source FROM scores
           WHERE event_id=$1 AND competitor_id=$2 AND round_number=$3 AND judge_id=$4
           FOR UPDATE`,
          [data.event_id, data.competitor_id, round, judgeId],
        );
        const existing = prior.rows[0] || null;
        isInsert = !existing;
        oldScore = existing ? Number(existing.score) : null;

        // Manual-fallback reconciliation (P5). If an operator
        // already typed this judge's score during an outage, the
        // existing row has score_source='manual_entry'. Two cases:
        //
        //   * Match  → silently confirm. Update source to
        //              'manual_then_reconciled'; the audit row
        //              captures the digital sync arrival.
        //   * Mismatch → operator wins (MANUAL-VS-SYNC-001). The
        //                judge's digital sync is rejected with a
        //                conflict_pending event so the review tray
        //                surfaces the mismatch for the referee.
        let reconciledManual = false;
        if (existing && existing.score_source === "manual_entry") {
          if (oldScore === score) {
            // Same value, reconcile by flipping the source.
            // status back to active too: this is the judge scoring again
            // after a redive, same as the upsert below.
            await client.query(
              `UPDATE scores SET score_source = 'manual_then_reconciled',
                                 actor_local_time = $2, status = 'active'
               WHERE id = $1`,
              [existing.id, actorLocalTime],
            );
            scoreId = existing.id;
            reconciledManual = true;
          } else {
            // Different value, operator's manual entry wins. We
            // DON'T update the score; we audit-log the rejected
            // digital sync and emit conflict_pending for the
            // operator's review tray.
            await insertScoreAudit(client, {
              scoreId: existing.id, eventId: data.event_id, competitorId: data.competitor_id,
              judgeId, round, action: "rejected_duplicate",
              // old = the operator's manual value, new = the judge's late
              // sync, which is the one being rejected.
              oldScore, newScore: score,
              actorId: socket.userId, ip: clientIp(socket),
              userAgent: socket.handshake.headers["user-agent"] || null,
              reason: "P5 reconciliation: judge digital sync differs from manual entry; operator value retained",
              actorLocalTime, committedNow: true,
            });
            await client.query("COMMIT");
            // Emit conflict so the operator can see the mismatch.
            io.to(`event:${data.event_id}`).emit("conflict_pending", {
              conflict_id: existing.id,
              action_type: "submit_score_vs_manual_entry",
              actor_id: judgeId,
              actor_local_time: actorLocalTime,
              target: {
                event_id: data.event_id,
                competitor_id: data.competitor_id,
                round_number: round,
                judge_id: judgeId,
              },
              existing_value: { score: oldScore, source: "manual_entry" },
              proposed_value: { score, source: "judge_direct" },
              resolution_required_by: "operator",
              created_at: new Date().toISOString(),
            });
            // Tell the judge their sync landed but was superseded.
            // The outbox will mark this entry as synced (no retry
            // needed); the operator decides via the review tray.
            socket.emit("score_received", {
              event_id: data.event_id,
              competitor_id: data.competitor_id,
              round_number: round,
              dive_id: undefined,
              judge_id: judgeId,
              judge_number: judgeNumber,
              score: oldScore,            // canonical = operator value
              superseded_by: "manual_entry",
            });
            metrics?.scoresSubmitted.inc();
            return;
          }
        }

        // actor_local_time captures the judge's tap moment (when
        // the client outbox stamped the entry). Falls back to NULL
        // for legacy clients that don't use the outbox.
        //
        // Skip the UPSERT when we already handled the reconciliation
        // branch above (the row exists with the correct value;
        // we just flipped score_source).
        if (!reconciledManual) {
          const upsert = await client.query(
            `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score, actor_local_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (event_id, competitor_id, round_number, judge_id)
             DO UPDATE SET score = EXCLUDED.score, status = 'active',
                           actor_local_time = EXCLUDED.actor_local_time
             RETURNING id`,
            [
              data.event_id, data.competitor_id, judgeId,
              resolvedDiveId, round, score, actorLocalTime,
            ],
          );
          scoreId = upsert.rows[0].id;
        }

        if (isInsert || oldScore !== score || reconciledManual) {
          // Audit row records both clocks (migration 054). For
          // legacy online-only clients actor_local_time is NULL and
          // server_committed_at is now(), those rows look like the
          // pre-outbox world. For outbox clients both are populated.
          // For reconciled manual entries the action is 'reconcile'
          // so audit queries can spot the merge cleanly.
          const auditAction = reconciledManual
            ? "reconcile_manual"
            : (isInsert ? "insert" : "update");
          await insertScoreAudit(client, {
            scoreId, eventId: data.event_id, competitorId: data.competitor_id,
            judgeId, round, action: auditAction,
            oldScore, newScore: score,
            actorId: socket.userId, ip: clientIp(socket),
            userAgent: socket.handshake.headers["user-agent"] || null,
            actorLocalTime, committedNow: true,
          });
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[Score Persist Error]", err.message);
        reject("server_error");
        return;
      } finally {
        client.release();
      }

      metrics?.scoresSubmitted.inc();

      // Invalidate the cached scoreboard payload so the next
      // /api/scoreboard read rebuilds with this score included.
      // The TTL would otherwise let viewers stay 5s stale.
      scoreboardCache?.invalidate(data.event_id);

      // Build the score_received payload once so we can both
      // broadcast it AND cache it in idempotency_keys. Caching the
      // exact payload (not just "ok: true") means a replay can
      // tell the judge's UI the same details the original got.
      // Built from what the server checked, never by spreading the
      // client's object: that echoed arbitrary junk to the whole room
      // (the encoder walks it recursively, so a deep enough one crashed
      // the emit) and sent the raw score, say null, while 0 was stored.
      const scoreReceivedBody = {
        event_id: data.event_id,
        competitor_id: data.competitor_id,
        round_number: round,
        score,
        judge_id: judgeId,
        judge_number: judgeNumber,
      };
      io.to(`event:${data.event_id}`).emit("score_received", scoreReceivedBody);
      // Per-submit ack to the originating socket. The outbox
      // drain protocol resolves its pending entry on this ack;
      // legacy clients (no outbox) ignore it.
      safeAck({ ok: true, response: scoreReceivedBody });

      // Cache the response for outbox retries. Fire-and-forget;
      // failures log + continue. The judge's UI doesn't wait for
      // this to complete, the broadcast above is the user-facing
      // ack.
      if (idempotencyKey && payloadHash) {
        idem.socketStore(
          idempotencyKey, judgeId, "submit_score",
          payloadHash, 200, scoreReceivedBody,
        );
      }

      // Venue bridge fan-out: refresh the scoreboard_state for
      // hardware boards every time a judge submits.
      if (data.event_id) emitVenue(data.event_id, "submit_score");

      // A new score can only raise a book. One that replaced a score
      // already there (a corrected score, a judge scoring again after a
      // redive) can lower it, or raise a mark the dive itself set, so
      // those replay the dive's books instead.
      announceRecords({
        checkAndApplyRecords,
        recomputeRecordKeys: isInsert ? null : recomputeRecordKeys,
        io, scoreboardCache,
        eventId:      data.event_id,
        competitorId: data.competitor_id,
        roundNumber:  round,
      });
    });

    on("announce_score", async (data, ack) => {
      if (!(await guardControl(socket, data, ack, "announce_score",
                               { unauthorized: "not authorised", rateLimited: "rate limited" }))) return;
      io.to(`event:${data.event_id}`).emit("final_score_announced", data);
      // Venue bridges want the post-final state: dive_total is now
      // present, running_total + rank updated, leaderboard reshuffled.
      if (data.event_id) emitVenue(data.event_id, "announce_score");
      ackWith(ack, { ok: true });
    });

    // -----------------------------------------------------------
    // judge_signal: judge taps "Signal Referee" on the keypad
    // (e.g. didn't see the dive, wants a re-dive review,
    // disagrees with the scoreboard). Server validates the
    // sender is a judge on this event's panel, then rebroadcasts
    // to the event room. Control Room highlights the judge's
    // tile in red until the next state_update or another signal
    // toggling it off.
    //
    // judge_id + judge_number come from the server's view of
    // event_judges, never from the wire, same posture as
    // submit_score.
    // -----------------------------------------------------------
    on("judge_signal", async (data) => {
      if (!socket.userId) return;
      if (!socketRequireRole(socket)) return;     // maintenance mode
      if (socketActionRateLimited("judge_signal", socket.userId)) return;
      if (typeof socket.userTokenVersion === "number"
          && !(await isTokenVersionCurrent(socket.userId, socket.userTokenVersion))) {
        socket.disconnect(true);
        return;
      }
      if (!data?.event_id || !data?.competitor_id) return;
      const round = Number(data.round_number);
      if (!Number.isInteger(round) || round < 1) return;
      try {
        const r = await pool.query(
          `SELECT judge_number FROM event_judges
           WHERE event_id = $1 AND judge_id = $2`,
          [data.event_id, socket.userId],
        );
        if (!r.rows.length) return;        // not on this panel
        const judgeNumber = r.rows[0].judge_number;
        io.to(`event:${data.event_id}`).emit("judge_signal", {
          event_id:      data.event_id,
          competitor_id: data.competitor_id,
          round_number:  round,
          judge_id:      socket.userId,
          judge_number:  judgeNumber,
          signaled:      !!data.signaled,
        });
      } catch (err) {
        console.error("[Judge Signal Error]", err.message);
      }
    });

    // -----------------------------------------------------------
    // Referee actions: UPDATE the actual scores AND persist to
    // score_audit_log. 'failed' → 0; 'cap' → LEAST(score, cap);
    // 'redive' → no score change (new dive overwrites via
    // submit_score on the same UNIQUE key).
    // -----------------------------------------------------------
    // Resolves { ok: true, capValue } when the action landed, otherwise
    // { ok: false, error } (and referee_action_rejected has gone to the
    // socket where there's a reason worth telling it).
    const REFEREE_FAILED = { ok: false, error: "action_failed" };
    async function applyRefereeAction(action, data, actorUserId) {
      if (!data?.event_id || !data?.competitor_id) return REFEREE_FAILED;
      // Validate round_number is a positive integer, matching the
      // submit_score / judge_signal paths. Previously only truthiness
      // was checked, so a malformed value reached the parameterized
      // UPDATE and surfaced as a confusing 500 instead of a clean
      // rejection, an inconsistent input surface across the three
      // score-mutation paths.
      const round = Number(data.round_number);
      if (!Number.isInteger(round) || round < 1) {
        socket.emit("referee_action_rejected", { reason: "bad_round" });
        return REFEREE_FAILED;
      }
      // Use the coerced integer downstream so a value like "3.0"
      // (passes the integer check but fails a Postgres int cast)
      // can't reach the parameterized queries below.
      data.round_number = round;
      let capValue = 2.0;
      if (action === "cap") {
        const raw = Number(data.cap_value);
        if (!Number.isFinite(raw) || raw < 0 || raw > 10) {
          socket.emit("referee_action_rejected", {
            reason: "bad_cap_value",
            message: "cap_value must be between 0 and 10.",
          });
          return REFEREE_FAILED;
        }
        capValue = raw;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Live events only, same as submit_score. Otherwise a referee
        // could fail, cap or redive a dive in a finalised event and move
        // the published results and record books after the fact. FOR
        // SHARE holds the status still until this commits.
        const ev = await client.query("SELECT status FROM events WHERE id = $1 FOR SHARE", [data.event_id]);
        if (ev.rows[0]?.status !== "Live") {
          await client.query("ROLLBACK");
          socket.emit("referee_action_rejected", {
            reason: "event_not_live",
            message: "Referee actions only apply while the event is Live.",
          });
          return { ok: false, error: "event_not_live" };
        }
        const auditReason = `referee:${action}` + (action === "cap" ? `(${capValue})` : "");
        if (action === "failed") {
          await client.query(
            `WITH prior AS (
               SELECT id, score AS old_score
               FROM scores
               WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
               FOR UPDATE
             ),
             updated AS (
               UPDATE scores s
               SET score = 0
               FROM prior p
               WHERE s.id = p.id
               RETURNING s.id, s.event_id, s.competitor_id, s.judge_id,
                         s.round_number, p.old_score, s.score AS new_score
             )
             INSERT INTO score_audit_log
               (score_id, event_id, competitor_id, judge_id, round_number,
                action, old_score, new_score, actor_user_id, ip_address, user_agent, reason)
             SELECT id, event_id, competitor_id, judge_id, round_number,
                    'update', old_score, new_score,
                    $4, $5, $6, $7
             FROM updated`,
            [
              data.event_id, data.competitor_id, data.round_number,
              actorUserId || null,
              clientIp(socket),
              socket.handshake.headers["user-agent"] || null,
              auditReason,
            ],
          );
        } else if (action === "cap") {
          await client.query(
            `WITH prior AS (
               SELECT id, score AS old_score
               FROM scores
               WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
               FOR UPDATE
             ),
             updated AS (
               UPDATE scores s
               SET score = LEAST(s.score, $4::numeric)
               FROM prior p
               WHERE s.id = p.id
               RETURNING s.id, s.event_id, s.competitor_id, s.judge_id,
                         s.round_number, p.old_score, s.score AS new_score
             )
             INSERT INTO score_audit_log
               (score_id, event_id, competitor_id, judge_id, round_number,
                action, old_score, new_score, actor_user_id, ip_address, user_agent, reason)
             SELECT id, event_id, competitor_id, judge_id, round_number,
                    'update', old_score, new_score,
                    $5, $6, $7, $8
             FROM updated`,
            [
              data.event_id, data.competitor_id, data.round_number, capValue,
              actorUserId || null,
              clientIp(socket),
              socket.handshake.headers["user-agent"] || null,
              auditReason,
            ],
          );
        } else if (action === "redive") {
          // Redive changes no score (the diver's new dive overwrites
          // the round via submit_score on the same UNIQUE key), but we
          // still record the referee action so the audit trail shows
          // it. No UPDATE → old_score == new_score == current score.
          //
          // The old panel's rows are marked 'redive' though, and each
          // judge's new score flips its row back to active. Records
          // only count a dive whose whole panel is active, so a dive
          // with one fresh score and six stale ones can't set one.
          await client.query(
            `UPDATE scores SET status = 'redive'
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
            [data.event_id, data.competitor_id, data.round_number],
          );
          await client.query(
            `INSERT INTO score_audit_log
               (score_id, event_id, competitor_id, judge_id, round_number,
                action, old_score, new_score, actor_user_id, ip_address, user_agent, reason)
             SELECT s.id, s.event_id, s.competitor_id, s.judge_id, s.round_number,
                    'update', s.score, s.score,
                    $4, $5, $6, $7
             FROM scores s
             WHERE s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3`,
            [
              data.event_id, data.competitor_id, data.round_number,
              actorUserId || null,
              clientIp(socket),
              socket.handshake.headers["user-agent"] || null,
              auditReason,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[Referee Action Failed]", err.message);
        socket.emit("referee_action_rejected", { reason: "server_error" });
        return REFEREE_FAILED;
      } finally {
        client.release();
      }
      // Same reasoning as submit_score: fail/cap/redive
      // changed (or could change) the standings; flush so the
      // next /api/scoreboard read rebuilds.
      scoreboardCache?.invalidate(data.event_id);
      // A Failed or capped dive that already set a record doesn't hold
      // it any more, and a redive's old total never counted. Replay its
      // books. Not awaited, same as submit_score's check.
      if (recomputeRecordKeys) {
        announceRecords({
          recomputeRecordKeys, io, scoreboardCache,
          eventId: data.event_id, competitorId: data.competitor_id, roundNumber: data.round_number,
        });
      }
      return { ok: true, capValue };
    }

    on("referee_failed_dive", async (data, ack) => {
      if (!(await guardControl(socket, data, ack, "referee_action"))) return;
      const result = await applyRefereeAction("failed", data, socket.userId);
      if (!result.ok) {
        ackWith(ack, { ok: false, error: result.error });
        return;
      }
      io.to(`event:${data.event_id}`).emit("referee_action_failed", data);
      io.to(`event:${data.event_id}`).emit("score_corrected", {
        event_id: data.event_id,
        competitor_id: data.competitor_id,
        round_number: data.round_number,
        reason: "referee:failed",
      });
      ackWith(ack, { ok: true });
    });
    on("referee_cap_scores", async (data, ack) => {
      if (!(await guardControl(socket, data, ack, "referee_action"))) return;
      const result = await applyRefereeAction("cap", data, socket.userId);
      if (!result.ok) {
        ackWith(ack, { ok: false, error: result.error });
        return;
      }
      io.to(`event:${data.event_id}`).emit("referee_action_cap", data);
      io.to(`event:${data.event_id}`).emit("score_corrected", {
        event_id: data.event_id,
        competitor_id: data.competitor_id,
        round_number: data.round_number,
        // The value actually applied. `data.cap_value || 2.0` read a cap
        // of 0 as 2.
        reason: `referee:cap(${result.capValue})`,
      });
      ackWith(ack, { ok: true });
    });
    on("referee_redive", async (data, ack) => {
      if (!(await guardControl(socket, data, ack, "referee_action"))) return;
      const result = await applyRefereeAction("redive", data, socket.userId);
      if (!result.ok) {
        ackWith(ack, { ok: false, error: result.error });
        return;
      }
      io.to(`event:${data.event_id}`).emit("referee_action_redive", data);
      ackWith(ack, { ok: true });
    });

    // -----------------------------------------------------------
    // Hold / resume the meet
    // -----------------------------------------------------------
    on("meet_hold", async (data, ack) => {
      if (!(await guardControl(socket, data, ack, "meet_hold"))) return;
      meetHolds[data.event_id] = {
        reason: data.reason || null,
        since: Date.now(),
      };
      // Write-through to event_live_state.
      if (typeof persistMeetHold === "function") {
        persistMeetHold(data.event_id, {
          reason: meetHolds[data.event_id].reason,
          since:  new Date(meetHolds[data.event_id].since),
        });
      }
      io.to(`event:${data.event_id}`).emit("meet_held",
        { event_id: data.event_id, ...meetHolds[data.event_id] });
      // Venue: flip on_hold=true so the bridge can flash a HOLD banner.
      emitVenue(data.event_id, "meet_hold");
      ackWith(ack, { ok: true });
    });
    on("meet_resume", async (data, ack) => {
      if (!(await guardControl(socket, data, ack, "meet_resume"))) return;
      delete meetHolds[data.event_id];
      if (typeof persistClearMeetHold === "function") {
        persistClearMeetHold(data.event_id);
      }
      io.to(`event:${data.event_id}`).emit("meet_resumed", { event_id: data.event_id });
      // The hold is gone by now, so this sends on_hold=false.
      emitVenue(data.event_id, "meet_resume");
      ackWith(ack, { ok: true });
    });
    on("get_meet_hold", (data) => {
      if (!joinEvent(data?.event_id)) return;
      const state = meetHolds[data.event_id];
      if (state) socket.emit("meet_held", { event_id: data.event_id, ...state });
    });
  });
};
