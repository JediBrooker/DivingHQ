// Socket engine — every io.on / socket.on handler the app uses.
// Extracted from server.js as part of the Phase-3 split. Factory
// signature mirrors the rest of the route modules: pass in the
// pieces it needs and the function attaches handlers to `io`.
//
// Wires up:
//   * io.use(handshake)          — soft JWT verify, stash userId,
//                                   org_id, roles, sysadmin flag,
//                                   honour token_version (Migration 021)
//   * connection                 — broadcast current activeDivers,
//                                   join event rooms, register events
//   * subscribe_event            — explicit room join
//   * set_active_diver           — driven by Control Room
//   * get_active_diver           — on-demand pull for late joiners
//   * submit_score               — judge scoring (transactional)
//   * announce_score             — Control Room "say it on screen"
//   * referee_failed_dive / cap_scores / redive
//   * meet_hold / meet_resume / get_meet_hold
//
// All event-scoped emits use io.to(`event:${id}`) so two
// concurrent meets on the same instance don't cross-leak score
// events to each other's spectators.
//
// Per-event authz comes from socketCanManageEvent — verifies the
// event belongs to the caller's org or that they have an
// event_managers row. Rate limiting is per-(action, user) so a
// single role-holder can't spam meet_hold cycles.

const jwt = require("jsonwebtoken");
const createIdempotency = require("../lib/idempotency");
const { readSessionCookie } = require("../lib/session-cookie");

