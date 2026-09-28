// docs/design-system.md tells authors which shared classes to reach for.
// Every one it names has to exist in app.css, or code that follows the
// doc renders with browser defaults (that's how the claim-objection
// textarea on /claims ended up unstyled).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("every primitive the design-system doc names is defined in app.css", () => {
  const doc = fs.readFileSync(path.join(root, "docs", "design-system.md"), "utf8");
  const section = doc.split(/^## UI Primitives\s*$/m)[1].split(/^## /m)[0];
  const classes = [...section.matchAll(/`\.([\w-]+)`/g)].map((m) => m[1]);
  assert.ok(classes.length >= 5, "didn't find the primitives list, has the doc moved?");

  const css = fs.readFileSync(path.join(root, "src", "styles", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const missing = classes.filter((c) => !new RegExp(`(^|[\\s,}>+~(])\\.${c}(?![\\w-])[^{;]*\\{`, "m").test(css));
  assert.deepEqual(missing, []);
});
