// A <style scoped> block that animates with a keyframes name it doesn't
// define itself only works if that name exists globally. Vue hashes the
// names of keyframes declared in scoped blocks (pulse-red becomes
// pulse-red-a0b0ed32) and only rewrites references in the same block, so
// borrowing one from another component's scoped CSS silently does
// nothing. That's how MeetsBrowser's LIVE badges stopped pulsing. DB-less.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const KEYWORDS = new Set([
  "infinite", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "alternate",
  "alternate-reverse", "forwards", "backwards", "both", "none", "normal", "reverse",
  "running", "paused", "step-start", "step-end", "inherit", "initial", "unset",
]);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const keyframesIn = (css) => new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
function animationNames(css) {
  const names = [];
  for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+/)
        .find((t) => /^-?[a-zA-Z_][\w-]*$/.test(t) && !KEYWORDS.has(t) && !/^(cubic-bezier|steps|var)\(/.test(t));
      if (name) names.push(name);
    }
  }
  return names;
}

test("scoped styles only animate with keyframes they can actually reach", () => {
  const files = walk(SRC);
  const globalKeyframes = new Set();
  const scoped = [];
  // src/styles/*.css is imported globally from main.js. Its own
  // animations can only reach global keyframes too, so it gets checked
  // like a scoped block with nothing local.
  for (const f of files.filter((f) => f.startsWith(path.join(SRC, "styles")) && f.endsWith(".css"))) {
    const css = fs.readFileSync(f, "utf8");
    for (const k of keyframesIn(css)) globalKeyframes.add(k);
    scoped.push({ file: path.relative(SRC, f), css: css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "") });
  }
  for (const f of files.filter((f) => f.endsWith(".vue"))) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>|<style([^>]*)\/>/g)) {
      const attrs = m[1] ?? m[3] ?? "";
      const src = /src="([^"]+)"/.exec(attrs)?.[1];
      const css = src ? fs.readFileSync(path.resolve(path.dirname(f), src), "utf8") : (m[2] || "");
      if (/\bscoped\b/.test(attrs)) scoped.push({ file: path.relative(SRC, f), css });
      else for (const k of keyframesIn(css)) globalKeyframes.add(k);
    }
  }
  const missing = [];
  for (const { file, css } of scoped) {
    const local = keyframesIn(css);
    for (const name of animationNames(css)) {
      if (!local.has(name) && !globalKeyframes.has(name)) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
