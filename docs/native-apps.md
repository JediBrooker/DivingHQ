# Native apps

DivingHQ now has Capacitor 8 projects for iOS and Android. Both bundle the same
Vue application and server permission model, with mobile navigation and native
notification, document, sharing and link integrations. iOS targets
iPhone and iPad (`TARGETED_DEVICE_FAMILY = 1,2`); Android has no phone-only size
or orientation restriction. The original 1.0 (1) prototype is available in
owner-only internal testing. The corrective 1.1 (2) implementation is separate
from provider provisioning, release publication and physical-device acceptance;
see the [corrective plan](mobile-corrective-plan.md) and the verification ledger
below before treating a capability as verified.

## Build and run

Use the repository's Node 22 environment, Xcode for iOS, and JDK 21 plus an
Android SDK for Android. Install dependencies with `npm ci`. The app identifier
is `app.divinghq.mobile`, registered to the existing DivingHQ store accounts.
See [testing releases](native-testing-releases.md) for distribution signing.

Choose an explicit HTTPS staging API origin. There is deliberately no default
production endpoint and no cleartext HTTP exception:

```sh
VITE_NATIVE_API_ORIGIN=https://staging.example.com npm run native:sync
npm run native:ios
npm run native:android
```

`native:sync` builds into `dist-native/`, then copies that bundle and plugin
configuration into both projects. `native:build` builds just the bundle. Run
`native:sync` after frontend or plugin changes; changing the API origin also
requires a rebuild. The origin is public build configuration, never a secret.
Do not use `server.url`: native releases serve their own bundled application.
Normal `npm run build` continues building the website into `dist/`.

For command-line simulator/debug builds:

```sh
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
cd android
./gradlew assembleDebug
```

Set `ANDROID_HOME`/`ANDROID_SDK_ROOT` to your SDK and `JAVA_HOME` to JDK 21 if
your shell uses a different Java. Release signing uses the registered Apple
team/profile and an external Android upload-signing properties file; follow the
[testing release commands](native-testing-releases.md). No keys are checked in. Native
generated web bundles, local SDK paths, caches and signing files are ignored.
`node scripts/native-icons.js` regenerates launcher icons from `public/icon.svg`.

Reuse existing iOS simulators and Android emulators. Their default device storage
and Xcode's default DerivedData are on `/Volumes/Storage` in this workspace.
Do not set `ANDROID_AVD_HOME`, use `simctl --set`, or put DerivedData in the repo.
Create a device only when the required model or OS version is absent, and delete
only those newly created devices after testing.

For local device testing use a temporary HTTPS proxy to the local test backend
and temporary CA trust on the selected existing test simulators. Android can reach that
proxy using `adb reverse tcp:3443 tcp:3443`. A test CA/network-security override
must stay in temporary Debug configuration and must never enter release builds.
Use the guarded test database, never production accounts or meet data.

## Transport and sessions

- `src/native-main.js` installs the native boundary before importing the shared
  app. Only `/api/` requests to the bundled shell or the configured exact HTTPS
  origin use `CapacitorHttp`. External requests use browser fetch with omitted
  credentials. API redirects are refused. Native logging is disabled.
- Login, 2FA and session refresh keep using the existing HttpOnly session
  cookie in the platform cookie jar. Native cookie persistence is capped to the signed
  session's expiry; web cookies remain session-only. No session token is persisted in JavaScript
  storage or Capacitor Preferences. The native request marker suppresses the
  API's legacy bearer-token response body; it grants no permissions. Returned
  `Set-Cookie` headers are stripped before constructing the shared app's Response.
  The bridge still has native HTTP capabilities, so bundled-script integrity and
  the native CSP remain important; this is not a separate XSS security boundary.
- Native websocket connections obtain a fresh 30-second `auth.ticket` through
  the authenticated HTTP session. Tickets have a dedicated type/audience and
  cannot authenticate ordinary HTTP requests. Token-version and role checks are
  unchanged. The original session expiry bounds the socket lifetime. Explicit
  spectator sockets remain anonymous. No CORS allowlist was broadened.
- Native logout drains admitted requests and clears the app's cookie jar even
  without a network connection. Existing identity/cache clearing remains in the
  auth store. Session checks ignore responses that arrive after an account switch.
- Suspension disconnects pooled sockets. Resume reconnects them with fresh
  tickets and invokes the existing focus/online recovery paths. Transient ticket
  failures retry with backoff. The existing per-user IndexedDB caches and durable
  outbox remain the shared implementation; no scoring rules changed.
- Browser service workers and Web Push registration are disabled in native.
  In-app socket notifications continue while connected. Native APNs/FCM delivery,
  explicit permission controls, installation revocation and authenticated taps
  are implemented separately; [notification setup](native-notifications.md)
  records the required credentials and real-device acceptance checks.

## Implemented capabilities and remaining proof

