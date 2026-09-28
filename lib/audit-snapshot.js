// Audit retention: copy the three audit tables out to JSONL files in
// AUDIT_SNAPSHOT_DIR, then purge rows past the 30-day window
// (purge_audit_logs, migration 008). The files are the long-term,
// legal-retention copy; the operator ships the directory off-site with
// their own cron or systemd job.
//
// This used to live in server.js and only ran at boot, copying "the 24h
// before now". Two problems with that:
//   * restarts more than a day apart left a gap: rows from between the
//     previous boot and this boot minus 24h were never written anywhere,
//     and the purge deleted them a month later;
//   * a process that stayed up for weeks never purged at all, which
//     isn't the 30 days the privacy policy promises.
// So it runs daily now, and each table remembers how far it got (a small
// marks file next to the snapshots) instead of assuming a 24h window.
//
// Rows are only copied once they're a few minutes old. created_at is
// set when a transaction starts, so a row can commit after a later
// row is already visible; the settle window keeps the high-water mark
// from skipping over it.
//
// Every write goes through fs.promises. The old createWriteStream had no
// 'error' listener, so an unwritable directory (EACCES, a full disk)
// threw from an event emitter and crash-looped the server on every boot.

const fs = require("node:fs");
const path = require("node:path");

const TABLES = [
  ["score_audit_log", "score_audit"],
  ["role_audit_log", "role_audit"],
  ["audit_log", "audit"],
];
const MARKS_FILE = ".snapshot-marks.json";
const SETTLE_SECONDS = 5 * 60;
const BATCH = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

module.exports = function createAuditSnapshot({
  pool, logger, dir = process.env.AUDIT_SNAPSHOT_DIR, retentionDays = 30, settleSeconds = SETTLE_SECONDS,
}) {
  if (!pool) throw new Error("createAuditSnapshot requires { pool }");
  const log = logger || { info() {}, warn() {} };

  async function readMarks() {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(dir, MARKS_FILE), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw err;
    }
  }

  // Write-then-rename, so a crash halfway through never leaves a marks
  // file we can't parse (which would stall every table until someone
  // noticed).
  async function writeMarks(marks) {
    const file = path.join(dir, MARKS_FILE);
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(marks, null, 2));
    await fs.promises.rename(`${file}.tmp`, file);
  }

  // Copies each table's rows from its mark up to now minus the settle
  // window. A table with no mark yet (first run) copies everything still
  // in the database: a few duplicates of what an older boot-time snapshot
  // already wrote beat a gap. The mark only moves once a table's rows are
  // all on disk, so a failure part way retries from the same place next
  // time. Never throws; a failed table is logged and the rest carry on.
  async function snapshot() {
    if (!dir) return;
    let marks;
    let cutoff;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      marks = await readMarks();
      // Text, not a JS Date: timestamptz has microseconds, a Date doesn't,
      // and a mark rounded down would copy its boundary rows twice.
      cutoff = (await pool.query("SELECT (now() - make_interval(secs => $1))::text AS t", [settleSeconds])).rows[0].t;
    } catch (err) {
      log.warn({ dir, err: err.message }, "audit snapshot failed; purge will continue");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    for (const [table, prefix] of TABLES) {
      try {
        const file = path.join(dir, `${prefix}_${stamp}.jsonl`);
        let after = marks[table] ? { ts: marks[table], id: null } : null;
        let written = 0;
        for (;;) {
          // Keyset paging on (created_at, id) so a big first run doesn't
          // pull a month of score_audit_log into memory at once.
          const r = await pool.query(
            `SELECT *, created_at::text AS snapshot_ts FROM ${table}
              WHERE created_at <= $1::timestamptz
                AND ($2::timestamptz IS NULL
                     OR created_at > $2::timestamptz
                     OR (created_at = $2::timestamptz AND $3::uuid IS NOT NULL AND id > $3::uuid))
              ORDER BY created_at, id
              LIMIT ${BATCH}`,
            [cutoff, after?.ts ?? null, after?.id ?? null],
          );
          if (!r.rows.length) break;
          const last = r.rows[r.rows.length - 1];
          after = { ts: last.snapshot_ts, id: last.id };
          const lines = r.rows.map((row) => {
            delete row.snapshot_ts;
            return JSON.stringify(row) + "\n";
          }).join("");
          await fs.promises.appendFile(file, lines);
          written += r.rows.length;
          if (r.rows.length < BATCH) break;
        }
        marks[table] = cutoff;
        await writeMarks(marks);
        if (written) log.info({ table, file: path.basename(file), rows: written }, "audit snapshot written");
      } catch (err) {
        log.warn({ table, err: err.message }, "audit snapshot failed for one table; continuing");
      }
    }
  }

  async function purge() {
    try {
      const r = await pool.query("SELECT * FROM purge_audit_logs($1)", [retentionDays]);
      const total = r.rows.reduce((sum, row) => sum + Number(row.deleted_rows), 0);
      if (total > 0) log.info({ deleted_rows: total }, "purged audit log");
    } catch (err) {
      log.warn({ err: err.message }, "purge_audit_logs failed (run migration 008?)");
    }
  }

  // Snapshot first, so nothing is purged before it's been copied out.
  let running = null;
  function runOnce() {
    if (!running) {
      running = (async () => {
        await snapshot();
        await purge();
      })().finally(() => { running = null; });
    }
    return running;
  }

  // Once now, then daily. The timer never holds the process open.
  function start() {
    runOnce();
    setInterval(runOnce, DAY_MS).unref();
  }

  return { snapshot, purge, runOnce, start };
};
