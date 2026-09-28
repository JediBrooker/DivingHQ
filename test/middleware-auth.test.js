// Auth-perimeter unit tests for lib/middleware.js.
//
// No database required: createMiddleware takes the pool by
// injection, so we hand it a fake whose `query` returns a
// configurable users-row auth state. Each test builds a fresh
// middleware instance so the 30s token-version cache can't leak
// state between cases.
//
// Heads up: this is the primary regression guard (see the May-2026
// audit follow-up):
//   * Suspending an account must terminate its LIVE sessions, not
//     just block the next login. The bug was twofold:
//       1. POST /api/users/:id/suspend called bumpTokenVersion with
//          a single arg, so the helper's `if (!userId) return;`
//          guard made it a silent no-op and token_version never
//          moved; the suspended user kept a valid JWT for up to
//          JWT_EXPIRY.
//       2. verifyToken only consulted deleted_at + token_version,
//          so even a correct bump left no backstop for the 30s
//          cache window or for pre-Migration-021 tokens (no `tv`).
//     The fix bumps token_version on suspend AND treats
//     suspended_at as a hard revoke in verifyToken / optionalAuth /
//     isTokenVersionCurrent. The suspended-but-tv-matching case
//     below proves the backstop fires independently of the bump.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const createMiddleware = require("../lib/middleware");

const JWT_SECRET = "test-secret-for-middleware-unit-tests-0123456789";
const USER_ID = "11111111-1111-1111-1111-111111111111";

// Build a middleware instance whose DB returns one fixed users-row
// auth state for the SELECT in fetchUserAuthState.
function build({
  token_version = 1, deleted_at = null, suspended_at = null,
  org_status = "active", is_system_admin = false,
} = {}) {
  const fakePool = {
    async query(sql) {
      if (/FROM users u\s+LEFT JOIN organisations o/.test(sql)) {
        return { rows: [{ token_version, deleted_at, suspended_at, org_status, is_system_admin }] };
      }
      return { rows: [] };
    },
  };
  return createMiddleware({ pool: fakePool, JWT_SECRET });
}

// Like build(), but with a controllable maintenance flag for the socket gate.
function buildWithMaintenance(isMaintenance) {
  const fakePool = { async query() { return { rows: [] }; } };
  return createMiddleware({ pool: fakePool, JWT_SECRET, isMaintenance });
}

// Minimal socket stub: records emits so a test can see the unauthorized reason.
function fakeSocket({ userId = USER_ID, sysadmin = false } = {}) {
  const emits = [];
  return {
    userId,
    userIsSystemAdmin: sysadmin,
    userOrgRoles: ["judge"],
    emits,
    emit(event, payload) { this.emits.push({ event, payload }); },
  };
}

test("socketRequireRole: maintenance mode blocks a non-admin write", () => {
  const { socketRequireRole } = buildWithMaintenance(() => true);
  const socket = fakeSocket({ sysadmin: false });
  const ok = socketRequireRole(socket, ["judge"]);
  assert.equal(ok, false);
  assert.equal(socket.emits.at(-1).payload.reason, "maintenance");
});

test("socketRequireRole: maintenance mode still lets a sysadmin write", () => {
  const { socketRequireRole } = buildWithMaintenance(() => true);
  const socket = fakeSocket({ sysadmin: true });
  assert.equal(socketRequireRole(socket, ["judge"]), true);
});

test("socketRequireRole: with maintenance off, the normal role check applies", () => {
  const { socketRequireRole } = buildWithMaintenance(() => false);
  assert.equal(socketRequireRole(fakeSocket({ sysadmin: false }), ["judge"]), true);
  const wrongRole = fakeSocket({ sysadmin: false });
  assert.equal(socketRequireRole(wrongRole, ["referee"]), false);
  assert.equal(wrongRole.emits.at(-1).payload.reason, "insufficient_role");
});

test("socketRequireRole: default construction has maintenance off", () => {
  const { socketRequireRole } = build();
  assert.equal(socketRequireRole(fakeSocket({ sysadmin: false }), ["judge"]), true);
});

// Drive verifyToken to completion. Resolves { type:'next', req } when
// the request is allowed through, or { type:'res', statusCode, body }
// when it's rejected.
function runVerify(verifyToken, token) {
  return new Promise((resolve) => {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ type: "res", statusCode: this.statusCode, body }); return this; },
      end() { resolve({ type: "res", statusCode: this.statusCode }); return this; },
    };
    verifyToken(req, res, () => resolve({ type: "next", req }));
  });
}

const sign = (payload) => jwt.sign(payload, JWT_SECRET);

