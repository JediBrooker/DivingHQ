// lib/auth-links.js: the verify-email and password-reset JWTs that
// routes/auth.js and the admin buttons in routes/users.js both send. The
// verify-email and reset-password routes check `type`, `sub` and `fp`,
// so a change to any of them (or to the lifetimes) should show up here.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const createAuthLinks = require("../lib/auth-links");

const SECRET = "auth-links-test-secret-aaaaaaaaaaaaaaaaaaaa";
const { mintVerifyToken, mintResetToken } = createAuthLinks(SECRET);

test("a verify link is an email_verify token for the user, good for 24 hours", () => {
  const decoded = jwt.verify(mintVerifyToken("user-1"), SECRET, { algorithms: ["HS256"] });
  assert.equal(decoded.sub, "user-1");
  assert.equal(decoded.type, "email_verify");
  assert.equal(decoded.fp, undefined);
  assert.equal(decoded.exp - decoded.iat, 24 * 60 * 60);
});

test("a reset link carries the password fingerprint and lasts 30 minutes", () => {
  const decoded = jwt.verify(mintResetToken("user-2", "abc123"), SECRET, { algorithms: ["HS256"] });
  assert.equal(decoded.sub, "user-2");
  assert.equal(decoded.type, "password_reset");
  assert.equal(decoded.fp, "abc123");
  assert.equal(decoded.exp - decoded.iat, 30 * 60);
});

test("links are signed with the secret they were built with", () => {
  assert.throws(() => jwt.verify(mintVerifyToken("user-3"), "some-other-secret", { algorithms: ["HS256"] }));
});
