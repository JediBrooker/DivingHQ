// Auth + RBAC + payload validation perimeter.
//
// Every gate the API uses to reject a request lives here, in one
// file, so an agent reviewing security can read the whole surface
// in one pass. AGENTS.md links to this file as the security
// perimeter; if you add a new gate, add it here, not inline in a
// route handler.
//
// Factory pattern (passed `pool` + `JWT_SECRET`) so the test
// runner can swap them when needed without monkey-patching.
//
// Exports:
//   verifyToken            — decode JWT into req.user
//   requireOrgRole(roles)  — at least one of the listed roles
//   requireSystemAdmin     — sysadmin only
//   requireEventManager    — manager-or-admin OR event_managers row,
//                            scoped to the event's own org
//   ensureEventOrgGate     — confirm the URL event is in the caller's org
//   isInSameOrg            — confirm a user/team belongs to the event's org
//   socketRequireRole      — analogue of requireOrgRole for Socket.IO
//   isValidScore           — 0–10, half-point increments
//   parseDateRange         — parse from_date/to_date query params
//
// Invariants — see AGENTS.md before changing:
//   * req.user.id is the canonical UUID; never user_id / userId.
//   * Every org-scoped query uses the sysadmin-bypass pattern
//       WHERE … AND ($N::boolean OR org_id = $M)
//     with params […, !!req.user.is_system_admin, req.user.org_id].
//   * requireEventManager fetches the event row and stashes it on
//     req.event so handlers can reuse it without a second query.

const jwt = require("jsonwebtoken");
const { t } = require("./server-i18n");
const { SESSION_COOKIE } = require("./session-cookie");

// Pull the JWT off a request. API clients + the e2e harness send it
// explicitly in `Authorization: Bearer <jwt>`; the SPA carries it in
// an httpOnly session cookie (browser JS can't read it, so it never
// sets the header). The header wins when both are present: an explicit
// per-request token is the caller's stated identity and must not be
// shadowed by an ambient cookie — this is what lets the multi-identity
// e2e harness act as several users through one cookie-persisting
// request context.
function extractToken(req) {
  const authHeader = req.headers["authorization"];
  const headerToken = authHeader && authHeader.split(" ")[1];
  if (headerToken) return headerToken;
  return (req.cookies && req.cookies[SESSION_COOKIE]) || null;
}

