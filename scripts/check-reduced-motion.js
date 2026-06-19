#!/usr/bin/env node
// Reduced-motion gate (P0). Fails when NEW recurring (infinite)
// animation is added without a `prefers-reduced-motion` escape hatch in
// its owning file. Burn-down model: the current known-unguarded set is
// frozen in scripts/reduced-motion-baseline.json, so the gate is green
// today and only fails on sites not already baselined. Fixing a
// baselined site and re-running with --update shrinks the list; in
// review the list may only shrink.
//
//   node scripts/check-reduced-motion.js            -> check (CI gate)
//   node scripts/check-reduced-motion.js --update   -> rewrite baseline
//
// Scope: src/**/*.{css,vue}. "Recurring" = an `animation` shorthand that
// runs `infinite`, or `animation-iteration-count: infinite`. A file is
// considered guarded if it contains an
// `@media (prefers-reduced-motion: reduce)` block. This is the
// enforcement primitive P1 burns down against.
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const DEFAULT_ROOT = path.join(REPO_ROOT, "src");
const BASELINE = path.join(__dirname, "reduced-motion-baseline.json");
const RM_GUARD = /@media[^{]*prefers-reduced-motion\s*:\s*reduce/i;

function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => ent.name.endsWith(e))) out.push(full);
  }
  return out;
}

// Recurring-animation declarations: `animation: ... infinite ...` or an
// explicit `animation-iteration-count: infinite`.
function recurringDecls(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const isShorthand = /(^|[^-])animation\s*:\s*[^;]*\binfinite\b/i.test(line);
    const isCount = /animation-iteration-count\s*:\s*infinite/i.test(line);
    if (isShorthand || isCount) {
      const decl = line.trim().replace(/\s+/g, " ").replace(/;+$/, "");
      found.push({ line: i + 1, decl });
    }
  });
  return found;
}

function findUnguardedSites(rootDir) {
  const sites = [];
  for (const file of walk(rootDir, [".css", ".vue"])) {
    const text = fs.readFileSync(file, "utf8");
    const decls = recurringDecls(text);
    if (!decls.length || RM_GUARD.test(text)) continue;
    const rel = path.relative(rootDir, file).split(path.sep).join("/");
    for (const d of decls) {
      sites.push({ key: `${rel}::${d.decl}`, file: rel, line: d.line, decl: d.decl });
    }
  }
  sites.sort((a, b) => a.key.localeCompare(b.key));
  return sites;
}

function diff(current, baselineSites) {
  const base = new Set(baselineSites);
  const cur = new Set(current.map((s) => s.key));
  return {
    added: current.filter((s) => !base.has(s.key)),
    removed: [...base].filter((k) => !cur.has(k)),
  };
}

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  } catch {
    return { sites: [] };
  }
}

function main() {
  const sites = findUnguardedSites(DEFAULT_ROOT);
  if (process.argv.includes("--update")) {
    fs.writeFileSync(
      BASELINE,
      JSON.stringify(
        { generated: "P0 baseline", count: sites.length, sites: sites.map((s) => s.key) },
        null,
        2,
      ) + "\n",
    );
    console.log(`[check:motion] baseline updated: ${sites.length} known-unguarded recurring-animation site(s).`);
    return;
  }
  const { added, removed } = diff(sites, loadBaseline().sites);
  if (added.length) {
    console.error(
      `[check:motion] ${added.length} NEW unguarded recurring animation(s). Add an ` +
        `@media (prefers-reduced-motion: reduce) guard in the owning file:`,
    );
    for (const s of added) console.error(`  src/${s.file}:${s.line}  ${s.decl}`);
    process.exit(1);
  }
  if (removed.length) {
    console.log(`[check:motion] ${removed.length} baselined site(s) now fixed - run --update to shrink the baseline.`);
  }
  console.log("[check:motion] OK - no new unguarded recurring animation.");
}

module.exports = { findUnguardedSites, recurringDecls, diff };

if (require.main === module) main();
