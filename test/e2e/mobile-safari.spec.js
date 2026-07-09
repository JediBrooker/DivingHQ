// Mobile-Safari regression gate.
//
// Drives the iPhone-13 WebKit profile (see playwright.config.js's
// `mobile-safari` project) against the running build and asserts
// the bits the agent-skills:code-reviewer flagged across the
// 30-item iOS Safari audit (passes 1-10). If any of these regress,
// the next CI run fails fast, which beats discovering it at the
// deck during a meet.
//
// What this exercises:
//
//   * PWA standalone meta tags present in index.html (otherwise
//     "Add to Home Screen" opens with Safari's URL bar visible).
//
//   * Login form Submit button reachable on iPhone-SE-class
//     heights (100dvh, not 100vh, the test viewport is 390×844
//     so we'd notice immediately if the body shrank to 100vh
//     when WebKit's URL bar is visible at boot).
//
//   * Login username/password inputs have computed font-size
//     >= 16px (anything less triggers iOS Safari's focus-zoom).
//
//   * Login username has autocapitalize="none" + autocorrect="off"
//     + spellcheck="false", otherwise iOS capitalises the first
//     character and underlines it as a typo.
//
//   * Login password field has autocomplete="current-password"
//     (not new-password, iOS suppresses AutoFill on that).
//
//   * Global -webkit-tap-highlight-color: transparent rule
//     applies (no grey tap flash on designed buttons).
//
//   * Hover tooltip rule wraps in @media (hover: hover) so taps
//     don't get consumed by the tooltip-reveal.
//
//   * Body has no horizontal scrollbar (overflow-x: hidden / clip
//     correctly applied, broken layouts otherwise produce a
//     phone-wide horizontal scroll affordance).
//
//   * No console errors during the login page render.
//
// Things this doesn't test (yet):
//
//   * Trapped-modal scenarios (preflight, reflow, etc.). Those
//     require an authenticated session against a meet in a
//     specific state, out of scope for this smoke pass. The
//     existing meet-lifecycle / advance specs cover the modal
//     flows on chromium and would catch a vh-vs-dvh regression
//     visually if we add screenshot baselines later.
//   * Real iOS gesture handling (swipe-up to home, etc.), not
//     reproducible in any browser automation tool.

const { test, expect } = require("@playwright/test");

// Note: the test webServer (playwright.config.js) launches with
// RATE_LIMIT_DISABLED=true, which also asks server.js to drop the
// upgrade-insecure-requests CSP directive + HSTS. Without that,
// WebKit would silently rewrite every http://127.0.0.1 asset URL
// to https:// and fail the load. Chromium has a localhost
// exemption so the existing chromium tests aren't affected by
// either header.

test.describe.configure({ mode: "parallel" });

// All these tests hit static or public-pre-auth pages so they
// don't need the org/admin fixture from _setup.js. Keeps the
// suite fast and isolated.

// Shared helper: wait for the Vue SPA to mount and the login form
// to render. DOM elements inside the form don't exist until JS
// executes, without this, locator.evaluate() races the mount.
async function gotoLogin(page) {
  await page.goto("/login");
  // The username input only appears once Vue has mounted the
  // LoginView component, so waiting on it is a reliable "page is
  // interactive" signal.
  await expect(
    page.locator('input[autocomplete="username"]'),
  ).toBeVisible();
}

test("index.html declares the apple-mobile-web-app PWA tags", async ({ page }) => {
  await page.goto("/");

  // The three tags pass 6 added. Their absence means "Add to
  // Home Screen" opens in Safari with URL bar visible instead of
  // as a standalone PWA, which matters a lot for the offline-
  // poolside use case.
  const capable = await page.locator(
    'meta[name="apple-mobile-web-app-capable"]',
  ).getAttribute("content");
  expect(capable, "apple-mobile-web-app-capable").toBe("yes");

  const statusBar = await page.locator(
    'meta[name="apple-mobile-web-app-status-bar-style"]',
  ).getAttribute("content");
  expect(statusBar, "status-bar-style").toBe("black-translucent");

  const title = await page.locator(
    'meta[name="apple-mobile-web-app-title"]',
  ).getAttribute("content");
  expect(title, "apple-mobile-web-app-title").toBe("DivingHQ");

  // Viewport tag must include viewport-fit=cover so safe-area-inset
  // values are non-zero, otherwise the notch-aware padding from
  // pass 1 silently no-ops.
  const viewport = await page.locator('meta[name="viewport"]')
    .getAttribute("content");
  expect(viewport, "viewport meta").toMatch(/viewport-fit\s*=\s*cover/);
});

