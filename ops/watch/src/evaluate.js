// The watch Worker's alert rules, as one pure function:
//
//   evaluate(prevState, observations, now, options?) -> { state, alerts }
//
// No fetches, no KV, no clock reads. watch.js does the I/O and hands this
// what it saw; the tests hand it whatever they like. The returned state is
// a fresh object (prevState is never mutated) and goes back into KV as is.
//
// The rules, in short (README.md has the long version):
//   DOWN     /api/health not 200 + ok on two runs in a row. Alert, remind
//            hourly, note when it's back with how long it was out.
//   DB       /api/ops/status says ok:false on two runs in a row. Same.
//   BACKUP   last_ok false, or no success for 26 h. At most every 12 h,
//            note when a fresh success turns up.
//   OFFSITE  'failed' at most every 12 h, 'not_configured' weekly.
//   RESTORE  ok false, or not run for 8 days. At most daily.
//   DEPLOY   ok false, once per (last_at, sha).
//   ERRORS   >= 20 5xx and >= 5% of requests in the window. At most hourly.
//
// When the status endpoint can't be read (timeout, 404 because the route
// isn't deployed, junk JSON) every check that needs it holds still: no
// alerts, no recoveries, streaks untouched. The only thing that fires is
// a once-a-day "status endpoint unreachable" note after an hour of it
// with the site otherwise up, because a watcher that has quietly gone
// blind to backups is the failure this whole thing exists to prevent.
//
// Several rules can fire in one run (a database outage trips DOWN and DB
// together, a failed backup usually fails the offsite copy too). They come
// back as separate alerts so each is testable; watch.js folds a run's
// alerts into one email with composeEmail() below.

import { MINUTE, HOUR, DAY, toMs, toIso, formatDuration, formatWhen, formatAgo } from "./format.js";

/**
 * GET /api/ops/status, the contract shared with the server (track o1).
 * Every block can come back with all-null fields when the box's state
 * file is missing; the endpoint answers 200 with ok:false when the DB is
 * down.
 * @typedef {Object} OpsStatus
 * @property {boolean} ok
 * @property {number|null} schema_version
 * @property {string} time
 * @property {{last_attempt_at: string|null, last_success_at: string|null, last_ok: boolean|null,
 *   offsite: 'ok'|'failed'|'not_configured'|null, size_bytes: number|null}} backup
 * @property {{last_run_at: string|null, ok: boolean|null}} restore_check
 * @property {{last_at: string|null, ok: boolean|null, sha: string|null}} deploy
 * @property {{window_minutes: number, server_errors: number, requests: number}} errors
 */

/**
 * One HTTP probe, as watch.js's probe() reports it.
 * @typedef {Object} Probe
 * @property {number|null} httpStatus  null when no response arrived
 * @property {any} body                parsed JSON, or null
 * @property {string|null} error       e.g. "timed out after 10 s"
 *
 * @typedef {Object} Observations
 * @property {Probe} health  GET /api/health
 * @property {Probe} status  GET /api/ops/status
 *
 * @typedef {Object} Alert
 * @property {string} id      stable machine id, e.g. "down", "backup.recovered"
 * @property {string} tag     the short bit that goes in the subject
 * @property {string} title   first line of its section in the email
 * @property {string[]} lines the rest of the section
 * @property {string} at      ISO time the rule fired
 */

export const STATE_VERSION = 1;

