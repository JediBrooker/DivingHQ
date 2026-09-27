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
