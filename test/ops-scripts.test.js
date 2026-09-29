// The bash helpers behind scripts/ops/backup-db.sh and restore-check.sh
// (scripts/ops/common.sh), tested one at a time by sourcing the file in a
// throwaway bash, plus the restore check's refusals, which happen before
// it ever talks to a database.
//
// Nothing in here connects to Postgres or reads the repo's .env: every
// run gets an empty env file and a PGHOST that goes nowhere, since
// deploy.sh runs this suite on the live box. The runs that dump and
// restore a real database are in ops-backup.integration.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const COMMON = path.join(ROOT, "scripts", "ops", "common.sh");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dhq-opsscripts-"));
}

// A clean environment: no DB_*, PG*, R2_* or DATABASE_URL leaking in from
// the developer's shell or a CI service container.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(DB_|PG|R2_|DATABASE_URL|BACKUP_|OPS_STATE_DIR|RESTORE_CHECK_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, PGHOST: "/nonexistent-socket-dir", ...extra };
}

// Source common.sh and run a snippet; returns stdout.
function sh(snippet, env = {}) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source "${COMMON}"; ${snippet}`], {
    encoding: "utf8",
    env: cleanEnv(env),
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("ops_load_env reads a .env the way dotenv does, and the shell wins", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, [
      "# a comment",
      "",
      "DB_USER=diver",
      "export DB_HOST=db.internal",
      'R2_BUCKET="divinghq-backups"',
      "R2_ACCOUNT_ID='abc123'",
      "DB_PORT=5433   # trailing comment",
      "DB_PASSWORD=p#ss=word",
      'QUOTED_HASH="p#ss word"',
      "DB_DATABASE=from_file\r",
      "  SPACED = yes ",
      "ALREADY_EMPTY=from_file",
      "not a line",
      // Appended after a restore instead of editing the line above: the
      // app (dotenv) takes the last one, so the backup has to as well.
      "DB_USER=restored_role",
      "DB_DATABASE=also_from_file",
      "LAST=no-newline",
    ].join("\n"));
    const r = sh(
      `ops_load_env "${file}"; printf '%s|' "$DB_USER" "$DB_HOST" "$R2_BUCKET" "$R2_ACCOUNT_ID" "$DB_PORT" "$DB_PASSWORD" "$QUOTED_HASH" "$DB_DATABASE" "$SPACED" "$ALREADY_EMPTY" "$LAST"`,
      { DB_DATABASE: "from_shell", ALREADY_EMPTY: "" },
    );
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "restored_role|db.internal|divinghq-backups|abc123|5433|p|p#ss word|from_shell|yes||no-newline|");

    // And the same answers as the app's own reader, key for key, for
    // everything the shell didn't already set.
    const dotenv = require("dotenv").parse(fs.readFileSync(file));
    const names = ["DB_USER", "DB_HOST", "R2_BUCKET", "R2_ACCOUNT_ID", "DB_PORT", "DB_PASSWORD", "QUOTED_HASH", "DB_DATABASE", "SPACED", "LAST"];
    const mine = sh(`ops_load_env "${file}"; printf '%s|' ${names.map((n) => `"$${n}"`).join(" ")}`).out.split("|").slice(0, -1);
    assert.deepEqual(Object.fromEntries(names.map((n, i) => [n, mine[i]])), Object.fromEntries(names.map((n) => [n, dotenv[n]])));
    // A missing file is fine, it just loads nothing.
    assert.equal(sh(`ops_load_env "${dir}/nope"; echo ok`).out.trim(), "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ops_resolve_db: DATABASE_URL, else DB_*, else PG*", () => {
  const show = 'ops_resolve_db; printf "%s|" "${PGHOST:-}" "${PGPORT:-}" "${PGUSER:-}" "${PGPASSWORD:-}" "${PGDATABASE:-}" "${PGSSLMODE:-}"';
  let r = sh(show, { DATABASE_URL: "postgresql://app%40x:p%2Fss%3Aw%40rd@db.example.org:6543/diving_app?sslmode=require" });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "db.example.org|6543|app@x|p/ss:w@rd|diving_app|require|");

  r = sh(show, { DATABASE_URL: "postgres://u@[::1]:5432/db" });
  assert.equal(r.out, "::1|5432|u||db||");

  r = sh(show, { DATABASE_URL: "postgresql:///diving_app?host=/var/run/postgresql&user=postgres" });
  assert.equal(r.out, "/var/run/postgresql||postgres||diving_app||");

  r = sh(show, { DB_HOST: "localhost", DB_PORT: "5432", DB_USER: "diver", DB_PASSWORD: "pw", DB_DATABASE: "diving_app" });
  assert.equal(r.out, "localhost|5432|diver|pw|diving_app||");

  // CI's service container only sets PG*.
  r = sh(show, { PGHOST: "ci-host", PGUSER: "ci", PGDATABASE: "divinghq_test" });
  assert.equal(r.out, "ci-host||ci||divinghq_test||");

  // No host at all: TCP to localhost like node-pg, not libpq's unix
  // socket (peer auth as root, which fails on the box).
  r = sh(show, { PGHOST: "", DB_USER: "diver", DB_PASSWORD: "pw", DB_DATABASE: "diving_app" });
  assert.equal(r.out, "localhost||diver|pw|diving_app||");

  r = sh(show, { DATABASE_URL: "mysql://nope" });
  assert.notEqual(r.status, 0);
  r = sh(show, {});
  assert.notEqual(r.status, 0, "no database name at all");
  assert.match(r.err, /no database name/);
});

test("ops_counts_close: near enough passes, an emptied or wildly different table fails", () => {
  const close = (live, restored, env = {}) => sh(`ops_counts_close ${live} ${restored} && echo yes || echo no`, env).out.trim();
  assert.equal(close(2427, 2427), "yes");
  assert.equal(close(2427, 2300), "yes", "a day's worth of change");
  assert.equal(close(10, 30), "yes", "small tables get absolute slack");
  assert.equal(close(0, 0), "yes");
  assert.equal(close(40, 0), "no", "a table that has rows can't restore empty");
  assert.equal(close(2427, 1000), "no", "under half");
  assert.equal(close(1000, 2500), "no", "over double");
  assert.equal(close(0, 500), "no", "the live table emptied since the backup");
  assert.equal(close(1000, 450, { RESTORE_CHECK_MIN_PCT: "40" }), "yes");
  assert.equal(close("x", 1), "no");
});

test("state files are written whole, readable, and read back", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "state", "backup.json");
    const json = '{"last_attempt_at":"2026-09-29T16:30:00Z","last_success_at":"2026-09-28T16:30:00Z","last_ok":false,"offsite":null,"size_bytes":1234}';
    const r = sh(`umask 077; ops_write_state "${file}" '${json}' && ops_prev_iso "${file}" last_success_at && ops_prev_int "${file}" size_bytes && ops_prev_iso "${file}" nope; echo end`);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "2026-09-28T16:30:00Z\n1234\nend\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).size_bytes, 1234);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, "the app can read it whoever it runs as");
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["backup.json"], "no temp file left behind");
    assert.equal(sh(`ops_json_str ""; ops_json_str ok; ops_json_int 12; ops_json_int x`).out, 'null"ok"12null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ops_list_dumps lists only our dumps, oldest first", () => {
  const dir = tmp();
  try {
    for (const f of [
      "divinghq-20260929T163000Z.dump", "divinghq-20260101T163000Z.dump", "divinghq-20261001T000000Z.dump",
      "divinghq-manual.dump", "divinghq-20260929T163000Z.dump.enc", ".divinghq-20260930T163000Z.dump.partial",
      "notes.txt",
    ]) fs.writeFileSync(path.join(dir, f), "x");
    const r = sh(`export LC_ALL=C; ops_list_dumps "${dir}"`);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.out.trim().split("\n").map((p) => path.basename(p)), [
      "divinghq-20260101T163000Z.dump", "divinghq-20260929T163000Z.dump", "divinghq-20261001T000000Z.dump",
    ]);
    assert.equal(sh(`ops_list_dumps "${dir}/missing"; echo done`).out, "done\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore-check refuses to use the live database, or anything not named restore_check", () => {
  const dir = tmp();
  try {
    const envFile = path.join(dir, "empty.env");
    fs.writeFileSync(envFile, "");
    const run = (scratch) => spawnSync("bash", [path.join(ROOT, "scripts", "ops", "restore-check.sh")], {
      encoding: "utf8",
      env: cleanEnv({
        DIVINGHQ_ENV_FILE: envFile,
        DB_DATABASE: "not_a_real_live_db",
        RESTORE_CHECK_DB: scratch,
        BACKUP_DIR: path.join(dir, "backups"),
        OPS_STATE_DIR: path.join(dir, "state"),
      }),
    });
    const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state", "restore-check.json"), "utf8"));

    let r = run("not_a_real_live_db");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is the live database, refusing/);
    assert.equal(state().ok, false);
    assert.match(state().last_run_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    r = run("NOT_A_REAL_LIVE_DB");
    assert.notEqual(r.status, 0, "the live name in other case is refused too, unquoted it is the same database");
    assert.match(r.stderr, /is the live database/);

    r = run("not_a_real_live_db_copy");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /containing restore_check/);

    r = run('x_restore_check"; DROP DATABASE not_a_real_live_db; --');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /plain lowercase name/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ops/cron/divinghq-backup goes into /etc/cron.d as it is. cron skips a
// file there whose name has a dot in it and ignores a last line with no
// newline, both silently, so pin those along with the schedule.
test("the cron file runs both scripts at the agreed (Sydney) times", () => {
  const cronPath = path.join(ROOT, "ops", "cron", "divinghq-backup");
  assert.doesNotMatch(path.basename(cronPath), /\./);
  const text = fs.readFileSync(cronPath, "utf8");
  assert.ok(text.endsWith("\n"));
  const jobs = text.split("\n").filter((l) => /^\d/.test(l)).map((l) => l.split(/\s+/));
  assert.equal(jobs.length, 2);
  const [backup, restore] = jobs;
  assert.deepEqual(backup.slice(0, 6), ["30", "3", "*", "*", "*", "root"]);
  assert.match(backup.join(" "), /scripts\/ops\/backup-db\.sh" >> \/var\/log\/divinghq-backup\.log 2>&1$/);
  assert.deepEqual(restore.slice(0, 6), ["30", "4", "*", "*", "0", "root"]);
  assert.match(restore.join(" "), /scripts\/ops\/restore-check\.sh" >> \/var\/log\/divinghq-backup\.log 2>&1$/);
  for (const script of ["backup-db.sh", "restore-check.sh"]) {
    const mode = fs.statSync(path.join(ROOT, "scripts", "ops", script)).mode;
    assert.ok(mode & 0o100, `${script} is executable`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "ops", "cron", "divinghq-backup.logrotate"), "utf8"),
    /^\/var\/log\/divinghq-backup\.log \{/m);
});
