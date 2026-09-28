// docs/socket-events.md is meant to be the whole wire surface in one file
// (AGENTS.md: update it in the same commit as the event). It had drifted
// by about fifteen events, including a client-writable one. This scans the
// server for every event name it listens for or emits and wants each one
// documented.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function serverSources() {
  const out = [path.join(root, "server.js")];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(root, "routes"));
  walk(path.join(root, "lib"));
  return out;
}

test("every socket event the server listens for or emits is in docs/socket-events.md", () => {
  const names = new Set();
  for (const f of serverSources()) {
    // Comments show made-up usage (lib/idempotency.js), not real traffic.
    const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of code.matchAll(/socket\.on\(\s*["']([\w:.-]+)["']/g)) names.add(m[1]);
    for (const m of code.matchAll(/\.emit\(\s*["']([\w:.-]+)["']/g)) names.add(m[1]);
    for (const m of code.matchAll(/emitEvent\??\.?\(\s*[^,]+,\s*["']([\w:.-]+)["']/g)) names.add(m[1]);
  }
  for (const builtin of ["connection", "disconnect"]) names.delete(builtin);
  assert.ok(names.size > 20, `only found ${names.size} events, has the scan broken?`);

  const doc = fs.readFileSync(path.join(root, "docs", "socket-events.md"), "utf8");
  const missing = [...names].filter((n) => !doc.includes("`" + n + "`")).sort();
  assert.deepEqual(missing, []);
});
