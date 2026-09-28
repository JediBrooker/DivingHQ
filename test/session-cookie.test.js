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
