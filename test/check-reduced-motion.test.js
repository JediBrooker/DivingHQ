// Self-tests for the P0 reduced-motion gate, DB-less so it runs in test:safe.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findUnguardedSites, diff } = require("../scripts/check-reduced-motion.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rm-gate-"));
}

test("flags a recurring (infinite) animation with no reduced-motion guard", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "a.css"), ".x{ animation: spin 2s linear infinite; }");
  const sites = findUnguardedSites(d);
  assert.equal(sites.length, 1);
  assert.match(sites[0].decl, /infinite/);
});

test("does NOT flag when the owning file has a reduced-motion guard", () => {
  const d = tmp();
  fs.writeFileSync(
    path.join(d, "b.css"),
    ".x{ animation: spin 2s linear infinite; }\n" +
      "@media (prefers-reduced-motion: reduce){ .x{ animation: none; } }",
  );
  assert.equal(findUnguardedSites(d).length, 0);
});

test("does NOT flag a one-shot (non-infinite) animation", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "c.css"), ".x{ animation: fadeUp .3s ease both; }");
  assert.equal(findUnguardedSites(d).length, 0);
});

test("detects infinite expressed via animation-iteration-count", () => {
  const d = tmp();
  fs.writeFileSync(
    path.join(d, "e.vue"),
    "<style>.y{ animation-name: pulse; animation-iteration-count: infinite; }</style>",
  );
  assert.equal(findUnguardedSites(d).length, 1);
});

test("diff reports only sites missing from the baseline", () => {
  const current = [{ key: "a::x" }, { key: "b::y" }];
  const { added } = diff(current, ["a::x"]);
  assert.deepEqual(added.map((s) => s.key), ["b::y"]);
});
