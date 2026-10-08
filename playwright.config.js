// Playwright config, drives the SPA + API end-to-end through a
// real browser. Complements the Node test runner suite:
//
//   npm test           → 38 fast tests (unit + integration via
//                        HTTP API). No browser, no SPA.
//   npm run test:e2e   → this file. Boots the production build,
//                        clicks through the actual UI, asserts
//                        what the user sees.
//
// Convention: tests live in test/e2e/. The default test/ dir is
// covered by `npm test` (Node test runner) so the two suites
// don't interfere.

const { defineConfig, devices } = require("@playwright/test");
const { applyTestDbDefault, assertTestDatabase } = require("./test/support/test-db");

// Read .env here too. The fixtures in test/e2e/_setup.js always did, the
// webServer below didn't, so with .env saying DB_DATABASE=divinghq the
// server ran on divinghq_test while the fixtures wrote to divinghq. Now
// both see the same value (shell, then .env, then divinghq_test), the
// workers inherit it, and a non-test database stops the run here.
require("dotenv").config({ quiet: true });
applyTestDbDefault();
assertTestDatabase();

const DOCS_E2E = process.env.E2E_DOCS === "1";
// E2E_PORT moves the auto-booted server off 3097, so two checkouts (git
// worktrees, say) can run the suite side by side without one quietly
// reusing the other's server and database.
const E2E_PORT = process.env.E2E_PORT || "3097";
const requestedCiWorkers = Number(process.env.PW_WORKERS);
const ciWorkers = Number.isFinite(requestedCiWorkers) && requestedCiWorkers > 0
  ? Math.floor(requestedCiWorkers)
  : 3;

// Default suite skips the documentation screenshot generator
// (it's a one-shot writer that produces guide PNGs, not a
// regression gate). Pass E2E_DOCS=1 to include it.
//
// Gotcha, and it bit us for months: a project's own `testIgnore`
// REPLACES the config-level one, it doesn't merge with it. The
// chromium project below sets its own to keep the mobile/cross-browser
// specs out, wich quietly re-admitted wiki-screenshots.spec.js to
// every `npx playwright test` run. That spec rewrites all 48 files in
// public/guide-screenshots/ and (since it purges leftover e2e orgs)
// yanks the database out from under whatever else is running in
// parallel. Both symptoms were blamed on flake for a long time.
//
// So: build every project's ignore list from this one base.
const DOCS_SPEC = "**/wiki-screenshots.spec.js";
const testIgnore = DOCS_E2E ? [] : [DOCS_SPEC];

// Helper so a project can add its own exclusions without dropping the
// docs-spec guard on the floor.
const ignoreWithDocs = (...extra) => [...testIgnore, ...extra];