| Area | Current state / next proof |
|---|---|
| Broad role access | Existing routes and permissions are included with Home, Work, Inbox, searchable Menu and Settings navigation. Automated role/delegate checks pass; complete physical device-by-role workflows during beta. Feature flags still apply. |
| Phones and tablets | Narrow layouts use bottom tabs, wide native layouts use a labelled sidebar; member forms and coaching cards adapt to available width. Browser geometry and populated workflow checks are recorded in the corrective plan. Physical keyboard, safe areas, accessibility and tablet multitasking require separate acceptance. |
| Authentication | Cookie transport, 2FA, logout and ticket exchange are implemented. Native cookie persistence is configured up to the existing JWT expiry and was observed across an iPhone simulator restart and Android emulator process restart; physical-device restart, expiry, revocation and shared-device switching still require beta verification. |
| Live/offline behaviour | Existing outbox/reconnect logic is reused. Test screen lock, OS suspension, force termination, airplane mode and interrupted writes on devices before meet use. Native abort stops response delivery but cannot guarantee cancellation of a write already sent; existing idempotency stays essential. |
| Notifications | APNs/FCM registration, permission/settings UX, provider delivery, generic private payloads, authenticated taps and offline revocation are implemented and contract-tested. Provider credentials and observed store-installed delivery are separate gates; do not infer delivery from a simulator alert or provider acceptance alone. |
| App links | Exact origin/route validation, protected-route login continuation, cold/warm handlers, association endpoints and platform entitlements are implemented. Associations must be deployed and verified against the installed signed release. |
| Downloads/sharing | PDF/CSV/ICS exports, private cache files, native Save/Share, result links and platform printing are implemented. Session changes cancel pending exports. Physical Files/Downloads destinations, cancellation and account switching need platform acceptance. See [native integrations](native-integrations.md). |
| Payments/external navigation | External HTTPS and checkout/Connect handoffs use the system browser; valid associated returns use normal route guards. Feature flags remain unchanged. Real payment transactions and store-installed return flows are unverified. |
| File uploads | Multipart requests fail explicitly rather than being silently mis-encoded. There are no current FormData callers; implement native upload handling before adding one. |
| Release compatibility | Define minimum API/app version negotiation and upgrade policy before distributing versions that can outlive backend releases. |
| Stores/accessibility | The original 1.0 (1) internal builds remain distinct from corrective 1.1 (2). Publication of a replacement and real-device VoiceOver/TalkBack acceptance must be recorded explicitly. |

## Verification

The [original 8 October emulator report](native-test-report-2026-10-08.md) records
the 1.0 prototype's authenticated Android and anonymous production-origin checks.
It does not verify the corrective notification and integration features. The
[corrective test report](native-corrective-test-report-2026-10-08.md),
[corrective plan](mobile-corrective-plan.md), [native integrations](native-integrations.md)
and [notification guide](native-notifications.md) distinguish implementation,
automated evidence and outstanding physical-device acceptance.

Measured on 5 October 2026 against a local HTTPS proxy and the guarded test DB:

- iOS simulator build succeeded without distribution signing. Dedicated iPhone
  and iPad simulators both signed in with Secure cookies and opened the Control
  Room online. Concurrent windows exercised the existing controller warning.
- After native cookie persistence was added, force-quit/relaunch on the iPhone
  restored the signed-in session. The public landing-page safe-area overlap
  found during this check was corrected.
- Android Debug compilation succeeded. Phone and tablet emulator runtime checks
  were blocked by available disk space: the installed API 36 Play Store image
  requires about 7.4 GB free to boot, while roughly 3.6 GB was available. Android
  runtime was unverified in that initial run; the later October 8 checks below supersede that gap.
- `npm run verify:local` passed (lint, web build, safe tests, motion and bundle
  limits). The final targeted native/auth checks passed all 37 tests after the
  logout-response ordering fix.

On 8 October 2026 the existing API 36 Android emulator passed local HTTPS
sign-in, Control Room live connection, process-restart session persistence,
background/resume, server-interruption recovery, online logout and offline logout
followed by restart (the next authenticated request returned 401). Phone portrait
and tablet-sized landscape layouts were inspected. The temporary Debug trust
files and test fixtures were removed before production-origin builds.

These observations do not establish physical-device, background-push or complete
role/workflow parity. Temporary test certificates are not release configuration.
The temporary Debug trust manifest, CA and network-security XML were removed
after the simulator proof, together with its synthetic test fixture and backend.

Focused contracts run with:

```sh
node --test test/native-transport.test.js test/native-socket-lifecycle.test.js test/socket-ticket.test.js
```

They cover exact origin isolation, iOS's opaque custom-scheme origin, credential
and response-header handling, offline logout ordering, binary/JSON responses,
ticket purpose/expiry and the real HTTP/socket authorization boundaries.
Run the normal lint, web build, safe/integration tests and relevant Playwright
regressions too. Native compilation and simulator evidence are separate gates;
an HTML build alone does not establish native readiness.

Primary references: [Capacitor setup](https://capacitorjs.com/docs/getting-started),
[configuration](https://capacitorjs.com/docs/config),
[native HTTP](https://capacitorjs.com/docs/apis/http),
[cookies](https://capacitorjs.com/docs/apis/cookies), and
[application lifecycle](https://capacitorjs.com/docs/apis/app).
