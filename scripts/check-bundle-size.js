#!/usr/bin/env node
// Bundle-size gate (P0). After `vite build`, asserts that the entry
// chunk, the three named vendor chunks, AND the per-route ControlView
// chunk stay at or under the ceilings frozen in
// scripts/bundle-size-baseline.json. Ceilings carry ~15% headroom over
// the size measured when the baseline was written, so ordinary churn
// passes and only a real weight regression -- e.g. a heavy import
// landing on the live /control route -- trips the gate.
//
//   node scripts/check-bundle-size.js            -> check (needs dist/)
//   node scripts/check-bundle-size.js --update   -> rewrite baseline from dist/
//
// Generate the baseline from a flag-on build so it matches CI:
//   VITE_OFFLINE_OUTBOX_ENABLED=1 npm run build && node scripts/check-bundle-size.js --update
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const ASSETS = path.join(REPO_ROOT, "dist", "assets");
const BASELINE = path.join(__dirname, "bundle-size-baseline.json");

// logical chunk -> filename matcher (Vite hashes as <name>-<hash>.js)
const CHUNKS = {
  entry: /^index-.*\.js$/,
  "vendor-vue": /^vendor-vue-.*\.js$/,
  "vendor-i18n": /^vendor-i18n-.*\.js$/,
  "vendor-socket": /^vendor-socket-.*\.js$/,
  // Matches the per-route Control Room chunk in EITHER build: the V2
  // ControlViewV2 (the cutover default) or the legacy ControlView (the
  // VITE_CONTROL_V2=off rollback). Only one ships per build.
  control: /^ControlView(V2)?-.*\.js$/,
};

function measure(assetsDir) {
  let files = [];
  try {
    files = fs.readdirSync(assetsDir);
  } catch {
    files = [];
  }
  const out = {};
  for (const [name, re] of Object.entries(CHUNKS)) {
    out[name] = files
      .filter((f) => re.test(f))
      .reduce((sum, f) => sum + fs.statSync(path.join(assetsDir, f)).size, 0);
  }
  return out;
}

function ceilingFor(bytes) {
  // 15% headroom, rounded up to the next KiB
  return Math.ceil((bytes * 1.15) / 1024) * 1024;
}

function evaluate(sizes, baseline) {
  const failures = [];
  for (const [name, ceiling] of Object.entries(baseline.ceilings || {})) {
    const cur = sizes[name] || 0;
    if (cur === 0) failures.push({ name, kind: "missing", cur, ceiling });
    else if (cur > ceiling) failures.push({ name, kind: "over", cur, ceiling });
  }
  return failures;
}

function kib(n) {
  return `${(n / 1024).toFixed(1)} KiB`;
}

function main() {
  const sizes = measure(ASSETS);
  if (process.argv.includes("--update")) {
    const ceilings = {};
    for (const [name, bytes] of Object.entries(sizes)) ceilings[name] = ceilingFor(bytes);
    fs.writeFileSync(
      BASELINE,
      JSON.stringify({ generated: "P0 baseline", measured: sizes, ceilings }, null, 2) + "\n",
    );
    console.log("[check:size] baseline updated:");
    for (const [name, bytes] of Object.entries(sizes)) {
      console.log(`  ${name}: ${kib(bytes)} (ceiling ${kib(ceilings[name])})`);
    }
    return;
  }
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  } catch {
    console.error("[check:size] no baseline - run: node scripts/check-bundle-size.js --update");
    process.exit(2);
  }
  const failures = evaluate(sizes, baseline);
  if (failures.length) {
    console.error("[check:size] bundle budget exceeded:");
    for (const f of failures) {
      if (f.kind === "missing") {
        console.error(`  ${f.name}: chunk not found in dist/assets (renamed? build skipped?)`);
      } else {
        console.error(`  ${f.name}: ${kib(f.cur)} > ceiling ${kib(f.ceiling)}`);
      }
    }
    process.exit(1);
  }
  console.log("[check:size] OK - all tracked chunks within budget:");
  for (const [name, ceiling] of Object.entries(baseline.ceilings)) {
    console.log(`  ${name}: ${kib(sizes[name] || 0)} / ${kib(ceiling)}`);
  }
}

module.exports = { measure, evaluate, ceilingFor, CHUNKS };

if (require.main === module) main();
