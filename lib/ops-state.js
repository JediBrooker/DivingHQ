// Reads the little JSON files the ops scripts leave in OPS_STATE_DIR
// (default /var/lib/divinghq) and turns them into the backup /
// restore_check / deploy blocks of GET /api/ops/status.
//
//   backup.json         scripts/ops/backup-db.sh
//   restore-check.json  scripts/ops/restore-check.sh
//   deploy.json         deploy.sh
//
// The endpoint is public, so nothing here passes a value through as-is.
// Every field is picked by name and checked for the type the contract
// promises (an ISO time, a boolean, a count, one of a few words, a short
// sha), and anything else comes out as null. A script that one day adds
// an error message or a file path to its JSON can't leak it that way.
// A file that's missing, unreadable, too big or not JSON gives a block of
// nulls, same as a box where the scripts were never installed.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_STATE_DIR = "/var/lib/divinghq";
// The scripts write well under 200 bytes. Anything this size is not ours.
const MAX_STATE_FILE_BYTES = 16 * 1024;
const OFFSITE_STATES = new Set(["ok", "failed", "not_configured"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function stateDir(env = process.env) {
  return env.OPS_STATE_DIR || DEFAULT_STATE_DIR;
}

function isoOrNull(v) {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const boolOrNull = (v) => (typeof v === "boolean" ? v : null);
const countOrNull = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const offsiteOrNull = (v) => (typeof v === "string" && OFFSITE_STATES.has(v) ? v : null);
function shaOrNull(v) {
  if (typeof v !== "string" || !/^[0-9a-f]{7,40}$/i.test(v)) return null;
  return v.slice(0, 7).toLowerCase();
}

async function readStateFile(dir, name) {
  const file = path.join(dir, name);
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_STATE_FILE_BYTES) return null;
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function backupBlock(raw) {
  const r = raw || {};
  return {
    last_attempt_at: isoOrNull(r.last_attempt_at),
    last_success_at: isoOrNull(r.last_success_at),
    last_ok: boolOrNull(r.last_ok),
    offsite: offsiteOrNull(r.offsite),
    size_bytes: countOrNull(r.size_bytes),
  };
}

function restoreCheckBlock(raw) {
  const r = raw || {};
  return { last_run_at: isoOrNull(r.last_run_at), ok: boolOrNull(r.ok) };
}

function deployBlock(raw) {
  const r = raw || {};
  return { last_at: isoOrNull(r.last_at), ok: boolOrNull(r.ok), sha: shaOrNull(r.sha) };
}

async function readOpsState(dir = stateDir()) {
  const [backup, restore, deploy] = await Promise.all([
    readStateFile(dir, "backup.json"),
    readStateFile(dir, "restore-check.json"),
    readStateFile(dir, "deploy.json"),
  ]);
  return {
    backup: backupBlock(backup),
    restore_check: restoreCheckBlock(restore),
    deploy: deployBlock(deploy),
  };
}

module.exports = {
  DEFAULT_STATE_DIR,
  stateDir,
  readOpsState,
  // exported for the tests
  backupBlock,
  restoreCheckBlock,
  deployBlock,
};
