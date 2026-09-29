// routes/metrics.js, the Prometheus scrape target.
//
//   GET /metrics   text/plain; version=0.0.4 (prom-client's default, which
//                  is what Prometheus expects)
//
// Operational counters only, no personal data, but route names and
// request volume are still intel we don't hand out anonymously. Who may
// read it is lib/metrics-access.js's call:
//   * anything that came through Cloudflare (cf-ray, cf-connecting-ip and
//     friends) gets a plain 404 unless it carries the METRICS_TOKEN
//     bearer. The tunnel forwards every path to the app's port, so "port
//     3000 isn't public" never protected /metrics on the live box.
//   * a direct request (Prometheus on the same box) needs the bearer when
//     METRICS_TOKEN is set; without one it's open outside production and
//     in production only with METRICS_PUBLIC=true. Otherwise 401.
//
// lib/metrics.js documents the cardinality discipline each metric follows.

const express = require("express");
const { createMetricsGate } = require("../lib/metrics-access");

module.exports = function createMetricsRouter({ pool, metrics, logger, access = createMetricsGate() }) {
  const router = express.Router();

  router.get("/metrics", async (req, res) => {
    const verdict = access(req);
    if (verdict === 404) {
      // Worded like server.js's final 404, nothing to say there's a
      // door here at all.
      return res.status(404).type("text/plain").send("Not found");
    }
    if (verdict !== 200) {
      res.set("WWW-Authenticate", 'Bearer realm="metrics"');
      return res.status(401).end();
    }
    try {
      metrics.collectPoolStats(pool);
      res.set("Content-Type", metrics.registry.contentType);
      res.end(await metrics.registry.metrics());
    } catch (err) {
      logger.error({ err }, "metrics scrape failed");
      res.status(500).end();
    }
  });

  return router;
};
