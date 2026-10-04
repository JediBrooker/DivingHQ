// lib/session-cookie.js readSessionCookie: the socket handshake's way of
// finding the session JWT in a raw Cookie header. The header comes
// straight off the wire, so anything the client sends has to come back
// as a string or null, never an exception (one malformed cookie used to
// crash the server from inside the async handshake).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readSessionCookie, SESSION_COOKIE } = require("../lib/session-cookie");

test("readSessionCookie finds the session cookie among others", () => {
  assert.equal(readSessionCookie(`a=1; ${SESSION_COOKIE}=abc.def; b=2`), "abc.def");
  assert.equal(readSessionCookie(`${SESSION_COOKIE}=a%20b`), "a b");
});

test("readSessionCookie answers null when there's nothing usable", () => {
  assert.equal(readSessionCookie(undefined), null);
  assert.equal(readSessionCookie(""), null);
  assert.equal(readSessionCookie(["not", "a", "string"]), null);
  assert.equal(readSessionCookie("other=1"), null);
});

test("readSessionCookie treats bad percent-encoding as no cookie instead of throwing", () => {
  for (const bad of ["%E0%A4%A", "%", "%zz", "abc%"]) {
    assert.doesNotThrow(() => readSessionCookie(`${SESSION_COOKIE}=${bad}`));
    assert.equal(readSessionCookie(`${SESSION_COOKIE}=${bad}`), null, bad);
  }
});


test("native cookies persist only until signed expiry while browser cookies remain session-only", () => {
  const { cookieOptions, nativeCookieOptions } = require("../lib/session-cookie");
  const now = 1800000000000;
  const expiry = now / 1000 + 3600;
  const native = nativeCookieOptions(expiry, now);
  assert.equal(native.maxAge, 3600000);
  assert.equal(native.httpOnly, true);
  assert.equal(native.sameSite, "lax");
  assert.equal(native.secure, cookieOptions().secure);
  assert.equal(cookieOptions().maxAge, undefined);
  assert.equal(cookieOptions().expires, undefined);
  assert.throws(() => nativeCookieOptions(now / 1000, now));
  assert.throws(() => nativeCookieOptions(NaN, now));
});
