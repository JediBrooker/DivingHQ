// The pieces behind GET /api/ops/status that don't need a database:
// the rolling 15-minute response tally (lib/request-window.js) and the
// state-file reader that decides what a public endpoint may repeat
// (lib/ops-state.js). The endpoint itself, with a real and a dead
// database, is in ops-status.integration.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRequestWindow } = require("../lib/request-window");
const { readOpsState, backupBlock, deployBlock, restoreCheckBlock, stateDir } = require("../lib/ops-state");

const MIN = 60 * 1000;

test("the request window counts responses and 5xx over the last 15 minutes", () => {
  let now = Date.UTC(2026, 8, 29, 10, 0, 30);
  const w = createRequestWindow({ minutes: 15, now: () => now });
  assert.deepEqual(w.snapshot(), { window_minutes: 15, server_errors: 0, requests: 0 });

  w.record(200);
  w.record(404);
  w.record(500);
  w.record(503);
  assert.deepEqual(w.snapshot(), { window_minutes: 15, server_errors: 2, requests: 4 });

  // 14 minutes on, the first minute is still inside the window.
  now += 14 * MIN;
  w.record(502);
  assert.deepEqual(w.snapshot(), { window_minutes: 15, server_errors: 3, requests: 5 });

  // One more minute and it has rolled off; only the 502 is left.
  now += MIN;
  assert.deepEqual(w.snapshot(), { window_minutes: 15, server_errors: 1, requests: 1 });

  // The slot the old minute used gets reused rather than added to.
  w.record(200);
  assert.deepEqual(w.snapshot(), { window_minutes: 15, server_errors: 1, requests: 2 });

  // A quiet half hour empties it.
  now += 30 * MIN;
  assert.deepEqual(w.snapshot(), { window_minutes: 15, server_errors: 0, requests: 0 });
});

test("the request window middleware counts what went out, on finish", () => {
  const w = createRequestWindow({ minutes: 15 });
  const handlers = {};
  const res = { statusCode: 500, on: (ev, fn) => { handlers[ev] = fn; } };
  let nexted = false;
  w.middleware({}, res, () => { nexted = true; });
  assert.ok(nexted);
  assert.equal(w.snapshot().requests, 0, "nothing counted before the response finishes");
  handlers.finish();
  assert.deepEqual(w.snapshot(), { window_minutes: 15, server_errors: 1, requests: 1 });
});

test("only well-formed values survive into the public blocks", () => {
  assert.deepEqual(backupBlock({
    last_attempt_at: "2026-09-29T16:30:01Z",
    last_success_at: "2026-09-28T16:30:00.123Z",
    last_ok: true,
    offsite: "ok",
    size_bytes: 69738696,
    file: "/var/backups/divinghq/divinghq-20260929T163001Z.dump",
    error: "pg_dump: connection to server at 10.0.0.5 failed",
  }), {
    last_attempt_at: "2026-09-29T16:30:01.000Z",
    last_success_at: "2026-09-28T16:30:00.123Z",
    last_ok: true,
    offsite: "ok",
    size_bytes: 69738696,
  });

  assert.deepEqual(backupBlock({
    last_attempt_at: "yesterday",
    last_success_at: "Tue, 29 Sep 2026 16:30:00 GMT",
    last_ok: "true",
    offsite: "maybe",
    size_bytes: -1,
  }), { last_attempt_at: null, last_success_at: null, last_ok: null, offsite: null, size_bytes: null });
  assert.equal(backupBlock({ size_bytes: 1.5 }).size_bytes, null);
  assert.equal(backupBlock({ offsite: "not_configured" }).offsite, "not_configured");

  assert.deepEqual(deployBlock({ last_at: "2026-09-29T01:02:03+10:00", ok: false, sha: "53235667AbCdEf0123456789abcdef0123456789" }),
    { last_at: "2026-09-28T15:02:03.000Z", ok: false, sha: "5323566" });
  assert.equal(deployBlock({ sha: "main" }).sha, null);
  assert.equal(deployBlock({ sha: "abc12" }).sha, null, "too short to be a commit");
  assert.equal(deployBlock({ sha: "5323566; rm -rf /" }).sha, null);

  assert.deepEqual(restoreCheckBlock({ last_run_at: "2026-09-27T17:30:00Z", ok: true, detail: "users 2427/2427" }),
    { last_run_at: "2026-09-27T17:30:00.000Z", ok: true });
  assert.deepEqual(restoreCheckBlock(null), { last_run_at: null, ok: null });
});

test("readOpsState: files present, missing, garbage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dhq-opsstate-"));
  try {
    // Nothing there at all, e.g. a dev box.
    const empty = await readOpsState(dir);
    assert.deepEqual(empty, {
      backup: { last_attempt_at: null, last_success_at: null, last_ok: null, offsite: null, size_bytes: null },
      restore_check: { last_run_at: null, ok: null },
      deploy: { last_at: null, ok: null, sha: null },
    });

    fs.writeFileSync(path.join(dir, "backup.json"), JSON.stringify({
      last_attempt_at: "2026-09-29T16:30:00Z", last_success_at: "2026-09-29T16:30:00Z",
      last_ok: true, offsite: "not_configured", size_bytes: 1234,
    }));
    fs.writeFileSync(path.join(dir, "restore-check.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify(["2026-09-29T00:00:00Z", true]));
    const mixed = await readOpsState(dir);
    assert.deepEqual(mixed.backup, {
      last_attempt_at: "2026-09-29T16:30:00.000Z", last_success_at: "2026-09-29T16:30:00.000Z",
      last_ok: true, offsite: "not_configured", size_bytes: 1234,
    });
    assert.deepEqual(mixed.restore_check, { last_run_at: null, ok: null }, "garbage reads as missing");
    assert.deepEqual(mixed.deploy, { last_at: null, ok: null, sha: null }, "an array isn't a state file");

    // Something the size of a real file (not ours) is skipped unread.
    fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify({ ok: true, pad: "x".repeat(20000) }));
    assert.equal((await readOpsState(dir)).deploy.ok, null);

    // A directory where a file should be.
    fs.rmSync(path.join(dir, "deploy.json"));
    fs.mkdirSync(path.join(dir, "deploy.json"));
    assert.equal((await readOpsState(dir)).deploy.ok, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OPS_STATE_DIR picks the directory, /var/lib/divinghq otherwise", () => {
  assert.equal(stateDir({}), "/var/lib/divinghq");
  assert.equal(stateDir({ OPS_STATE_DIR: "/srv/state" }), "/srv/state");
});
