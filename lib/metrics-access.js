// Who gets to read GET /metrics.
//
// The old rule was "no METRICS_TOKEN in production means 401, unless
// METRICS_PUBLIC=true says port 3000 is firewalled". That promise doesn't
// hold behind a Cloudflare Tunnel. cloudflared runs on the box and hands
// every request for divinghq.app to localhost:3000, /metrics included, so
// with METRICS_PUBLIC=true (which the live box has, so Prometheus can
// scrape tokenless) the endpoint was readable by anyone on the internet.
// No firewall sits between the tunnel and the port.
//
// What does tell the two apart is the headers. Cloudflare's edge stamps
// every request it forwards with cf-ray and cf-connecting-ip (and a few
// more, below), a client can't strip them, and cloudflared passes them
// on. Prometheus, scraping host.docker.internal:3000 from the docker
// network on the same box, sends none of them. So:
//
//   came through Cloudflare  -> only with the METRICS_TOKEN bearer, else 404
//                               (a 404, not a 401, so there's nothing to
//                               hint that a door exists)
//   direct, token configured -> bearer required, else 401 as before
//   direct, no token         -> open in dev; in production only with
//                               METRICS_PUBLIC=true, else 401 as before
//
// "Direct" still trusts whatever can reach port 3000 without Cloudflare,
// which on the live box is the box itself and its LAN. Setting
// METRICS_TOKEN (and giving Prometheus the credential) closes that too,
// see ops/observability/README.md.

const crypto = require("node:crypto");

// Any one of these marks a request that went through Cloudflare's edge.
// cf-ray and cf-connecting-ip are on every proxied request; the others
// are belt and braces in case a future Cloudflare setting drops one.
const CLOUDFLARE_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-visitor", "cf-ipcountry"];

function cameThroughCloudflare(headers = {}) {
  if (CLOUDFLARE_HEADERS.some((h) => headers[h] !== undefined)) return true;
  // Cloudflare adds "CDN-Loop: cloudflare" to what it sends an origin.
  const loop = headers["cdn-loop"];
  return typeof loop === "string" && /cloudflare/i.test(loop);
}

function bearerMatches(headers, token) {
  if (!token) return false;
  const header = headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  // timingSafeEqual wants equal lengths. Leaking the length is fine, it's
  // the configured token's length and says nothing about its contents.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Returns 200 (serve it), 401 (ask for the token) or 404 (pretend there's
// nothing here). Read the env once at boot, like the rest of server.js.
function createMetricsGate({
  token = process.env.METRICS_TOKEN || null,
  allowPublic = process.env.METRICS_PUBLIC === "true",
  production = process.env.NODE_ENV === "production",
} = {}) {
  return function metricsAccess(req) {
    const headers = req.headers || {};
    const tokenOk = bearerMatches(headers, token);
    if (cameThroughCloudflare(headers)) return tokenOk ? 200 : 404;
    if (token) return tokenOk ? 200 : 401;
    // No token at all: fine in dev, and in production only when the
    // operator says the direct path is private (METRICS_PUBLIC=true).
    return !production || allowPublic ? 200 : 401;
  };
}

module.exports = { createMetricsGate, cameThroughCloudflare, CLOUDFLARE_HEADERS };
