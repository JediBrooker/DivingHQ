// deploy.sh leaves the old process running against the new schema until
// the tests pass and PM2 restarts. scripts/migration-compat.js lists the
// migrations that break that old process, and deploy.sh has to stop on
// them rather than promise every migration is additive (094 wasn't: the
// previous lib/records.js couldn't write a single record against it).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { BREAKS_PREVIOUS_CODE, breakingAmong } = require("../scripts/migration-compat");

const root = path.join(__dirname, "..");

test("094 is on the list of migrations the running code can't live with", () => {
  assert.ok(BREAKS_PREVIOUS_CODE[94], "094 swapped the records unique keys");
  assert.deepEqual(breakingAmong([93, 94, 95]).map((b) => b.version), [94]);
  assert.deepEqual(breakingAmong([95, 96]), []);
});

test("every listed version is a real migration file", () => {
  const versions = new Set(
    fs.readdirSync(path.join(root, "migrations"))
      .map((f) => f.match(/^(\d+)_.*\.sql$/))
      .filter(Boolean)
      .map((m) => Number(m[1])),
  );
  for (const v of Object.keys(BREAKS_PREVIOUS_CODE)) assert.ok(versions.has(Number(v)), `migration ${v} exists`);
});

test("deploy.sh checks before migrating and doesn't call every migration safe to leave", () => {
  const sh = fs.readFileSync(path.join(root, "deploy.sh"), "utf8");
  const check = sh.indexOf("--check-breaking");
  const apply = sh.indexOf('step "migrate (apply)"');
  assert.ok(check > 0 && check < apply, "the compatibility check runs before the migrations apply");
  assert.match(sh, /--allow-breaking\) ALLOW_BREAKING=1/);
  assert.ok(!sh.includes("any migrations applied in this run are additive and safe to leave"));
  assert.ok(!/Every migration in this repo is additive/.test(sh));
  const runner = fs.readFileSync(path.join(root, "scripts", "migrate.js"), "utf8");
  assert.match(runner, /--check-breaking/);
  assert.match(runner, /process\.exitCode = 3/);
});
