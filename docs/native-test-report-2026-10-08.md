# Native emulator verification — 8 October 2026

This records emulator coverage for the initial native beta. The authenticated
checks used synthetic data in the guarded local `divinghq_test` database.
Production checks against `https://divinghq.app` were anonymous and read-only.
Neither emulator coverage nor a signed archive implies store upload or approval.

## Devices and builds

All devices were reused from their default locations on `/Volumes/Storage`.
No new AVD or simulator was created and no existing iOS keychain was changed.

| Device | Coverage |
| --- | --- |
| Existing `TacMap_API_36`, Android API 36, `emulator-5582` | Authenticated lifecycle, live reconnect, phone and tablet-sized layouts |
| Existing `BrewHaha Standard iPhone UI Review`, iOS 26.5, `97966DBC-6368-4D0E-BB41-86A96FED2F77` | Production launch, login screen, public scoreboard, portrait and landscape |
| Existing `BrewHaha iPad Check`, iPadOS 26.5, `509A6925-3FED-4973-96A3-9D7927601F73` | Production launch, login screen, public scoreboard, portrait and landscape |

Android tablet coverage used temporary `wm size` / `wm density` overrides on the
existing phone AVD, **not a separate tablet hardware profile**. CSS viewports were
411×914 / 914×411 for phone and 1066×1706 / 1707×1067 for tablet. No horizontal
viewport overflow appeared in the tested dashboard and Control Room layouts.
Original Android size 1080×2400 and density 420 were restored. Both iOS devices
were returned to portrait after their orientation checks. The two reused iOS
devices and Android AVD, all initially shut down, were shut down again after the
test. The final production-origin DivingHQ smoke app remains installed for the
next manual session; other installed apps and devices were left untouched.

Runtime source was commit `19fe0eb0`, followed by release configuration and a
public scoreboard safe-area correction. The final iOS simulator build included
that correction. Build output used Xcode's default DerivedData location.

## Authenticated local Android checks

The local backend used HTTPS `localhost:3443` proxying port 3098, production-mode
Secure cookies, a test-only database, and disabled external mail, push and
payment credentials. Temporary certificate trust was confined to a debug-only
Android manifest/resource; it was removed after the test. The release configuration
did not acquire a cleartext or custom-CA exception.

Passed on the actual Android WebView:

- Native HTTPS login and authenticated dashboard/Control Room with Online state.
- Session absent from JavaScript-readable cookies and browser storage.
- Force-stop/relaunch restores the authenticated session.
- Background/resume reconnects the live screen.
- Stopping the local HTTPS proxy produces Offline. Restoring it automatically
  reconnects and recovers a hold issued against the synthetic event while the
  emulator was disconnected.
- Online logout clears the native session (`/api/auth/me` returns 401); protected
  routes remain unavailable after restart.
- Offline logout also clears the session after connectivity returns and remains
  signed out after restart.
- Phone and tablet-sized portrait/landscape rendering.

Synthetic fixtures, temporary debug trust files, ADB reverse forwarding and local
backend/proxy processes were removed. Tests never changed a production meet.

## iOS and production scope

The preceding native-foundation milestone already exercised authenticated native
HTTPS login and the live Control Room on iPhone and iPad, plus iPhone session
persistence after force-quit/relaunch. Those earlier checks used dedicated local
test devices, not the reused devices above. Evidence remains under
`/tmp/divinghq-native-proof/`, including `ios-phone-session-restored.png`.

This run used the production-origin bundle on Android, iPhone and iPad. Login
screens rendered and the public scoreboard completed its request with the empty
state “No meets yet — check back when one starts.” Native Android HTTP returned
200 for health/features and 401 for the anonymous session endpoint.

The final Android debug smoke APK was reinstalled after the safe-area fix and
passed launch → Login → public Scoreboard navigation at 411×914 without horizontal
overflow. Artifact: `DivingHQ-1.0-1-smoke.apk`, SHA-256
`5e572c6ce19fccd14ae90060495b3175d53a13328b093cbd3426cda57160986d`.
This is the debug smoke binary, not a claim that the signed release bundle was
installed from Google Play.

Visual testing found the public scoreboard initially overlapped iOS system UI.
The corrected public-only container applies top and lateral safe-area insets.
Final iPhone portrait/landscape and iPad portrait/landscape screenshots show the
header clear of the status area and iPhone landscape notch. No bottom interactive
clipping was observed in the available empty-list state; populated production
results and their bottom controls were not available to exercise. Authenticated
AppShell, broadcast and overlay layout rules were not broadened by this fix.

At the initial production smoke, `/api/auth/socket-ticket` returned 404, indicating
the compatible backend had not yet been deployed. The normal deployment of
`8cbd5b95` completed at 10:57:50 UTC. A brief Cloudflare tunnel disconnect
interrupted external verification; it recovered without infrastructure changes.
Subsequent public checks returned health/features 200, anonymous ticket 403 and
malformed-token ticket 401, matching the existing middleware contract. Schema
104 and feature flags were unchanged. These public checks do not establish
authenticated production live-session coverage.

