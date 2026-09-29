// Rolling count of the responses this process served, and how many of them
// were 5xx, over the last N minutes. GET /api/ops/status reports it
// (routes/ops-status.js) so an outside monitor can tell "up but failing"
// from "up and fine" without scraping /metrics, which is locked away from
// the internet (lib/metrics-access.js).
//
// One bucket per wall-clock minute, kept in a fixed ring. A bucket whose
// minute has gone stale is reset the next time anything lands in its slot,
// and ignored by snapshot() until then, so memory stays at N small objects
// no matter how busy it gets. The window is therefore "this minute plus the
// N-1 before it", close enough to 15 rolling minutes for an alert.
//
// In memory only: a restart starts from zero, which is fine, a restart is
// visible on its own (deploy.json, the uptime monitor).

const MINUTE_MS = 60 * 1000;

function createRequestWindow({ minutes = 15, now = () => Date.now() } = {}) {
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error("request window needs a whole number of minutes");
  const buckets = Array.from({ length: minutes }, () => ({ minute: -1, requests: 0, serverErrors: 0 }));

  function record(status) {
    const minute = Math.floor(now() / MINUTE_MS);
    const b = buckets[minute % minutes];
    if (b.minute !== minute) {
      b.minute = minute;
      b.requests = 0;
      b.serverErrors = 0;
    }
    b.requests += 1;
    if (status >= 500) b.serverErrors += 1;
  }

  function snapshot() {
    const current = Math.floor(now() / MINUTE_MS);
    let requests = 0;
    let serverErrors = 0;
    for (const b of buckets) {
      if (b.minute > current - minutes && b.minute <= current) {
        requests += b.requests;
        serverErrors += b.serverErrors;
      }
    }
    return { window_minutes: minutes, server_errors: serverErrors, requests };
  }

  // Counted on 'finish', so it's the status that actually went out,
  // whatever answered it (a route, the SPA fallback, the error handler).
  // A client that hangs up before we answer never finishes and isn't
  // counted, there was no response to count.
  function middleware(req, res, next) {
    res.on("finish", () => record(res.statusCode));
    next();
  }

  return { record, snapshot, middleware };
}

module.exports = { createRequestWindow };