test("verifyToken: suspended account is revoked even when token_version matches", async () => {
  // tv in the token matches the DB row, so the ONLY thing that can
  // reject this request is the suspended_at backstop. This is the
  // core guard: it proves suspension revokes live sessions without
  // relying on the bump (covers pre-021 tokens + the cache window).
  const { verifyToken } = build({ token_version: 1, suspended_at: "2026-01-01T00:00:00Z" });
  const out = await runVerify(verifyToken, sign({ id: USER_ID, tv: 1 }));
  assert.equal(out.type, "res");
  assert.equal(out.statusCode, 401);
  assert.equal(out.body.code, "account_suspended");
});

test("verifyToken: active account with matching token_version passes", async () => {
  const { verifyToken } = build({ token_version: 1, suspended_at: null });
  const out = await runVerify(verifyToken, sign({ id: USER_ID, tv: 1 }));
  assert.equal(out.type, "next");
  assert.equal(out.req.user.id, USER_ID);
});

test("verifyToken: deleted account is revoked (regression baseline)", async () => {
  const { verifyToken } = build({ token_version: 1, deleted_at: "2026-01-01T00:00:00Z" });
  const out = await runVerify(verifyToken, sign({ id: USER_ID, tv: 1 }));
  assert.equal(out.type, "res");
  assert.equal(out.statusCode, 401);
});

test("verifyToken: stale token_version is revoked (regression baseline)", async () => {
  const { verifyToken } = build({ token_version: 2 });
  const out = await runVerify(verifyToken, sign({ id: USER_ID, tv: 1 }));
  assert.equal(out.type, "res");
  assert.equal(out.statusCode, 401);
});

test("optionalAuth: suspended account is downgraded to guest, not 401", async () => {
  const { optionalAuth } = build({ token_version: 1, suspended_at: "2026-01-01T00:00:00Z" });
  const out = await runVerify(optionalAuth, sign({ id: USER_ID, tv: 1 }));
  assert.equal(out.type, "next");
  assert.equal(out.req.user, undefined); // guest, no owner-only fields
});

test("isTokenVersionCurrent: returns false for a suspended user (kicks live sockets)", async () => {
  const { isTokenVersionCurrent } = build({ token_version: 1, suspended_at: "2026-01-01T00:00:00Z" });
  assert.equal(await isTokenVersionCurrent(USER_ID, 1), false);
});

test("isTokenVersionCurrent: returns true for an active user with matching tv", async () => {
  const { isTokenVersionCurrent } = build({ token_version: 1, suspended_at: null });
  assert.equal(await isTokenVersionCurrent(USER_ID, 1), true);
});

// A federation that's pending approval or suspended locks out its
// members' open sessions too, not just new logins. Sysadmins live in the
// Administration org and are never caught by this.
test("verifyToken: a user in a pending org is revoked", async () => {
  const { verifyToken } = build({ org_status: "pending" });
  const out = await runVerify(verifyToken, sign({ id: USER_ID, tv: 1 }));
  assert.equal(out.type, "res");
  assert.equal(out.statusCode, 401);
  assert.equal(out.body.code, "org_not_active");
});

test("verifyToken: a sysadmin passes whatever their org's status", async () => {
  const { verifyToken } = build({ org_status: "suspended", is_system_admin: true });
  const out = await runVerify(verifyToken, sign({ id: USER_ID, tv: 1 }));
  assert.equal(out.type, "next");
});

test("optionalAuth: a user in a suspended org reads as a guest", async () => {
  const { optionalAuth } = build({ org_status: "suspended" });
  const out = await runVerify(optionalAuth, sign({ id: USER_ID, tv: 1 }));
  assert.equal(out.type, "next");
  assert.equal(out.req.user, undefined);
});

test("isTokenVersionCurrent: false when the user's org isn't active", async () => {
  const { isTokenVersionCurrent } = build({ org_status: "pending" });
  assert.equal(await isTokenVersionCurrent(USER_ID, 1), false);
});

// The revocation rules live in one helper now; these pin the exact
// bodies so the three callers keep answering the way they did.
test("verifyToken: deleted and stale-tv sessions share the revoked message", async () => {
  const deleted = build({ token_version: 1, deleted_at: "2026-01-01T00:00:00Z" });
  const stale = build({ token_version: 2 });
  for (const { verifyToken } of [deleted, stale]) {
    const out = await runVerify(verifyToken, sign({ id: USER_ID, tv: 1 }));
    assert.deepEqual(out.body, { error: "Session has been revoked, please sign in again" });
  }
});

