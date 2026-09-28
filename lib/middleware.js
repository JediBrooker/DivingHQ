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
//   verifyToken            : decode JWT into req.user
//   requireOrgRole(roles)  : at least one of the listed roles
//   requireSystemAdmin     : sysadmin only
//   requireEventManager    : manager-or-admin OR event_managers row,
//                            scoped to the event's own org
//   ensureEventOrgGate     : confirm the URL event is in the caller's org
//   isInSameOrg            : confirm a user/team belongs to the event's org
//   socketRequireRole      : analogue of requireOrgRole for Socket.IO
//   socketMaintenanceBlocked : is this socket locked out by maintenance mode
//   isValidScore           : 0–10, half-point increments (lib/score-audit)
//   parseDateRange         : parse from_date/to_date query params
//
// Module exports next to the factory: CLUB_SEAT_SQL, and isSessionClaims
// (is this decoded JWT a session), which the socket handshake shares.
//
// Invariants (see AGENTS.md before changing):
//   * req.user.id is the canonical UUID; never user_id / userId.
//   * Every org-scoped query uses the sysadmin-bypass pattern
//       WHERE … AND ($N::boolean OR org_id = $M)
//     with params […, !!req.user.is_system_admin, req.user.org_id].
//   * requireEventManager fetches the event row and stashes it on
//     req.event so handlers can reuse it without a second query.

const jwt = require("jsonwebtoken");
const { t } = require("./server-i18n");
const { SESSION_COOKIE } = require("./session-cookie");
const { suspendedAccountMessage } = require("./support");
const { isUuid } = require("./uuid");

// Pull the JWT off a request. API clients + the e2e harness send it
// explicitly in `Authorization: Bearer <jwt>`; the SPA carries it in
// an httpOnly session cookie (browser JS can't read it, so it never
// sets the header). The header wins when both are present: an explicit
// per-request token is the caller's stated identity and shouldn't be
// shadowed by an ambient cookie, which is what lets the multi-identity
// e2e harness act as several users through one cookie-persisting
// request context.
function extractToken(req) {
  const authHeader = req.headers["authorization"];
  const headerToken = authHeader && authHeader.split(" ")[1];
  if (headerToken) return headerToken;
  return (req.cookies && req.cookies[SESSION_COOKIE]) || null;
}

// A club admin row only counts while its holder is still in the club's
// org (see isEventDelegate for why). $1 = club, $2 = user. Exported so
// the routes that check a seat outside these guards (the class-payment
// refund, say) use the same rule.
const CLUB_SEAT_SQL = `SELECT 1 FROM club_admins ca JOIN users u ON u.id = ca.user_id AND u.org_id = ca.org_id
                        WHERE ca.club_id = $1 AND ca.user_id = $2`;

// Only a session JWT is a session. The email-verify, password-reset and
// 2FA-step links are signed with the same secret but carry `sub` and a
// `type`, no `id`, and they used to authenticate as an id-less user
// (the auth-state lookup found no row, which passed). A session names
// its user by a UUID `id` and has no type. Module level and exported
// because the socket handshake (routes/socket.js) asks the same thing.
function isSessionClaims(decoded) {
  return decoded != null && typeof decoded === "object"
    && decoded.type == null
    && isUuid(decoded.id);
}

