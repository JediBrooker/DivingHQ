// scripts/ops/backup-db.sh and scripts/ops/restore-check.sh run for real
// against the test database, with temp BACKUP_DIR / OPS_STATE_DIR:
//
//   * a local-only backup (R2 unset): a verified dump, retention, and the
//     backup.json the status page reads
//   * a failed backup keeps the last success on record
//   * the off-site path against a fake R2 (R2_ENDPOINT) that records the
//     PUT: SigV4 signed for region "auto" / service "s3", no secret in the
//     log, and then the restore runbook in ops/backups/README.md command
//     for command (curl download, openssl decrypt, pg_restore into a new
//     database)
//   * the refusals: no passphrase file, half the R2 settings, a rejected
//     upload, an ETag that doesn't match
//   * the restore check: restores into a scratch database, compares, drops
//     it, and fails on a garbage dump or an empty directory
//
// Skips when Postgres isn't reachable or pg_dump / pg_restore / psql /
// openssl / curl aren't on PATH, and when pg_dump is older than the
// server (it refuses to dump a newer one).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { Pool } = require("pg");

require("dotenv").config({ quiet: true });

const ROOT = path.join(__dirname, "..");
const BACKUP = path.join(ROOT, "scripts", "ops", "backup-db.sh");
const RESTORE_CHECK = path.join(ROOT, "scripts", "ops", "restore-check.sh");
const DUMP_RE = /^divinghq-\d{8}T\d{6}Z\.dump$/;

let skipReason = null;
let pool;
let liveDb;
let work;
let emptyEnvFile;
let passphraseFile;
const PASSPHRASE = crypto.randomBytes(48).toString("base64");

function onPath(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

before(async () => {
  require("./support/test-db").assertTestDatabase();
  const missing = ["pg_dump", "pg_restore", "psql", "openssl", "curl"].filter((c) => !onPath(c));
  if (missing.length) {
    skipReason = `not on PATH: ${missing.join(", ")}`;
    return;
  }
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user:     process.env.DB_USER     || process.env.PGUSER,
        host:     process.env.DB_HOST     || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port:     Number(process.env.DB_PORT || process.env.PGPORT || 5432),
      });
  try {
    const r = await pool.query("SELECT current_database() AS db, current_setting('server_version_num')::int AS v");
    liveDb = r.rows[0].db;
    const clientMajor = Number((spawnSync("pg_dump", ["--version"], { encoding: "utf8" }).stdout.match(/(\d+)\.\d+/) || [])[1]);
    if (clientMajor && clientMajor < Math.floor(r.rows[0].v / 10000)) {
      skipReason = `pg_dump ${clientMajor} is older than the server`;
    }
  } catch (err) {
    skipReason = `Postgres not reachable: ${err.message}`;
  }
  if (skipReason) return;
  work = fs.mkdtempSync(path.join(os.tmpdir(), "dhq-backup-"));
  emptyEnvFile = path.join(work, "empty.env");
  fs.writeFileSync(emptyEnvFile, "");
  passphraseFile = path.join(work, "passphrase");
  fs.writeFileSync(passphraseFile, `${PASSPHRASE}\n`, { mode: 0o600 });
});

after(async () => {
  if (pool) {
    // The restore check drops its scratch database itself; this is for a
    // run that died half way.
    for (const db of [scratchName(), frozenName()]) {
      try { await pool.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* not ours to worry about */ }
    }
    await pool.end();
  }
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

function scratchName() {
  return `${liveDb}_restore_check`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}
// The still copy the restore check test compares against.
function frozenName() {
  return `${liveDb}_restore_src`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

// Runs a script without blocking the event loop (the fake R2 server lives
// in this process). The repo's .env is never read: DIVINGHQ_ENV_FILE is
// empty and the connection comes from this process's environment.
function runScript(script, env) {
  return runBash([script], env);
}
function runBash(args, env) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(R2_|BACKUP_|OPS_STATE_DIR|RESTORE_CHECK_)/.test(k)) continue;
    base[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn("bash", args, {
      env: { ...base, DIVINGHQ_ENV_FILE: emptyEnvFile, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr, log: stdout + stderr }));
  });
}

