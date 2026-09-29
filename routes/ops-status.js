// routes/ops-status.js, the one-look answer to "is the service healthy
// and are the backups working?" for an outside monitor.
//
//   GET /api/ops/status   public, no auth, Cache-Control: no-store
//
// {
//   ok,                 server up AND a trivial DB query worked
//   schema_version,     int or null
//   time,               now, ISO
//   backup:        { last_attempt_at, last_success_at, last_ok, offsite, size_bytes },
//   restore_check: { last_run_at, ok },
//   deploy:        { last_at, ok, sha },
//   errors:        { window_minutes: 15, server_errors, requests },
// }
//
// Always a 200, even with the database down (ok: false then). That's the
// difference from /api/health, which deploy.sh and the load balancer read
// and which does answer 503. A monitor polling this one wants the rest of
// the body whatever the database is doing, a backup that stopped running
// matters just as much during an outage.
//
// Public on purpose, so it says nothing a stranger could use: no names,
// hosts, paths, versions of anything but our own schema, and no error
// text. The backup/restore/deploy blocks come from files the ops scripts
// write, filtered field by field in lib/ops-state.js. The shape is a
// contract shared with the monitoring side, change it in both places or
// not at all. ops/backups/README.md has the operator's view.

const express = require("express");
const { readOpsState, stateDir: defaultStateDir } = require("../lib/ops-state");

// A wedged Postgres can leave a query hanging well past any monitor's
// timeout (the pool has no connect timeout of its own), and a status page
// that hangs reads as "the whole box is down". Give up after this and
// report ok: false.
const DB_TIMEOUT_MS = 2000;

module.exports = function createOpsStatusRouter({
  pool,
  requestWindow,
  stateDir = defaultStateDir(),
  logger = null,
  dbTimeoutMs = DB_TIMEOUT_MS,
}) {
  const router = express.Router();

  async function schemaVersion() {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("status query timed out")), dbTimeoutMs);
    });
    try {
      const r = await Promise.race([
        pool.query("SELECT version FROM public.schema_meta WHERE id = 1"),
        timeout,
      ]);
      const v = Number(r.rows[0]?.version);
      return { ok: true, version: Number.isSafeInteger(v) ? v : null };
    } catch (err) {
      // Logged here, never sent: the message can carry a hostname or a
      // role name.
      if (logger) logger.warn({ err: err.message }, "ops status: database check failed");
      return { ok: false, version: null };
    } finally {
      clearTimeout(timer);
    }
  }

  router.get("/api/ops/status", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const [db, state] = await Promise.all([schemaVersion(), readOpsState(stateDir)]);
    res.json({
      ok: db.ok,
      schema_version: db.version,
      time: new Date().toISOString(),
      backup: state.backup,
      restore_check: state.restore_check,
      deploy: state.deploy,
      errors: requestWindow
        ? requestWindow.snapshot()
        : { window_minutes: 15, server_errors: 0, requests: 0 },
    });
  });

  return router;
};
