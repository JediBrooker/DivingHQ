// Per-route tab titles (src/lib/pageTitle.js). Pure, so the ESM module is
// imported straight into node:test like the other src/ helpers.

const { test } = require("node:test");
const assert = require("node:assert/strict");

let formatTitle, routeTitle, APP_NAME;

test.before(async () => {
  ({ formatTitle, routeTitle, APP_NAME } = await import("../src/lib/pageTitle.js"));
});

const dict = {
  "auth.login.title": "Sign In",
  "home.meta_title": "Diving competition software for clubs and federations",
};
const t = (key) => dict[key] ?? key;

test("a route with a title key reads '<page> · DivingHQ'", () => {
  assert.equal(routeTitle({ meta: { titleKey: "auth.login.title" } }, t), "Sign In · DivingHQ");
});

test("the home page puts the brand first", () => {
  assert.equal(
    routeTitle({ meta: { titleKey: "home.meta_title", brandFirst: true } }, t),
    "DivingHQ · Diving competition software for clubs and federations",
  );
});

test("no title, or a key the dictionary doesn't have, stays generic", () => {
  assert.equal(APP_NAME, "DivingHQ");
  assert.equal(routeTitle({ meta: {} }, t), "DivingHQ");
  assert.equal(routeTitle({}, t), "DivingHQ");
  assert.equal(routeTitle(null, t), "DivingHQ");
  // vue-i18n hands back the key itself when it's missing; never show that.
  assert.equal(routeTitle({ meta: { titleKey: "nope.not_here" } }, t), "DivingHQ");
});

test("formatTitle trims and ignores blanks", () => {
  assert.equal(formatTitle("  Quick Start  "), "Quick Start · DivingHQ");
  assert.equal(formatTitle(""), "DivingHQ");
  assert.equal(formatTitle(undefined), "DivingHQ");
});

// Every page the sitemap sends crawlers to gets a real title, not just
// "DivingHQ". /records came in on another branch without one.
test("every sitemap page's route has a title key", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const router = fs.readFileSync(path.join(root, "src", "router", "index.js"), "utf8");
  const en = JSON.parse(fs.readFileSync(path.join(root, "src", "locales", "en.json"), "utf8"));
  const xml = fs.readFileSync(path.join(root, "public", "sitemap.xml"), "utf8");
  const paths = [...xml.matchAll(/<loc>https:\/\/divinghq\.app([^<]*)<\/loc>/g)]
    .map((m) => m[1] || "/")
    .filter((p) => !p.startsWith("/guide/"));   // one route, checked via /guide/:topic
  for (const p of [...new Set(paths)]) {
    const esc = p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    // The first route whose path is this one, optionally with params after it.
    const m = router.match(new RegExp(`path: '${esc}(?:/:[^']*)?',[\\s\\S]*?meta: \\{([^}]*)\\}`));
    assert.ok(m, `no route for ${p}`);
    const key = m[1].match(/titleKey: '([^']+)'/)?.[1];
    assert.ok(key, `${p} has no titleKey`);
    assert.ok(key.split(".").reduce((o, k) => o?.[k], en), `${p}: ${key} isn't in en.json`);
  }
});
