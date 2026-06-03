// In-process runner for DiveRecorder imports triggered inside the web
// server — the sysadmin "import now" button (routes/dr-archive.js) and
// the optional scheduled sync (server.js). It owns a single shared job
// state so two triggers can't run concurrently and so the UI can poll
// progress.
//
// Deliberately lightweight: one import at a time, fire-and-forget, with
// an in-memory status object. For the heavy full backfill the operator
// still uses the CLI (scripts/import-diverecorder.js); this runner is
// tuned for incremental "pull new meets" runs.

const { createHttpFetcher, importArchive } = require("./diverecorder-import");
const { COUNTRIES } = require("./diverecorder-parser");

// Politeness delay for server-side runs. A touch slower than the CLI
// default so a background sync never hammers the source.
const SERVER_DELAY_MS = Number(process.env.DR_IMPORT_DELAY_MS || 1000);
const LOG_TAIL = 200; // keep the last N log lines for the status poll

const status = {
  running: false,
  trigger: null, // who/what started it: 'manual:<userId>' | 'schedule'
  startedAt: null,
  finishedAt: null,
  error: null,
  stats: null, // running stats from importArchive
  log: [],
};
let stopRequested = false;

function getImportStatus() {
  return { ...status, log: status.log.slice(-50) };
}

function pushLog(line) {
  status.log.push(line);
  if (status.log.length > LOG_TAIL) status.log.splice(0, status.log.length - LOG_TAIL);
}

// Start an import unless one is already running. Non-blocking — the
// promise runs detached and updates `status`. Returns { ok, status }.
// `nowIso` is injected (caller passes a timestamp) so this module never
// calls Date directly; callers in the server pass new Date().toISOString().
function startImport(pool, opts = {}) {
  if (status.running) return { ok: false, status: getImportStatus() };

  const countries = opts.nat
    ? COUNTRIES.filter((c) =>
        String(opts.nat).split(",").map((s) => s.trim().toUpperCase()).includes(c.nat),
      )
    : COUNTRIES;

  status.running = true;
  status.trigger = opts.trigger || "manual";
  status.startedAt = opts.nowIso || new Date().toISOString();
  status.finishedAt = null;
  status.error = null;
  status.stats = { meets: 0, events: 0, results: 0, dives: 0, skipped: 0, discovered: 0 };
  status.log = [];
  stopRequested = false;

  const fetchHtml = createHttpFetcher({
    delayMs: SERVER_DELAY_MS,
    log: pushLog,
  });

  // Detached — do not await.
  importArchive(pool, fetchHtml, {
    onlyNew: opts.onlyNew !== false,
    limitMeets: opts.limitMeets ?? null,
    countries,
    log: pushLog,
    shouldStop: () => stopRequested,
    onProgress: (s) => {
      status.stats = s;
    },
  })
    .then((s) => {
      status.stats = s;
    })
    .catch((err) => {
      status.error = err.message;
      pushLog(`! import failed: ${err.message}`);
    })
    .finally(() => {
      status.running = false;
      status.finishedAt = new Date().toISOString();
    });

  return { ok: true, status: getImportStatus() };
}

function requestStop() {
  stopRequested = true;
}

module.exports = { startImport, getImportStatus, requestStop };
