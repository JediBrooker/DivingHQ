// deploy.sh builds the SPA somewhere the running server can't see it and
// only swaps it into dist/ right before the restart. Building straight
// into dist/ (vite empties it first) handed the old process the new
// index.html and deleted the chunks open tabs still needed, for as long
// as migrate and the tests took, and for good if either one stopped the
// deploy.
//
// Checks: the step order in a --dry run (in a throwaway git repo, so
// the dirty-tree guard doesn't trip over whatever this checkout has
// uncommitted), scripts/swap-dist.sh itself against a fake dist/, and the
// deploy.json each real run leaves for GET /api/ops/status. Every run that
// isn't --dry gets a temporary OPS_STATE_DIR, since the live box runs this
// file during its own deploy.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dhq-deploy-"));
}

test("deploy.sh builds into dist.next and swaps it in only after migrate and tests", () => {
  const dir = tmp();
  try {
    fs.copyFileSync(path.join(ROOT, "deploy.sh"), path.join(dir, "deploy.sh"));
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.email=t@example.test", "-c", "user.name=t", "add", "deploy.sh");
    git("-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "x");
    const state = path.join(dir, "ops-state");
    const out = execFileSync("bash", [path.join(dir, "deploy.sh"), "--dry"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, OPS_STATE_DIR: state },
    });
    assert.ok(!fs.existsSync(state), "--dry records nothing, not even deploy.json");
    const at = (re) => {
      const i = out.split("\n").findIndex((l) => re.test(l));
      assert.ok(i >= 0, `no line matching ${re} in:\n${out}`);
      return i;
    };
    const build = at(/DRY: .*npm run build.*--outDir dist\.next/);
    const migrate = at(/DRY: npm run migrate$/);
    const tests = at(/DRY: .*npm run test:safe/);
    const swap = at(/DRY: .*swap-dist\.sh/);
    const restart = at(/DRY: pm2 restart/);
    assert.ok(build < migrate && migrate < tests && tests < swap && swap < restart, out);
    assert.doesNotMatch(out, /DRY: .*npm run build(?!.*--outDir)/, "nothing builds into dist/ in place");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A run with nothing new to pull only restarts, dist/ is left alone, and
// dist.prev/ is whatever an older deploy swapped out. If the health check
// then fails, following a hint that says "mv dist.prev dist" would put a
// stale SPA in front of the current API.
test("a plain restart that fails its health check doesn't suggest restoring dist.prev", () => {
  const dir = tmp();
  const origin = tmp();
  const bin = tmp();
  try {
    const id = ["-c", "user.email=t@example.test", "-c", "user.name=t"];
    const git = (...a) => execFileSync("git", [...id, ...a], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" });
    fs.copyFileSync(path.join(ROOT, "deploy.sh"), path.join(dir, "deploy.sh"));
    fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\ndist.next/\ndist.prev/\n");
    git("init", "-q");
    git("add", "deploy.sh", ".gitignore");
    git("commit", "-qm", "x");
    git("remote", "add", "origin", origin);
    git("push", "-q", "-u", "origin", "HEAD");
    for (const d of ["dist", "dist.prev"]) {
      fs.mkdirSync(path.join(dir, d));
      fs.writeFileSync(path.join(dir, d, "index.html"), d);
    }
    // pm2 "restarts", and nothing ever answers the health check.
    fs.writeFileSync(path.join(bin, "pm2"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });

    let out = "";
    try {
      execFileSync("bash", [path.join(dir, "deploy.sh")], {
        cwd: dir, encoding: "utf8", stdio: "pipe",
        // OPS_STATE_DIR always points somewhere temporary in these tests:
        // deploy.sh runs this suite on the live box, and the default is
        // the real /var/lib/divinghq the status page reads.
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HEALTH_TIMEOUT_S: "1", OPS_STATE_DIR: path.join(bin, "state") },
      });
      assert.fail("the health check was supposed to fail");
    } catch (err) {
      if (err.code === "ERR_ASSERTION") throw err;
      out = String(err.stdout);
    }
    assert.match(out, /no new commits/, out);
    assert.match(out, /To roll back: git reset --hard \w+ && pm2 restart/, out);
    assert.doesNotMatch(out, /mv dist\.prev dist/, out);
    assert.equal(fs.readFileSync(path.join(dir, "dist", "index.html"), "utf8"), "dist", "dist/ untouched");
    const recorded = JSON.parse(fs.readFileSync(path.join(bin, "state", "deploy.json"), "utf8"));
    assert.equal(recorded.ok, false, "a failed health check is a failed deploy on the status page");
    assert.equal(recorded.sha, git("rev-parse", "HEAD").toString().trim());
  } finally {
    for (const d of [dir, origin, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// deploy.json (GET /api/ops/status's deploy block). A throwaway repo with
// an origin to pull from, fake pm2 / curl / npm on PATH, and the state dir
// somewhere temporary.
function deployRepo() {
  const dir = tmp();
  const origin = tmp();
  const bin = tmp();
  const id = ["-c", "user.email=t@example.test", "-c", "user.name=t"];
  const git = (cwd, ...a) => execFileSync("git", [...id, ...a], { cwd, stdio: "pipe" }).toString().trim();
  execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" });
  fs.copyFileSync(path.join(ROOT, "deploy.sh"), path.join(dir, "deploy.sh"));
  // .env is ignored on the box too, or the dirty-tree check would trip.
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\ndist/\ndist.next/\ndist.prev/\n");
  git(dir, "init", "-q");
  git(dir, "add", "deploy.sh", ".gitignore");
  git(dir, "commit", "-qm", "first");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "HEAD");
  fs.writeFileSync(path.join(bin, "pm2"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // A healthy service: the health check gets its 200 straight away.
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\necho '{\"ok\":true,\"schema_version\":104}'\n", { mode: 0o755 });
  const deploy = (args = [], env = {}) => {
    // An OPS_STATE_DIR exported in whoever's shell runs the suite would win
    // over the temp .env below and send these fake deploys to the real one.
    const base = { ...process.env };
    delete base.OPS_STATE_DIR;
    try {
      const out = execFileSync("bash", [path.join(dir, "deploy.sh"), ...args], {
        cwd: dir, encoding: "utf8", stdio: "pipe",
        env: { ...base, PATH: `${bin}:${process.env.PATH}`, HEALTH_TIMEOUT_S: "1", ...env },
      });
      return { code: 0, out };
    } catch (err) {
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  const cleanup = () => { for (const d of [dir, origin, bin]) fs.rmSync(d, { recursive: true, force: true }); };
  return { dir, origin, bin, git, deploy, cleanup };
}

test("a deploy that gets to the end records ok and the commit it deployed", () => {
  const r = deployRepo();
  try {
    const state = path.join(r.bin, "state");
    // Nothing to pull and told not to restart: nothing was deployed, so
    // nothing is recorded.
    let run = r.deploy(["--no-restart-if-noop"], { OPS_STATE_DIR: state });
    assert.equal(run.code, 0, run.out);
    assert.ok(!fs.existsSync(path.join(state, "deploy.json")));

    // A plain restart that comes back healthy. OPS_STATE_DIR from .env
    // this time, the way the box would have it.
    fs.writeFileSync(path.join(r.dir, ".env"), `DB_DATABASE=nothing_here\nOPS_STATE_DIR="${state}"\n`);
    run = r.deploy();
    assert.equal(run.code, 0, run.out);
    const file = path.join(state, "deploy.json");
    const recorded = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(recorded).sort(), ["last_at", "ok", "sha"]);
    assert.equal(recorded.ok, true);
    assert.equal(recorded.sha, r.git(r.dir, "rev-parse", "HEAD"));
    assert.match(recorded.last_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(Math.abs(Date.parse(recorded.last_at) - Date.now()) < 60_000);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(state), ["deploy.json"], "no temp file left behind");

    // What the status page makes of it.
    const { deployBlock } = require("../lib/ops-state");
    assert.equal(deployBlock(recorded).sha, recorded.sha.slice(0, 7));

    // A state dir that can't be written is a warning, not a failed deploy.
    run = r.deploy([], { OPS_STATE_DIR: "/dev/null/nope" });
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /warning: couldn't write \/dev\/null\/nope\/deploy\.json/);
  } finally {
    r.cleanup();
  }
});

test("a step failing after the pull records ok false with the commit it tried", () => {
  const r = deployRepo();
  const other = tmp();
  try {
    const state = path.join(r.bin, "state");
    // Start from a good deploy on record.
    let run = r.deploy([], { OPS_STATE_DIR: state });
    assert.equal(run.code, 0, run.out);

    // Somebody merges a new commit...
    const branch = r.git(r.dir, "rev-parse", "--abbrev-ref", "HEAD");
    execFileSync("git", ["clone", "-q", "-b", branch, r.origin, other], { stdio: "pipe" });
    fs.writeFileSync(path.join(other, "feature.txt"), "new");
    r.git(other, "add", "feature.txt");
    r.git(other, "commit", "-qm", "second");
    r.git(other, "push", "-q", "origin", branch);
    const tried = r.git(other, "rev-parse", "HEAD");

    // ...and npm ci falls over on the box.
    fs.writeFileSync(path.join(r.bin, "npm"), "#!/bin/sh\necho \"npm $*: registry unreachable\" >&2\nexit 1\n", { mode: 0o755 });
    run = r.deploy([], { OPS_STATE_DIR: state });
    assert.notEqual(run.code, 0, run.out);
    assert.match(run.out, /npm ci/);
    const recorded = JSON.parse(fs.readFileSync(path.join(state, "deploy.json"), "utf8"));
    assert.equal(recorded.ok, false);
    assert.equal(recorded.sha, tried, "the commit it tried, not the one still running");
    assert.equal(r.git(r.dir, "rev-parse", "HEAD"), tried);
  } finally {
    r.cleanup();
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("swap-dist.sh puts the new build in place and keeps last week's chunks", () => {
  const dir = tmp();
  try {
    const put = (p, body, ageDays = 0) => {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), body);
      if (ageDays) {
        const t = new Date(Date.now() - ageDays * 86400000);
        fs.utimesSync(path.join(dir, p), t, t);
      }
    };
    put("dist/index.html", "old shell");
    put("dist/assets/Manager-old.js", "old chunk", 1);
    put("dist/assets/Ancient-old.js", "ancient chunk", 30);
    put("dist/assets/shared-same.js", "old copy");
    put("dist.next/index.html", "new shell");
    put("dist.next/assets/Manager-new.js", "new chunk");
    put("dist.next/assets/shared-same.js", "new copy");

    execFileSync("bash", [path.join(ROOT, "scripts", "swap-dist.sh"), dir], { stdio: "pipe" });

    const read = (p) => fs.readFileSync(path.join(dir, p), "utf8");
    assert.equal(read("dist/index.html"), "new shell");
    assert.equal(read("dist/assets/Manager-new.js"), "new chunk");
    assert.equal(read("dist/assets/Manager-old.js"), "old chunk", "an open tab can still lazy-load it");
    assert.equal(read("dist/assets/shared-same.js"), "new copy", "the new build wins a name clash");
    assert.ok(!fs.existsSync(path.join(dir, "dist/assets/Ancient-old.js")), "chunks past the grace period go");
    assert.ok(!fs.existsSync(path.join(dir, "dist.next")));
    assert.equal(read("dist.prev/index.html"), "old shell", "the previous build is kept for a rollback");

    // Nothing to swap is an error, not a silent no-op.
    assert.throws(() => execFileSync("bash", [path.join(ROOT, "scripts", "swap-dist.sh"), dir], { stdio: "pipe" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
