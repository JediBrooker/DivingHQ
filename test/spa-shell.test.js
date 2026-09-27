// The SEO plumbing that doesn't need a server: the shell rewrite that gives
// every deep link its own canonical URL (lib/spa-shell.js), and the sitemap
// staying in step with the guide. The HTTP side (robots.txt and sitemap.xml
// answered as files, not the SPA shell) is in test/integration.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { renderShell, publicOrigin, HOSTED_ORIGIN } = require("../lib/spa-shell");

const ROOT = path.join(__dirname, "..");
// The source shell. Vite leaves the head tags alone, so this is what
// dist/index.html carries too.
const SHELL = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const canonical = (html) => html.match(/<link rel="canonical" href="([^"]*)">/)?.[1];
const ogUrl = (html) => html.match(/<meta property="og:url" content="([^"]*)">/)?.[1];

test("the shell has the tags renderShell rewrites, and no stale notes", () => {
  assert.equal(canonical(SHELL), "https://divinghq.app/");
  assert.equal(ogUrl(SHELL), "https://divinghq.app/");
  for (const tag of ['name="description"', 'property="og:title"', 'property="og:image"', 'name="twitter:card"']) {
    assert.ok(SHELL.includes(tag), `index.html is missing ${tag}`);
  }
  assert.match(SHELL, /<meta name="twitter:card" content="summary_large_image">/);
  assert.ok(fs.existsSync(path.join(ROOT, "public", "og-image.png")), "og:image points at a file that exists");
  assert.doesNotMatch(SHELL, /public\/index\.html/, "the old developer note is gone");
});

test("each deep link gets its own canonical URL and og:url", () => {
  const out = renderShell(SHELL, { origin: HOSTED_ORIGIN, path: "/guide/faq" });
  assert.equal(canonical(out), "https://divinghq.app/guide/faq");
  assert.equal(ogUrl(out), "https://divinghq.app/guide/faq");
  // Nothing else in the page moves.
  assert.equal(out.replace(/guide\/faq/g, ""), SHELL);
});

test("a self-hosted origin replaces the hosted one everywhere", () => {
  const out = renderShell(SHELL, { origin: "https://diving.example.org", path: "/privacy" });
  assert.equal(canonical(out), "https://diving.example.org/privacy");
  assert.match(out, /<meta property="og:image" content="https:\/\/diving\.example\.org\/og-image\.png">/);
  assert.ok(!out.includes(HOSTED_ORIGIN), "no divinghq.app URLs left behind");
});

test("the requested path can't break out of the attribute", () => {
  const out = renderShell(SHELL, { path: '/x"><script>alert(1)</script>' });
  assert.equal(canonical(out), "https://divinghq.app/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.ok(!out.includes("<script>alert(1)"));
  // A "$&" in the path is text, not a replacement pattern.
  assert.equal(canonical(renderShell(SHELL, { path: "/a$&b" })), "https://divinghq.app/a$&amp;b");
  assert.equal(canonical(renderShell(SHELL, { path: "no-slash" })), "https://divinghq.app/");
});

test("publicOrigin reads APP_BASE_URL and ignores junk", () => {
  assert.equal(publicOrigin({ APP_BASE_URL: "https://divinghq.app/some/path" }), "https://divinghq.app");
  assert.equal(publicOrigin({ APP_BASE_URL: "http://127.0.0.1:3097" }), "http://127.0.0.1:3097");
  assert.equal(publicOrigin({}), HOSTED_ORIGIN);
  assert.equal(publicOrigin({ APP_BASE_URL: "not a url" }), HOSTED_ORIGIN);
  assert.equal(publicOrigin({ APP_BASE_URL: "javascript:alert(1)" }), HOSTED_ORIGIN);
});

test("robots.txt keeps crawlers off the API and points at the sitemap", () => {
  const robots = fs.readFileSync(path.join(ROOT, "public", "robots.txt"), "utf8");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Sitemap: https:\/\/divinghq\.app\/sitemap\.xml$/m);
});

test("the sitemap lists the public pages and every guide topic", () => {
  const xml = fs.readFileSync(path.join(ROOT, "public", "sitemap.xml"), "utf8");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const loc of locs) assert.ok(loc.startsWith("https://divinghq.app/"), loc);
  assert.equal(new Set(locs).size, locs.length, "no duplicates");
  const paths = new Set(locs.map((l) => l.slice("https://divinghq.app".length)));
  for (const p of ["/", "/guide", "/login", "/register", "/register-org", "/privacy", "/terms", "/records", "/scoreboard", "/judges"]) {
    assert.ok(paths.has(p), `sitemap is missing ${p}`);
  }
  // Every topic the guide ships, by its slug in topics.js. Adding a topic
  // without listing it here fails this test.
  const topics = fs.readFileSync(path.join(ROOT, "src", "guide", "topics.js"), "utf8");
  const slugs = [...topics.matchAll(/slug: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(slugs.length >= 10, "found the guide topics");
  for (const slug of slugs) assert.ok(paths.has(`/guide/${slug}`), `sitemap is missing /guide/${slug}`);
});