export const LIMITS = Object.freeze({
  DEBOUNCE_RUNS: 2,
  DOWN_REMIND_MS: 60 * MINUTE,
  DB_REMIND_MS: 60 * MINUTE,
  BACKUP_MAX_AGE_MS: 26 * HOUR,
  BACKUP_REMIND_MS: 12 * HOUR,
  OFFSITE_FAILED_REMIND_MS: 12 * HOUR,
  OFFSITE_UNCONFIGURED_REMIND_MS: 7 * DAY,
  RESTORE_MAX_AGE_MS: 8 * DAY,
  RESTORE_REMIND_MS: 24 * HOUR,
  ERRORS_MIN: 20,
  // 5%, kept as a ratio of integers so 20 of 400 is exactly on the line
  // rather than at the mercy of floating point.
  ERRORS_PER: 1,
  ERRORS_OF: 20,
  ERRORS_REMIND_MS: 60 * MINUTE,
  BLIND_AFTER_MS: 60 * MINUTE,
  BLIND_REMIND_MS: 24 * HOUR,
  // A stored timestamp further in the future than this is junk (a bad
  // clock, a hand-edited KV value) and gets ignored rather than holding
  // an alert back for however long it claims.
  FUTURE_SKEW_MS: 10 * MINUTE,
  OUTBOX_MAX: 20,
  OUTBOX_MAX_AGE_MS: 6 * HOUR,
});

const RUNBOOK_BACKUPS = "The runbook is ops/backups/README.md in the repo.";
const BOX_CHECKS =
  "On the box: pm2 status, pm2 logs dive-recorder --lines 200, " +
  "systemctl status postgresql cloudflared, and df -h (a full disk takes Postgres down with it).";

const HTTP_HINTS = {
  502: "A 502 means Cloudflare reached the tunnel but nothing answered behind it, so the app process is probably down.",
  503: "/api/health answers 503 when its database query fails, so the process is up and Postgres probably isn't.",
  504: "A 504 means the app took too long to answer.",
  524: "A 524 means Cloudflare gave up waiting on the app.",
  530: "A 530 means Cloudflare couldn't reach the tunnel at all, so cloudflared or the box itself is down.",
};

function freshState() {
  return {
    version: STATE_VERSION,
    lastRunAt: null,
    // Summary of the latest run, only for GET / on the Worker.
    last: null,
    down: { fails: 0, since: null, alerted: false, lastAlertAt: null },
    db: { fails: 0, since: null, alerted: false, lastAlertAt: null },
    // baseline: the last success (backup) or last run (restore) on record
    // when the trouble started. Only something newer counts as a recovery.
    backup: { failing: false, since: null, alerted: false, lastAlertAt: null, noneSince: null, baseline: null },
    offsite: { failedSince: null, failedAlerted: false, failedLastAlertAt: null, unconfiguredLastAlertAt: null },
    restore: { failing: false, since: null, alerted: false, lastAlertAt: null, noneSince: null, baseline: null },
    deploy: { lastAlertedKey: null },
    errors: { lastAlertAt: null },
    blind: { since: null, lastAlertAt: null },
    // Alerts whose email didn't go out; watch.js retries them next run.
    outbox: [],
  };
}

const SECTIONS = ["down", "db", "backup", "offsite", "restore", "deploy", "errors", "blind"];

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Take a field from stored state only if it has the type the template
// expects. KV can hold anything (an older version, a hand edit), and one
// bad field shouldn't take the whole watcher down.
function coerce(template, value) {
  if (typeof template === "number") return Number.isInteger(value) && value >= 0 ? value : template;
  if (typeof template === "boolean") return typeof value === "boolean" ? value : template;
  return typeof value === "string" ? value : null;
}

function normalizeAlert(a) {
  if (!isObj(a)) return null;
  if (typeof a.id !== "string" || typeof a.tag !== "string" || typeof a.title !== "string") return null;
  if (toMs(a.at) === null) return null;
  const lines = Array.isArray(a.lines) ? a.lines.filter((l) => typeof l === "string") : [];
  return { id: a.id, tag: a.tag, title: a.title, lines, at: a.at };
}

export function normalizeOutbox(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeAlert).filter(Boolean).slice(-LIMITS.OUTBOX_MAX);
}

