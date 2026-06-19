// Playwright config — drives the SPA + API end-to-end through a
// real browser. Complements the Node test runner suite:
//
//   npm test           → 38 fast tests (unit + integration via
//                        HTTP API). No browser, no SPA.
//   npm run test:e2e   → this file. Boots the production build,
//                        clicks through the actual UI, asserts
//                        what the user sees.
//
// Convention: tests live in test/e2e/. The default test/ dir is
// covered by `npm test` (Node test runner), so the two suites
// don't interfere.

const { defineConfig, devices } = require("@playwright/test");

const DOCS_E2E = process.env.E2E_DOCS === "1";
const requestedCiWorkers = Number(process.env.PW_WORKERS);
const ciWorkers = Number.isFinite(requestedCiWorkers) && requestedCiWorkers > 0
  ? Math.floor(requestedCiWorkers)
  : 3;

// Default suite excludes the documentation screenshot generator
// (it's a one-shot writer that produces wiki PNGs, not a
// regression gate). Pass E2E_DOCS=1 to include it.
const testIgnore = DOCS_E2E ? [] : ["**/wiki-screenshots.spec.js"];

module.exports = defineConfig({
  testDir: "./test/e2e",
  testIgnore,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,        // fail the build if .only slipped in
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? ciWorkers : undefined,
  reporter: process.env.CI ? "github" : "list",
  // Long enough for `npm run build` (~1s) + the server's first
  // boot read of schema_meta + audit purge (~200ms). The
  // `npm start` script serves dist/ statically, so no Vite dev
  // server in the loop.
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3097",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Mobile-Safari project — runs only the mobile-safari.spec.js
    // file by default (testMatch keeps it out of the regular
    // chromium project) using Playwright's iPhone 13 device
    // profile + the WebKit engine. WebKit is the actual rendering
    // engine that ships in iOS Safari, so CSS quirks (font-size
    // auto-zoom, safe-area-inset behaviour, backdrop-filter
    // prefix requirements, position:fixed under transformed
    // ancestors) match production Safari rather than a Chromium
    // emulation.
    //
    // Requires the WebKit binary, installed once via
    //   `npx playwright install webkit`
    // CI image already has it from the @playwright/test postinstall
    // hook. Local devs see a friendly prompt the first time they
    // run this project if it's missing.
    // Firefox project — runs the cross-browser spec only.
    // Gecko has different CSS quirks than WebKit/Blink and
    // a few of our fixes (autocorrect attribute, -webkit-
    // backdrop-filter prefix, env(safe-area-inset)) behave
    // differently. The smoke test asserts the page still
    // renders + the form is reachable; engine-specific
    // attributes are scoped to the mobile-safari project.
    {
      name: "firefox",
      testMatch: /cross-browser\.spec\.js$/,
      use: {
        browserName: "firefox",
        viewport: { width: 1280, height: 800 },
      },
    },
    // Mobile-Chrome project — Android-like (Pixel 7) profile
    // against Chromium. Catches issues that would affect Android
    // Chrome users specifically (different default font-size,
    // viewport handling).
    {
      name: "mobile-chrome",
      testMatch: /cross-browser\.spec\.js$/,
      use: {
        ...devices["Pixel 7"],
      },
    },
    {
      name: "mobile-safari",
      testMatch: /mobile-safari\.spec\.js$/,
      use: {
        ...devices["iPhone 13"],
        // Newer WebKit features (dvh, safe-area-inset, :has()) all
        // landed before iOS 16, which the iPhone 13 profile maps
        // to. No additional flags required.

        // bypassCSP: the production server (helmet middleware) sets
        // `upgrade-insecure-requests` in its CSP, which WebKit
        // respects by silently rewriting every asset URL from
        // http://127.0.0.1:3097/... to https://... The local test
        // server only listens on HTTP, so every JS/CSS/manifest
        // fetch fails with a TLS error and the SPA never mounts.
        // Chromium isn't affected because its localhost handling
        // skips the upgrade.
        //
        // Disabling CSP in the test context lets WebKit fetch the
        // built assets over HTTP — the production HTTPS posture
        // is unchanged.
        bypassCSP: true,
      },
    },
    {
      name: "chromium",
      testIgnore: /(mobile-safari|cross-browser)\.spec\.js$/,
      use: {
        // Don't spread devices["Desktop Chrome"] — it bakes in
        // a fixed 1280×720 viewport plus a deviceScaleFactor,
        // which clamp the page to that resolution even when the
        // operator manually resizes the --headed Chrome window.
        //
        // viewport:null disables Playwright's viewport emulation
        // so the page renders at the actual Chromium window's
        // inner size — meaning a manual window resize also
        // resizes the rendered page (like normal Chrome).
        //
        // BUT: viewport:null on its own doesn't tell Chromium
        // what size to OPEN the window at. Headed Chromium
        // defaults to ~800×600 and headless defaults to a
        // similarly small frame, which is why the dashboard
        // overflowed under e2e but rendered fine in Safari /
        // user's normal Chrome (which open at a sensible size).
        // --window-size sets the initial frame; the user is
        // still free to resize.
        browserName: "chromium",
        viewport: null,
        launchOptions: {
          args: ["--window-size=1440,900"],
          // Playwright Test doesn't accept `--slow-mo` on the
          // CLI (that flag belongs to `playwright codegen` /
          // Puppeteer); the equivalent for tests is
          // launchOptions.slowMo. Read it from PW_SLOWMO so the
          // npm test:e2e:headed script can pass it through
          // without editing config. 0 = no slow-mo (default).
          slowMo: Number(process.env.PW_SLOWMO || 0),
        },
      },
    },
  ],
  // Boots a server on :3097 if one isn't already running. We
  // run on a non-default port so a developer with `npm start`
  // already going on :3000 can run e2e in parallel without a
  // port collision. PORT + DB_DATABASE are passed through the
  // env so the e2e suite uses the same Postgres the integration
  // tests use (divinghq_test).
  webServer: {
    command: "npm run build && PORT=3097 node server.js",
    url: "http://127.0.0.1:3097/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: "3097",
      // Point at the local test DB created in `npm test` setup.
      DB_DATABASE: process.env.DB_DATABASE || "divinghq_test",
      // Disable the auth + bulk-write rate limiters for the suite.
      // Every request comes from 127.0.0.1 so the production limit
      // (20 auth req / 15 min / IP) trips after a few tests and
      // poisons the rest with 429s. The bypass is opt-in via env
      // var — production .env never sets it.
      RATE_LIMIT_DISABLED: "true",
      // Local .env often points SMTP_HOST at smtp.example.com so
      // registration tests can exercise email-triggering paths.
      // For e2e, force the helper into documented dev no-op mode:
      // no DNS lookups, no noisy best-effort mailer failures.
      SMTP_HOST: "",
      // Control Room cutover flag (P9): on | cohort | off. The TEST
      // webServer defaults to "off" (the V1 build) so the existing
      // control suite + the V1-only legacy specs stay green by default;
      // VITE_CONTROL_V2=on builds + serves V2 for control-v2-*.spec.js.
      // Production defaults the OTHER way (unset -> V2) via the router
      // resolver — the two defaults are intentionally opposite so the
      // rollback path keeps its regression coverage through the soak.
      VITE_CONTROL_V2: process.env.VITE_CONTROL_V2 || "off",
    },
  },
});