## Reproduction and evidence

Use Node 22, JDK 21 and the configured Android SDK. Serialize origin changes and
native sync with other builds; the same generated assets feed both platforms.

```sh
VITE_NATIVE_API_ORIGIN=https://divinghq.app npm run native:sync
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
cd android
./gradlew assembleDebug
```

Reuse an idle existing emulator, recording its original settings first. The tablet
layout check used `adb -s emulator-5582 shell wm size 1600x2560` and `wm density 240`,
then size `2560x1600` for landscape. Restore with `wm size reset` and `wm density
reset` only when the recorded initial state had no overrides, as it did here.

Working evidence directory: `/tmp/divinghq-native-20261008/`. Selected screenshots,
the local summary and final build log are also preserved in
`/Volumes/Storage/DivingHQ-releases/1.0-1/verification/`.

- `verification.json`: local authenticated check summary.
- `android-phone-control-online.png`, `android-phone-session-restored.png`,
  `android-phone-offline.png`, `android-phone-recovered-hold.png`: lifecycle proof.
- `android-tablet-portrait.png`, `android-tablet-landscape.png`: tablet-sized UI.
- `android-production-final-login.png`, `android-production-final-scoreboard.png`:
  final anonymous production smoke.
- `ios-iphone-production-final-portrait.png`,
  `ios-iphone-production-final-landscape.png`,
  `ios-ipad-production-final-portrait.png`,
  `ios-ipad-production-final-landscape.png`: final safe-area verification.
- `ios-production-simulator-final-build.log`: final simulator build success.

This does not cover physical devices, every role workflow, store-installed builds,
native push delivery, or populated production competition data. The local CI and
artifact checks below are separate from device coverage; store status is recorded
in the [testing release guide](native-testing-releases.md).

## Local CI and independent release review

Verification used Node 22.23.1 and the guarded `divinghq_test` database after the
device fixtures and local proxy were removed:

- `npm run lint`: passed with zero errors and 62 existing warnings.
- `npm run build`: passed; rebuilt after the final public scoreboard top/side
  safe-area change. The changed Vue file also passed its focused ESLint check.
- `npm test`: **1,540 passed, zero failed or skipped**.
- Full Playwright run, three workers: **423 passed, one failed, one did not run**.
  The referee-dashboard sign-off-card test could not find its card within eight
  seconds; its following serial test was skipped. The test sends the request
  immediately after navigation, before explicitly waiting for dashboard
  readiness. A readiness timing race is a possible explanation, not a confirmed
  root cause. The complete unchanged serial file subsequently passed **12/12**
  across three repetitions against the final web build. No assertion was relaxed
  and no dashboard implementation or test was changed.
- After the final top/side CSS change, focused scoreboard, live refresh, mobile
  Safari, cross-browser, broadcast, overlay and recap coverage passed **65/65**.
- `npm run check:motion`, `npm run check:size` and `git diff --check`: passed.

The first attempted browser run was stopped because this Playwright version's
browser binaries were absent. Its matching Chromium, Firefox and WebKit versions
were installed before the completed runs above. The accepted gate comprises the
full suite, the unchanged failing-file repetitions and the final focused pass;
it is not a claim that the first full browser run was entirely green.

Independent checks on the final signed candidates under
`/Volumes/Storage/DivingHQ-releases/1.0-1/`:

| Artifact | SHA-256 |
| --- | --- |
| `ios/App.ipa` | `fa8fdc013e7522aaeaa24318ea67be5ac1d76b118f7e948b444d0e47a0edfb96` |
| `android/DivingHQ-1.0-1.aab` | `da5f7b56da0144cc1e99ec71b9481e9a429083a390bad1bf03ed2d48823b4bee` |

Both package the same native runtime, `assets/index-ByEhwgmo.js`, with the exact
production HTTPS origin and the final public safe-area CSS. Neither contains a
local-test runtime origin, test CA, proof trust resource or signing key. The
bundled CSP permits the configured HTTPS/WebSocket endpoint and does not add a
wildcard network origin.

`codesign --verify --deep --strict` passed on the exported iOS app. Its signed
entitlements have `get-task-allow=false`, the expected app/team identifiers and
TestFlight beta reporting. The package supports iPhone and iPad, includes the
Capacitor/Cordova SDK privacy manifests, and contains no ATS exception. The
internal-only export setting does not submit a public release.
`ITSAppUsesNonExemptEncryption=false` describes the app's use of operating-system
HTTPS/TLS, with no additional bundled encryption implementation; it does not
describe server-side data collection.

JDK 21 `jarsigner -verify` verified the AAB signature, and Google's bundletool
1.18.3 `validate` passed. Its packaged manifest targets API 36, keeps backups
disabled, and has no debuggable, cleartext or custom trust override. Android
release signing also rejected a build with no external signing configuration.
These checks establish the local candidates' integrity and configuration, not
store processing, tester availability or authenticated production compatibility.