// Any stored value -> a complete state of the current version. Unknown or
// older shapes start over, which at worst re-sends one alert.
export function normalizeState(prev) {
  const s = freshState();
  if (!isObj(prev) || prev.version !== STATE_VERSION) return s;
  s.lastRunAt = toMs(prev.lastRunAt) === null ? null : prev.lastRunAt;
  s.last = isObj(prev.last) ? JSON.parse(JSON.stringify(prev.last)) : null;
  for (const name of SECTIONS) {
    const src = prev[name];
    if (!isObj(src)) continue;
    for (const key of Object.keys(s[name])) s[name][key] = coerce(s[name][key], src[key]);
  }
  s.down.fails = Math.min(s.down.fails, LIMITS.DEBOUNCE_RUNS);
  s.db.fails = Math.min(s.db.fails, LIMITS.DEBOUNCE_RUNS);
  s.outbox = normalizeOutbox(prev.outbox);
  return s;
}

// Has at least `interval` passed since `last`? Never-sent is due. A `last`
// from well in the future is treated as never, see FUTURE_SKEW_MS.
export function isDue(last, interval, now) {
  const l = toMs(last);
  if (l === null) return true;
  const elapsed = now - l;
  if (elapsed < -LIMITS.FUTURE_SKEW_MS) return true;
  return elapsed >= interval;
}

function readHealth(p) {
  if (!isObj(p)) return { ok: false, detail: "no result", httpStatus: null };
  if (p.error) return { ok: false, detail: String(p.error), httpStatus: null };
  const code = Number.isInteger(p.httpStatus) ? p.httpStatus : null;
  if (code !== 200) return { ok: false, detail: code === null ? "no response" : `HTTP ${code}`, httpStatus: code };
  if (!isObj(p.body) || p.body.ok !== true) {
    return { ok: false, detail: "HTTP 200 but the body didn't say ok: true", httpStatus: code };
  }
  return { ok: true, detail: "ok", httpStatus: code };
}

function readStatus(p) {
  if (!isObj(p)) return { known: false, body: null, detail: "no result" };
  if (p.error) return { known: false, body: null, detail: String(p.error) };
  const code = Number.isInteger(p.httpStatus) ? p.httpStatus : null;
  if (code !== 200) return { known: false, body: null, detail: code === null ? "no response" : `HTTP ${code}` };
  if (!isObj(p.body) || typeof p.body.ok !== "boolean") {
    return { known: false, body: null, detail: "HTTP 200 but not the expected JSON" };
  }
  return { known: true, body: p.body, detail: "ok" };
}

function block(status, name) {
  return status && isObj(status[name]) ? status[name] : null;
}