module.exports = function attachSocket({
  io,
  pool,
  JWT_SECRET,
  // From lib/middleware:
  socketRequireRole,        // currently re-exported but no longer
                            // used directly — every privileged event
                            // calls socketCanManageEvent now.
  socketCanManageEvent,
  isValidScore,
  isTokenVersionCurrent,
  // From lib/records:
  checkAndApplyRecords,
  // From lib/live-state:
  activeDivers,
  meetHolds,
  // Persistence helpers — fire-and-forget DB writes that
  // mirror the in-memory map mutations so a server restart
  // mid-meet doesn't leak the live state.
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
  // From lib/push: optional. When supplied the connection
  // handler joins per-user rooms (`user:<id>`) so the engine can
  // io.to()` an in-app banner, and adopts a `notification:ack`
  // listener so the SPA's banner click marks the row read.
  push,
}) {
  if (!io || !pool || !JWT_SECRET) {
    throw new Error("attachSocket requires { io, pool, JWT_SECRET, … }");
  }
  // Avoid an unused-var lint warning while still naming the
  // dependency at the call site for clarity.
  void socketRequireRole;

  // Idempotency layer (migration 054 + lib/idempotency.js).
  // Socket handlers that accept writes call `idem.socketCheck`
  // on the incoming payload's `idempotency_key` and replay the
  // cached response on hit. See docs/offline-p1-design.md §2.
  const idem = createIdempotency({ pool });

  // -----------------------------------------------------------
  // Handshake — soft JWT verify
  // -----------------------------------------------------------
  // We don't reject — spectators connect with no token — but if a
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
    const authToken = socket.handshake.auth?.token;
    const raw = authToken === "spectator"
      ? null
      : (authToken || readSessionCookie(socket.handshake.headers?.cookie));
    if (raw) {
      try {
        const decoded = jwt.verify(raw, JWT_SECRET, { algorithms: ["HS256"] });
        // Validate tv via the same 30s cache the HTTP path uses.
        // A revoked session must lose its socket privileges too.
        const tvOk = await isTokenVersionCurrent(decoded.id, decoded.tv);
        if (!tvOk) return next();        // stale — fall through to anonymous
        socket.userId = decoded.id;
        socket.userOrgId = decoded.org_id;
        socket.userIsSystemAdmin = !!decoded.is_system_admin;
        socket.userOrgRoles = decoded.org_roles || [];
        // Stash the token version so socketCanManageEvent can
        // re-check it on every privileged action (catches role
        // revocation / 2FA-bump on a long-lived websocket).
        socket.userTokenVersion = decoded.tv != null ? Number(decoded.tv) : null;
      } catch {
        // Invalid token — treat as anonymous (spectator).
      }
    }
    next();
  });

  // -----------------------------------------------------------
  // XFF / IP — mirror the Express side's TRUST_PROXY chain
  // length so audit-log IPs aren't trivially forgeable.
  // -----------------------------------------------------------
  const TRUST_PROXY_HOPS = (() => {
    const raw = process.env.TRUST_PROXY;
    if (raw === undefined || raw === "" || raw === "true") return 1;
    if (raw === "false" || raw === "0") return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  })();

  function clientIp(socket) {
    const fwd = socket.handshake.headers["x-forwarded-for"];
    if (fwd && TRUST_PROXY_HOPS > 0) {
      const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
      const idx = Math.max(0, parts.length - 1 - TRUST_PROXY_HOPS);
      if (parts[idx]) return parts[idx];
      if (parts[0]) return parts[0];
    }
    return socket.handshake.address || null;
  }

  // -----------------------------------------------------------
  // Rate limiters (per-judge for scores, per-(action,user) for
  // every other privileged event)
  // -----------------------------------------------------------
  const SCORE_LIMIT = 60;
  const SCORE_WINDOW_MS = 60 * 1000;
  const scoreSubmissions = new Map();   // judgeId → array of timestamps

  function judgeIsRateLimited(judgeId) {
    if (!judgeId) return false;
    const now = Date.now();
    const cutoff = now - SCORE_WINDOW_MS;
    const arr = (scoreSubmissions.get(judgeId) || []).filter((t) => t > cutoff);
    if (arr.length >= SCORE_LIMIT) {
      scoreSubmissions.set(judgeId, arr);
      return true;
    }
    arr.push(now);
    scoreSubmissions.set(judgeId, arr);
    return false;
  }

  const SOCKET_ACTION_LIMITS = {
    meet_hold:        { limit: 10, windowMs: 60 * 1000 },
    meet_resume:      { limit: 10, windowMs: 60 * 1000 },
    set_active_diver: { limit: 60, windowMs: 60 * 1000 },
    referee_action:   { limit: 30, windowMs: 60 * 1000 },
    announce_score:   { limit: 30, windowMs: 60 * 1000 },
    // judge_signal: 30 toggles/min/judge — generous because a
    // judge might toggle on/off a few times legitimately, but
    // tight enough to stop a malicious client spamming the
    // Control Room with red flashes.
    judge_signal:     { limit: 30, windowMs: 60 * 1000 },
  };
  const socketActionWindows = new Map();   // `${action}:${userId}` → [t,…]

  function socketActionRateLimited(action, userId) {
    const cfg = SOCKET_ACTION_LIMITS[action];
    if (!cfg || !userId) return false;
    const key = `${action}:${userId}`;
    const now = Date.now();
    const cutoff = now - cfg.windowMs;
    const arr = (socketActionWindows.get(key) || []).filter((t) => t > cutoff);
    if (arr.length >= cfg.limit) {
      socketActionWindows.set(key, arr);
      return true;
    }
    arr.push(now);
    socketActionWindows.set(key, arr);
    return false;
  }

  // Per-IP limiter for the unauthenticated, expensive read events.
  // socketActionRateLimited above is keyed on userId and no-ops for
  // anonymous spectators/bridges (userId is null), so the public reads
  // that trigger real DB work need an IP-keyed guard of their own —
  // the socket analogue of server.js's HTTP exportLimiter. Today only
  // subscribe_venue qualifies: it runs the multi-CTE leaderboard build
  // in lib/venue-state.js. Cheap room-join reads (subscribe_event,
  // get_active_diver, get_meet_hold) don't touch the DB, so they're
  // left out — a connection cap is the right control for those.
  const SOCKET_IP_LIMITS = {
    subscribe_venue: { limit: 30, windowMs: 60 * 1000 },
  };
  const socketIpWindows = new Map();   // `${action}:${ip}` → [t,…]

  function socketIpRateLimited(action, ip) {
    const cfg = SOCKET_IP_LIMITS[action];
    if (!cfg || !ip) return false;     // unknown IP → can't key, fail open
    const key = `${action}:${ip}`;
    const now = Date.now();
    const cutoff = now - cfg.windowMs;
    const arr = (socketIpWindows.get(key) || []).filter((t) => t > cutoff);
    if (arr.length >= cfg.limit) {
      socketIpWindows.set(key, arr);
      return true;
    }
    arr.push(now);
    socketIpWindows.set(key, arr);
    return false;
  }

  // events.id is a UUID; reject anything else before doing DB work.
  // Same lenient shape used for event ids elsewhere (lib/records.js).
  const EVENT_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  setInterval(() => {
    const cutoff = Date.now() - SCORE_WINDOW_MS;
    for (const [judgeId, arr] of scoreSubmissions.entries()) {
      const fresh = arr.filter((t) => t > cutoff);
      if (fresh.length === 0) scoreSubmissions.delete(judgeId);
      else scoreSubmissions.set(judgeId, fresh);
    }
    const maxWindow = Math.max(...Object.values(SOCKET_ACTION_LIMITS).map(c => c.windowMs));
    const actionCutoff = Date.now() - maxWindow;
    for (const [key, arr] of socketActionWindows.entries()) {
      const fresh = arr.filter((t) => t > actionCutoff);
      if (fresh.length === 0) socketActionWindows.delete(key);
      else socketActionWindows.set(key, fresh);
    }
    const ipMaxWindow = Math.max(...Object.values(SOCKET_IP_LIMITS).map(c => c.windowMs));
    const ipCutoff = Date.now() - ipMaxWindow;
    for (const [key, arr] of socketIpWindows.entries()) {
      const fresh = arr.filter((t) => t > ipCutoff);
      if (fresh.length === 0) socketIpWindows.delete(key);
      else socketIpWindows.set(key, fresh);
    }
  }, 5 * 60 * 1000).unref?.();

  // -----------------------------------------------------------
  // Connection
  // -----------------------------------------------------------
  io.on("connection", (socket) => {
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
    });

    // Per-user room — the push engine `io.to(\`user:<id>\`)` fans
    // an in-app banner out to every open SPA tab the user has.
    // Also doubles as the routing key for any future direct-to-
    // user broadcast (judge calls, dive-on-deck nudges, etc.).
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    // SPA banner click → mark the notifications row 'acknowledged'
    // via the engine. Idempotent; cross-user attempts no-op
    // because the engine scopes the UPDATE to user_id.
    socket.on("notification:ack", async (data) => {
      if (!socket.userId || !data?.id || !push) return;
      try {
        await push.acknowledgeNotification(data.id, socket.userId);
      } catch (err) {
        console.error("[notification:ack]", err.message);
      }
    });

    // Helper: clients join `event:${id}` rooms when they
    // subscribe to an event (via get_active_diver, get_meet_hold,
    // or by explicit `subscribe_event`).
    function joinEvent(eventId) {
      if (!eventId) return;
      socket.join(`event:${eventId}`);
    }
    socket.on("subscribe_event", (data) => joinEvent(data?.event_id));

    // Venue bridge subscription. Hardware bridges (Daktronics,
    // Colorado Time Systems, OmegaTiming, etc.) join `venue:<id>`
    // rooms to receive canonical `venue.scoreboard_state` payloads.
    // See lib/venue-state.js for the spec + wire shape.
    //
    // No auth gate here — a bridge runs inside the venue's own LAN
    // and the venue operator chose to install it. Adding a
    // dedicated bridge token would harden against curious public
    // clients but doesn't change the security posture (the same
    // data is on the public scoreboard already).
    function joinVenue(eventId) {
      if (!eventId) return;
      socket.join(`venue:${eventId}`);
    }
    socket.on("subscribe_venue", async (data) => {
      const eventId = data?.event_id;
      // Validate shape before any work: events.id is a UUID, so a
      // malformed id is junk — reject it without joining a room or
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
      // state to render — important after a bridge restart.
      try {
        const { emitVenueState } = require("../lib/venue-state");
        await emitVenueState({
          io,
          pool,
          eventId,
          activePayload: activeDivers[eventId],
          onHoldReason: meetHolds[eventId]?.reason || null,
        });
      } catch (err) {
        console.error("[subscribe_venue] initial snapshot failed", err.message);
      }
    });

    // Bring late-arriving clients up to speed with whatever's
    // currently live.
    if (Object.keys(activeDivers).length > 0) {
      Object.values(activeDivers).forEach((state) => {
        socket.emit("state_update", state);
      });
    }

    socket.on("set_active_diver", async (data) => {
      if (!(await socketCanManageEvent(socket, data?.event_id,
                                       ["meet_manager", "referee", "org_admin"]))) return;
      if (socketActionRateLimited("set_active_diver", socket.userId)) return;
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
      // Errors logged but never propagate — score path stays clean.
      if (data.event_id && push) {
        try {
          require("../lib/coach-alerts")
            .maybeNotifyCoachesOfNextDivers({ pool, push }, data.event_id, data);
        } catch (err) {
          console.error("[set_active_diver] coach alert hook failed", err.message);
        }
      }

      // Venue scoreboard state — fan out to any connected
      // hardware bridge in this event's venue room. See
      // lib/venue-state.js for the wire shape.
      if (data.event_id) {
        try {
          require("../lib/venue-state").emitVenueState({
            io, pool,
            eventId: data.event_id,
            activePayload: data,
            onHoldReason: meetHolds[data.event_id]?.reason || null,
          });
        } catch (err) {
          console.error("[set_active_diver] venue emit failed", err.message);
        }
      }
    });

    socket.on("get_active_diver", (data) => {
      if (!data?.event_id) return;
      joinEvent(data.event_id);
      const state = activeDivers[data.event_id];
      if (state) socket.emit("state_update", state);
    });

    // -----------------------------------------------------------
    // submit_score — fully transactional. Prior-row read with
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
    socket.on("submit_score", async (data, ack) => {
      // Socket.IO ack callback (3rd argument). When the client
      // uses the outbox drain protocol, it provides a callback to
      // correlate "my submit" with "the server confirmed mine" —
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
      // work. Hash excludes the key itself + actor_local_time so a
      // retry with the same semantic payload but different wall-clock
      // claim still matches the cache.
      const idempotencyKey = data.idempotency_key;
      const actorLocalTime = data.actor_local_time || null;
      let payloadHash = null;
      if (idempotencyKey) {
        const payloadForHash = { ...data };
        delete payloadForHash.idempotency_key;
        delete payloadForHash.actor_local_time;
        payloadHash = idem.hashPayload(payloadForHash);
        const cached = await idem.socketCheck(idempotencyKey, judgeId, payloadHash);
        if (cached?.error) {
          reject(cached.error, { status: cached.status });
          return;
        }
        if (cached) {
          // Cache hit — replay the success ack to THIS socket only.
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
        // the operator fix the list — falling back to the wire
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
            // Same value — reconcile by flipping the source.
            await client.query(
              `UPDATE scores SET score_source = 'manual_then_reconciled',
                                 actor_local_time = $2
               WHERE id = $1`,
              [existing.id, actorLocalTime],
            );
            scoreId = existing.id;
            reconciledManual = true;
          } else {
            // Different value — operator's manual entry wins. We
            // DON'T update the score; we audit-log the rejected
            // digital sync and emit conflict_pending for the
            // operator's review tray.
            await client.query(
              `INSERT INTO score_audit_log
                 (score_id, event_id, competitor_id, judge_id, round_number,
                  action, old_score, new_score, actor_user_id, ip_address, user_agent,
                  reason, actor_local_time, server_committed_at)
               VALUES ($1,$2,$3,$4,$5,'rejected_duplicate',$6,$7,$8,$9,$10,$11,$12,now())`,
              [
                existing.id, data.event_id, data.competitor_id, judgeId, round,
                oldScore, score,  // old=operator's manual, new=judge's late sync (rejected)
                socket.userId, clientIp(socket),
                socket.handshake.headers["user-agent"] || null,
                "P5 reconciliation: judge digital sync differs from manual entry; operator value retained",
                actorLocalTime,
              ],
            );
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
          // server_committed_at is now() — those rows look like the
          // pre-outbox world. For outbox clients both are populated.
          // For reconciled manual entries the action is 'reconcile'
          // so audit queries can spot the merge cleanly.
          const auditAction = reconciledManual
            ? "reconcile_manual"
            : (isInsert ? "insert" : "update");
          await client.query(
            `INSERT INTO score_audit_log
               (score_id, event_id, competitor_id, judge_id, round_number,
                action, old_score, new_score, actor_user_id, ip_address, user_agent,
                actor_local_time, server_committed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
            [
              scoreId, data.event_id, data.competitor_id, judgeId, round,
              auditAction,
              oldScore, score,
              socket.userId, clientIp(socket),
              socket.handshake.headers["user-agent"] || null,
              actorLocalTime,
            ],
          );
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
      const scoreReceivedBody = {
        ...data,
        idempotency_key: undefined,  // never leak it back
        actor_local_time: undefined,
        dive_id: undefined,           // don't leak whatever the client sent
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
      // this to complete — the broadcast above is the user-facing
      // ack.
      if (idempotencyKey && payloadHash) {
        idem.socketStore(
          idempotencyKey, judgeId, "submit_score",
          payloadHash, 200, scoreReceivedBody,
        );
      }

      // Venue bridge fan-out — refresh the scoreboard_state for
      // hardware boards every time a judge submits.
      if (data.event_id) {
        try {
          require("../lib/venue-state").emitVenueState({
            io, pool,
            eventId: data.event_id,
            activePayload: activeDivers[data.event_id],
            onHoldReason: meetHolds[data.event_id]?.reason || null,
          });
        } catch (err) {
          console.error("[submit_score] venue emit failed", err.message);
        }
      }

      checkAndApplyRecords({
        eventId:      data.event_id,
        competitorId: data.competitor_id,
        roundNumber:  round,
      }).then((broken) => {
        for (const b of broken) {
          io.to(`event:${data.event_id}`).emit("record_broken", b);
        }
      }).catch((e) => console.error("[Records broadcast]", e.message));
    });

    socket.on("announce_score", async (data) => {
      if (!(await socketCanManageEvent(socket, data?.event_id,
                                       ["meet_manager", "referee", "org_admin"]))) return;
      if (socketActionRateLimited("announce_score", socket.userId)) return;
      io.to(`event:${data.event_id}`).emit("final_score_announced", data);
      // Venue bridges want the post-final state: dive_total is now
      // present, running_total + rank updated, leaderboard reshuffled.
      if (data.event_id) {
        try {
          require("../lib/venue-state").emitVenueState({
            io, pool,
            eventId: data.event_id,
            activePayload: activeDivers[data.event_id],
            onHoldReason: meetHolds[data.event_id]?.reason || null,
          });
        } catch (err) {
          console.error("[announce_score] venue emit failed", err.message);
        }
      }
    });

    // -----------------------------------------------------------
    // judge_signal — judge taps "Signal Referee" on the keypad
    // (e.g. didn't see the dive, wants a re-dive review,
    // disagrees with the scoreboard). Server validates the
    // sender is a judge on this event's panel, then rebroadcasts
    // to the event room. Control Room highlights the judge's
    // tile in red until the next state_update or another signal
    // toggling it off.
    //
    // judge_id + judge_number come from the server's view of
    // event_judges, never from the wire — same posture as
    // submit_score.
    // -----------------------------------------------------------
    socket.on("judge_signal", async (data) => {
      if (!socket.userId) return;
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
    // Referee actions — UPDATE the actual scores AND persist to
    // score_audit_log. 'failed' → 0; 'cap' → LEAST(score, cap);
    // 'redive' → no score change (new dive overwrites via
    // submit_score on the same UNIQUE key).
    // -----------------------------------------------------------
    async function applyRefereeAction(action, data, actorUserId) {
      if (!data?.event_id || !data?.competitor_id) return;
      // Validate round_number is a positive integer, matching the
      // submit_score / judge_signal paths. Previously only truthiness
      // was checked, so a malformed value reached the parameterized
      // UPDATE and surfaced as a confusing 500 instead of a clean
      // rejection — an inconsistent input surface across the three
      // score-mutation paths.
      const round = Number(data.round_number);
      if (!Number.isInteger(round) || round < 1) {
        socket.emit("referee_action_rejected", { reason: "bad_round" });
        return;
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
          return;
        }
        capValue = raw;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
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
        await client.query("ROLLBACK");
        console.error("[Referee Action Failed]", err.message);
        socket.emit("referee_action_rejected", { reason: "server_error" });
        return;
      } finally {
        client.release();
      }
      // Same reasoning as submit_score — fail/cap/redive
      // changed (or could change) the standings; flush so the
      // next /api/scoreboard read rebuilds.
      scoreboardCache?.invalidate(data.event_id);
      return true;
    }

    socket.on("referee_failed_dive", async (data) => {
      if (!(await socketCanManageEvent(socket, data?.event_id,
                                       ["referee", "meet_manager", "org_admin"]))) return;
      if (socketActionRateLimited("referee_action", socket.userId)) return;
      if (!(await applyRefereeAction("failed", data, socket.userId))) return;
      io.to(`event:${data.event_id}`).emit("referee_action_failed", data);
      io.to(`event:${data.event_id}`).emit("score_corrected", {
        event_id: data.event_id,
        competitor_id: data.competitor_id,
        round_number: data.round_number,
        reason: "referee:failed",
      });
    });
    socket.on("referee_cap_scores", async (data) => {
      if (!(await socketCanManageEvent(socket, data?.event_id,
                                       ["referee", "meet_manager", "org_admin"]))) return;
      if (socketActionRateLimited("referee_action", socket.userId)) return;
      if (!(await applyRefereeAction("cap", data, socket.userId))) return;
      io.to(`event:${data.event_id}`).emit("referee_action_cap", data);
      io.to(`event:${data.event_id}`).emit("score_corrected", {
        event_id: data.event_id,
        competitor_id: data.competitor_id,
        round_number: data.round_number,
        reason: `referee:cap(${data.cap_value || 2.0})`,
      });
    });
    socket.on("referee_redive", async (data) => {
      if (!(await socketCanManageEvent(socket, data?.event_id,
                                       ["referee", "meet_manager", "org_admin"]))) return;
      if (socketActionRateLimited("referee_action", socket.userId)) return;
      if (!(await applyRefereeAction("redive", data, socket.userId))) return;
      io.to(`event:${data.event_id}`).emit("referee_action_redive", data);
    });

    // -----------------------------------------------------------
    // Hold / resume the meet
    // -----------------------------------------------------------
    socket.on("meet_hold", async (data) => {
      if (!(await socketCanManageEvent(socket, data?.event_id,
                                       ["meet_manager", "referee", "org_admin"]))) return;
      if (socketActionRateLimited("meet_hold", socket.userId)) return;
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
      try {
        require("../lib/venue-state").emitVenueState({
          io, pool,
          eventId: data.event_id,
          activePayload: activeDivers[data.event_id],
          onHoldReason: meetHolds[data.event_id].reason,
        });
      } catch (err) {
        console.error("[meet_hold] venue emit failed", err.message);
      }
    });
    socket.on("meet_resume", async (data) => {
      if (!(await socketCanManageEvent(socket, data?.event_id,
                                       ["meet_manager", "referee", "org_admin"]))) return;
      if (socketActionRateLimited("meet_resume", socket.userId)) return;
      delete meetHolds[data.event_id];
      if (typeof persistClearMeetHold === "function") {
        persistClearMeetHold(data.event_id);
      }
      io.to(`event:${data.event_id}`).emit("meet_resumed", { event_id: data.event_id });
      // Venue: clear on_hold so the bridge drops the HOLD banner.
      try {
        require("../lib/venue-state").emitVenueState({
          io, pool,
          eventId: data.event_id,
          activePayload: activeDivers[data.event_id],
          onHoldReason: null,
        });
      } catch (err) {
        console.error("[meet_resume] venue emit failed", err.message);
      }
    });
    socket.on("get_meet_hold", (data) => {
      if (!data?.event_id) return;
      joinEvent(data.event_id);
      const state = meetHolds[data.event_id];
      if (state) socket.emit("meet_held", { event_id: data.event_id, ...state });
    });

    socket.on("disconnect", () =>
      console.log(`[Socket] Disconnected: ${socket.id}`),
    );
  });
};
