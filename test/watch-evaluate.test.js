// The watch Worker's alert rules (ops/watch/src/evaluate.js) and its MIME
// builder (ops/watch/src/mime.js). DB-less, runs in test:safe.
//
// The Worker is plain ESM with no dependencies, so these import it
// straight from Node. Every run round-trips the state through JSON the way
// KV would, so a rule that only works on live objects (a Date in the
// state, say) fails here rather than on the first real outage.
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");

let evaluate, normalizeState, isDue, composeEmail, testAlert, LIMITS;
let formatDuration, formatWhen;
let buildMime, encodeHeader, formatMailbox, formatRfc5322Date;

before(async () => {
  ({ evaluate, normalizeState, isDue, composeEmail, testAlert, LIMITS } = await import(
    "../ops/watch/src/evaluate.js"
  ));
  ({ formatDuration, formatWhen } = await import("../ops/watch/src/format.js"));
  ({ buildMime, encodeHeader, formatMailbox, formatRfc5322Date } = await import("../ops/watch/src/mime.js"));
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RUN = 2 * MIN;
const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

// ---- observation builders -------------------------------------------------

const healthy = () => ({ httpStatus: 200, body: { ok: true, schema_version: 99 }, error: null });
const healthHttp = (code, body = null) => ({ httpStatus: code, body, error: null });
const timedOut = () => ({ httpStatus: null, body: null, error: "timed out after 10 s" });

// A status body where everything is fine as of `now`. `over` replaces
// whole blocks or top-level fields.
function statusBody(now, over = {}) {
  return {
    ok: true,
    schema_version: 99,
    time: iso(now),
    backup: {
      last_attempt_at: iso(now - 2 * HOUR),
      last_success_at: iso(now - 2 * HOUR),
      last_ok: true,
      offsite: "ok",
      size_bytes: 52_428_800,
    },
    restore_check: { last_run_at: iso(now - DAY), ok: true },
    deploy: { last_at: iso(now - 3 * DAY), ok: true, sha: "5323566" },
    errors: { window_minutes: 15, server_errors: 0, requests: 300 },
    ...over,
  };
}
const status = (now, over) => ({ httpStatus: 200, body: statusBody(now, over), error: null });
const statusGone = () => ({ httpStatus: null, body: null, error: "timed out after 10 s" });

// Drives evaluate() through a sequence of runs, keeping state the way KV
// would (JSON in, JSON out).
function watcher(start = T0) {
  let state = null;
  let now = start;
  return {
    get now() {
      return now;
    },
    get state() {
      return state;
    },
    set state(s) {
      state = s;
    },
    // obs: { health, status } or a function of now returning that.
    run(obs, { at, timeZone } = {}) {
      if (at !== undefined) now = at;
      const o = typeof obs === "function" ? obs(now) : obs;
      const r = evaluate(state, o, now, { timeZone, target: "https://divinghq.app" });
      state = JSON.parse(JSON.stringify(r.state));
      return r.alerts;
    },
    tick(obs, ms = RUN) {
      now += ms;
      return this.run(obs);
    },
  };
}
const ids = (alerts) => alerts.map((a) => a.id);
const allOk = (now) => ({ health: healthy(), status: status(now) });
const siteDown = () => ({ health: healthHttp(530), status: statusGone() });

// ---- DOWN -----------------------------------------------------------------

describe("DOWN", () => {
  test("one failed check is a blip, the second in a row alerts", () => {
    const w = watcher();
    assert.deepEqual(ids(w.run(allOk)), []);
    assert.deepEqual(ids(w.tick(siteDown)), []);
    assert.equal(w.state.down.fails, 1);
    const alerts = w.tick(siteDown);
    assert.deepEqual(ids(alerts), ["down"]);
    assert.equal(alerts[0].tag, "DOWN");
    assert.equal(alerts[0].title, "DivingHQ is down");
    assert.match(alerts[0].lines.join("\n"), /530/);
    assert.match(alerts[0].lines.join("\n"), /pm2 logs dive-recorder/);
    // And only once.
    assert.deepEqual(ids(w.tick(siteDown)), []);
  });

  test("a pass between two failures resets the debounce", () => {
    const w = watcher();
    w.run(siteDown);
    w.tick(allOk);
    assert.deepEqual(ids(w.tick(siteDown)), []);
    assert.deepEqual(ids(w.tick(allOk)), []);
    assert.equal(w.state.down.fails, 0);
    assert.equal(w.state.down.since, null);
  });

  test("timeouts, non-200s, ok:false, junk bodies and redirects all count as down", () => {
    const cases = [
      timedOut(),
      { httpStatus: null, body: null, error: "network error" },
      healthHttp(503, { ok: false }),
      healthHttp(200, { ok: false }),
      healthHttp(200, null),
      healthHttp(200, { ok: "true" }),
      healthHttp(302),
    ];
    for (const health of cases) {
      const w = watcher();
      w.run({ health, status: statusGone() });
      assert.deepEqual(ids(w.tick({ health, status: statusGone() })), ["down"], JSON.stringify(health));
    }
  });

  test("the alert says what the status endpoint knows", () => {
    const w = watcher();
    const dbDown = (now) => ({ health: healthHttp(503, { ok: false }), status: status(now, { ok: false }) });
    w.run(dbDown);
    const text = w.tick(dbDown)[0].lines.join("\n");
    assert.match(text, /database query fails/);
    assert.match(text, /start with Postgres/);

    const w2 = watcher();
    w2.run(siteDown);
    assert.match(w2.tick(siteDown)[0].lines.join("\n"), /didn't answer either/);
  });

  test("reminds every 60 minutes while down, not before", () => {
    const w = watcher();
    w.run(siteDown);
    assert.deepEqual(ids(w.tick(siteDown)), ["down"]);
    const alertedAt = w.now;
    const seen = [];
    // Runs every 2 minutes for three hours.
    while (w.now < alertedAt + 3 * HOUR) {
      for (const a of w.tick(siteDown)) seen.push({ id: a.id, after: w.now - alertedAt, tag: a.tag });
    }
    assert.deepEqual(
      seen.map((s) => [s.id, s.after]),
      [
        ["down.reminder", 60 * MIN],
        ["down.reminder", 120 * MIN],
        ["down.reminder", 180 * MIN],
      ],
    );
    // Down since the first failed check, 2 minutes before the alert.
    assert.equal(seen[0].tag, "still DOWN (1 h 2 min)");
  });

  test("a reminder waits for the full hour when the cron runs a little early", () => {
    const w = watcher();
    w.run(siteDown);
    w.tick(siteDown);
    const alertedAt = w.now;
    assert.deepEqual(ids(w.run(siteDown, { at: alertedAt + 60 * MIN - 1 })), []);
    assert.deepEqual(ids(w.run(siteDown, { at: alertedAt + 60 * MIN })), ["down.reminder"]);
  });

  test("back up: one note with the outage length, then quiet", () => {
    const w = watcher();
    w.run(siteDown); // first failed check at T0
    w.tick(siteDown);
    for (let i = 0; i < 4; i++) w.tick(siteDown);
    const alerts = w.run(allOk, { at: T0 + 12 * MIN });
    assert.deepEqual(ids(alerts), ["down.recovered"]);
    assert.equal(alerts[0].tag, "back up after 12 min");
    assert.equal(alerts[0].title, "DivingHQ is back up");
    assert.deepEqual(ids(w.tick(allOk)), []);
    assert.deepEqual(w.state.down, { fails: 0, since: null, alerted: false, lastAlertAt: null });
  });

  test("no recovery note for a blip nobody was told about", () => {
    const w = watcher();
    w.run(siteDown);
    assert.deepEqual(ids(w.tick(allOk)), []);
  });

  test("long outages read in hours and days", () => {
    const w = watcher();
    w.run(siteDown);
    w.tick(siteDown);
    assert.equal(w.run(allOk, { at: T0 + 2 * DAY + 3 * HOUR + 20 * MIN })[0].tag, "back up after 2 d 3 h");
  });

  test("a second outage after recovery alerts again", () => {
    const w = watcher();
    w.run(siteDown);
    w.tick(siteDown);
    w.tick(allOk);
    w.tick(siteDown);
    assert.deepEqual(ids(w.tick(siteDown)), ["down"]);
  });
});

// ---- DB -------------------------------------------------------------------

describe("DB", () => {
  const dbFalse = (now) => ({ health: healthy(), status: status(now, { ok: false }) });

  test("status ok:false on two runs alerts, reminds hourly, notes recovery", () => {
    const w = watcher();
    assert.deepEqual(ids(w.run(dbFalse)), []);
    const first = w.tick(dbFalse);
    assert.deepEqual(ids(first), ["db"]);
    assert.equal(first[0].tag, "database down");
    const alertedAt = w.now;
    assert.deepEqual(ids(w.run(dbFalse, { at: alertedAt + 58 * MIN })), []);
    assert.deepEqual(ids(w.run(dbFalse, { at: alertedAt + 60 * MIN })), ["db.reminder"]);
    const back = w.run(allOk, { at: T0 + 70 * MIN });
    assert.deepEqual(ids(back), ["db.recovered"]);
    assert.equal(back[0].tag, "database back after 1 h 10 min");
  });

  test("an unreadable status neither extends nor breaks the streak", () => {
    const w = watcher();
    w.run(dbFalse);
    assert.deepEqual(ids(w.tick({ health: healthy(), status: statusGone() })), []);
    assert.equal(w.state.db.fails, 1);
    assert.deepEqual(ids(w.tick(dbFalse)), ["db"]);
  });

  test("a database outage trips DOWN and DB in the same run, folded into one email", () => {
    const w = watcher();
    const out = (now) => ({ health: healthHttp(503, { ok: false }), status: status(now, { ok: false }) });
    w.run(out);
    const alerts = w.tick(out);
    assert.deepEqual(ids(alerts), ["down", "db"]);
    const mail = composeEmail(alerts, { now: w.now, target: "https://divinghq.app" });
    assert.equal(mail.subject, "[DivingHQ] DOWN, database down");
    // Recovery lands together too.
    assert.deepEqual(ids(w.tick(allOk)), ["down.recovered", "db.recovered"]);
  });
});

// ---- BACKUP ---------------------------------------------------------------

describe("BACKUP", () => {
  const withBackup = (fn) => (now) => ({ health: healthy(), status: status(now, { backup: fn(now) }) });
  const failed = withBackup((now) => ({
    last_attempt_at: iso(now - 10 * MIN),
    last_success_at: iso(now - 20 * HOUR),
    last_ok: false,
    offsite: "ok",
    size_bytes: null,
  }));

  test("a failed backup alerts at once, then at most every 12 hours", () => {
    const w = watcher();
    const first = w.run(failed);
    assert.deepEqual(ids(first), ["backup.failed"]);
    assert.equal(first[0].tag, "backup failed");
    assert.match(first[0].lines.join("\n"), /ops\/backups\/README\.md/);
    assert.deepEqual(ids(w.tick(failed)), []);
    assert.deepEqual(ids(w.run(failed, { at: T0 + 12 * HOUR - 1 })), []);
    assert.deepEqual(ids(w.run(failed, { at: T0 + 12 * HOUR })), ["backup.failed"]);
  });

  test("26 hours without a success is fine, a millisecond more is overdue", () => {
    const at = (age) => withBackup((now) => ({ ...statusBody(now).backup, last_success_at: iso(now - age) }));
    assert.deepEqual(ids(watcher().run(at(26 * HOUR))), []);
    const alerts = watcher().run(at(26 * HOUR + 1));
    assert.deepEqual(ids(alerts), ["backup.stale"]);
    assert.equal(alerts[0].tag, "no backup for 26 h");
  });

  test("an overdue backup with no recent attempt blames the schedule", () => {
    const stuck = withBackup((now) => ({
      ...statusBody(now).backup,
      last_attempt_at: iso(now - 30 * HOUR),
      last_success_at: iso(now - 30 * HOUR),
    }));
    assert.match(watcher().run(stuck)[0].lines.join("\n"), /schedule itself/);
  });

  test("a fresh success after an alert sends one recovery note", () => {
    const w = watcher();
    w.run(failed);
    const alerts = w.tick(allOk);
    assert.deepEqual(ids(alerts), ["backup.recovered"]);
    assert.equal(alerts[0].tag, "backups OK again");
    assert.match(alerts[0].lines.join("\n"), /50\.0 MB/);
    assert.deepEqual(ids(w.tick(allOk)), []);
  });

  test("no backup on record gets 26 hours of grace from when the watcher first saw it", () => {
    const none = withBackup(() => ({
      last_attempt_at: null,
      last_success_at: null,
      last_ok: null,
      offsite: null,
      size_bytes: null,
    }));
    const w = watcher();
    assert.deepEqual(ids(w.run(none)), []);
    assert.equal(w.state.backup.noneSince, iso(T0));
    assert.deepEqual(ids(w.run(none, { at: T0 + 26 * HOUR })), []);
    const alerts = w.run(none, { at: T0 + 26 * HOUR + RUN });
    assert.deepEqual(ids(alerts), ["backup.none"]);
    assert.match(alerts[0].lines.join("\n"), /OPS_STATE_DIR/);
  });

  test("the first backup landing inside the grace period is silent", () => {
    const none = withBackup(() => ({
      last_attempt_at: null,
      last_success_at: null,
      last_ok: null,
      offsite: null,
      size_bytes: null,
    }));
    const w = watcher();
    w.run(none);
    assert.deepEqual(ids(w.run(allOk, { at: T0 + 20 * HOUR })), []);
    assert.equal(w.state.backup.noneSince, null);
  });

  test("a failure with nothing ever successful says so", () => {
    const f = withBackup((now) => ({
      last_attempt_at: iso(now),
      last_success_at: null,
      last_ok: false,
      offsite: null,
      size_bytes: null,
    }));
    assert.match(watcher().run(f)[0].lines.join("\n"), /No successful backup on record/);
  });

  test("a success stamped slightly in the future (server clock ahead) is fresh", () => {
    const ahead = withBackup((now) => ({ ...statusBody(now).backup, last_success_at: iso(now + 5 * MIN) }));
    assert.deepEqual(ids(watcher().run(ahead)), []);
  });

  // Fixed timestamps from here on, the way a real backup.json holds still
  // between runs.
  const lastGood = iso(T0 - 20 * HOUR);
  const fixedFail = withBackup(() => ({
    last_attempt_at: iso(T0 - 10 * MIN),
    last_success_at: lastGood,
    last_ok: false,
    offsite: "ok",
    size_bytes: null,
  }));
  const unreadable = withBackup(() => ({
    last_attempt_at: null,
    last_success_at: null,
    last_ok: null,
    offsite: null,
    size_bytes: null,
  }));

  test("backup.json going unreadable after a failure isn't a recovery", () => {
    const w = watcher();
    assert.deepEqual(ids(w.run(fixedFail)), ["backup.failed"]);
    // Every field null clears the rule on paper (no failure, "never" still
    // inside its grace), but nothing worked, so no "working again".
    for (let i = 0; i < 5; i++) assert.deepEqual(ids(w.tick(unreadable)), []);
    assert.equal(w.state.backup.alerted, true);
    // Still nothing a day on: the "none" alert is due (26 h since first
    // seen null, 12 h since the last email) and says so.
    assert.deepEqual(ids(w.run(unreadable, { at: T0 + 27 * HOUR })), ["backup.none"]);
    // A real success after all that is the recovery.
    const back = w.tick(allOk);
    assert.deepEqual(ids(back), ["backup.recovered"]);
    assert.doesNotMatch(back[0].lines.join("\n"), /never/);
  });

  test("last_ok dropping to null over the same old success isn't a recovery either", () => {
    const w = watcher();
    w.run(fixedFail);
    const inFlight = withBackup(() => ({
      last_attempt_at: iso(T0 + HOUR),
      last_success_at: lastGood,
      last_ok: null,
      offsite: "ok",
      size_bytes: null,
    }));
    assert.deepEqual(ids(w.run(inFlight, { at: T0 + HOUR })), []);
    // And failing again inside the 12 hours stays throttled, no fresh alert.
    assert.deepEqual(ids(w.run(fixedFail, { at: T0 + 2 * HOUR })), []);
    assert.deepEqual(ids(w.run(fixedFail, { at: T0 + 12 * HOUR })), ["backup.failed"]);
  });

  test("a newer success ends it even when the old one was never", () => {
    const w = watcher();
    const neverOk = withBackup(() => ({
      last_attempt_at: iso(T0),
      last_success_at: null,
      last_ok: false,
      offsite: null,
      size_bytes: null,
    }));
    assert.deepEqual(ids(w.run(neverOk)), ["backup.failed"]);
    assert.deepEqual(ids(w.tick(allOk)), ["backup.recovered"]);
    assert.equal(w.state.backup.baseline, null);
  });
});

// ---- OFFSITE --------------------------------------------------------------

describe("OFFSITE", () => {
  const offsite = (value) => (now) => ({
    health: healthy(),
    status: status(now, { backup: { ...statusBody(now).backup, offsite: value } }),
  });

  test("'failed' alerts at most every 12 hours and notes recovery", () => {
    const w = watcher();
    const first = w.run(offsite("failed"));
    assert.deepEqual(ids(first), ["offsite.failed"]);
    assert.equal(first[0].tag, "offsite copy failed");
    assert.deepEqual(ids(w.run(offsite("failed"), { at: T0 + 12 * HOUR - 1 })), []);
    assert.deepEqual(ids(w.run(offsite("failed"), { at: T0 + 12 * HOUR })), ["offsite.failed"]);
    assert.deepEqual(ids(w.tick(offsite("ok"))), ["offsite.recovered"]);
    assert.deepEqual(ids(w.tick(offsite("ok"))), []);
  });

  test("'not_configured' is a weekly reminder", () => {
    const w = watcher();
    const first = w.run(offsite("not_configured"));
    assert.deepEqual(ids(first), ["offsite.not_configured"]);
    assert.equal(first[0].tag, "offsite backups not set up");
    assert.deepEqual(ids(w.run(offsite("not_configured"), { at: T0 + 7 * DAY - 1 })), []);
    assert.deepEqual(ids(w.run(offsite("not_configured"), { at: T0 + 7 * DAY })), ["offsite.not_configured"]);
  });

  test("going from failed to not_configured stops the failed alerts without a recovery note", () => {
    const w = watcher();
    w.run(offsite("failed"));
    assert.deepEqual(ids(w.tick(offsite("not_configured"))), ["offsite.not_configured"]);
    assert.equal(w.state.offsite.failedAlerted, false);
  });

  test("null says nothing", () => {
    const w = watcher();
    assert.deepEqual(ids(w.run(offsite(null))), []);
  });
});

// ---- RESTORE CHECK --------------------------------------------------------

describe("RESTORE CHECK", () => {
  const restore = (fn) => (now) => ({ health: healthy(), status: status(now, { restore_check: fn(now) }) });

  test("ok:false alerts at most daily and notes recovery", () => {
    const w = watcher();
    const bad = restore((now) => ({ last_run_at: iso(now - HOUR), ok: false }));
    const first = w.run(bad);
    assert.deepEqual(ids(first), ["restore.failed"]);
    assert.equal(first[0].tag, "restore check failed");
    assert.deepEqual(ids(w.run(bad, { at: T0 + 24 * HOUR - 1 })), []);
    assert.deepEqual(ids(w.run(bad, { at: T0 + 24 * HOUR })), ["restore.failed"]);
    assert.deepEqual(ids(w.tick(allOk)), ["restore.recovered"]);
  });

  test("8 days since the last run is fine, a millisecond more is overdue", () => {
    const age = (ms) => restore((now) => ({ last_run_at: iso(now - ms), ok: true }));
    assert.deepEqual(ids(watcher().run(age(8 * DAY))), []);
    const alerts = watcher().run(age(8 * DAY + 1));
    assert.deepEqual(ids(alerts), ["restore.stale"]);
    assert.equal(alerts[0].tag, "restore check overdue");
  });

  test("never run gets 8 days of grace from first sight", () => {
    const never = restore(() => ({ last_run_at: null, ok: null }));
    const w = watcher();
    assert.deepEqual(ids(w.run(never)), []);
    assert.deepEqual(ids(w.run(never, { at: T0 + 8 * DAY })), []);
    assert.deepEqual(ids(w.run(never, { at: T0 + 8 * DAY + RUN })), ["restore.never"]);
  });

  test("'restored cleanly' needs a newer run that said ok: true", () => {
    const w = watcher();
    const failedRun = iso(T0 - HOUR);
    assert.deepEqual(ids(w.run(restore(() => ({ last_run_at: failedRun, ok: false })))), ["restore.failed"]);
    // restore-check.json unreadable: not a pass.
    assert.deepEqual(ids(w.tick(restore(() => ({ last_run_at: null, ok: null })))), []);
    // A newer run that hasn't said how it went: not a pass either.
    assert.deepEqual(ids(w.tick(restore((now) => ({ last_run_at: iso(now), ok: null })))), []);
    assert.equal(w.state.restore.alerted, true);
    const back = w.tick(restore((now) => ({ last_run_at: iso(now), ok: true })));
    assert.deepEqual(ids(back), ["restore.recovered"]);
    assert.match(back[0].lines.join("\n"), /restored cleanly/);
    assert.deepEqual(ids(w.tick(allOk)), []);
  });
});

// ---- DEPLOY ---------------------------------------------------------------

describe("DEPLOY", () => {
  const deploy = (d) => (now) => ({ health: healthy(), status: status(now, { deploy: d }) });

  test("one alert per failed (last_at, sha)", () => {
    const w = watcher();
    const bad = deploy({ last_at: iso(T0 - 5 * MIN), ok: false, sha: "abc1234" });
    const first = w.run(bad);
    assert.deepEqual(ids(first), ["deploy.failed"]);
    assert.equal(first[0].tag, "deploy failed (abc1234)");
    assert.match(first[0].lines.join("\n"), /pm2 logs dive-recorder/);
    for (let i = 0; i < 50; i++) assert.deepEqual(ids(w.tick(bad)), []);
    // Same sha retried later is a different deploy.
    assert.deepEqual(ids(w.tick(deploy({ last_at: iso(T0 + HOUR), ok: false, sha: "abc1234" }))), [
      "deploy.failed",
    ]);
    assert.deepEqual(ids(w.tick(deploy({ last_at: iso(T0 + 2 * HOUR), ok: true, sha: "def5678" }))), []);
  });

  test("a failed deploy with no sha still alerts once", () => {
    const w = watcher();
    const bad = deploy({ last_at: iso(T0), ok: false, sha: null });
    assert.equal(w.run(bad)[0].tag, "deploy failed (unknown commit)");
    assert.deepEqual(ids(w.tick(bad)), []);
  });

  test("ok null (no deploy.json) says nothing", () => {
    assert.deepEqual(ids(watcher().run(deploy({ last_at: null, ok: null, sha: null }))), []);
  });
});

// ---- ERRORS ---------------------------------------------------------------

describe("ERRORS", () => {
  const errs = (server_errors, requests) => (now) => ({
    health: healthy(),
    status: status(now, { errors: { window_minutes: 15, server_errors, requests } }),
  });

  test("needs at least 20 errors and at least 5% of requests", () => {
    assert.deepEqual(ids(watcher().run(errs(19, 100))), []);
    assert.deepEqual(ids(watcher().run(errs(20, 401))), []);
    const alerts = watcher().run(errs(20, 400));
    assert.deepEqual(ids(alerts), ["errors.spike"]);
    assert.equal(alerts[0].tag, "5xx spike: 20 of 400 requests");
    assert.match(alerts[0].lines.join("\n"), /\(5\.0%\)/);
  });

  test("at most once an hour", () => {
    const w = watcher();
    w.run(errs(50, 100));
    assert.deepEqual(ids(w.run(errs(50, 100), { at: T0 + 60 * MIN - 1 })), []);
    assert.deepEqual(ids(w.run(errs(50, 100), { at: T0 + 60 * MIN })), ["errors.spike"]);
  });

  test("zero requests and junk counts are ignored", () => {
    for (const [e, r] of [
      [0, 0],
      [25, 0],
      ["25", 100],
      [25.5, 100],
      [-1, 100],
      [null, null],
    ]) {
      assert.deepEqual(ids(watcher().run(errs(e, r))), [], `${e}/${r}`);
    }
  });
});

// ---- unknown status -------------------------------------------------------

describe("unknown status", () => {
  test("health fine but status unreachable: the status rules hold still", () => {
    const w = watcher();
    // Put every status rule into an alerting state first.
    const everythingWrong = (now) => ({
      health: healthy(),
      status: status(now, {
        ok: false,
        backup: { ...statusBody(now).backup, last_ok: false, offsite: "failed" },
        restore_check: { last_run_at: iso(now), ok: false },
      }),
    });
    w.run(everythingWrong);
    w.tick(everythingWrong);
    const before = JSON.parse(JSON.stringify(w.state));
    assert.equal(before.db.alerted, true);
    assert.equal(before.backup.alerted, true);

    for (const bad of [
      statusGone(),
      { httpStatus: 404, body: { error: "not found" }, error: null },
      { httpStatus: 200, body: null, error: null },
      { httpStatus: 200, body: { ok: "yes" }, error: null },
      { httpStatus: 200, body: [1, 2], error: null },
    ]) {
      assert.deepEqual(ids(w.tick({ health: healthy(), status: bad })), [], JSON.stringify(bad));
    }
    for (const k of ["down", "db", "backup", "offsite", "restore", "deploy", "errors"]) {
      assert.deepEqual(w.state[k], before[k], k);
    }
  });

  test("a status body missing one block holds just that check", () => {
    const w = watcher();
    const noBackup = (now) => {
      const body = statusBody(now, { deploy: { last_at: iso(now), ok: false, sha: "abc1234" } });
      delete body.backup;
      return { health: healthy(), status: { httpStatus: 200, body, error: null } };
    };
    assert.deepEqual(ids(w.run(noBackup)), ["deploy.failed"]);
    assert.equal(w.state.backup.noneSince, null);
  });

  test("after an hour of it with the site up, one note a day", () => {
    const w = watcher();
    const blind = () => ({ health: healthy(), status: statusGone() });
    w.run(blind);
    assert.deepEqual(ids(w.run(blind, { at: T0 + 60 * MIN - 1 })), []);
    const alerts = w.run(blind, { at: T0 + 60 * MIN });
    assert.deepEqual(ids(alerts), ["status.unreachable"]);
    assert.match(alerts[0].lines.join("\n"), /timed out after 10 s/);
    const sentAt = w.now;
    assert.deepEqual(ids(w.run(blind, { at: sentAt + 24 * HOUR - 1 })), []);
    assert.deepEqual(ids(w.run(blind, { at: sentAt + 24 * HOUR })), ["status.unreachable"]);
  });

  test("the hour restarts when status answers, and doesn't run while the site is down", () => {
    const w = watcher();
    const blind = () => ({ health: healthy(), status: statusGone() });
    w.run(blind);
    w.run(allOk, { at: T0 + 50 * MIN });
    w.run(blind, { at: T0 + 52 * MIN });
    assert.deepEqual(ids(w.run(blind, { at: T0 + 70 * MIN })), []);

    const w2 = watcher();
    w2.run(siteDown);
    for (let i = 0; i < 40; i++) {
      assert.ok(!ids(w2.tick(siteDown)).includes("status.unreachable"));
    }
    assert.equal(w2.state.blind.since, null);
  });
});

// ---- clock edges and bad state ---------------------------------------------

describe("clock edges and stored state", () => {
  test("isDue: exactly the interval is due, a millisecond short isn't", () => {
    assert.equal(isDue(null, HOUR, T0), true);
    assert.equal(isDue(iso(T0 - HOUR), HOUR, T0), true);
    assert.equal(isDue(iso(T0 - HOUR + 1), HOUR, T0), false);
    assert.equal(isDue("not a date", HOUR, T0), true);
  });

  test("a stored timestamp from the future is junk past the skew allowance, trusted inside it", () => {
    assert.equal(isDue(iso(T0 + LIMITS.FUTURE_SKEW_MS + 1), HOUR, T0), true);
    assert.equal(isDue(iso(T0 + 5 * MIN), HOUR, T0), false);

    // A reminder isn't held back for a day by a lastAlertAt from tomorrow.
    const w = watcher();
    w.run(siteDown);
    w.tick(siteDown);
    w.state = { ...w.state, down: { ...w.state.down, lastAlertAt: iso(T0 + DAY) } };
    assert.deepEqual(ids(w.tick(siteDown)), ["down.reminder"]);
  });

  test("garbage in KV starts fresh instead of throwing", () => {
    for (const junk of [
      null,
      undefined,
      "state",
      42,
      [],
      { version: 999, down: { fails: 5 } },
      { version: 1, down: "yes", db: { fails: -3, alerted: "true", since: 17 }, outbox: "no" },
      { version: 1, down: { fails: 99, since: "2026-09-29T09:58:00.000Z", alerted: false, lastAlertAt: null } },
    ]) {
      const r = evaluate(junk, allOk(T0), T0);
      assert.equal(r.state.version, 1);
      assert.equal(r.state.down.fails, 0);
      assert.equal(r.state.db.fails, 0);
      assert.deepEqual(r.state.outbox, []);
    }
    // An over-large streak is clamped, so one more failure alerts rather
    // than being lost.
    const clamped = normalizeState({ version: 1, down: { fails: 99, since: iso(T0), alerted: false } });
    assert.equal(clamped.down.fails, LIMITS.DEBOUNCE_RUNS);
  });

  test("prevState is never mutated", () => {
    const w = watcher();
    w.run(siteDown);
    const prev = JSON.parse(JSON.stringify(w.state));
    const frozen = JSON.parse(JSON.stringify(prev));
    evaluate(prev, siteDown(), T0 + RUN);
    assert.deepEqual(prev, frozen);
  });

  test("now must be a real time", () => {
    assert.throws(() => evaluate(null, allOk(T0), "yesterday"), TypeError);
    assert.throws(() => evaluate(null, allOk(T0), NaN), TypeError);
    // A Date and an ISO string work as well as a number.
    assert.doesNotThrow(() => evaluate(null, allOk(T0), new Date(T0)));
    assert.doesNotThrow(() => evaluate(null, allOk(T0), iso(T0)));
  });

  test("missing observations read as down and unknown, not a crash", () => {
    const r = evaluate(null, undefined, T0);
    assert.deepEqual(r.alerts, []);
    assert.equal(r.state.down.fails, 1);
    assert.deepEqual(r.state.last.status, { unknown: "no result" });
  });

  test("the display summary only keeps the contract's fields", () => {
    const body = statusBody(T0, { hostname: "box.internal", secret: "x" });
    body.backup.path = "/var/lib/divinghq/backups";
    const r = evaluate(null, { health: healthy(), status: { httpStatus: 200, body, error: null } }, T0);
    const s = JSON.stringify(r.state.last);
    assert.doesNotMatch(s, /box\.internal|secret|\/var\/lib/);
    assert.equal(r.state.last.status.backup.last_ok, true);
  });
});

// ---- formatting -----------------------------------------------------------

describe("formatting", () => {
  test("durations", () => {
    assert.equal(formatDuration(0), "1 min");
    assert.equal(formatDuration(-5), "1 min");
    assert.equal(formatDuration(NaN), "1 min");
    assert.equal(formatDuration(59 * MIN + 20_000), "59 min");
    assert.equal(formatDuration(60 * MIN), "1 h");
    assert.equal(formatDuration(125 * MIN), "2 h 5 min");
    assert.equal(formatDuration(47 * HOUR + 59 * MIN), "47 h 59 min");
    assert.equal(formatDuration(48 * HOUR), "2 d");
    assert.equal(formatDuration(50 * HOUR), "2 d 2 h");
  });

  test("times: local zone first with UTC after, across a DST change", () => {
    assert.equal(formatWhen(T0), "Tue 29 Sep 2026, 10:00 UTC");
    assert.equal(formatWhen(T0, "Australia/Sydney"), "Tue 29 Sep 2026, 20:00 AEST (10:00 UTC)");
    // Sydney moves to daylight time on the first Sunday of October.
    assert.equal(
      formatWhen(Date.parse("2026-10-05T10:00:00Z"), "Australia/Sydney"),
      "Mon 5 Oct 2026, 21:00 AEDT (10:00 UTC)",
    );
    assert.equal(formatWhen(null), "unknown");
    // A typo in TIME_ZONE falls back to UTC instead of killing the run.
    assert.equal(formatWhen(T0, "Mars/Olympus"), "Tue 29 Sep 2026, 10:00 UTC");
  });
});

// ---- composing the email ----------------------------------------------------

describe("composeEmail", () => {
  test("one alert: its tag is the subject, and the body says what to check", () => {
    const w = watcher();
    w.run(siteDown);
    const mail = composeEmail(w.tick(siteDown), { now: w.now, target: "https://divinghq.app" });
    assert.equal(mail.subject, "[DivingHQ] DOWN");
    assert.match(mail.text, /^DivingHQ is down\n/);
    assert.match(mail.text, /ops\/watch\/README\.md/);
    assert.ok(mail.text.endsWith("\n"));
  });

  test("more than four alerts collapse the subject", () => {
    const at = iso(T0);
    const list = ["a", "b", "c", "d", "e"].map((x) => ({ id: x, tag: x, title: x, lines: [], at }));
    assert.equal(composeEmail(list, { now: T0 }).subject, "[DivingHQ] a, b, c, 2 more");
    assert.equal(composeEmail(list.slice(0, 4), { now: T0 }).subject, "[DivingHQ] a, b, c, d");
  });

  test("an alert that waited in the outbox says when it was raised", () => {
    const old = { id: "down", tag: "DOWN", title: "DivingHQ is down", lines: [], at: iso(T0) };
    assert.match(composeEmail([old], { now: T0 + 4 * MIN }).text, /^(?![\s\S]*first attempt)/);
    assert.match(composeEmail([old], { now: T0 + 5 * MIN }).text, /first attempt to email it failed/);
  });

  test("nothing to send is a bug, not an empty email", () => {
    assert.throws(() => composeEmail([], { now: T0 }));
  });

  test("the test alert composes like any other", () => {
    assert.equal(composeEmail([testAlert(T0)], { now: T0 }).subject, "[DivingHQ] test alert");
  });
});

// ---- MIME -----------------------------------------------------------------

function splitMessage(raw) {
  const cut = raw.indexOf("\r\n\r\n");
  assert.ok(cut > 0, "headers and body are separated by a blank line");
  const head = raw.slice(0, cut);
  const body = raw.slice(cut + 4);
  // Unfold: a CRLF followed by whitespace continues the previous header.
  const fields = head
    .split(/\r\n(?![ \t])/)
    .map((f) => {
      const i = f.indexOf(":");
      return { name: f.slice(0, i), value: f.slice(i + 1).replace(/\r\n[ \t]/g, " ").trim(), raw: f };
    });
  return { head, body, fields };
}

function decodeWords(v) {
  // Whitespace between adjacent encoded-words is dropped when decoding.
  return v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g, (_, b64) => `\u0000${b64}\u0000`)
    .split("\u0000")
    .reduce(
      (acc, part, i) => {
        if (i % 2) acc.bytes.push(...Buffer.from(part, "base64"));
        else {
          acc.text += Buffer.from(acc.bytes).toString("utf8") + part;
          acc.bytes = [];
        }
        return acc;
      },
      { text: "", bytes: [] },
    ).text;
}

const baseMessage = () => ({
  from: "alerts@divinghq.app",
  fromName: "DivingHQ watch",
  to: "someone@example.com",
  subject: "[DivingHQ] DOWN",
  text: "DivingHQ is down\n\nFirst failed check: 10:00 UTC.\n",
  date: new Date(T0),
});

describe("MIME builder", () => {
  test("CRLF everywhere, never a bare LF or CR", () => {
    const raw = buildMime({ ...baseMessage(), text: "one\ntwo\r\nthree\rfour\n\n" });
    assert.doesNotMatch(raw, /[^\r]\n/, "no bare LF");
    assert.doesNotMatch(raw, /\r(?!\n)/, "no bare CR");
    assert.ok(raw.endsWith("\r\n"));
    assert.match(raw, /\r\n\r\none\r\ntwo\r\nthree\r\nfour\r\n\r\n$/);
  });

  test("the headers the task asks for, each exactly once", () => {
    const { fields } = splitMessage(buildMime(baseMessage()));
    const by = (n) => fields.filter((f) => f.name.toLowerCase() === n.toLowerCase());
    for (const name of ["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type"]) {
      assert.equal(by(name).length, 1, name);
    }
    assert.equal(by("From")[0].value, '"DivingHQ watch" <alerts@divinghq.app>');
    assert.equal(by("To")[0].value, "someone@example.com");
    assert.equal(by("Subject")[0].value, "[DivingHQ] DOWN");
    assert.equal(by("Date")[0].value, "Tue, 29 Sep 2026 10:00:00 +0000");
    assert.equal(Date.parse(by("Date")[0].value), T0);
    assert.match(by("Message-ID")[0].value, /^<[A-Za-z0-9._-]+@divinghq\.app>$/);
    assert.equal(by("MIME-Version")[0].value, "1.0");
    assert.equal(by("Content-Type")[0].value, "text/plain; charset=utf-8");
    assert.equal(by("Content-Transfer-Encoding")[0].value, "7bit");
  });

  test("header lines stay short", () => {
    const long = "[DivingHQ] " + "status endpoint unreachable, ".repeat(6);
    const { head, fields } = splitMessage(buildMime({ ...baseMessage(), subject: long }));
    for (const line of head.split("\r\n")) assert.ok(line.length <= 78, `${line.length}: ${line}`);
    // Folding is reversible.
    assert.equal(fields.find((f) => f.name === "Subject").value, long.trim());
  });

  test("a non-ASCII subject is encoded and decodes back", () => {
    const subject = "[DivingHQ] backup failed at Zürich (Größe 0) and 北京 too, café résumé naïve ".repeat(2).trim();
    const { head, fields } = splitMessage(buildMime({ ...baseMessage(), subject }));
    const field = fields.find((f) => f.name === "Subject");
    assert.match(field.raw, /^Subject: =\?UTF-8\?B\?/);
    assert.ok(/^[\x20-\x7e\r\n\t]*$/.test(head), "the header block is pure ASCII");
    for (const line of head.split("\r\n")) assert.ok(line.length <= 76, `${line.length}: ${line}`);
    assert.equal(decodeWords(field.value), subject);
  });

  test("a non-ASCII display name is encoded too", () => {
    const { fields } = splitMessage(buildMime({ ...baseMessage(), fromName: "Plongée watch" }));
    const from = fields.find((f) => f.name === "From").value;
    assert.match(from, /^=\?UTF-8\?B\?.+\?= <alerts@divinghq\.app>$/);
    assert.equal(decodeWords(from.replace(/ <.*$/, "")), "Plongée watch");
    const quoted = splitMessage(buildMime({ ...baseMessage(), fromName: 'Say "hi"' }));
    assert.equal(quoted.fields.find((f) => f.name === "From").value, '"Say \\"hi\\"" <alerts@divinghq.app>');
  });

  test("CR/LF in a header value can't inject a header", () => {
    const raw = buildMime({ ...baseMessage(), subject: "hello\r\nBcc: victim@example.com\nX-Evil: 1" });
    const { fields } = splitMessage(raw);
    assert.deepEqual(
      fields.map((f) => f.name),
      ["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding", "Auto-Submitted"],
    );
    assert.equal(fields.find((f) => f.name === "Subject").value, "hello Bcc: victim@example.com X-Evil: 1");
  });

  test("a non-ASCII body goes base64 and decodes to the CRLF text", () => {
    const { fields, body } = splitMessage(buildMime({ ...baseMessage(), text: "Zürich is down\nsince 10:00\n" }));
    assert.equal(fields.find((f) => f.name === "Content-Transfer-Encoding").value, "base64");
    for (const line of body.split("\r\n")) assert.ok(line.length <= 76);
    assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Zürich is down\r\nsince 10:00\r\n");
  });

  test("an ASCII body with an absurdly long line goes base64 rather than break the 998 limit", () => {
    const { fields } = splitMessage(buildMime({ ...baseMessage(), text: "x".repeat(1200) }));
    assert.equal(fields.find((f) => f.name === "Content-Transfer-Encoding").value, "base64");
  });

  test("the whole composed alert email passes the same checks", () => {
    const w = watcher();
    w.run(siteDown, { timeZone: "Australia/Sydney" });
    const alerts = w.tick(siteDown);
    const mail = composeEmail(alerts, { now: w.now, timeZone: "Australia/Sydney", target: "https://divinghq.app" });
    const raw = buildMime({ ...baseMessage(), subject: mail.subject, text: mail.text, date: new Date(w.now) });
    assert.doesNotMatch(raw, /[^\r]\n/);
    assert.doesNotMatch(raw, /\r(?!\n)/);
    const { body } = splitMessage(raw);
    assert.equal(body, mail.text.replace(/\n/g, "\r\n"));
  });

  test("bad addresses and dates are refused", () => {
    assert.throws(() => buildMime({ ...baseMessage(), to: "not an address" }), TypeError);
    assert.throws(() => buildMime({ ...baseMessage(), to: "a@b.com\r\nBcc: c@d.com" }), TypeError);
    assert.throws(() => buildMime({ ...baseMessage(), from: "" }), TypeError);
    assert.throws(() => formatRfc5322Date(new Date("nope")), TypeError);
  });

  test("single-digit days aren't padded, times are", () => {
    assert.equal(formatRfc5322Date(new Date("2026-10-04T03:04:05Z")), "Sun, 4 Oct 2026 03:04:05 +0000");
    assert.equal(encodeHeader("Subject", "plain"), "Subject: plain");
    assert.equal(formatMailbox("a@b.co", ""), "a@b.co");
  });
});