function count(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

// Only the contract's fields, so a chatty server can't bloat the KV value.
function summarize(health, status, statusDetail, now) {
  const pick = (obj, keys) => (isObj(obj) ? Object.fromEntries(keys.map((k) => [k, obj[k] ?? null])) : null);
  const body = status;
  return {
    at: toIso(now),
    health: { ok: health.ok, detail: health.detail },
    status: body
      ? {
          ok: body.ok,
          schema_version: body.schema_version ?? null,
          time: typeof body.time === "string" ? body.time : null,
          backup: pick(body.backup, ["last_attempt_at", "last_success_at", "last_ok", "offsite", "size_bytes"]),
          restore_check: pick(body.restore_check, ["last_run_at", "ok"]),
          deploy: pick(body.deploy, ["last_at", "ok", "sha"]),
          errors: pick(body.errors, ["window_minutes", "server_errors", "requests"]),
        }
      : { unknown: statusDetail },
  };
}

function fire(ctx, id, tag, title, lines) {
  ctx.alerts.push({ id, tag, title, lines: lines.filter(Boolean), at: toIso(ctx.now) });
}

// DOWN and DB share this: debounce, first alert, hourly reminder,
// recovery note. `failing` null means we can't tell this run, so nothing
// moves.
function streakRule(sec, failing, ctx, remindMs, text) {
  if (failing === null) return;
  const now = ctx.now;
  if (failing) {
    if (sec.fails === 0 || toMs(sec.since) === null) sec.since = toIso(now);
    sec.fails = Math.min(sec.fails + 1, LIMITS.DEBOUNCE_RUNS);
    if (sec.fails < LIMITS.DEBOUNCE_RUNS) return;
    if (!sec.alerted) {
      text.first();
      sec.alerted = true;
      sec.lastAlertAt = toIso(now);
    } else if (isDue(sec.lastAlertAt, remindMs, now)) {
      text.reminder(now - toMs(sec.since));
      sec.lastAlertAt = toIso(now);
    }
    return;
  }
  if (sec.alerted) text.recovered(now - toMs(sec.since));
  sec.fails = 0;
  sec.since = null;
  sec.alerted = false;
  sec.lastAlertAt = null;
}

function downDiagnosis(health, st) {
  const lines = [];
  if (health.httpStatus && HTTP_HINTS[health.httpStatus]) lines.push(HTTP_HINTS[health.httpStatus]);
  if (!st.known) {
    lines.push("The status endpoint didn't answer either.");
  } else if (st.body.ok === false) {
    lines.push("The status endpoint still answers but reports its database check failing, so start with Postgres.");
  } else {
    lines.push(
      "The status endpoint answers and says the database is fine, so this may be narrower than a full outage (the health route, or something in front of it).",
    );
  }
  return lines;
}

function checkDown(s, health, st, ctx) {
  const url = `${ctx.target}/api/health`;
  streakRule(s.down, !health.ok, ctx, LIMITS.DOWN_REMIND_MS, {
    first: () =>
      fire(ctx, "down", "DOWN", "DivingHQ is down", [
        `${url} failed on two checks in a row (latest: ${health.detail}).`,
        `First failed check: ${ctx.when(toMs(s.down.since))}. Checks run every 2 minutes, so it went down shortly before that.`,
        ...downDiagnosis(health, st),
        BOX_CHECKS,
        "You'll get a reminder every hour while it stays down, and a note when it's back.",
      ]),
    reminder: (dur) =>
      fire(ctx, "down.reminder", `still DOWN (${formatDuration(dur)})`, "DivingHQ is still down", [
        `${url} has been failing since ${ctx.when(toMs(s.down.since))}, about ${formatDuration(dur)} now (latest: ${health.detail}).`,
        ...downDiagnosis(health, st),
        BOX_CHECKS,
      ]),
    recovered: (dur) =>
      fire(ctx, "down.recovered", `back up after ${formatDuration(dur)}`, "DivingHQ is back up", [
        `${url} passed again at ${ctx.when(ctx.now)}.`,
        `It first failed at ${ctx.when(toMs(s.down.since))}, so it was out for about ${formatDuration(dur)} (give or take the 2 minutes between checks).`,
        "pm2 logs dive-recorder on the box should say what happened.",
      ]),
  });
}

function checkDb(s, st, ctx) {
  const failing = st.known ? st.body.ok === false : null;
  const whatToCheck =
    "On the box: systemctl status postgresql, journalctl -u postgresql --since '-1 hour', df -h, and pm2 logs dive-recorder for connection errors.";
  streakRule(s.db, failing, ctx, LIMITS.DB_REMIND_MS, {
    first: () =>
      fire(ctx, "db", "database down", "The database check is failing", [
        "/api/ops/status has said ok: false on two checks in a row, which means the app couldn't run a trivial query.",
        `First failing check: ${ctx.when(toMs(s.db.since))}.`,
        whatToCheck,
        "You'll get a reminder every hour while it stays down, and a note when it's back.",
      ]),
    reminder: (dur) =>
      fire(ctx, "db.reminder", `database still down (${formatDuration(dur)})`, "The database check is still failing", [
        `It has been failing since ${ctx.when(toMs(s.db.since))}, about ${formatDuration(dur)} now.`,
        whatToCheck,
      ]),
    recovered: (dur) =>
      fire(ctx, "db.recovered", `database back after ${formatDuration(dur)}`, "The database check passes again", [
        `/api/ops/status said ok: true again at ${ctx.when(ctx.now)}, after about ${formatDuration(dur)}.`,
        "journalctl -u postgresql on the box should say what happened.",
      ]),
  });
}

function checkBackup(s, st, ctx) {
  const b = st.known ? block(st.body, "backup") : null;
  if (!b) return;
  const sec = s.backup;
  const now = ctx.now;
  const successMs = toMs(b.last_success_at);
  const attemptMs = toMs(b.last_attempt_at);

  // "Never" gets the same 26 h of grace as "late", counted from when the
  // watcher first saw it, so a fresh install doesn't page before the first
  // nightly run and a box where backups were never set up still does.
  if (successMs === null) {
    if (toMs(sec.noneSince) === null) sec.noneSince = toIso(now);
  } else {
    sec.noneSince = null;
  }

  let problem = null;
  if (b.last_ok === false) problem = "failed";
  else if (successMs === null) {
    if (now - toMs(sec.noneSince) > LIMITS.BACKUP_MAX_AGE_MS) problem = "none";
  } else if (now - successMs > LIMITS.BACKUP_MAX_AGE_MS) problem = "stale";

  if (!problem) {
    // The rule clearing isn't proof a backup worked. backup.json going
    // unreadable (every field null, so "never" with a fresh grace period)
    // clears it too, and so would last_ok dropping to null while a run is
    // in flight. Telling someone "working again, last success: never" is
    // worse than saying nothing, so only a success newer than the one on
    // record when this started ends it. Anything else holds still.
    if (sec.failing) {
      const base = toMs(sec.baseline);
      const fresh = successMs !== null && (base === null || successMs > base);
      if (!fresh && sec.alerted) return;
      if (fresh && sec.alerted) {
        fire(ctx, "backup.recovered", "backups OK again", "Backups are working again", [
          `Last successful backup: ${ctx.ago(successMs)}.`,
          count(b.size_bytes) !== null ? `Size: ${formatBytes(b.size_bytes)}.` : null,
        ]);
      }
    }
    sec.failing = false;
    sec.since = null;
    sec.alerted = false;
    sec.lastAlertAt = null;
    sec.baseline = null;
    return;
  }

  if (!sec.failing) {
    sec.failing = true;
    sec.since = toIso(now);
    sec.baseline = toIso(successMs);
  }
  if (sec.alerted && !isDue(sec.lastAlertAt, LIMITS.BACKUP_REMIND_MS, now)) return;

  const lastSuccess =
    successMs === null ? "No successful backup on record." : `Last successful backup: ${ctx.ago(successMs)}.`;
  const repeat = "You'll hear again in 12 hours if it's still failing, and get a note when a good backup lands.";
  if (problem === "failed") {
    fire(ctx, "backup.failed", "backup failed", "The last backup failed", [
      `backup.json says the attempt at ${ctx.when(attemptMs)} didn't succeed.`,
      lastSuccess,
      RUNBOOK_BACKUPS + " It covers the backup log and running one by hand.",
      repeat,
    ]);
  } else if (problem === "stale") {
    const neverTried = attemptMs === null || now - attemptMs > LIMITS.BACKUP_MAX_AGE_MS;
    fire(ctx, "backup.stale", `no backup for ${formatDuration(now - successMs)}`, "Backups are overdue", [
      `${lastSuccess} They should run at least daily.`,
      neverTried
        ? `Nothing has even been attempted since ${ctx.when(attemptMs)}, so the schedule itself (the systemd timer or cron entry) may have stopped.`
        : `The last attempt was ${ctx.ago(attemptMs)}.`,
      RUNBOOK_BACKUPS,
      repeat,
    ]);
  } else {
    fire(ctx, "backup.none", "no backup on record", "No backup on record", [
      `The status endpoint has reported no successful backup since this watcher started looking (${ctx.when(toMs(sec.noneSince))}).`,
      "Either backups aren't installed yet, or the server can't read backup.json from OPS_STATE_DIR (default /var/lib/divinghq).",
      RUNBOOK_BACKUPS,
      repeat,
    ]);
  }
  sec.alerted = true;
  sec.lastAlertAt = toIso(now);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function checkOffsite(s, st, ctx) {
  const b = st.known ? block(st.body, "backup") : null;
  if (!b) return;
  const sec = s.offsite;
  const now = ctx.now;
  const clearFailed = () => {
    sec.failedSince = null;
    sec.failedAlerted = false;
    sec.failedLastAlertAt = null;
  };

  if (b.offsite === "failed") {
    if (toMs(sec.failedSince) === null) sec.failedSince = toIso(now);
    if (!sec.failedAlerted || isDue(sec.failedLastAlertAt, LIMITS.OFFSITE_FAILED_REMIND_MS, now)) {
      fire(ctx, "offsite.failed", "offsite copy failed", "The offsite backup copy failed", [
        "The latest backup run reports offsite: failed, so right now the only copy is on the box itself.",
        `First seen failing: ${ctx.when(toMs(sec.failedSince))}.`,
        RUNBOOK_BACKUPS,
        "You'll hear again in 12 hours if it's still failing.",
      ]);
      sec.failedAlerted = true;
      sec.failedLastAlertAt = toIso(now);
    }
  } else if (b.offsite === "ok") {
    if (sec.failedAlerted) {
      fire(ctx, "offsite.recovered", "offsite copy OK again", "The offsite backup copy is working again", [
        `The latest backup run (${ctx.ago(toMs(b.last_attempt_at))}) copied off the box fine.`,
      ]);
    }
    clearFailed();
    sec.unconfiguredLastAlertAt = null;
  } else if (b.offsite === "not_configured") {
    // Switching the remote off isn't a recovery, just stop the failed alerts.
    clearFailed();
    if (isDue(sec.unconfiguredLastAlertAt, LIMITS.OFFSITE_UNCONFIGURED_REMIND_MS, now)) {
      fire(ctx, "offsite.not_configured", "offsite backups not set up", "Backups aren't being copied off the box", [
        "backup.json reports offsite: not_configured. If the box or its disk dies, the backups go with it.",
        "Setting up the offsite copy is in ops/backups/README.md.",
        "This reminder repeats weekly until it's configured.",
      ]);
      sec.unconfiguredLastAlertAt = toIso(now);
    }
  }
  // null or anything else: the file didn't say, hold still.
}

function checkRestore(s, st, ctx) {
  const r = st.known ? block(st.body, "restore_check") : null;
  if (!r) return;
  const sec = s.restore;
  const now = ctx.now;
  const runMs = toMs(r.last_run_at);

  if (runMs === null) {
    if (toMs(sec.noneSince) === null) sec.noneSince = toIso(now);
  } else {
    sec.noneSince = null;
  }

  let problem = null;
  if (r.ok === false) problem = "failed";
  else if (runMs === null) {
    if (now - toMs(sec.noneSince) > LIMITS.RESTORE_MAX_AGE_MS) problem = "never";
  } else if (now - runMs > LIMITS.RESTORE_MAX_AGE_MS) problem = "stale";

  if (!problem) {
    // Same idea as backups: the note says it restored cleanly, so it needs
    // a newer run that actually said ok: true, not a file that went
    // missing or an ok that's null.
    if (sec.failing) {
      const base = toMs(sec.baseline);
      const fresh = r.ok === true && runMs !== null && (base === null || runMs > base);
      if (!fresh && sec.alerted) return;
      if (fresh && sec.alerted) {
        fire(ctx, "restore.recovered", "restore check OK again", "The restore check passes again", [
          `Last restore check: ${ctx.ago(runMs)}, and it restored cleanly.`,
        ]);
      }
    }
    sec.failing = false;
    sec.since = null;
    sec.alerted = false;
    sec.lastAlertAt = null;
    sec.baseline = null;
    return;
  }

  if (!sec.failing) {
    sec.failing = true;
    sec.since = toIso(now);
    sec.baseline = toIso(runMs);
  }
  if (sec.alerted && !isDue(sec.lastAlertAt, LIMITS.RESTORE_REMIND_MS, now)) return;

  const repeat = "You'll hear again in 24 hours if nothing changes.";
  if (problem === "failed") {
    fire(ctx, "restore.failed", "restore check failed", "The restore check failed", [
      `The restore check at ${ctx.when(runMs)} couldn't restore the latest backup cleanly. A backup that won't restore isn't a backup.`,
      RUNBOOK_BACKUPS,
      repeat,
    ]);
  } else if (problem === "stale") {
    fire(ctx, "restore.stale", "restore check overdue", "The restore check is overdue", [
      `The last restore check ran ${ctx.ago(runMs)}. It should run weekly.`,
      RUNBOOK_BACKUPS,
      repeat,
    ]);
  } else {
    fire(ctx, "restore.never", "restore check never ran", "No restore check on record", [
      `The status endpoint has reported no restore check since this watcher started looking (${ctx.when(toMs(sec.noneSince))}).`,
      "Either it isn't installed yet, or the server can't read restore-check.json from OPS_STATE_DIR.",
      RUNBOOK_BACKUPS,
      repeat,
    ]);
  }
  sec.alerted = true;
  sec.lastAlertAt = toIso(now);
}

function checkDeploy(s, st, ctx) {
  const d = st.known ? block(st.body, "deploy") : null;
  if (!d || d.ok !== false) return;
  const sha = typeof d.sha === "string" && d.sha ? d.sha : null;
  const key = `${typeof d.last_at === "string" ? d.last_at : ""}|${sha || ""}`;
  if (key === s.deploy.lastAlertedKey) return;
  fire(ctx, "deploy.failed", `deploy failed (${sha || "unknown commit"})`, "A deploy failed", [
    `deploy.json says the deploy of ${sha || "an unknown commit"} at ${ctx.when(toMs(d.last_at))} failed.`,
    "deploy.sh stops before the restart when migrate, the tests or the build fail, so the previous release is probably still serving. If it got as far as the restart and the health check failed, its output has the rollback command.",
    "Check the deploy output and pm2 logs dive-recorder --lines 200 on the box.",
    "You won't hear about this deploy again; the next failed one gets its own email.",
  ]);
  s.deploy.lastAlertedKey = key;
}

function checkErrors(s, st, ctx) {
  const e = st.known ? block(st.body, "errors") : null;
  if (!e) return;
  const errors = count(e.server_errors);
  const requests = count(e.requests);
  if (errors === null || requests === null || requests === 0) return;
  if (errors < LIMITS.ERRORS_MIN) return;
  if (errors * LIMITS.ERRORS_OF < requests * LIMITS.ERRORS_PER) return;
  if (!isDue(s.errors.lastAlertAt, LIMITS.ERRORS_REMIND_MS, ctx.now)) return;
  const windowMin = count(e.window_minutes) || 15;
  const pct = ((errors / requests) * 100).toFixed(1);
  fire(ctx, "errors.spike", `5xx spike: ${errors} of ${requests} requests`, "Lots of server errors", [
    `In the ${windowMin} minutes to ${ctx.when(ctx.now)} the server answered ${errors} of ${requests} requests with a 5xx (${pct}%).`,
    "pm2 logs dive-recorder --lines 300 on the box will have the stack traces. The Grafana dashboard helps too if the observability stack is running.",
    "At most one of these an hour.",
  ]);
  s.errors.lastAlertAt = toIso(ctx.now);
}

function checkBlind(s, health, st, ctx) {
  const sec = s.blind;
  // Status readable, or the whole site down (DOWN has that covered): not blind.
  if (st.known || !health.ok) {
    sec.since = null;
    return;
  }
  if (toMs(sec.since) === null) sec.since = toIso(ctx.now);
  if (ctx.now - toMs(sec.since) < LIMITS.BLIND_AFTER_MS) return;
  if (!isDue(sec.lastAlertAt, LIMITS.BLIND_REMIND_MS, ctx.now)) return;
  fire(ctx, "status.unreachable", "status endpoint unreachable", "Can't read /api/ops/status", [
    `The site is up (health passes) but ${ctx.target}/api/ops/status hasn't answered properly since ${ctx.when(toMs(sec.since))} (latest: ${st.detail}).`,
    "Until it does, the database, backup, restore-check, deploy and error-rate checks can't see anything.",
    "If the server was deployed without that route, this is expected until it ships.",
    "At most one of these a day.",
  ]);
  sec.lastAlertAt = toIso(ctx.now);
}

/**
 * Run every rule once.
 * @param {any} prevState          whatever was in KV (null on the first run)
 * @param {Observations} observations
 * @param {number|Date|string} now
 * @param {{timeZone?: string, target?: string}} [options]
 * @returns {{state: object, alerts: Alert[]}}
 */
export function evaluate(prevState, observations, now, options = {}) {
  const t = toMs(now);
  if (t === null) throw new TypeError("evaluate: now must be a time");
  const tz = options.timeZone || "UTC";
  const obs = isObj(observations) ? observations : {};
  const s = normalizeState(prevState);
  const health = readHealth(obs.health);
  const st = readStatus(obs.status);
  const ctx = {
    now: t,
    target: String(options.target || "https://divinghq.app").replace(/\/+$/, ""),
    alerts: [],
    when: (ms) => formatWhen(ms, tz),
    ago: (ms) => formatAgo(ms, t, tz),
  };

  checkDown(s, health, st, ctx);
  checkDb(s, st, ctx);
  checkDeploy(s, st, ctx);
  checkErrors(s, st, ctx);
  checkBackup(s, st, ctx);
  checkOffsite(s, st, ctx);
  checkRestore(s, st, ctx);
  checkBlind(s, health, st, ctx);

  s.lastRunAt = toIso(t);
  s.last = summarize(health, st.known ? st.body : null, st.detail, t);
  return { state: s, alerts: ctx.alerts };
}

// The part of the state that matters for alerting, i.e. everything but
// the run timestamp and the display summary. watch.js only writes KV when
// this changes (or on a slow heartbeat), which keeps a healthy day to a
// few dozen writes against the free plan's 1,000.
export function significant(state) {
  const s = normalizeState(state);
  delete s.lastRunAt;
  delete s.last;
  return JSON.stringify(s);
}

/**
 * One run's alerts -> one email. Order is the order the rules ran, which
 * puts outages first and backup housekeeping last.
 * @param {Alert[]} alerts
 * @param {{now: number, timeZone?: string, target?: string, stateUrl?: string}} opts
 */
export function composeEmail(alerts, opts) {
  const list = normalizeOutbox(alerts);
  if (!list.length) throw new Error("composeEmail: nothing to send");
  const now = toMs(opts.now);
  const tz = opts.timeZone || "UTC";
  const tags = list.map((a) => a.tag);
  const shown = tags.length > 4 ? [...tags.slice(0, 3), `${tags.length - 3} more`] : tags;
  const subject = `[DivingHQ] ${shown.join(", ")}`;

  const sections = list.map((a) => {
    const lines = [a.title, "", ...a.lines];
    const at = toMs(a.at);
    // Came out of the outbox: say so, or the times in it look wrong.
    if (at !== null && now - at >= 5 * MINUTE) {
      lines.push(`(Raised at ${formatWhen(at, tz)}; the first attempt to email it failed.)`);
    }
    return lines.join("\n");
  });
  const footer = [
    "--",
    `Sent by the divinghq-watch Worker, checking ${opts.target || "https://divinghq.app"} every 2 minutes (ops/watch in the repo).`,
    `This email: ${formatWhen(now, tz)}.`,
    "To pause or retarget it, see ops/watch/README.md.",
  ];
  const text = [...sections.flatMap((sec, i) => (i ? ["", "", sec] : [sec])), "", "", ...footer].join("\n") + "\n";
  return { subject, text };
}

// What GET /test-alert sends.
export function testAlert(now, target) {
  return {
    id: "test",
    tag: "test alert",
    title: "Test alert",
    lines: [
      "This is a test from the divinghq-watch Worker, sent because someone opened /test-alert with the right key.",
      `If you're reading it, alerts reach you. It's watching ${target || "https://divinghq.app"}.`,
    ],
    at: toIso(toMs(now)),
  };
}
