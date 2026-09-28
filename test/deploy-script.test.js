// deploy.sh builds the SPA somewhere the running server can't see it and
// only swaps it into dist/ right before the restart. Building straight
// into dist/ (vite empties it first) handed the old process the new
// index.html and deleted the chunks open tabs still needed, for as long
// as migrate and the tests took, and for good if either one stopped the
// deploy.
//
// Two checks: the step order in a --dry run (in a throwaway git repo, so
// the dirty-tree guard doesn't trip over whatever this checkout has
// uncommitted), and scripts/swap-dist.sh itself against a fake dist/.

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
    const out = execFileSync("bash", [path.join(dir, "deploy.sh"), "--dry"], { cwd: dir, encoding: "utf8" });
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
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HEALTH_TIMEOUT_S: "1" },
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
  } finally {
    for (const d of [dir, origin, bin]) fs.rmSync(d, { recursive: true, force: true });
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
