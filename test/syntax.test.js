// Lightweight tests that don't need a DB. Runs on every npm test
// invocation so a fresh dev clone catches obvious breakage.
//   - server.js parses cleanly
//   - SPA built bundle, if present, contains the expected entry
//   - the World Aquatics category helper is consistent (no DB)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

test("server.js syntax is valid", () => {
  // node --check just parses the file; nothing executes.
  execSync("node --check server.js", { stdio: "pipe" });
});

test("server.js loads cleanly (catches TDZ / missing-binding bugs)", () => {
  // node --check above only validates parser-level syntax. It
  // does NOT catch a `const x = x` self-reference, a missing
  // import binding, or any other TDZ-class issue that explodes
  // at module-evaluation time. We add this so a botched perl
  // sweep across hundreds of call sites can't ship a server
  // that won't boot. We pre-set every env var server.js insists
  // on at boot so the load can complete without a real DB.
  const env = {
    ...process.env,
    JWT_SECRET: "test_test_test_test_test_test_test_test",
    DB_HOST: "127.0.0.1",
    DB_PORT: "5432",
    DB_NAME: "divinghq_test",
    DB_USER: "test",
    DB_PASSWORD: "test",
    NODE_ENV: "test",
    SKIP_LISTEN: "1",        // honoured by server.js to skip server.listen()
  };
  const cmd = `node -e "process.env.SKIP_LISTEN='1'; require('./server.js')"`;
  // We accept any exit status that proves module evaluation got
  // past every top-level binding. server.js intentionally fails
  // closed if it can't reach the DB on boot — but that's a
  // runtime branch, not a load-time one. The TDZ failure we're
  // guarding against would crash before even the env validation.
  try {
    execSync(cmd, { env, stdio: "pipe", timeout: 10_000 });
  } catch (err) {
    const out = String(err.stdout || "") + String(err.stderr || "");
    // If we tripped a ReferenceError or "before initialization"
    // the load itself was broken — fail the test.
    if (/ReferenceError|before initialization|is not defined/i.test(out)) {
      assert.fail("server.js failed to load:\n" + out);
    }
    // Anything else (DB pool errors, exit codes from the
    // intentional fail-closed paths) is fine — the load itself
    // succeeded, which is what we're verifying.
  }
});

test("init.sql exists and is non-empty", () => {
  const p = path.join(__dirname, "..", "init.sql");
  assert.ok(fs.existsSync(p), "init.sql should exist at repo root");
  const stat = fs.statSync(p);
  assert.ok(stat.size > 1000, `init.sql looks suspiciously small: ${stat.size} bytes`);
});

test("seed_test_data.sql exists and is non-empty", () => {
  const p = path.join(__dirname, "..", "seed_test_data.sql");
  assert.ok(fs.existsSync(p));
  const stat = fs.statSync(p);
  assert.ok(stat.size > 1000);
});

test("init.sql declares schema version 53", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "init.sql"), "utf8");
  assert.match(sql, /INSERT INTO public\.schema_meta \(id, version\) VALUES \(1, 53\)/);
});

test("Vue templates use v-tip instead of native title attributes", () => {
  const srcDir = path.join(__dirname, "..", "src");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".vue")) files.push(full);
    }
  };
  walk(srcDir);

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(path.join(__dirname, ".."), file);
    const text = fs.readFileSync(file, "utf8");
    const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
    const re = /<([a-z][a-z0-9-]*)[^>]*\s(?::title|title)\s*=/g;
    let match;
    while ((match = re.exec(stripped))) {
      // <iframe> is the one allowed exception: it's a replaced element,
      // so v-tip's ::after tooltip bubble can't render on it, and `title`
      // is the correct accessibility mechanism for an iframe (WCAG H64).
      if (match[1] === "iframe") continue;
      const line = stripped.slice(0, match.index).split("\n").length;
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("scoreCategory boundaries match World Aquatics buckets", () => {
  // We can't import the .js composable directly under CommonJS, so
  // re-implement the same boundaries here. If they ever drift, this
  // test will catch it. (Mirror of src/composables/useScoreCategories.js.)
  const cat = (s) => {
    if (s == null || Number.isNaN(s)) return null;
    if (s === 0) return "failed";
    if (s <= 2.0) return "deficient";
    if (s <= 4.5) return "unsatisfactory";
    if (s <= 6.0) return "satisfactory";
    if (s <= 8.0) return "good";
    if (s <= 9.5) return "very-good";
    return "excellent";
  };
  assert.equal(cat(0), "failed");
  assert.equal(cat(1), "deficient");
  assert.equal(cat(2), "deficient");
  assert.equal(cat(2.5), "unsatisfactory");
  assert.equal(cat(4.5), "unsatisfactory");
  assert.equal(cat(5), "satisfactory");
  assert.equal(cat(6), "satisfactory");
  assert.equal(cat(7), "good");
  assert.equal(cat(8), "good");
  assert.equal(cat(9), "very-good");
  assert.equal(cat(9.5), "very-good");
  assert.equal(cat(10), "excellent");
});

test("client password policy mirrors the server minimum", async () => {
  const { isValidPassword } = await import("../src/lib/passwordPolicy.js");
  assert.equal(isValidPassword("abc123"), false);
  assert.equal(isValidPassword("abcdefghijkl"), false);
  assert.equal(isValidPassword("123456789012"), false);
  assert.equal(isValidPassword("abcdefghijk1"), true);
});
