// Response-token content negotiation (security audit F4).
//
// The login / 2FA / password-change / locale responses omit the bearer
// token from the JSON body for BROWSER requests (so XSS during login
// can't read it), while non-browser API clients still receive it. The
// signal is the presence of a Sec-Fetch-* header, which browsers always
// attach to fetch/XHR and JS cannot forge or strip. This pins that
// decision function.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { includeBodyToken } = require("../routes/auth");

// Minimal Express-like req: get() is case-insensitive header lookup.
function reqWith(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[name.toLowerCase()] };
}

test("non-browser clients (no Sec-Fetch) receive the body token", () => {
  assert.equal(includeBodyToken(reqWith({})), true);
  assert.equal(includeBodyToken(reqWith({ "User-Agent": "node" })), true);
});

test("browser requests (any Sec-Fetch-Site) do not receive the body token", () => {
  for (const site of ["same-origin", "same-site", "cross-site", "none"]) {
    assert.equal(
      includeBodyToken(reqWith({ "Sec-Fetch-Site": site })),
      false,
      `Sec-Fetch-Site: ${site} should omit the token`,
    );
  }
});
