// Prometheus metrics — exposed at GET /metrics.
//
// Default Node.js metrics (memory, GC, event loop lag, CPU) are
// collected automatically by prom-client. On top we add the
// app-specific counters/histograms below. Anything Prometheus-
// scrape-shaped, anything more complex (StatsD, OpenTelemetry)
// can layer on top later.
//
// Cardinality discipline: NEVER tag a metric with a high-
// cardinality value (event_id, user_id, judge_id). Each unique
// label combination becomes its own time series in Prometheus,
// and a meet with 1000 events × 100 divers × 7 judges blows up
// the registry. Aggregate at the metric definition; track the
// per-event detail in the structured logs.
//
// Usage:
//   const m = require("./lib/metrics");
//   m.scoresSubmitted.inc();
//   m.scoreboardCacheHits.inc();
//   const end = m.httpDuration.startTimer({ method, route });
//   …handler logic…
//   end({ status: res.statusCode });

const promClient = require("prom-client");

// Default metrics: process_resident_memory_bytes, nodejs_eventloop_lag_seconds,
// process_cpu_user_seconds_total, GC stats, etc.
promClient.collectDefaultMetrics({ prefix: "dive_recorder_" });

const registry = promClient.register;

// ---- HTTP -----------------------------------------------------
const httpRequests = new promClient.Counter({
  name: "dive_recorder_http_requests_total",
  help: "Total HTTP requests by method, route template, and status class",
  labelNames: ["method", "route", "status"],
});
const httpDuration = new promClient.Histogram({
  name: "dive_recorder_http_request_duration_seconds",
  help: "HTTP request duration by method + route template",
  labelNames: ["method", "route", "status"],
  // Bucket layout tuned for typical API responses (10ms–10s).
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// ---- Socket ---------------------------------------------------
const socketConnections = new promClient.Gauge({
  name: "dive_recorder_socket_connections",
  help: "Currently-connected Socket.IO clients (anonymous + authed)",
});
const scoresSubmitted = new promClient.Counter({
  name: "dive_recorder_scores_submitted_total",
  help: "Score submissions accepted by submit_score",
});
const scoresRejected = new promClient.Counter({
  name: "dive_recorder_scores_rejected_total",
  help: "Score submissions rejected by submit_score, by reason",
  labelNames: ["reason"],
});

// ---- Scoreboard cache ----------------------------------------
const scoreboardCacheHits = new promClient.Counter({
  name: "dive_recorder_scoreboard_cache_hits_total",
  help: "Scoreboard payload served from cache",
});
const scoreboardCacheMisses = new promClient.Counter({
  name: "dive_recorder_scoreboard_cache_misses_total",
  help: "Scoreboard payload rebuilt from DB (cache miss or invalidated)",
});

// ---- DB pool --------------------------------------------------
// Updated once per scrape via collectPoolStats() below.
const dbPoolTotal = new promClient.Gauge({
  name: "dive_recorder_db_pool_total",
  help: "Total clients in the pg pool",
});
const dbPoolIdle = new promClient.Gauge({
  name: "dive_recorder_db_pool_idle",
  help: "Idle clients in the pg pool",
});
const dbPoolWaiting = new promClient.Gauge({
  name: "dive_recorder_db_pool_waiting",
  help: "Clients waiting for a pool slot (saturation signal)",
});

function collectPoolStats(pool) {
  if (!pool) return;
  dbPoolTotal.set(pool.totalCount ?? 0);
  dbPoolIdle.set(pool.idleCount ?? 0);
  dbPoolWaiting.set(pool.waitingCount ?? 0);
}

// Express middleware that times every request. Call BEFORE
// app.use(express.json) — we want to count even malformed JSON
// bodies. Uses the route TEMPLATE (req.route.path) when express
// has matched a route, and a single constant bucket otherwise.
// We must NOT fall back to the raw req.path: this middleware runs
// before the static handler / body parser / CORS, so any request
// that terminates early with a non-404 status (a 200 static asset,
// a 413 from the body parser, a CORS short-circuit) would have no
// req.route and would mint a fresh time series per unique URL —
// unbounded label cardinality. Collapse all of them to "(unmatched)".
function httpMetricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path || "(unmatched)";
    const status = String(res.statusCode);
    end({ method: req.method, route, status });
    httpRequests.inc({ method: req.method, route, status });
  });
  next();
}

module.exports = {
  registry,
  httpMetricsMiddleware,
  collectPoolStats,
  // Counters / histograms / gauges (importers can .inc / .observe / .set)
  httpRequests,
  httpDuration,
  socketConnections,
  scoresSubmitted,
  scoresRejected,
  scoreboardCacheHits,
  scoreboardCacheMisses,
};
