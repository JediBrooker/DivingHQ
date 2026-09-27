// A key the templates ask for that no locale has shows up as the raw key
// ("my_region.members") in every language: vue-i18n runs with
// missingWarn off, and the parity test only compares locale files with
// each other, so a key renamed on one branch and still used on another
// slips through both. This walks src/ for literal t('a.b') / $t('a.b')
// calls and checks en.json has each one. Dynamic keys (template strings,
// variables) can't be checked this way and are left alone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const en = JSON.parse(fs.readFileSync(path.join(root, "src/locales/en.json"), "utf8"));

function has(key) {
  let cur = en;
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object" || !(part in cur)) return false;
    cur = cur[part];
  }
  return typeof cur === "string";
}

function sources(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) sources(p, out);
    else if (/\.(vue|js)$/.test(f)) out.push(p);
  }
  return out;
}

test("every literal i18n key used in src/ exists in en.json", () => {
  const call = /(?<![\w$])\$?t\(\s*['"]([a-z][\w-]*(?:\.[\w-]+)+)['"]/g;
  const missing = [];
  for (const file of sources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(call)) {
      if (!has(m[1])) missing.push(`${path.relative(root, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], "keys the UI would print raw");
});