function dirs(name) {
  const backupDir = path.join(work, name, "backups");
  const stateDir = path.join(work, name, "state");
  return { backupDir, stateDir, env: { BACKUP_DIR: backupDir, OPS_STATE_DIR: stateDir } };
}
const readState = (stateDir, file) => JSON.parse(fs.readFileSync(path.join(stateDir, file), "utf8"));
const dumpsIn = (dir) => fs.readdirSync(dir).filter((f) => DUMP_RE.test(f)).sort();

// A stand-in for R2: records every request, keeps what's PUT and hands it
// back on a GET (for the runbook's download), and answers a PUT with the
// MD5 ETag R2 gives a single upload. `respond` can override.
async function fakeR2(respond) {
  const requests = [];
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (respond && respond(req, res, body)) return;
      if (req.method === "GET") {
        const obj = objects.get(req.url);
        res.statusCode = obj && req.headers.authorization ? 200 : 404;
        res.end(obj || "");
        return;
      }
      objects.set(req.url, body);
      res.setHeader("ETag", `"${crypto.createHash("md5").update(body).digest("hex")}"`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const R2 = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET: "divinghq-backups",
  R2_ACCESS_KEY_ID: "AKIDTESTONLY0000EXAMPLE",
  R2_SECRET_ACCESS_KEY: "sEcReT-test-only-" + crypto.randomBytes(12).toString("hex"),
};

// Recomputes the AWS SigV4 signature for a recorded request, so the test
// proves the upload is signed the way S3-compatible endpoints check it,
// with R2's region ("auto") and service ("s3").
function expectedSignature(reqRec, secret) {
  const auth = reqRec.headers.authorization;
  const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  assert.ok(m, `unexpected Authorization header: ${auth}`);
  const [, , date, region, service, signedHeaders, signature] = m;
  const canonicalHeaders = signedHeaders.split(";")
    .map((h) => `${h}:${String(reqRec.headers[h]).trim()}\n`).join("");
  const canonicalRequest = [
    reqRec.method, reqRec.url.split("?")[0], "", canonicalHeaders, signedHeaders,
    reqRec.headers["x-amz-content-sha256"],
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", reqRec.headers["x-amz-date"], scope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
  return { region, service, signedHeaders, signature, expected: hmac(kSigning, stringToSign).toString("hex") };
}

test("a local-only backup: verified dump, backup.json, offsite not_configured", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const d = dirs("local");
  const r = await runScript(BACKUP, d.env);
  assert.equal(r.code, 0, r.log);

  const dumps = dumpsIn(d.backupDir);
  assert.equal(dumps.length, 1, r.log);
  const file = path.join(d.backupDir, dumps[0]);
  assert.equal(fs.statSync(file).mode & 0o077, 0, "only root can read the dump");
  const toc = spawnSync("pg_restore", ["--list", file], { encoding: "utf8" });
  assert.equal(toc.status, 0);
  assert.match(toc.stdout, / TABLE DATA public users /);
  assert.deepEqual(fs.readdirSync(d.backupDir).filter((f) => !f.startsWith(".divinghq-ops.lock")), dumps,
    "no partial or temp files left behind");

  const state = readState(d.stateDir, "backup.json");
  assert.equal(state.last_ok, true);
  assert.equal(state.offsite, "not_configured");
  assert.equal(state.size_bytes, fs.statSync(file).size);
  assert.equal(state.last_attempt_at, state.last_success_at);
  const stamp = dumps[0].match(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/).slice(1);
  assert.equal(state.last_success_at, `${stamp[0]}-${stamp[1]}-${stamp[2]}T${stamp[3]}:${stamp[4]}:${stamp[5]}Z`);
  assert.equal(fs.statSync(path.join(d.stateDir, "backup.json")).mode & 0o777, 0o644);

  // What the endpoint makes of it.
  const { readOpsState } = require("../lib/ops-state");
  const block = (await readOpsState(d.stateDir)).backup;
  assert.equal(block.last_ok, true);
  assert.equal(block.offsite, "not_configured");
  assert.equal(block.size_bytes, state.size_bytes);
});

test("retention keeps the newest BACKUP_KEEP_LOCAL dumps and nothing else is touched", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const d = dirs("retention");
  fs.mkdirSync(d.backupDir, { recursive: true });
  const old = ["divinghq-20250101T163000Z.dump", "divinghq-20250102T163000Z.dump", "divinghq-20250103T163000Z.dump"];
  for (const f of old) fs.writeFileSync(path.join(d.backupDir, f), "old");
  for (const f of ["divinghq-manual.dump", "notes.txt"]) fs.writeFileSync(path.join(d.backupDir, f), "keep me");
  // What a run killed with SIGKILL leaves: its temp files, never cleaned
  // by its own trap. Old ones go, a fresh one might be another run's.
  const stale = [".divinghq-20250104T163000Z.dump.partial", "divinghq-20250103T163000Z.dump.enc", ".r2-headers.AbC123", ".r2-body.XyZ789"];
  const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
  for (const f of stale) {
    fs.writeFileSync(path.join(d.backupDir, f), "half");
    fs.utimesSync(path.join(d.backupDir, f), sevenHoursAgo, sevenHoursAgo);
  }
  const fresh = ".divinghq-20250105T163000Z.dump.partial";
  fs.writeFileSync(path.join(d.backupDir, fresh), "someone else's");

  const r = await runScript(BACKUP, { ...d.env, BACKUP_KEEP_LOCAL: "2" });
  assert.equal(r.code, 0, r.log);
  const left = dumpsIn(d.backupDir);
  assert.equal(left.length, 2);
  assert.equal(left[0], "divinghq-20250103T163000Z.dump");
  assert.ok(left[1] > left[0], "the new dump is the other one kept");
  assert.ok(fs.existsSync(path.join(d.backupDir, "divinghq-manual.dump")));
  assert.ok(fs.existsSync(path.join(d.backupDir, "notes.txt")));
  assert.match(r.log, /removed old dump divinghq-20250101T163000Z\.dump/);
  for (const f of stale) assert.ok(!fs.existsSync(path.join(d.backupDir, f)), `${f} cleared`);
  assert.match(r.log, /removed \.divinghq-20250104T163000Z\.dump\.partial, left over/);
  assert.ok(fs.existsSync(path.join(d.backupDir, fresh)), "a temp file that's still young is left alone");

  const bad = await runScript(BACKUP, { ...d.env, BACKUP_KEEP_LOCAL: "0" });
  assert.notEqual(bad.code, 0);
  assert.equal(dumpsIn(d.backupDir).length, 2, "a bad setting deletes nothing");
});

