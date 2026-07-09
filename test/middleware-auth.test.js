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
function build({ token_version = 1, deleted_at = null, suspended_at = null } = {}) {
  const fakePool = {
    async query(sql) {
      if (/FROM users WHERE id = \$1/.test(sql)) {
        return { rows: [{ token_version, deleted_at, suspended_at }] };
      }
      return { rows: [] };
    },
  };
  return createMiddleware({ pool: fakePool, JWT_SECRET });
}

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
