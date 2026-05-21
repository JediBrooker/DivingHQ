// Background sweeper for the idempotency_keys table.
//
// Deletes rows older than 72 hours (the retention window agreed
// in docs/offline-p1-design.md §2). Runs on a 1-hour interval
// inside the Node process. Started by server.js after the pool
// is wired up; no separate cron process.
//
// If the server restarts, the interval restarts too — worst-case
// cleanup delay after a restart is ~1 hour. The table is bounded
// at ~70MB even at peak load (see design doc §8 risk #4), so
// transient lag is acceptable. Predictable cron-style scheduling
// would add a dependency for negligible benefit.
//
// Idempotent: re-calling start() while the sweeper is already
// running is a no-op. stop() is exposed for tests (and a clean
// process-shutdown path if we ever add one).

const RETENTION_HOURS = 72;
const INTERVAL_MS = 60 * 60 * 1000;  // 1 hour

let timer = null;
let pool = null;

/**
 * Start the sweeper. Idempotent.
 *
 * @param {{ pool: import('pg').Pool, intervalMs?: number }} opts
 *        intervalMs override is intended for tests; production
 *        leaves it at the default 1 hour.
 * @returns {void}
 */
function start({ pool: poolInstance, intervalMs = INTERVAL_MS } = {}) {
  if (timer) return;  // already running
  if (!poolInstance) {
    console.error("[idempotency-sweeper] start() requires { pool }");
    return;
  }
  pool = poolInstance;

  // Fire an initial sweep immediately so a freshly-started server
  // doesn't wait an hour to catch up on whatever the previous
  // instance left behind. Errors logged, not thrown.
  sweep().catch((err) =>
    console.error("[idempotency-sweeper] initial sweep failed:", err.message),
  );

  timer = setInterval(() => {
    sweep().catch((err) =>
      console.error("[idempotency-sweeper] scheduled sweep failed:", err.message),
    );
  }, intervalMs);

  // Don't keep the event loop alive solely for the sweeper. A
  // server with no other handles still has the HTTP listener +
  // socket.io + pg pool to keep it up, so this is purely defensive
  // against a future refactor that strips other handles.
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the sweeper. Exposed for tests + future graceful shutdown. */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Run one sweep pass. Returns the number of rows deleted. Used by
 * start() on a timer, and exposed for tests / manual invocation.
 *
 * @returns {Promise<number>}
 */
async function sweep() {
  if (!pool) return 0;
  const r = await pool.query(
    `DELETE FROM idempotency_keys
     WHERE created_at < now() - ($1::text || ' hours')::interval`,
    [String(RETENTION_HOURS)],
  );
  const deleted = r.rowCount || 0;
  if (deleted > 0) {
    console.log(`[idempotency-sweeper] deleted ${deleted} expired key(s)`);
  }
  return deleted;
}

module.exports = { start, stop, sweep, RETENTION_HOURS };
