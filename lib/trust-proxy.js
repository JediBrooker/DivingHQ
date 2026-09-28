// How many reverse proxies sit in front of us, read once from
// TRUST_PROXY, for both sides that care:
//   * server.js hands expressTrustProxy() to app.set("trust proxy"),
//     which decides req.ip for the rate limiters and the audit logs;
//   * routes/socket.js resolves a socket's IP (score audit rows, the
//     per-IP connection cap) with the trust function Express compiled
//     from that value, handed in by server.js, so it lands on req.ip's
//     answer. trustProxyHops() is only its fallback when nothing is
//     handed in (the unit tests).
// They used to parse it separately and disagreed on "true": the socket
// side read it as one hop, Express got the literal string, tried to
// compile it as an IP address and threw at boot, so PM2 crash-looped.
//
// Accepted values:
//   unset, "", "true"   one hop, a single edge proxy (the default setup)
//   "false"             no proxy, trust nothing
//   "0", "1", "2", ...  that many hops
//   anything else       Express's own syntax ("loopback", an address or
//                       subnet list), passed through untouched. Only the
//                       socket fallback has to guess, and it assumes one.
// Not "true" in Express's sense (trust every hop): that lets any client
// pick its own req.ip by sending X-Forwarded-For, rate limits included.

function expressTrustProxy(raw = process.env.TRUST_PROXY) {
  if (raw === undefined || raw === null) return 1;
  const v = String(raw).trim();
  if (v === "" || v === "true") return 1;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function trustProxyHops(raw = process.env.TRUST_PROXY) {
  const v = expressTrustProxy(raw);
  if (v === false) return 0;
  if (typeof v === "number") return v;
  return 1;
}

module.exports = { expressTrustProxy, trustProxyHops };