test("verifyToken: a pre-021 token (no tv) passes when the account is fine", async () => {
  const { verifyToken } = build({ token_version: 7 });
  const out = await runVerify(verifyToken, sign({ id: USER_ID }));
  assert.equal(out.type, "next");
});

test("verifyToken: a pre-021 token is still refused for a suspended account", async () => {
  const { verifyToken } = build({ token_version: 7, suspended_at: "2026-01-01T00:00:00Z" });
  const out = await runVerify(verifyToken, sign({ id: USER_ID }));
  assert.equal(out.statusCode, 401);
  assert.equal(out.body.code, "account_suspended");
});

test("optionalAuth: deleted or stale-tv sessions read as guests", async () => {
  for (const state of [{ deleted_at: "2026-01-01T00:00:00Z" }, { token_version: 2 }]) {
    const { optionalAuth } = build(state);
    const out = await runVerify(optionalAuth, sign({ id: USER_ID, tv: 1 }));
    assert.equal(out.type, "next");
    assert.equal(out.req.user, undefined);
  }
});

test("isTokenVersionCurrent: missing row and missing tv both pass, a stale tv doesn't", async () => {
  const noRow = createMiddleware({ pool: { async query() { return { rows: [] }; } }, JWT_SECRET });
  assert.equal(await noRow.isTokenVersionCurrent(USER_ID, 1), true);
  const { isTokenVersionCurrent } = build({ token_version: 3 });
  assert.equal(await isTokenVersionCurrent(USER_ID, null), true);
  assert.equal(await isTokenVersionCurrent(USER_ID, 2), false);
});

// requireClubAdmin and requireClubAdminOnly share one guard. The only
// difference is the federation org_admin shortcut, so pin that.
const CLUB_ID = "22222222-2222-2222-2222-222222222222";
function buildClub({ clubOrg = "org-1", status = "active", seat = false } = {}) {
  const pool = {
    async query(sql) {
      if (/FROM users u\s+LEFT JOIN organisations o/.test(sql)) {
        return { rows: [{ token_version: 1, org_status: "active", is_system_admin: false }] };
      }
      if (/FROM clubs WHERE id/.test(sql)) return { rows: [{ id: CLUB_ID, org_id: clubOrg, status }] };
      if (/FROM club_admins ca/.test(sql)) return { rows: seat ? [{ "?column?": 1 }] : [] };
      return { rows: [] };
    },
  };
  return createMiddleware({ pool, JWT_SECRET });
}

function runClub(guard, user) {
  return new Promise((resolve) => {
    const req = {
      headers: { authorization: `Bearer ${sign({ id: USER_ID, tv: 1, ...user })}` },
      params: { id: CLUB_ID },
      body: {},
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ type: "res", statusCode: this.statusCode, body }); return this; },
    };
    guard()(req, res, () => resolve({ type: "next", req }));
  });
}

test("club guards: a same-org org_admin passes requireClubAdmin but not requireClubAdminOnly", async () => {
  const orgAdmin = { org_id: "org-1", org_roles: ["org_admin"] };
  const mw = buildClub();
  const open = await runClub(mw.requireClubAdmin, orgAdmin);
  assert.equal(open.type, "next");
  assert.equal(open.req.club.id, CLUB_ID);
  const priv = await runClub(mw.requireClubAdminOnly, orgAdmin);
  assert.equal(priv.statusCode, 403);
});

test("club guards: an org_admin from another org doesn't get the shortcut", async () => {
  const out = await runClub(buildClub({ clubOrg: "org-2" }).requireClubAdmin,
    { org_id: "org-1", org_roles: ["org_admin"] });
  assert.equal(out.statusCode, 403);
});

test("club guards: a club_admins seat passes both, and a pending club answers 409", async () => {
  for (const name of ["requireClubAdmin", "requireClubAdminOnly"]) {
    const ok = await runClub(buildClub({ seat: true })[name], { org_id: "org-1", org_roles: [] });
    assert.equal(ok.type, "next", name);
    const pending = await runClub(buildClub({ seat: true, status: "pending" })[name], { org_id: "org-1" });
    assert.equal(pending.statusCode, 409, name);
    assert.equal(pending.body.code, "club_pending", name);
  }
});

test("club guards: no club id is a 400", async () => {
  const mw = buildClub();
  const out = await new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${sign({ id: USER_ID, tv: 1 })}` }, params: {}, body: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    mw.requireClubAdminOnly()(req, res, () => resolve({ statusCode: 0 }));
  });
  assert.equal(out.statusCode, 400);
});