test("a failed backup says so and keeps the last success on record", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const d = dirs("failure");
  const ok = await runScript(BACKUP, d.env);
  assert.equal(ok.code, 0, ok.log);
  const before = readState(d.stateDir, "backup.json");

  // One second on, so the attempt time can't equal the success time.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const r = await runScript(BACKUP, { ...d.env, DATABASE_URL: "", DB_DATABASE: `${liveDb}_does_not_exist`, PGDATABASE: "" });
  assert.notEqual(r.code, 0);
  const after = readState(d.stateDir, "backup.json");
  assert.equal(after.last_ok, false);
  assert.equal(after.last_success_at, before.last_success_at);
  assert.equal(after.size_bytes, before.size_bytes);
  assert.ok(after.last_attempt_at > before.last_attempt_at);
  assert.equal(after.offsite, "not_configured");
  assert.equal(dumpsIn(d.backupDir).length, 1, "nothing half-written left behind");
  assert.deepEqual(fs.readdirSync(d.backupDir).filter((f) => f.includes("partial")), []);
});

test("off-site: encrypted, SigV4-signed PUT to R2, and the restore runbook gets it back", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const d = dirs("r2");
  const r2 = await fakeR2();
  try {
    const r = await runScript(BACKUP, { ...d.env, ...R2, R2_ENDPOINT: r2.endpoint, BACKUP_PASSPHRASE_FILE: passphraseFile });
    assert.equal(r.code, 0, r.log);
    const state = readState(d.stateDir, "backup.json");
    assert.equal(state.offsite, "ok");
    assert.equal(state.last_ok, true);

    assert.equal(r2.requests.length, 1);
    const put = r2.requests[0];
    const dump = dumpsIn(d.backupDir)[0];
    assert.equal(put.method, "PUT");
    assert.equal(put.url, `/${R2.R2_BUCKET}/divinghq/${dump}.enc`);
    assert.ok(put.headers["x-amz-content-sha256"], "S3 wants the payload hash header");
    assert.match(put.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);

    const sig = expectedSignature(put, R2.R2_SECRET_ACCESS_KEY);
    assert.equal(sig.region, "auto");
    assert.equal(sig.service, "s3");
    assert.match(sig.signedHeaders, /host/);
    assert.match(sig.signedHeaders, /x-amz-date/);
    assert.equal(sig.signature, sig.expected, "the signature checks out with the secret key");
    assert.ok(put.headers.authorization.includes(`Credential=${R2.R2_ACCESS_KEY_ID}/`));

    // Decrypt exactly as ops/backups/README.md tells the owner to.
    const enc = path.join(work, "downloaded.dump.enc");
    const out = path.join(work, "downloaded.dump");
    fs.writeFileSync(enc, put.body);
    const dec = spawnSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
      "-in", enc, "-out", out, "-pass", `file:${passphraseFile}`], { encoding: "utf8" });
    assert.equal(dec.status, 0, dec.stderr);
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(path.join(d.backupDir, dump))), "decrypts to the local dump");
    assert.notEqual(put.body.subarray(0, 5).toString(), "PGDMP", "what left the box wasn't the plain dump");
    assert.equal(spawnSync("pg_restore", ["--list", out]).status, 0);

    // The wrong passphrase doesn't open it.
    const wrong = path.join(work, "wrong-pass");
    fs.writeFileSync(wrong, "not-the-passphrase\n");
    const bad = spawnSync("sh", ["-c", `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "${enc}" -pass "file:${wrong}" | pg_restore --list`]);
    assert.notEqual(bad.status, 0);

    for (const secret of [R2.R2_SECRET_ACCESS_KEY, PASSPHRASE]) {
      assert.ok(!r.log.includes(secret), "no secret in the log");
    }

    // The rest of the restore runbook (ops/backups/README.md), command for
    // command: download with curl, decrypt, restore into a new database as
    // the app's role, check it.
    const cfg = path.join(work, "r2.curl");
    fs.writeFileSync(cfg, `user = "${R2.R2_ACCESS_KEY_ID}:${R2.R2_SECRET_ACCESS_KEY}"\n`, { mode: 0o600 });
    const fetched = path.join(work, "fetched.dump.enc");
    const dl = await runBash(["-c",
      `curl --fail --silent --show-error --config "${cfg}" --aws-sigv4 "aws:amz:auto:s3" \\
        -o "${fetched}" "${r2.endpoint}/${R2.R2_BUCKET}/divinghq/${dump}.enc"`], {});
    assert.equal(dl.code, 0, dl.log);
    assert.ok(fs.readFileSync(fetched).equals(put.body), "downloads what was uploaded");
    const get = r2.requests.find((q) => q.method === "GET");
    assert.equal(expectedSignature(get, R2.R2_SECRET_ACCESS_KEY).signature,
      expectedSignature(get, R2.R2_SECRET_ACCESS_KEY).expected, "the download is signed too");

    const restoredDb = `${liveDb}_runbook_restore`;
    const plain = path.join(work, "runbook.dump");
    const steps = await runBash(["-c", `set -euo pipefail
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "${fetched}" -out "${plain}" -pass "file:${passphraseFile}"
      pg_restore --list "${plain}" > /dev/null
      source "${path.join(ROOT, "scripts", "ops", "common.sh")}" && ops_load_env "${emptyEnvFile}" && ops_resolve_db
      dropdb --if-exists "${restoredDb}"
      createdb "${restoredDb}"
      pg_restore --no-owner --no-privileges --single-transaction --exit-on-error -d "${restoredDb}" "${plain}"
      psql -X -tA -d "${restoredDb}" -c "SELECT version FROM schema_meta"`], {});
    try {
      assert.equal(steps.code, 0, steps.log);
      const live = await pool.query("SELECT version FROM public.schema_meta WHERE id = 1");
      assert.equal(steps.stdout.trim(), String(live.rows[0].version));
    } finally {
      await pool.query(`DROP DATABASE IF EXISTS "${restoredDb}" WITH (FORCE)`);
    }
    assert.deepEqual(fs.readdirSync(d.backupDir).filter((f) => f.endsWith(".enc") || f.startsWith(".r2-")), [],
      "the encrypted copy and curl's headers are cleaned up");
  } finally {
    await r2.close();
  }
});