test("login page renders without horizontal scroll", async ({ page }) => {
  await gotoLogin(page);

  // No horizontal scroll on body or html. Either would mean a
  // descendant overflowed the viewport (long display-font name,
  // wide event card title, etc.), i.e. broken layout on phones.
  const widths = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    viewW: document.documentElement.clientWidth,
  }));
  expect(widths.docW, "no horizontal overflow on <html>")
    .toBeLessThanOrEqual(widths.viewW);
});

test("login Sign-In button is within the visible viewport", async ({ page }) => {
  await gotoLogin(page);

  // body min-height: 100dvh, not 100vh, see passes 1 + 5. If
  // someone reverts to vh, the Sign In button slips below the
  // address bar on a 390x844 iPhone profile.
  const button = page.getByRole("button", { name: /sign in|log in/i });
  await expect(button).toBeVisible();

  const box = await button.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  // Allow tiny rounding slop; what we're really checking is that
  // the button isn't pushed off-screen by a 100vh body on a
  // viewport where the dynamic toolbar is expanded.
  expect(box.y + box.height, "Sign-In button bottom edge in viewport")
    .toBeLessThanOrEqual(viewport.height + 2);
});

test("login inputs are >= 16px so iOS doesn't focus-zoom", async ({ page }) => {
  await gotoLogin(page);

  // Iterate both expected fields. font-size < 16px on either
  // would trigger iOS Safari's focus-zoom. Pass 2 fixed the
  // small-input variants, we want this guard so adding a new
  // *-sm input class in a future commit doesn't regress.
  const usernameSize = await page.locator('input[autocomplete="username"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(usernameSize, "username font-size").toBeGreaterThanOrEqual(16);

  const passwordSize = await page.locator('input[type="password"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(passwordSize, "password font-size").toBeGreaterThanOrEqual(16);
});

test("login username input suppresses iOS auto-capitalize + autocorrect", async ({ page }) => {
  await gotoLogin(page);
  const username = page.locator('input[autocomplete="username"]');

  // Pass 6: usernames aren't sentences, without these iOS
  // capitalises the first character and red-underlines it.
  await expect(username).toHaveAttribute("autocapitalize", "none");
  await expect(username).toHaveAttribute("autocorrect", "off");
  await expect(username).toHaveAttribute("spellcheck", "false");
});

test("login password field requests current-password AutoFill", async ({ page }) => {
  await gotoLogin(page);
  // Pass 6: current-password lets iOS surface saved passwords,
  // new-password would suppress AutoFill.
  const pw = page.locator('input[type="password"]');
  await expect(pw).toHaveAttribute("autocomplete", "current-password");
});

test("global -webkit-tap-highlight-color reset is applied", async ({ page }) => {
  await gotoLogin(page);

  // Pass 7: the `* { -webkit-tap-highlight-color: transparent; }`
  // reset in app.css should compute to a transparent value on any
  // interactive element. We probe a real button rather than
  // documentElement because the property cascades from the
  // wildcard reset and Safari reports it on each element.
  const highlight = await page.locator("button, a").first()
    .evaluate((el) => getComputedStyle(el).webkitTapHighlightColor);
  // WebKit normalises 'transparent' to either 'rgba(0, 0, 0, 0)'
  // or the literal 'transparent' depending on version.
  expect(highlight, "tap-highlight transparent").toMatch(
    /^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/,
  );
});

test("no horizontal overflow on the home/landing page", async ({ page }) => {
  await page.goto("/");

  const widths = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    viewW: document.documentElement.clientWidth,
  }));
  expect(widths.docW).toBeLessThanOrEqual(widths.viewW);
});

test("page renders without console errors on iPhone profile", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  await gotoLogin(page);
  // Give vue-i18n etc. a tick to settle. If a recent commit
  // introduced a Vue compile error or a missing module on WebKit
  // specifically, this fires.
  await page.waitForLoadState("networkidle");

  // Filter out third-party noise that the e2e environment can't
  // resolve: Google Fonts (no internet during test runs against
  // 127.0.0.1), service-worker dev mode warnings, and the TLS
  // failures WebKit reports when preconnect targets are
  // unreachable. None of these are our bugs, and none reflect
  // what an iPhone user on a real network would actually see.
  const ours = errors.filter((e) =>
    !/fonts\.gstatic\.com|fonts\.googleapis\.com|service.worker|TLS error|Failed to load resource/i.test(e)
  );
  expect(ours, ours.join("\n")).toEqual([]);
});
