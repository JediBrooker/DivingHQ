// lib/trust-proxy.js: one reading of TRUST_PROXY for Express (req.ip,
// the rate limiters, audit IPs) and the socket layer's clientIp. They
// used to parse it separately, and TRUST_PROXY=true, which the socket
// side took as one hop, went to Express as the string "true", which it
// tries to compile as an IP address and throws on at boot.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { expressTrustProxy, trustProxyHops } = require("../lib/trust-proxy");

test("every accepted TRUST_PROXY value is something Express will take", () => {
  for (const raw of [undefined, "", "true", "false", "0", "1", "2", "loopback", "loopback, 10.0.0.0/8"]) {
    const app = express();
    assert.doesNotThrow(() => app.set("trust proxy", expressTrustProxy(raw)), String(raw));
  }
});

test("Express and the socket layer agree on the hop count", () => {
  const cases = [
    [undefined, 1, 1], ["", 1, 1], ["true", 1, 1], ["1", 1, 1], ["2", 2, 2],
    ["false", false, 0], ["0", 0, 0],
  ];
  for (const [raw, forExpress, hops] of cases) {
    assert.equal(expressTrustProxy(raw), forExpress, String(raw));
    assert.equal(trustProxyHops(raw), hops, String(raw));
  }
  // An address list is Express's own syntax, passed through untouched.
  assert.equal(expressTrustProxy("loopback, 10.0.0.1"), "loopback, 10.0.0.1");
  assert.equal(trustProxyHops("loopback, 10.0.0.1"), 1);
});
