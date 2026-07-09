// Cross-browser smoke spec.
//
// Runs against two non-Chromium engine profiles:
//   * firefox            - desktop Firefox / Gecko
//   * mobile-chrome      - Pixel 7 / Chromium with mobile UA
//
// (Mobile WebKit / iOS Safari is covered in detail by
// mobile-safari.spec.js, that one tests iOS-specific
// attributes the other engines don't surface.)
//
// What we're guarding against is silent regression on browsers
// that don't support the newer CSS features we lean on. The iOS
// Safari passes 1-10 added `dvh` viewport units, `-webkit-tap-
// highlight-color`, and `@media (hover: hover)` rules. Each has
// a fallback for older engines, and this spec just checks those
// fallbacks actually fire.
//
// Specifically:
//   * 100dvh body min-height has a 100vh fallback line so
//     pre-Q4-2022 browsers don't end up with no min-height at
//     all.
//   * Login form mounts and the Sign-In button is reachable.
//   * No console errors during render.
//   * No horizontal overflow.
//   * Page renders without the Vue mount silently failing on a
//     missing CSS feature.

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "parallel" });

async function gotoLogin(page) {
  await page.goto("/login");
  await expect(
    page.locator('input[autocomplete="username"]'),
  ).toBeVisible();
}

test("login page renders and Sign-In button is reachable", async ({ page }) => {
  await gotoLogin(page);

  const button = page.getByRole("button", { name: /sign in|log in/i });
  await expect(button).toBeVisible();

  // Body should have a sane min-height. We don't care whether
  // it's computed from `vh` or `dvh`, just that the resolved
  // value is non-zero and at least the viewport height (i.e.
  // the fallback line didn't get dropped).
  const minHeight = await page.locator("body").evaluate(
    (el) => parseFloat(getComputedStyle(el).minHeight),
  );
  const viewportHeight = page.viewportSize().height;
  expect(minHeight, "body min-height >= viewport height")
    .toBeGreaterThanOrEqual(viewportHeight - 1);
});

test("no horizontal overflow on the login page", async ({ page }) => {
  await gotoLogin(page);
  const widths = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    viewW: document.documentElement.clientWidth,
  }));
  expect(widths.docW).toBeLessThanOrEqual(widths.viewW);
});

test("page renders without console errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  await gotoLogin(page);
  await page.waitForLoadState("networkidle");

  // Same noise filter as mobile-safari.spec: Google Fonts,
  // service worker, TLS errors from preconnects are all
  // out of our control in the local test environment.
  const ours = errors.filter((e) =>
    !/fonts\.gstatic\.com|fonts\.googleapis\.com|service.worker|TLS error|Failed to load resource|NS_ERROR|net::ERR/i.test(e)
  );
  expect(ours, ours.join("\n")).toEqual([]);
});

test("login form inputs accept text (engine doesn't break event handling)", async ({ page }) => {
  await gotoLogin(page);
  // Type into the username field - if Vue's v-model is broken
  // under this engine, this fails outright. Catches the kind
  // of "SPA mounts but is dead" regression we'd otherwise miss.
  const username = page.locator('input[autocomplete="username"]');
  await username.fill("test-user");
  await expect(username).toHaveValue("test-user");
});
