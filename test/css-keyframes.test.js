// Every `animation:` in the source has to name keyframes it can actually
// see once Vue has scoped the styles.
//
// Vue renames @keyframes inside a <style scoped> block (pulse-red becomes
// pulse-red-871b59e9) and rewrites only the references in that same block.
// So a name defined in one scoped block is invisible to every other file,
// and a global rule or another component pointing at it silently animates
// nothing. That's how the LIVE badges stopped pulsing. A name resolves if
// it's in the same block or in a global stylesheet.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Pull every style block out of the tree as { file, scoped, css }.
function styleBlocks() {
  const files = walk(SRC);
  const blocks = [];
  // src/styles/* are imported from main.js, so they're global.
  for (const f of files.filter((f) => f.startsWith(path.join(SRC, "styles")) && f.endsWith(".css"))) {
    blocks.push({ file: f, scoped: false, css: fs.readFileSync(f, "utf8") });
  }
  for (const f of files.filter((f) => f.endsWith(".vue"))) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
      const attrs = m[1];
      let css = m[2];
      const src = attrs.match(/src="([^"]+)"/);
      if (src) css += fs.readFileSync(path.resolve(path.dirname(f), src[1]), "utf8");
      blocks.push({ file: f, scoped: /\bscoped\b/.test(attrs), css });
    }
  }
  return blocks;
}

const NOT_A_NAME = new Set([
  "none", "infinite", "normal", "reverse", "alternate", "alternate-reverse",
  "forwards", "backwards", "both", "running", "paused", "linear", "ease",
  "ease-in", "ease-out", "ease-in-out", "step-start", "step-end", "initial",
  "inherit", "unset",
]);

function animationNames(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = [];
  for (const m of clean.matchAll(/(?:^|[;{\s])animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    // Functions (cubic-bezier, steps, var) carry commas and numbers of
    // their own, drop them before splitting the list.
    const value = m[1].replace(/[\w-]+\([^)]*\)/g, " ");
    for (const part of value.split(",")) {
      for (const tok of part.trim().split(/\s+/)) {
        if (!tok || NOT_A_NAME.has(tok) || /^-?[\d.]/.test(tok) || tok.startsWith("!")) continue;
        if (/^[a-zA-Z_-][\w-]*$/.test(tok)) names.push(tok);
      }
    }
  }
  return names;
}

const keyframesIn = (css) => new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));

test("every animation name resolves to keyframes it can see", () => {
  const blocks = styleBlocks();
  const global = new Set();
  for (const b of blocks.filter((b) => !b.scoped)) for (const k of keyframesIn(b.css)) global.add(k);

  const missing = [];
  for (const b of blocks) {
    const local = keyframesIn(b.css);
    for (const name of animationNames(b.css)) {
      if (!local.has(name) && !global.has(name)) {
        missing.push(`${path.relative(SRC, b.file)}: ${name}`);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], "animations pointing at keyframes they can't see");
});

test("the name parser skips timing keywords and functions", () => {
  assert.deepEqual(animationNames(".a{animation: pulse-red 1.6s ease-in-out infinite}"), ["pulse-red"]);
  assert.deepEqual(animationNames(".a{animation: fadeUp 0.3s cubic-bezier(0.2, 0, 0, 1), spin 1s linear infinite}"), ["fadeUp", "spin"]);
  assert.deepEqual(animationNames(".a{animation: none}"), []);
});
