#!/usr/bin/env node
// Local verification runner.
//
// Encodes the repo's required pre-push checks in one command:
//   npm run verify:local
//
// Pass `--e2e` followed by Playwright args to append a focused
// browser run after the non-browser checks, for example:
//   npm run verify:local -- --e2e test/e2e/authz-privileged-writes.spec.js --project=chromium

const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage:
  npm run verify:local
  npm run verify:local -- --e2e [playwright args...]

Runs:
  1. npm run lint
  2. npm run build
  3. npm run test:safe
  4. optional: npx playwright test [playwright args...]`);
  process.exit(0);
}

const e2eIndex = args.indexOf("--e2e");
const e2eArgs = e2eIndex === -1 ? null : args.slice(e2eIndex + 1);
const unknown = e2eIndex === -1 ? args : args.slice(0, e2eIndex);

if (unknown.length) {
  console.error(`[verify:local] Unknown argument(s): ${unknown.join(" ")}`);
  console.error("[verify:local] Use --e2e to pass Playwright arguments.");
  process.exit(2);
}

function run(label, command, commandArgs) {
  console.log(`\n[verify:local] ${label}`);
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (result.status !== 0) {
    const code = typeof result.status === "number" ? result.status : 1;
    console.error(`\n[verify:local] ${label} failed with exit code ${code}`);
    process.exit(code);
  }
}

run("lint", "npm", ["run", "lint"]);
run("build", "npm", ["run", "build"]);
run("test:safe", "npm", ["run", "test:safe"]);

if (e2eArgs) {
  run(
    e2eArgs.length ? `e2e: ${e2eArgs.join(" ")}` : "e2e",
    "npx",
    ["playwright", "test", ...e2eArgs],
  );
}

console.log("\n[verify:local] all checks passed");
