#!/usr/bin/env node
// Test discovery runner (P0). Replaces the hand-maintained file arrays
// that package.json's "test"/"test:safe" used to carry, so new
// test/*.test.js files get picked up automatically and can never be
// silently orphaned again (the bug that left test/scoring-sql.test.js
// running in ZERO scripts despite sitting on disk for weeks).
//
//   node scripts/run-tests.js full   -> every test/*.test.js (CI, with DB)
//   node scripts/run-tests.js safe   -> all except *.integration.test.js
//                                       (deploy.sh / verify:local). DB-backed
//                                       units in this set self-skip when
//                                       Postgres is unreachable, e.g.
//                                       calc.test.js / integration paths.
//
// "safe" excludes any file whose name carries `integration` as a dotted
// segment: foo.integration.test.js AND the legacy integration.test.js.
// Everything else, including the pure, DB-less scoring-sql.test.js,
// runs in both. This reproduces the previous curated split exactly while
// adding scoring-sql.test.js to both lists.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TEST_DIR = path.join(__dirname, "..", "test");
const INTEGRATION = /(^|\.)integration\.test\.js$/;

function discover(mode) {
  const all = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .sort();
  const files = mode === "safe" ? all.filter((f) => !INTEGRATION.test(f)) : all;
  return files.map((f) => path.join("test", f));
}

function main() {
  const mode = process.argv[2];
  if (mode !== "full" && mode !== "safe") {
    console.error("Usage: node scripts/run-tests.js <full|safe>");
    process.exit(2);
  }
  const files = discover(mode);
  if (!files.length) {
    console.error(`[run-tests] no test files found for mode=${mode}`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { discover, INTEGRATION };

if (require.main === module) main();
