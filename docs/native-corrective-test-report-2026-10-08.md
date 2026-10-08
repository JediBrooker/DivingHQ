# Mobile corrective verification — 8 October 2026

Target source version: **1.1 (2)**, bundle ID `app.divinghq.mobile`.
The existing owner-only 1.0 (1) store builds are earlier artifacts. This report
does not claim that a replacement build is published or that native push has
been received on physical hardware.

## Automated verification

Executed locally on macOS with Node **22.22.1**. Independent fresh databases
`divinghq_corrective_ci_test` and `divinghq_corrective_e2e_test` isolated full CI
from ongoing simulator fixtures. No production account or meet was mutated.
Test processes blank native APNs/FCM credential paths as well as Web Push keys;
Playwright also disables email delivery.

| Check | Result |
|---|---|
| Full ESLint/server syntax | Pass: zero errors, 62 existing warnings |
| Production web build | Pass |
| Bundle-size budgets | Pass: entry 88.3 KiB / 118 KiB ceiling; every tracked chunk within budget |
| Reduced-motion guard | Pass |
| Schema drift | Pass: 52 tail migrations; all 98 migrations replayed; both bootstrap paths agree |
| Full Node suite, including DB integration | **1,576 passed**, zero failed/skipped |
| Full configured Playwright projects | **443 passed**, zero failed/skipped, 5.7 minutes |
| Final affected Playwright checks after auth/setup safe-area correction | **41 passed**, zero failed/skipped |
| Final syntax, locale parity and used-key checks | **15 passed**, zero failed/skipped |
| Final SDK teardown/auth/integration/structural contracts | **69 passed**, zero failed/skipped |
| Final navigation and delayed-inbox-response browser checks | **16 passed**, zero failed/skipped |
| Whitespace/diff check | Pass |

The full browser run included Chromium, Firefox, mobile Chrome and mobile Safari
according to each project's configured spec selection. The subsequent 41 checks
ran against the final rebuilt web bundle: mobile navigation, populated role
workflows, phone onboarding, cross-browser/mobile auth screens and two-factor
login. The three new onboarding checks set browser `env(safe-area-inset-*)`
values, covering top and landscape side insets across six auth screens and four
setup steps. These are browser geometry tests, not physical-device screenshots.

The first Node run found eight tests unable to import the widget-dashboard
module because new document imports used Vite aliases. Explicit relative imports
restored its plain-Node contract; all eight focused checks and the subsequent
full suite passed. The first bundle-size check found the entry exceeded its
existing ceiling. Loading authenticated AppShell navigation on demand reduced
the entry; no budget or test assertion was relaxed.

Logs and browser failure-artifact directories are retained outside the repository:
`/Volumes/Storage/DivingHQ-releases/corrective-mobile/ci/`.
The authoritative successful logs are `node-full-final.log`, `e2e-full.log`,
`e2e-final-affected.log`, `lint-final.log`, `build-final.log`, `size-final.log`,
`motion.log`, `schema.log` and `final-structural.log`. Initial failed logs remain
for traceability.

After those runs, the Android notification bridge was corrected to disable FCM
auto-init by default and await the actual token-deletion task. Native client
cleanup now serializes SDK operations and persists teardown retries. The final
69 checks cover push client/provider/database integration, authenticated native
transport/documents, auth response ordering, notification banners and structural
syntax/locale checks. Their log is `final-sdk-contracts.log`; lint, build, bundle
size and motion checks were repeated successfully on these changes.
The inbox now ignores responses belonging to an unmounted view or previous
account while still showing current-session failures. The final 16-test
navigation run verifies both a delayed failure after logout and a visible
current-account failure (`e2e-final-inbox-corrected.log`). The first run of the
two new tests used incorrect English selectors; they were corrected to the
actual button/toast text before the complete 16-test file passed.

### Hosted source CI