test("off-site refusals: no passphrase, half the settings, a rejected PUT, a bad ETag", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r2 = await fakeR2();
  try {
    // No passphrase file: no upload at all, the local dump still counts.
    let d = dirs("nopass");
    let r = await runScript(BACKUP, { ...d.env, ...R2, R2_ENDPOINT: r2.endpoint, BACKUP_PASSPHRASE_FILE: path.join(work, "nope") });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /passphrase file .* missing or unreadable/);
    assert.equal(r2.requests.length, 0, "nothing unencrypted leaves the box");
    let state = readState(d.stateDir, "backup.json");
    assert.equal(state.last_ok, true);
    assert.equal(state.offsite, "failed");
    assert.equal(dumpsIn(d.backupDir).length, 1);
    assert.deepEqual(fs.readdirSync(d.backupDir).filter((f) => f.endsWith(".enc")), []);

    // An empty passphrase file is no better.
    const empty = path.join(work, "empty-pass");
    fs.writeFileSync(empty, "\n  \n");
    d = dirs("emptypass");
    r = await runScript(BACKUP, { ...d.env, ...R2, R2_ENDPOINT: r2.endpoint, BACKUP_PASSPHRASE_FILE: empty });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /is empty/);
    assert.equal(readState(d.stateDir, "backup.json").offsite, "failed");
    assert.equal(r2.requests.length, 0);

    // Three of the four settings.
    d = dirs("half");
    r = await runScript(BACKUP, { ...d.env, ...R2, R2_SECRET_ACCESS_KEY: "", R2_ENDPOINT: r2.endpoint, BACKUP_PASSPHRASE_FILE: passphraseFile });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /half set up, missing: R2_SECRET_ACCESS_KEY/);
    assert.equal(readState(d.stateDir, "backup.json").offsite, "failed");
    assert.equal(r2.requests.length, 0);
  } finally {
    await r2.close();
  }

  // R2 says no, and the log says why in R2's own words.
  const denied = await fakeR2((_req, res) => {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/xml");
    res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    return true;
  });
  try {
    const d = dirs("denied");
    const r = await runScript(BACKUP, { ...d.env, ...R2, R2_ENDPOINT: denied.endpoint, BACKUP_PASSPHRASE_FILE: passphraseFile });
    assert.notEqual(r.code, 0);
    assert.equal(denied.requests.length, 1, "a 403 isn't retried");
    assert.match(r.log, /the upload to R2 failed \(R2 said: HTTP 403 AccessDenied: Access Denied\)/);
    const state = readState(d.stateDir, "backup.json");
    assert.equal(state.offsite, "failed");
    assert.equal(state.last_ok, true);
    assert.ok(!r.log.includes(R2.R2_SECRET_ACCESS_KEY));
    assert.deepEqual(fs.readdirSync(d.backupDir).filter((f) => f.startsWith(".r2-")), [], "no header or body file left behind");
  } finally {
    await denied.close();
  }

  // The mistake that prompted it: the Token value pasted in as the key id.
  // R2's message goes in the log, but never the key id or the secret, even
  // when a message quotes them back (nothing else in the body, either).
  const tooLong = await fakeR2((_req, res) => {
    res.statusCode = 400;
    res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code>' +
      `<Message>Credential access key has length 53, should be 32 &amp; got ${R2.R2_ACCESS_KEY_ID} with ${R2.R2_SECRET_ACCESS_KEY}</Message>` +
      `<StringToSign>AWS4-HMAC-SHA256 ${R2.R2_ACCESS_KEY_ID}</StringToSign></Error>`);
    return true;
  });
  try {
    const d = dirs("toolong");
    const r = await runScript(BACKUP, { ...d.env, ...R2, R2_ENDPOINT: tooLong.endpoint, BACKUP_PASSPHRASE_FILE: passphraseFile });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /R2 said: HTTP 400 InvalidArgument: Credential access key has length 53, should be 32 & got <key id> with <secret>\)/);
    assert.ok(!r.log.includes(R2.R2_SECRET_ACCESS_KEY), "no secret in the log");
    assert.ok(!r.log.includes(R2.R2_ACCESS_KEY_ID), "no key id in the log");
    assert.doesNotMatch(r.log, /StringToSign|AWS4-HMAC/);
    assert.equal(readState(d.stateDir, "backup.json").offsite, "failed");
  } finally {
    await tooLong.close();
  }

  // R2 took it but stored something else.
  const garbled = await fakeR2((_req, res) => {
    res.setHeader("ETag", '"00000000000000000000000000000000"');
    res.end();
    return true;
  });
  try {
    const d = dirs("etag");
    const r = await runScript(BACKUP, { ...d.env, ...R2, R2_ENDPOINT: garbled.endpoint, BACKUP_PASSPHRASE_FILE: passphraseFile });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /ETag/);
    assert.equal(readState(d.stateDir, "backup.json").offsite, "failed");
  } finally {
    await garbled.close();
  }
});