module.exports = function createMiddleware({ pool, JWT_SECRET }) {
  if (!pool || !JWT_SECRET) {
    throw new Error("createMiddleware requires { pool, JWT_SECRET }");
  }

  // -------------------------------------------------------------
  // Token-version cache (Migration 021)
  //
  // Every JWT carries `tv` — the value of users.token_version at
  // the moment the token was issued. We compare incoming tv
  // against the current DB row; a mismatch means the user was
  // demoted, locked out, or rotated their password since this
  // token was minted, and the request must be refused.
  //
  // To avoid a DB round-trip on every authed request we cache
  // (userId → currentVersion) for ~30s. The cache is invalidated
  // by any code that bumps token_version (it just calls
  // bumpTokenVersion below, which both writes and clears the
  // entry). Worst-case staleness is therefore ~30s, which is
  // acceptable for revocation latency and a 200× win on hot path.
  //
  // Tokens that pre-date Migration 021 (no `tv` field at all)
  // are accepted — they'll fade out over JWT_EXPIRY (8h) and
  // every subsequent login mints a versioned replacement.
  // -------------------------------------------------------------
  const TV_TTL_MS = 30 * 1000;
  // userId → { v, deleted, suspended, expires }. `deleted` is the
  // Migration 053 self-delete tombstone (deleted_at IS NOT NULL);
  // `suspended` is the Migration 058 admin-suspend flag
  // (suspended_at IS NOT NULL). verifyToken treats either as a hard
  // revoke, so an admin suspending an account terminates its live
  // sessions even if the token_version bump is ever missed and even
  // for pre-Migration-021 tokens that carry no `tv`.
  const tokenVersionCache = new Map();

  async function fetchUserAuthState(userId) {
    const hit = tokenVersionCache.get(userId);
    if (hit && hit.expires > Date.now()) return hit;
    const r = await pool.query(
      "SELECT token_version, deleted_at, suspended_at FROM users WHERE id = $1",
      [userId],
    );
    const row = r.rows[0];
    if (row == null) return null;
    const entry = {
      v: row.token_version,
      deleted: row.deleted_at != null,
      suspended: row.suspended_at != null,
      expires: Date.now() + TV_TTL_MS,
    };
    if (entry.v != null) {
      tokenVersionCache.set(userId, entry);
    }
    return entry;
  }

  // Back-compat shim — existing callers expect a bare integer.
  async function fetchCurrentTokenVersion(userId) {
    const state = await fetchUserAuthState(userId);
    return state == null ? null : state.v;
  }

  function invalidateTokenVersion(userId) {
    tokenVersionCache.delete(userId);
  }

  // Public helper for callers that want a yes/no check against
  // the cached current version (e.g. the socket handshake — same
  // semantics as verifyToken's tv check, but exposed so the socket
  // layer benefits from the same 30s cache instead of running a
  // raw `pool.query` on every connect).
  //
  // Migration 053: a deleted user fails the check unconditionally.
  // The self-delete endpoint bumps token_version too, so this is
  // belt-and-braces — but it covers the narrow window where a
  // pre-delete socket already passed the tv check and is now
  // re-using the connection.
  async function isTokenVersionCurrent(userId, tv) {
    const state = await fetchUserAuthState(userId);
    if (state == null) return true;     // user row missing — fail open here, verifyToken will reject elsewhere
    if (state.deleted) return false;
    if (state.suspended) return false;  // Migration 058 — suspend kicks live sockets too
    if (tv == null) return true;        // pre-Migration-021 token
    return state.v === tv;
  }

  // Increments users.token_version, invalidating every outstanding
  // JWT for that user. Call this from any place that revokes role,
  // changes password, or otherwise needs immediate logout.
  // Composes inside a transaction — pass the open client as `db`.
  async function bumpTokenVersion(db, userId) {
    if (!userId) return;
    await (db || pool).query(
      "UPDATE users SET token_version = token_version + 1 WHERE id = $1",
      [userId],
    );
    invalidateTokenVersion(userId);
  }

  // Decode JWT and attach req.user. Does not enforce roles.
  function verifyToken(req, res, next) {
    const token = extractToken(req);
    if (!token) return res.status(403).json({ error: t(req, "errors.unauthorized") });
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
      if (err) return res.status(401).json({ error: t(req, "errors.unauthorized") });
      // Reject if the JWT's tv is older than the current DB row.
      // Tokens minted before Migration 021 have no tv — accept
      // those for the rollout window (they expire within JWT_EXPIRY).
      //
      // Migration 053: a user whose deleted_at IS NOT NULL gets
      // the same 401 as a tv mismatch. The self-delete endpoint
      // already bumps token_version inside its transaction, so
      // every existing JWT is invalidated within the 30s cache
      // TTL — this branch is the explicit defence so a stale
      // cache entry can't slip a deleted user through.
      try {
        const state = await fetchUserAuthState(decoded.id);
        if (state != null && state.deleted) {
          return res.status(401).json({ error: "Session has been revoked, please sign in again" });
        }
        // Migration 058: a suspended account is logged out immediately,
        // not just blocked at next login. 401 so the SPA drops the
        // session; the code lets it surface the suspension message.
        if (state != null && state.suspended) {
          return res.status(401).json({
            error: "Your account has been suspended. Contact your federation administrator.",
            code: "account_suspended",
          });
        }
        if (decoded.tv != null && state != null && state.v !== decoded.tv) {
          return res.status(401).json({ error: "Session has been revoked, please sign in again" });
        }
      } catch (e) {
        console.error("[verifyToken auth-state check]", e.message);
        // Fail closed on DB error — better to force a re-login
        // than to admit an unverified token.
        return res.status(503).json({ error: "Auth temporarily unavailable" });
      }
      req.user = decoded;
      next();
    });
  }

  // Optional-auth variant: decodes the JWT into req.user when one
  // is present and valid, but lets unauthenticated requests through
  // (req.user stays undefined). Used by public-read endpoints like
  // the diver profile so anonymous spectators can land on a
  // /profile/<id> link from a meet scoreboard, while signed-in
  // visitors still get the same data plus any owner-only fields the
  // handler chooses to add. An invalid/expired token is treated as
  // "no token" rather than 401 — anonymous access is the floor.
  function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) return next();
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
      if (err) return next();        // bad token → treat as guest
      try {
        const state = await fetchUserAuthState(decoded.id);
        if (state != null && state.deleted) return next();    // Migration 053 → guest
        if (state != null && state.suspended) return next();  // Migration 058 → guest
        if (decoded.tv != null && state != null && state.v !== decoded.tv) {
          return next();             // revoked → guest
        }
      } catch (e) {
        console.error("[optionalAuth auth-state check]", e.message);
        return next();                // db wobble → guest, don't 503 a public read
      }
      req.user = decoded;
      next();
    });
  }

  // Ensures the user holds at least one of the given org-level roles.
  // system_admin always passes.
  const requireOrgRole = (roles = []) => (req, res, next) => {
    verifyToken(req, res, () => {
      if (req.user.is_system_admin) return next();
      const userRoles = req.user.org_roles || [];
      const ok = roles.length === 0 || roles.some((r) => userRoles.includes(r));
      if (!ok) return res.status(403).json({ error: t(req, "errors.forbidden") });
      next();
    });
  };

  function requireSystemAdmin(req, res, next) {
    verifyToken(req, res, () => {
      if (!req.user.is_system_admin)
        return res.status(403).json({ error: t(req, "errors.forbidden") });
      next();
    });
  }

  // Ensures the user can manage the event in the URL.
  //
  // system_admin always passes. Otherwise we fetch the event's
  // org_id and require either:
  //   * org_admin role in *that same org*, or
  //   * event_managers membership for the specific event.
  //
  // Stashes the event row on req.event so handlers can reuse it.
  const requireEventManager = () => async (req, res, next) => {
    verifyToken(req, res, async () => {
      try {
        const eventId = req.params.id || req.body.eventId;
        if (!eventId) return res.status(400).json({ error: t(req, "errors.validation_failed") });

        const ev = await pool.query(
          "SELECT id, org_id FROM events WHERE id = $1",
          [eventId],
        );
        if (!ev.rows.length) return res.status(404).json({ error: t(req, "errors.not_found") });
        req.event = ev.rows[0];

        if (req.user.is_system_admin) return next();

        const sameOrg = req.event.org_id === req.user.org_id;
        const orgRoles = req.user.org_roles || [];
        if (sameOrg && orgRoles.includes("org_admin")) return next();

        const result = await pool.query(
          "SELECT 1 FROM event_managers WHERE event_id = $1 AND user_id = $2",
          [eventId, req.user.id],
        );
        if (result.rows.length === 0)
          return res.status(403).json({ error: t(req, "errors.forbidden") });
        next();
      } catch (err) {
        console.error("[requireEventManager]", err.message);
        res.status(500).json({ error: t(req, "errors.server_error") });
      }
    });
  };

  // Express helper: confirms the event in :id (or the named param)
  // is in the calling user's org. system_admin bypasses. Returns
  // false on missing/wrong-org and writes the response. On success
  // stashes req.event for the handler.
  async function ensureEventOrgGate(req, res, paramName = "id") {
    const id = req.params[paramName];
    if (!id) { res.status(400).json({ error: t(req, "errors.validation_failed") }); return false; }
    const r = await pool.query("SELECT id, org_id FROM events WHERE id = $1", [id]);
    if (!r.rows.length) { res.status(404).json({ error: t(req, "errors.not_found") }); return false; }
    req.event = r.rows[0];
    if (req.user.is_system_admin) return true;
    if (r.rows[0].org_id !== req.user.org_id) {
      res.status(403).json({ error: t(req, "errors.forbidden") });
      return false;
    }
    return true;
  }

  // Confirms a target user/team belongs to the same org as the
  // event the request targets. Returns true/false. Accepts either
  // a pool or a transaction client (so it composes inside an open
  // transaction).
  async function isInSameOrg(db, eventOrgId, id, kind = "users") {
    if (!id || !eventOrgId) return false;
    const table = kind === "teams" ? "teams" : "users";
    const r = await db.query(`SELECT org_id FROM ${table} WHERE id = $1`, [id]);
    return r.rows[0]?.org_id === eventOrgId;
  }

  // Authorisation gate for privileged socket events. Returns true
  // when the connection has a verified user and (optionally) one
  // of the listed org_roles, or is a system admin. Emits
  // "unauthorized" and returns false otherwise.
  function socketRequireRole(socket, roles = null) {
    if (!socket.userId) {
      socket.emit("unauthorized", { reason: "not_authenticated" });
      return false;
    }
    if (!roles || socket.userIsSystemAdmin) return true;
    const userRoles = socket.userOrgRoles || [];
    if (!roles.some((r) => userRoles.includes(r))) {
      socket.emit("unauthorized", { reason: "insufficient_role" });
      return false;
    }
    return true;
  }

  // Per-event authorisation for privileged socket actions. The
  // role check (socketRequireRole) only confirms the user holds
  // the role *somewhere* — without this, a referee in Org A
  // could fail-dive an Org B final by emitting referee_failed_dive
  // with the other event's UUID. Mirrors requireEventManager on
  // the HTTP side.
  //
  // sysadmin → always ok. Otherwise the event's org_id must match
  // the socket's stashed org_id (set at handshake), and the user
  // must hold one of the listed roles in that org.
  async function socketCanManageEvent(socket, eventId, roles = ["meet_manager", "referee", "org_admin"]) {
    if (!socket.userId) {
      socket.emit("unauthorized", { reason: "not_authenticated" });
      return false;
    }
    if (!eventId) {
      socket.emit("unauthorized", { reason: "missing_event_id" });
      return false;
    }

    // Re-check token version on every privileged socket action.
    // io.use ran the check at handshake, but a stable websocket
    // can outlive the JWT_EXPIRY (8h) — and more importantly, an
    // org admin who just had their role revoked or 2FA bumped
    // should lose privileged action immediately, not "next
    // disconnect". The 30s TTL on the cache means this is
    // O(1) in practice.
    if (typeof socket.userTokenVersion === "number") {
      const stillValid = await isTokenVersionCurrent(
        socket.userId, socket.userTokenVersion,
      );
      if (!stillValid) {
        socket.emit("unauthorized", { reason: "token_revoked" });
        socket.disconnect(true);
        return false;
      }
    }

    if (socket.userIsSystemAdmin) return true;

    const ev = await pool.query(
      "SELECT org_id FROM events WHERE id = $1",
      [eventId],
    );
    if (!ev.rows.length) {
      socket.emit("unauthorized", { reason: "event_not_found" });
      return false;
    }
    if (ev.rows[0].org_id !== socket.userOrgId) {
      socket.emit("unauthorized", { reason: "wrong_org" });
      return false;
    }
    const have = socket.userOrgRoles || [];
    if (!roles.some((r) => have.includes(r))) {
      // Allow event_managers row as a fallback so a per-event
      // manager (without a blanket meet_manager role on the org)
      // can still drive their assigned event.
      const m = await pool.query(
        "SELECT 1 FROM event_managers WHERE event_id = $1 AND user_id = $2",
        [eventId, socket.userId],
      );
      if (!m.rows.length) {
        socket.emit("unauthorized", { reason: "insufficient_role" });
        return false;
      }
    }
    return true;
  }

  // Validate a score from the wire (HTTP or socket). 0–10 in
  // 0.5-point increments. Used by the socket submit_score handler
  // and the HTTP /api/scores/:id correction route.
  function isValidScore(s) {
    const n = Number(s);
    if (!Number.isFinite(n)) return false;
    if (n < 0 || n > 10) return false;
    return Math.round(n * 2) === n * 2;       // half-points only
  }

  // Confirms the event is still in the pre-meet 'Upcoming' phase.
  // Used to gate operations that should only be possible before
  // the first dive (start-order randomise, drag-reorder, etc.).
  // Once status flips to 'Live' or 'Completed' these endpoints
  // return 409 Conflict with a clear message; the frontend mirrors
  // the rule by hiding/disabling the controls but the server is
  // the source of truth.
  //
  // Pass `client` (a transaction client) when you're already inside
  // a BEGIN; otherwise pass `pool`. Returns true if pre-meet (and
  // stashes the row on req.event); writes 409 + returns false
  // otherwise.
  async function ensureEventPreMeet(req, res, eventId, db = pool) {
    const r = await db.query(
      "SELECT id, status, name FROM events WHERE id = $1",
      [eventId],
    );
    if (!r.rows.length) {
      res.status(404).json({ error: t(req, "errors.not_found") });
      return false;
    }
    req.event = r.rows[0];
    if (r.rows[0].status !== "Upcoming") {
      res.status(409).json({
        error:
          `Cannot change the dive order once "${r.rows[0].name}" has started ` +
          `(status is ${r.rows[0].status}). Withdraw a diver instead if they ` +
          `need to be skipped.`,
        event_status: r.rows[0].status,
      });
      return false;
    }
    return true;
  }

  // Gate dive-list submission flows. An event accepts entries when:
  //
  //     status = 'Upcoming'
  //   AND (entries_close_at IS NULL OR entries_close_at > now())
  //
  // Returns { error, status, event, lateReview }. `error` is null +
  // `event` is the row when the event is still accepting; otherwise
  // `error` is a human-readable message and `status` is the HTTP
  // code the caller should return.
  //
  // `lateReview` is true when the client claims (via actorLocalTime)
  // that they submitted BEFORE the deadline, but the server only saw
  // the request AFTER the deadline. Per DEC-04 in
  // docs/offline-inventory.md the gate ACCEPTS the write in this
  // case (error stays null, status stays 200) but the caller is
  // expected to set late_arrival_flag = true on the rows it creates
  // so the operator's review tray can surface them.
  //
  // Used by both submission paths:
  //   * /api/competitor/submit-list   — diver self-submit
  //   * /api/teams/:teamId/dive-lists — team manager bulk submit
  //   * /api/coach/dive-lists/:e/:d   — coach on behalf of diver
  //
  // Important: NOT applied to the controller-side late-entry add
  // (POST /api/events/:id/roster) — late entry is the manager-only
  // override that exists precisely for after-deadline roster
  // changes.
  //
  // opts.actorLocalTime: client-claimed submit time (ISO string or
  // Date). Optional; legacy clients without an outbox don't send it
  // and get the strict pre-outbox behaviour.
  const { evaluateDeadline } = require("./deadline-gate");
  async function loadEventForEntries(client, eventId, opts = {}) {
    const { actorLocalTime = null } = opts;
    const r = await client.query(
      `SELECT id, org_id, event_type, total_rounds, status,
              entries_close_at, dive_list_locks_at,
              name, height, round_rules,
              dd_limit_rounds, dd_limit_value
         FROM events WHERE id = $1`,
      [eventId],
    );
    if (!r.rows.length) {
      return { error: "Event not found", status: 404, event: null, lateReview: false };
    }
    const ev = r.rows[0];
    if (ev.status !== "Upcoming") {
      return {
        error: `"${ev.name}" has already started — entries are closed.`,
        status: 409,
        event: ev,
        lateReview: false,
      };
    }

    // Evaluate both deadlines (entries_close_at + dive_list_locks_at)
    // against the actor's claimed clock + server clock. Either one
    // tripping a "rejected" verdict closes the gate; a "late_review"
    // on either is propagated so the caller flags the row.
    const serverNow = new Date();
    const entriesVerdict = evaluateDeadline({
      deadline: ev.entries_close_at,
      actorLocalTime,
      serverNow,
    });
    const locksVerdict = evaluateDeadline({
      deadline: ev.dive_list_locks_at,
      actorLocalTime,
      serverNow,
    });

    if (entriesVerdict.verdict === "rejected") {
      const closed = new Date(ev.entries_close_at).toISOString();
      const reasonHint = entriesVerdict.reason === "future_dated"
        ? " (your device clock looks wrong — check the date/time)"
        : "";
      return {
        error: `Entries for "${ev.name}" closed at ${closed}.${reasonHint}`,
        status: 409,
        event: ev,
        lateReview: false,
      };
    }
    if (locksVerdict.verdict === "rejected") {
      const locked = new Date(ev.dive_list_locks_at).toISOString();
      return {
        error: `Dive list for "${ev.name}" locked at ${locked} (per the meet's stage-progression deadline). Contact the meet manager for late changes.`,
        status: 409,
        event: ev,
        lateReview: false,
      };
    }

    const lateReview = entriesVerdict.verdict === "late_review"
      || locksVerdict.verdict === "late_review";
    return { error: null, status: 200, event: ev, lateReview };
  }

  // -------------------------------------------------------------
  // 2FA enforcement for privileged roles (Migration 022 + #3 of
  // the May-2026 audit follow-up).
  //
  // When TOTP_REQUIRED_FOR_ADMINS=true is set in the env:
  //   * org_admin / meet_manager / is_system_admin without
  //     totp_enabled_at → 403 with code: "totp_required". The
  //     SPA catches that code and routes them to /account/2fa
  //     to set it up.
  //   * Diver / judge / coach / spectator → no gate (the role
  //     doesn't carry sensitive enough authority).
  //
  // When the flag is false (or unset) the helper no-ops so the
  // middleware can stay pre-wired into the requireOrgAdmin /
  // requireMeetEditor chains without forcing enforcement until
  // the operator is ready (soft rollout: encourage first via the
  // SPA's 2FA setup banner, then flip the env var when adoption
  // is ≥X%).
  //
  // The lookup queries one column per privileged request — fine
  // for a low-traffic admin surface, and the result could fold
  // into the existing token_version cache later if it ever
  // becomes a hot path.
  async function requireTotpForPrivilegedRoles(req, res, next) {
    if (process.env.TOTP_REQUIRED_FOR_ADMINS !== "true") {
      return next();
    }
    if (!req.user) return next();         // verifyToken hasn't fired yet
    const orgRoles = req.user.org_roles || [];
    const isPrivileged =
      req.user.is_system_admin ||
      orgRoles.includes("org_admin") ||
      orgRoles.includes("meet_manager");
    if (!isPrivileged) return next();
    try {
      const r = await pool.query(
        "SELECT totp_enabled_at FROM users WHERE id = $1",
        [req.user.id],
      );
      if (!r.rows[0]?.totp_enabled_at) {
        return res.status(403).json({
          error: "Your role requires 2FA. Set it up in account settings before continuing.",
          code: "totp_required",
        });
      }
      next();
    } catch (err) {
      console.error("[totp gate]", err.message);
      // Fail closed on DB error — better to refuse than to admit
      // an unverified privileged request through.
      res.status(503).json({ error: "Auth temporarily unavailable" });
    }
  }

  // Parse + normalise the optional ?from_date / ?to_date query
  // params used by /profile and /analytics. Returns { from, to }
  // where each is YYYY-MM-DD or null. Throws a 400-shaped Error
  // on invalid input.
  function parseDateRange(query) {
    const norm = (raw) => {
      if (!raw) return null;
      const s = String(raw).trim();
      if (!s) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const e = new Error("from_date / to_date must be YYYY-MM-DD");
        e.status = 400; throw e;
      }
      const t = Date.parse(s + "T00:00:00Z");
      if (Number.isNaN(t)) {
        const e = new Error("from_date / to_date is not a real date");
        e.status = 400; throw e;
      }
      return s;
    };
    return { from: norm(query.from_date), to: norm(query.to_date) };
  }

  return {
    verifyToken,
    optionalAuth,
    requireOrgRole,
    requireSystemAdmin,
    requireEventManager,
    ensureEventOrgGate,
    ensureEventPreMeet,
    isInSameOrg,
    socketRequireRole,
    socketCanManageEvent,
    isValidScore,
    parseDateRange,
    bumpTokenVersion,
    invalidateTokenVersion,
    isTokenVersionCurrent,
    loadEventForEntries,
    requireTotpForPrivilegedRoles,
  };
};