module.exports = defineConfig({
  testDir: "./test/e2e",
  testIgnore,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,        // bail the build if .only snuck in
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? ciWorkers : undefined,
  // CI also writes the HTML report (never opened) so the failure artifact
  // in ci.yml has a browsable index next to the raw traces and videos in
  // test-results/.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Long enough for `npm run build` (~1s) plus the server's first
  // boot read of schema_meta + audit purge (~200ms). The
  // `npm start` script serves dist/ statically, so there's no Vite
  // dev server in the loop.
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || `http://127.0.0.1:${E2E_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Mobile-Safari project, runs the mobile-safari.spec.js file
    // (testMatch keeps it out of the regular chromium project), and
    // judge-pad-fit.spec.js (see below), using Playwright's iPhone 13 device
    // profile + the WebKit engine. WebKit is the actual rendering
    // engine that ships in iOS Safari, so CSS quirks (font-size
    // auto-zoom, safe-area-inset behaviour, backdrop-filter
    // prefix requirements, position:fixed under transformed
    // ancestors) match production Safari rather than a Chromium
    // emulation.
    //
    // Requires the WebKit binary, installed once via
    //   `npx playwright install webkit`
    // CI already has it from the @playwright/test postinstall
    // hook. Local devs get a friendly prompt the first time they
    // run this project if it's missing.
    // Firefox project, runs the cross-browser spec only.
    // Gecko has different CSS quirks than WebKit/Blink and
    // a few of our fixes (autocorrect attribute, -webkit-
    // backdrop-filter prefix, env(safe-area-inset)) behave
    // differently. The smoke test just asserts the page still
    // renders and the form is reachable; engine-specific
    // attributes are scoped to the mobile-safari project.
    {
      name: "firefox",
      testMatch: /cross-browser\.spec\.js$/,
      use: {
        browserName: "firefox",
        viewport: { width: 1280, height: 800 },
      },
    },
    // Mobile-Chrome project, Android-like (Pixel 7) profile
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
    // judge-pad-fit.spec.js runs here as well as in chromium: whether the
    // judge pad fits an iPhone is a WebKit question first. It makes its
    // own phone contexts, so the iPhone 13 below doesn't apply to it.
    {
      name: "mobile-safari",
      testMatch: /(mobile-safari|judge-pad-fit)\.spec\.js$/,
      use: {
        ...devices["iPhone 13"],
        // Newer WebKit features (dvh, safe-area-inset, :has()) all
        // landed before iOS 16, which the iPhone 13 profile maps
        // to, so no additional flags required.

        // bypassCSP: the production server (helmet middleware) sets
        // `upgrade-insecure-requests` in its CSP, which WebKit
        // respects by silently rewriting every asset URL from
        // http://127.0.0.1:3097/... to https://... The local test
        // server only listens on HTTP, so every JS/CSS/manifest
        // fetch fails with a TLS error and the SPA never mounts.
        // Chromium isn't affected since its localhost handling
        // skips the upgrade.
        //
        // Disabling CSP in the test context lets WebKit fetch the
        // built assets over HTTP, the production HTTPS posture
        // stays unchanged.
        bypassCSP: true,
      },
    },
    {
      name: "chromium",
      testIgnore: ignoreWithDocs("**/mobile-safari.spec.js", "**/cross-browser.spec.js"),
      use: {
        // Don't spread devices["Desktop Chrome"], it bakes in
        // a fixed 1280×720 viewport plus a deviceScaleFactor,
        // which clamp the page to that resolution even when the
        // operator manually resizes teh --headed Chrome window.
        //
        // viewport:null disables Playwright's viewport emulation
        // so the page renders at the actual Chromium window's
        // inner size, meaning a manual window resize also
        // resizes the rendered page (like normal Chrome).
        //
        // BUT: viewport:null on its own doesn't tell Chromium
        // what size to OPEN the window at. Headed Chromium
        // defaults to ~800×600 and headless defaults to a
        // similarly small frame, which is why the dashboard
        // overflowed under e2e but rendered fine in Safari and
        // the user's normal Chrome (which open at a sensible size).
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
          // without editing config. 0 = no slow-mo (default)
          slowMo: Number(process.env.PW_SLOWMO || 0),
        },
      },
    },
  ],
  // Boots a server on :3097 if one isn't already running. We
  // run on a non-default port so a developer with `npm start`
  // already going on :3000 can run e2e in parallel without a
  // port collision. PORT + DB_DATABASE get passed through the
  // env so the e2e suite uses the same Postgres the integration
  // tests use (divinghq_test).
  webServer: {
    // Skip the SPA build when PW_SKIP_BUILD is set. CI downloads a
    // prebuilt dist/ artifact from the `build` job, so rebuilding here
    // would just repeat work already on the critical path. Locally
    // (flag unset) we always build so dist/ stays fresh.
    command: process.env.PW_SKIP_BUILD
      ? `PORT=${E2E_PORT} node server.js`
      : `npm run build && PORT=${E2E_PORT} node server.js`,
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: E2E_PORT,
      // Resolved and checked at the top of this file, so the server and
      // the fixtures agree on it. A DATABASE_URL in .env still wins in
      // both, same as it does in server.js.
      DB_DATABASE: process.env.DB_DATABASE || "divinghq_test",
      // Disable the auth + bulk-write rate limiters for the suite.
      // Every request comes from 127.0.0.1 so the production limit
      // (20 auth req / 15 min / IP) trips after a few tests and
      // poisons the rest with 429s. Heads up: the bypass is opt-in
      // via env var, production .env never sets it.
      RATE_LIMIT_DISABLED: "true",
      // Feature flags ship off (migration 085/086 seeds payments/classes/
      // maintenance off; signups on). The e2e specs register orgs + divers as
      // fixtures and drive the payment/class screens, so force those three on
      // for the whole suite. This is the break-glass override in lib/features:
      // force-on only, so nothing here can flip a flag back off mid-run.
      // 'maintenance' is intentionally absent, its specs toggle it per-test.
      FEATURE_FLAGS_ON: "payments,classes,signups",
      // A local .env might carry real Cloudflare Email Sending creds, and
      // we really dont want the e2e run mailing fixture addresses. Blank
      // them so lib/email drops into its documented no-op mode.
      CF_ACCOUNT_ID: "",
      CF_EMAIL_TOKEN: "",
      // Same for web push. The test DB holds real browser subscriptions
      // (the admin's own Chrome, for one) and fixture orgs ping every
      // sysadmin, so a run with the .env VAPID keys buzzed real phones.
      VAPID_PUBLIC_KEY: "",
      VAPID_PRIVATE_KEY: "",
      // Native provider credentials follow the same no-delivery boundary.
      APNS_KEY_PATH: "",
      FCM_SERVICE_ACCOUNT_PATH: "",
    },
  },
});