module.exports = function createMiddleware({ pool, JWT_SECRET, isMaintenance = () => false }) {
  if (!pool || !JWT_SECRET) {
    throw new Error("createMiddleware requires { pool, JWT_SECRET }");
  }
  // Read at call time, never cached: maintenance mode is a live flag that a
  // sysadmin flips mid-session (lib/features), and the socket gate below has
  // to honour it on the very next emit. Defaults to always-off so a router
  // constructed without it (unit tests) behaves exactly as before.
  const maintenanceOn = () => isMaintenance() === true;

  // -------------------------------------------------------------
  // Token-version cache (Migration 021)
  //
  // Every JWT carries `tv`, the value of users.token_version at
  // the moment the token was issued. We compare incoming tv
  // against the current DB row; a mismatch means the user got
  // demoted, locked out, or rotated their password since this
  // token was minted, and the request has to be refused.
  //
  // To avoid a DB round-trip on every authed request we cache
  // (userId → currentVersion) for ~30s. The cache gets invalidated
  // by any code that bumps token_version (it just calls
  // bumpTokenVersion below, which both writes and clears the
  // entry). Worst-case staleness is therefore ~30s, which is
  // acceptable for revocation latency and a 200× win on hot path.
  //
  // Tokens that pre-date Migration 021 (no `tv` field at all)
  // are still accepted, they'll fade out over JWT_EXPIRY (8h) and
  // every subsequent login mints a versioned replacement.
  // -------------------------------------------------------------
  const TV_TTL_MS = 30 * 1000;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    // The org join is for orgInactive: a federation that's still
    // pending approval, or got suspended, locks out everyone in it
    // except the sysadmin. Shares the 30s cache, so a suspension
    // takes up to TV_TTL_MS to bite on sessions already open.
    const r = await pool.query(
      `SELECT u.token_version, u.deleted_at, u.suspended_at, u.is_system_admin,
              o.status AS org_status, o.claim_state AS org_claim_state
         FROM users u
         LEFT JOIN organisations o ON o.id = u.org_id
        WHERE u.id = $1`,
      [userId],
    );
    const row = r.rows[0];
    if (row == null) return null;
    const entry = {
      v: row.token_version,
      deleted: row.deleted_at != null,
      suspended: row.suspended_at != null,
      orgInactive: !row.is_system_admin && row.org_status !== "active",
      orgClaimState: row.org_claim_state,
      expires: Date.now() + TV_TTL_MS,
    };
    if (entry.v != null) {
      tokenVersionCache.set(userId, entry);
    }
    return entry;
  }

  function invalidateTokenVersion(userId) {
    tokenVersionCache.delete(userId);
  }

  // The revocation rules, kept in one spot so verifyToken, optionalAuth
  // and isTokenVersionCurrent can't drift apart. Returns null when the
  // session is still good, otherwise the 401 body verifyToken sends.
  // The order matters because each case has its own message. A token
  // with no tv (pre Migration 021) skips only the version check.
  //
  // A missing user row (state == null) is revoked too. It used to pass,
  // on the theory that verifyToken caught it elsewhere, which it didn't:
  // the claim flow hard-deletes a self-deleted account's row, and that
  // account's already-revoked JWTs then came back to life with whatever
  // org_roles and is_system_admin they carried, until expiry.
  //
  // Migration 053: a deleted user gets the same answer as a tv mismatch.
  // Migration 058: a suspended account is logged out right away, not
  // just blocked at next login; the code lets the SPA show why.
  // orgInactive is the same idea one level up, the whole federation is
  // pending or suspended (login refuses these too, this catches sessions
  // that were open when the status flipped).
  function authStateVerdict(state, tv) {
    if (state == null) return { error: "Session has been revoked, please sign in again" };
    if (state.deleted) return { error: "Session has been revoked, please sign in again" };
    if (state.suspended) {
      return { error: suspendedAccountMessage(state.orgClaimState), code: "account_suspended" };
    }
    if (state.orgInactive) {
      return { error: "Your organisation isn't active on DivingHQ right now.", code: "org_not_active" };
    }
    if (tv != null && state.v !== tv) return { error: "Session has been revoked, please sign in again" };
    return null;
  }

  // Public helper for callers that want a yes/no check against
  // the cached current version (e.g. the socket handshake, same
  // semantics as verifyToken's tv check, but exposed so the socket
  // layer benefits from the same 30s cache instead of running a
  // raw `pool.query` on every connect).
  //
  // Migration 053: a deleted user fails the check unconditionally.
  // The self-delete endpoint bumps token_version too, so this is
  // belt-and-braces, but it covers the narrow window where a
  // pre-delete socket already passed the tv check and is now
  // re-using the connection.
  //
  // A missing user row fails like a deleted one, and suspension kicks
  // live sockets too.
  async function isTokenVersionCurrent(userId, tv) {
    if (typeof userId !== "string" || !UUID_RE.test(userId)) return false;
    return authStateVerdict(await fetchUserAuthState(userId), tv) === null;
  }

  // Increments users.token_version, invalidating every outstanding
  // JWT for that user. Call this from any place that revokes role,
  // changes password, or otherwise needs immediate logout.
  // Composes inside a transaction, pass the open client as `db`.
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
    // Pin the expected algorithm (HS256 is what we sign with) so a
    // forged token can't dictate a different verification scheme
    // (alg:none, or HS/RS confusion if an asymmetric key is ever
    // introduced). Defence-in-depth; jsonwebtoken rejects alg:none by
    // default anyway. Applied to every verify call in the app.
    jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, async (err, decoded) => {
      if (err || !isSessionClaims(decoded)) return res.status(401).json({ error: t(req, "errors.unauthorized") });
      // Reject if the JWT's tv is older than the current DB row, or the
      // account (or its org) has been shut off since it was minted. The
      // self-delete endpoint already bumps token_version, the deleted
      // check is there so a stale cache entry can't slip one through.
      try {
        const verdict = authStateVerdict(await fetchUserAuthState(decoded.id), decoded.tv);
        if (verdict) return res.status(401).json(verdict);
      } catch (e) {
        console.error("[verifyToken auth-state check]", e.message);
        // Heads up: fail closed on DB error, better to force a
        // re-login than to admit an unverified token.
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
  // "no token" rather than 401, anonymous access is the floor.
  function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) return next();
    jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, async (err, decoded) => {
      if (err || !isSessionClaims(decoded)) return next();   // bad token → treat as guest
      try {
        // Anything verifyToken would 401 just reads as a guest here.
        if (authStateVerdict(await fetchUserAuthState(decoded.id), decoded.tv)) return next();
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

  // A "delegate" runs one particular event without holding an org-wide
  // role for it. Three ways to be one:
  //   * an event_managers row for the event (always existed),
  //   * a club_admins row for the club hosting the event's meet
  //     (meets.host_club_id, migration 087). That's how a club in a
  //     country with no federation runs its own meets, and it only
  //     reaches its own club's meets, never a neighbour's,
  //   * a region_admins row for the region hosting the meet, or the
  //     region the host club is in (migration 088). A state runs its own
  //     championships and can step in on its clubs' meets, one level
  //     down, never sideways into another state.
  // The org_id matches are belt and braces, the rows are written with
  // the club's / region's org so they should always hold. The admin has
  // to still be in that org too: a transfer used to leave their old
  // club's row behind (routes/club-changes.js drops it now), and rows
  // stranded that way before the fix mustn't count.
  async function isEventDelegate(eventId, userId) {
    if (!eventId || !userId || !UUID_RE.test(String(eventId))) return false;
    const r = await pool.query(
      `SELECT 1
         FROM events e
         LEFT JOIN meets m ON m.id = e.meet_id
        WHERE e.id = $1
          AND (
            EXISTS (SELECT 1 FROM event_managers em
                     WHERE em.event_id = e.id AND em.user_id = $2)
            OR (EXISTS (SELECT 1 FROM users me WHERE me.id = $2 AND me.org_id = e.org_id)
                AND (EXISTS (SELECT 1 FROM club_admins ca
                              WHERE ca.club_id = m.host_club_id AND ca.user_id = $2
                                AND ca.org_id = e.org_id)
                  OR EXISTS (SELECT 1 FROM region_admins ra
                              WHERE ra.user_id = $2 AND ra.org_id = e.org_id
                                AND ra.region_id IN (
                                  m.host_region_id,
                                  (SELECT hc.region_id FROM clubs hc WHERE hc.id = m.host_club_id)))))
          )`,
      [eventId, userId],
    );
    return r.rows.length > 0;
  }

  // Same idea at meet level: does this user admin the club hosting the
  // meet, the region hosting it, or the region the host club is in?
  // Org-hosted meets (no host club or region) never match.
  async function isMeetHostAdmin(meetId, userId) {
    if (!meetId || !userId || !UUID_RE.test(String(meetId))) return false;
    const r = await pool.query(
      `SELECT 1 FROM meets m
        WHERE m.id = $1
          AND EXISTS (SELECT 1 FROM users me WHERE me.id = $2 AND me.org_id = m.org_id)
          AND (
            EXISTS (SELECT 1 FROM club_admins ca
                     WHERE ca.club_id = m.host_club_id AND ca.org_id = m.org_id AND ca.user_id = $2)
            OR EXISTS (SELECT 1 FROM region_admins ra
                        WHERE ra.user_id = $2 AND ra.org_id = m.org_id
                          AND ra.region_id IN (
                            m.host_region_id,
                            (SELECT hc.region_id FROM clubs hc WHERE hc.id = m.host_club_id)))
          )`,
      [meetId, userId],
    );
    return r.rows.length > 0;
  }

  // Region ids this user admins.
  async function regionAdminRegionIds(userId) {
    if (!userId) return [];
    const r = await pool.query("SELECT region_id FROM region_admins WHERE user_id = $1", [userId]);
    return r.rows.map((row) => row.region_id);
  }

  // Club ids this user admins. Cheap, indexed on user_id.
  async function clubAdminClubIds(userId) {
    if (!userId) return [];
    const r = await pool.query("SELECT club_id FROM club_admins WHERE user_id = $1", [userId]);
    return r.rows.map((row) => row.club_id);
  }

  // First pass for meet-editing routes: the org-wide editors
  // (org_admin, meet_manager), or anyone who admins a club or a region.
  // It only answers "may this person manage meets at all". The route then
  // has to check the specific meet, because club and region admins only
  // get the meets they host (isMeetHostAdmin). The ids ride along on
  // req.clubAdminOf / req.regionAdminOf so creating a meet doesn't have
  // to look them up again.
  function requireMeetEditorOrClubAdmin(req, res, next) {
    verifyToken(req, res, async () => {
      const roles = req.user.org_roles || [];
      if (req.user.is_system_admin || roles.includes("org_admin") || roles.includes("meet_manager")) {
        return next();
      }
      try {
        [req.clubAdminOf, req.regionAdminOf] = await Promise.all([
          clubAdminClubIds(req.user.id),
          regionAdminRegionIds(req.user.id),
        ]);
      } catch (err) {
        console.error("[requireMeetEditorOrClubAdmin]", err.message);
        return res.status(500).json({ error: t(req, "errors.server_error") });
      }
      if (!req.clubAdminOf.length && !req.regionAdminOf.length) {
        return res.status(403).json({ error: t(req, "errors.forbidden") });
      }
      next();
    });
  }

  // requireOrgRole(roles), plus a way in for the event's delegates who
  // don't hold any of those roles. eventIdOf(req) says which event the
  // request is about, sync or async; null means "can't tell", and then
  // it's the role or nothing. The handler's own org checks still run
  // after this, a delegate is always in the event's org anyway.
  const requireRoleOrEventDelegate = (roles, eventIdOf) => (req, res, next) => {
    verifyToken(req, res, async () => {
      if (req.user.is_system_admin) return next();
      const have = req.user.org_roles || [];
      if (roles.some((r) => have.includes(r))) return next();
      try {
        const eventId = await eventIdOf(req);
        if (await isEventDelegate(eventId, req.user.id)) return next();
      } catch (err) {
        console.error("[requireRoleOrEventDelegate]", err.message);
        return res.status(500).json({ error: t(req, "errors.server_error") });
      }
      return res.status(403).json({ error: t(req, "errors.forbidden") });
    });
  };

  // Ensures the user can manage event in the URL.
  //
  // system_admin always passes. Otherwise we fetch the event's
  // org_id and require either:
  //   * org_admin role in *that same org*, or
  //   * being a delegate for the event (isEventDelegate: an
  //     event_managers row, or admin of the club hosting its meet).
  //
  // Stashes the event row on req.event so handlers can reuse it.
  const requireEventManager = () => async (req, res, next) => {
    verifyToken(req, res, async () => {
      try {
        const eventId = req.params.id || req.body.eventId;
        if (!eventId) return res.status(400).json({ error: t(req, "errors.validation_failed") });
        // Not a UUID, not an event (and pg would throw on it).
        if (!isUuid(eventId)) return res.status(404).json({ error: t(req, "errors.not_found") });

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

        if (!(await isEventDelegate(eventId, req.user.id)))
          return res.status(403).json({ error: t(req, "errors.forbidden") });
        next();
      } catch (err) {
        console.error("[requireEventManager]", err.message);
        res.status(500).json({ error: t(req, "errors.server_error") });
      }
    });
  };

  // Ensures the user can manage the CLUB in the URL (:id / :clubId, or
  // body.clubId). Mirrors requireEventManager for the club-payer routes
  // (affiliation/accreditation billing introduced with the fee taxonomy).
  //
  // system_admin always passes. Otherwise we fetch the club's org_id and
  // require either:
  //   * org_admin in *that same org* (federations administer their clubs), or
  //   * a club_admins row for this specific club.
  //
  // Stashes the club row {id, org_id} on req.club so handlers can reuse it.
  //
  // A club still waiting on its federation (clubs.status 'pending',
  // migration 096) has nothing to manage yet: no fees, no classes, no
  // payouts. Whoever gets past the role check is told so with a 409
  // club_pending rather than let in.
  const clubReady = (req, res, next) => {
    if (req.club.status === "pending") {
      return res.status(409).json({
        error: "This club is still waiting for its federation to approve it",
        code: "club_pending",
      });
    }
    return next();
  };

  // The two club guards below are the same check apart from whether a
  // same-org federation org_admin gets in on the role alone.
  const clubGuard = ({ allowOrgAdmin, label }) => () => async (req, res, next) => {
    verifyToken(req, res, async () => {
      try {
        const clubId = req.params.id || req.params.clubId || req.body.clubId;
        if (!clubId) return res.status(400).json({ error: t(req, "errors.validation_failed") });
        if (!isUuid(clubId)) return res.status(404).json({ error: t(req, "errors.not_found") });

        const c = await pool.query(
          "SELECT id, org_id, status FROM clubs WHERE id = $1",
          [clubId],
        );
        if (!c.rows.length) return res.status(404).json({ error: t(req, "errors.not_found") });
        req.club = c.rows[0];

        if (req.user.is_system_admin) return clubReady(req, res, next);

        if (allowOrgAdmin && req.club.org_id === req.user.org_id
            && (req.user.org_roles || []).includes("org_admin")) {
          return clubReady(req, res, next);
        }

        const r = await pool.query(CLUB_SEAT_SQL, [clubId, req.user.id]);
        if (r.rows.length === 0)
          return res.status(403).json({ error: t(req, "errors.forbidden") });
        clubReady(req, res, next);
      } catch (err) {
        console.error(`[${label}]`, err.message);
        res.status(500).json({ error: t(req, "errors.server_error") });
      }
    });
  };

  const requireClubAdmin = clubGuard({ allowOrgAdmin: true, label: "requireClubAdmin" });

  // Like requireClubAdmin, but CLUB-PRIVATE: a federation org_admin does NOT
  // get in by virtue of the org role. Only sysadmin (platform) or an actual
  // club_admins row for this club passes. Used by the training-classes routes
  // so the federation cannot see or manage a club's private classes/rosters.
  const requireClubAdminOnly = clubGuard({ allowOrgAdmin: false, label: "requireClubAdminOnly" });

  // Express helper: confirms the event in :id (or the named param)
  // is in the calling user's org. system_admin bypasses. Returns
  // false on missing/wrong-org and writes the response. On success
  // stashes req.event for the handler.
  async function ensureEventOrgGate(req, res, paramName = "id") {
    const id = req.params[paramName];
    if (!id) { res.status(400).json({ error: t(req, "errors.validation_failed") }); return false; }
    if (!isUuid(id)) { res.status(404).json({ error: t(req, "errors.not_found") }); return false; }
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

  // Maintenance lockdown for socket writes: true when this socket must be
  // refused because the flag is on and it isn't a sysadmin's. Sysadmins
  // keep working on purpose, they're the ones doing the maintenance.
  // Every mutating socket event has to ask this, through
  // socketRequireRole, socketCanManageEvent, or directly (submit_score and
  // judge_signal do their own role checks and call it themselves).
  function socketMaintenanceBlocked(socket) {
    return maintenanceOn() && !socket.userIsSystemAdmin;
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
    if (socketMaintenanceBlocked(socket)) {
      socket.emit("unauthorized", { reason: "maintenance" });
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
  // the role *somewhere*, without this check a referee in Org A
  // could fail-dive an Org B final by emitting referee_failed_dive
  // with the other event's UUID. Mirrors requireEventManager on
  // the HTTP side.
  //
  // sysadmin → always ok. Otherwise the event's org_id must match
  // the socket's stashed org_id (set at handshake), and the user
  // must hold one of the listed roles in that org.
  //
  // This never rejects. The socket handlers await it without a catch,
  // and socket.io doesn't catch for them either, so a throw in here (a
  // junk event_id hitting the uuid cast, a DB blip mid-meet) used to be
  // an unhandled rejection that killed the process and every live meet
  // with it. A bad id is refused up front and anything else that goes
  // wrong answers "unauthorized" like any other refusal.
  async function socketCanManageEvent(socket, eventId, roles = ["meet_manager", "referee", "org_admin"]) {
    if (!socket.userId) {
      socket.emit("unauthorized", { reason: "not_authenticated" });
      return false;
    }
    if (socketMaintenanceBlocked(socket)) {
      socket.emit("unauthorized", { reason: "maintenance" });
      return false;
    }
    if (!eventId) {
      socket.emit("unauthorized", { reason: "missing_event_id" });
      return false;
    }
    // The id comes off the wire as whatever the client sent. Anything that
    // isn't a UUID string can't be an event: letting it reach
    // `WHERE id = $1` makes pg throw, and an array holding one UUID would
    // pass a String() test and then ride into the handler's own queries.
    if (typeof eventId !== "string" || !UUID_RE.test(eventId)) {
      socket.emit("unauthorized", { reason: "bad_event_id" });
      return false;
    }

    try {
      // Re-check token version on every privileged socket action.
      // io.use ran the check at handshake, but a stable websocket
      // can outlive the JWT_EXPIRY (8h), and more importantly an
      // org admin who just had their role revoked or 2FA bumped
      // should lose privileged action immediately, not "next
      // disconnect". The 30s TTL on the cache means this stays
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
        // Delegates (event_managers row, or admin of the club hosting
        // the meet) can drive their own event without a blanket
        // meet_manager role on the org.
        if (!(await isEventDelegate(eventId, socket.userId))) {
          socket.emit("unauthorized", { reason: "insufficient_role" });
          return false;
        }
      }
      return true;
    } catch (err) {
      console.error("[socketCanManageEvent]", err.message);
      socket.emit("unauthorized", { reason: "server_error" });
      return false;
    }
  }

  // Validate a score from the wire (HTTP or socket). One rule for every
  // path, so it lives in lib/score-audit.js and this is the same
  // function: AGENTS.md is firm that the socket and HTTP paths agree, or
  // one of them becomes the back door.
  const { isValidScore } = require("./score-audit");

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
  //   * /api/competitor/submit-list   : diver self-submit
  //   * /api/teams/:teamId/dive-lists : team manager bulk submit
  //   * /api/coach/dive-lists/:e/:d   : coach on behalf of diver
  //
  // Important: NOT applied to the controller-side late-entry add
  // (POST /api/events/:id/roster). Late entry is the manager-only
  // override that exists precisely for after-deadline roster
  // changes.
  //
  // opts.actorLocalTime: client-claimed submit time (ISO string or
  // Date). Optional, legacy clients without an outbox don't send
  // it and get the strict pre-outbox behaviour.
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
  // The lookup queries one column per privileged request, fine
  // for a low-traffic admin surface. Worth double-checking later
  // if this ever turns into a hot path, could fold into the
  // existing token_version cache then.
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
      // Fail closed on DB error, better to refuse than to admit
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
      // Date.parse doesn't reject 2026-02-31, it rolls it over to 3
      // March, and Postgres then refuses the literal: a 500 on /profile
      // and quietly empty widgets on /analytics. A real date survives the
      // round trip unchanged.
      const t = Date.parse(s + "T00:00:00Z");
      if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) {
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
    requireRoleOrEventDelegate,
    requireMeetEditorOrClubAdmin,
    isEventDelegate,
    isMeetHostAdmin,
    requireClubAdmin,
    requireClubAdminOnly,
    ensureEventOrgGate,
    ensureEventPreMeet,
    isInSameOrg,
    socketRequireRole,
    socketCanManageEvent,
    socketMaintenanceBlocked,
    isValidScore,
    parseDateRange,
    bumpTokenVersion,
    invalidateTokenVersion,
    isTokenVersionCurrent,
    loadEventForEntries,
    requireTotpForPrivilegedRoles,
  };
};

module.exports.CLUB_SEAT_SQL = CLUB_SEAT_SQL;
module.exports.isSessionClaims = isSessionClaims;