test("restore check: restores the newest dump into a scratch database and drops it", async (t) => {
  if (skipReason) return t.skip(skipReason);
  // The test database is shared with every other test file running at the
  // same time, so its row counts can move between the dump and the
  // comparison and fail the check for nothing (CI did, scores 20 vs 0).
  // Freeze a copy first and point both scripts at that.
  const frozen = frozenName();
  const seed = dirs("restore-seed");
  const s = await runScript(BACKUP, seed.env);
  assert.equal(s.code, 0, s.log);
  const mk = await runBash(["-c", `set -euo pipefail
    source "${path.join(ROOT, "scripts", "ops", "common.sh")}" && ops_load_env "${emptyEnvFile}" && ops_resolve_db
    dropdb --if-exists "${frozen}"
    createdb "${frozen}"
    pg_restore --no-owner --no-privileges --single-transaction --exit-on-error -d "${frozen}" "${path.join(seed.backupDir, dumpsIn(seed.backupDir)[0])}"`], {});
  assert.equal(mk.code, 0, mk.log);
  const onFrozen = { DATABASE_URL: "", DB_DATABASE: frozen, PGDATABASE: "" };

  try {
    const d = dirs("restore");
    const b = await runScript(BACKUP, { ...d.env, ...onFrozen });
    assert.equal(b.code, 0, b.log);
    // An older dump alongside, garbage, to prove only the newest is used.
    fs.writeFileSync(path.join(d.backupDir, "divinghq-20200101T000000Z.dump"), "not a dump");

    const r = await runScript(RESTORE_CHECK, { ...d.env, ...onFrozen, RESTORE_CHECK_DB: scratchName() });
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /schema version \d+ matches/);
    assert.match(r.log, /users: live \d+, restored \d+/);
    const state = readState(d.stateDir, "restore-check.json");
    assert.equal(state.ok, true);
    assert.match(state.last_run_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  } finally {
    await pool.query(`DROP DATABASE IF EXISTS "${frozen}" WITH (FORCE)`);
  }

  const gone = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [scratchName()]);
  assert.equal(gone.rowCount, 0, "the scratch database is dropped");
  const live = await pool.query("SELECT version FROM public.schema_meta WHERE id = 1");
  assert.equal(live.rowCount, 1, "the live database is untouched");
});

test("restore check fails on a garbage newest dump, and on no dump at all", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const d = dirs("garbage");
  fs.mkdirSync(d.backupDir, { recursive: true });
  fs.writeFileSync(path.join(d.backupDir, "divinghq-29990101T000000Z.dump"), "PGDMP but not really");

  let r = await runScript(RESTORE_CHECK, { ...d.env, RESTORE_CHECK_DB: scratchName() });
  assert.notEqual(r.code, 0);
  assert.equal(readState(d.stateDir, "restore-check.json").ok, false);
  const gone = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [scratchName()]);
  assert.equal(gone.rowCount, 0, "dropped even when the restore failed");

  const e = dirs("empty");
  fs.mkdirSync(e.backupDir, { recursive: true });
  r = await runScript(RESTORE_CHECK, { ...e.env, RESTORE_CHECK_DB: scratchName() });
  assert.notEqual(r.code, 0);
  assert.match(r.log, /no divinghq-\*\.dump/);
  assert.equal(readState(e.stateDir, "restore-check.json").ok, false);
});