[GitHub Actions run 37776991430](https://github.com/JediBrooker/DivingHQ/actions/runs/37776991430)
completed successfully for source commit
`48e10c4c9732a2c85768be2fd7c55c156f544f0c`. All three jobs passed: build/lint/budgets,
Postgres tests/schema drift, and the full browser matrix. The final committed
source passed **1,575 Node tests with 3 skips and zero failures**, and **447
Playwright tests with 1 skip and zero failures**. Node's hosted skips are the
workflow's English-stuck check override and two macOS-font-only checks; the
browser suite's fee-save check requires a Stripe test key unavailable in hosted
CI. Local verification above records its own counts and later focused runs.

The hosted log is retained at `ci/hosted-source-ci.log`. Subsequent documentation
updates only record these results and deployment evidence; this successful run
belongs to the source commit, not to a later documentation-only workflow run.

## UI and native evidence

The [corrective experience plan](mobile-corrective-plan.md) records role-specific
navigation and populated manager/coach/member checks, the strengthened member
detail-drawer geometry assertion, and nine inspected screenshots. Their artifacts
are under `corrective-mobile/experience-2026-10-08/` in the same release directory.

Simulator/emulator artifacts are retained under
`/Volumes/Storage/DivingHQ-releases/corrective-mobile/device-verification/`.
The following were observed through native Debug builds and controlled local
HTTPS/test-database fixtures, rather than the production store releases:

| Native check | Observed result / limit |
|---|---|
| Platform compilation | iOS and Android Debug builds passed, including the final Android push teardown changes. The iOS notification-settings API availability guard was corrected to iOS 16. |
| Authentication and navigation | Native HTTPS login passed on both platforms; iPhone menu/settings and iPad labelled sidebar rendered. Android cold explicit intent to protected Settings preserved the destination through login with a different account. This does not prove verified domain association in an installed store build. |
| Sharing and printing | Actual iPhone profile Export PDF opened native print preview. Actual iPad member CSV opened an anchored native share sheet; the 282-byte private cache file contained the two synthetic fixture users. Android opened native print preview for synthetic HTML (`android-native-print.png`); this was a bridge test, not a profile PDF workflow. Physical save destinations and user-selected copies remain separate checks. |
| Session changes | Android UI logout caused a protected API read to return 401; login with another account and force-stop/relaunch retained only the switched account. Actual offline UI logout, proxy recovery and process restart also left the protected API at 401 and redirected Settings to login. iPhone UI logout/login and process restart retained the second account (`ios-account-switch-restart.png`). iPad Inbox → Sign Out showed no stale error toast after the response-ordering fix. |
| System settings | Android opened its exact App Notification Settings activity. On the iOS 26.5 simulator, the documented settings URLs reached the Settings root; the physical-device app-specific shortcut remains unverified. |
| Native judge support | Android keep-awake OS flag was observed enabled and subsequently reset. This does not establish physical haptic feel. |
| Android tablet layout | No overflow at 1067×1707 and 1707×1067 using an emulator viewport override; this was not a dedicated tablet or physical tablet. |
| Final iPhone setup layout | Actual fresh-install portrait/landscape screenshots confirm the safe-area correction (`ios-setup-final-portrait.png`, `ios-setup-final-landscape.png`). |
| Permission and injected notifications | A temporary iOS harness exercised real deny/grant OS prompts. An iPad simulator-injected generic notification opened the authorized Settings screen on tap. Neither result is APNs/FCM delivery evidence. |

The final Android auto-init/awaited-token-deletion correction compiled on both
platforms; Android logout, cold protected-link continuation and offline logout
were rechecked afterwards. A final sync for `https://divinghq.app` and both clean
Debug builds passed. Generated assets contain the production origin, with no
local test proxy or harness references; the APK contains no proof CA or harness
file. This is Debug compilation evidence, not a signed distribution upload.

Temporary Android Debug manifest/CA/network-security files and the temporary
iOS harness were removed. Clean production-origin Debug apps replaced the
fixture installations on all three reused test devices. The two owned fixture
organisations were deleted, local servers/proxy stopped, ADB reverse removed,
Android size/density restored to 1080×2400/420, and the reused iPhone/iPad returned
to portrait and shut down. Only the task's emulator was stopped. The exact task
CA was removed from both simulator trust stores while preserving other entries;
no keychain reset or new device creation occurred.

No APNs/FCM delivery, physical hardware, store-installed app links or replacement
store publication is claimed here.

## Production backend deployment

The normal `./deploy.sh` workflow deployed source commit
`48e10c4c9732a2c85768be2fd7c55c156f544f0c` in LXC 120 at
`/root/DiveRecorder`, completing successfully at **2026-10-08 12:28:56 UTC**.
Migration 105 applied. Deploy-time safe tests passed **1,017**, with **3 skips**
and **zero failures**. The remote checkout was clean and both its HEAD and
`dist/.build-sha` matched the deployed source commit.

Post-deploy read-only checks against `https://divinghq.app` confirmed:

- Health and feature endpoints returned HTTP 200, schema **105**. Payments,
  classes and maintenance remained off; signups remained on.
- Apple and Android association files returned HTTP 200 JSON without redirects.
  Apple identifies `6MY34D5RKG.app.divinghq.mobile` and includes `/settings`.
  Android identifies `app.divinghq.mobile` with the documented Play App Signing
  SHA-256 certificate fingerprint.
- Anonymous native-device status, notification read and socket-ticket requests
  returned HTTP **403**, preserving the authenticated boundary.
- Operations status recorded a successful `48e10c4` deployment and zero server
  errors in its 15-minute window at verification time.
- The runtime native provider factory reported **iOS false / Android false**.
  Provider credentials were not changed; live native delivery remains unavailable
  until legitimate provider provisioning is completed.

The deployment log and HTTP evidence are retained as
`device-verification/production-deploy-48e10c4.log` and
`device-verification/production-verification-48e10c4.json` under the release
artifact directory. Serving association JSON is not proof that a store-installed
device has verified or opened an associated link. Documentation-only commits
after this source commit do not require a backend redeployment.

## Remaining release acceptance

- Provision the legitimate APNs key and Firebase client/server credentials;
  confirm provider acceptance separately from observed device delivery.
- Verify installed release links and native notification registration against
  the deployed live service after provider and signed-build provisioning.
- Publish replacement owner-only internal builds after release validation.
- Complete store-installed physical iPhone/iPad checks. The owner offered an iOS
  device; a physical Android device is not available for this run. Android
  real-device background/locked delivery and TalkBack therefore remain unverified.
- Record permission denial/re-enable, foreground/background/locked reception,
  cold/warm taps, expired notifications, offline logout/account switching,
  Files/Downloads sharing, printing, app links and accessibility. Follow the
  [notification guide](native-notifications.md), [integration guide](native-integrations.md)
  and [physical acceptance checklist](mobile-corrective-plan.md#physical-store-build-acceptance).

Provider/legal-account setup requiring the account holder's confirmation remains
a provisioning dependency. No simulator result substitutes for those steps or
for real store-installed delivery. The original [1.0 test report](native-test-report-2026-10-08.md)
is preserved as historical evidence.
