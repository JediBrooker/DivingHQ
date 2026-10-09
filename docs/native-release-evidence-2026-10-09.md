# Native release evidence — 9 October 2026

## Simultaneous-event release — 1.2 (3)

Owner-only testing release **1.2 (3)** uses `app.divinghq.mobile` and the explicit
API origin `https://divinghq.app`. Both stores report it available to the
existing owner-only internal audiences. The matching backend was deployed and
verified healthy at the exact final source below. The historical 1.1 (2) release and notification proof are retained
below and are not presented as physical-device acceptance of 1.2 (3).

### Behaviour and compatibility

Judges with several Live assignments now choose an event using its event and
meet labels; a single Live assignment still opens automatically. Pending or
unacknowledged scores prevent switching, and queued scores keep their original
event and diver. Control Room opens as an observer. Each event has one explicit
controller, with named takeover between devices, including devices signed in to
the same account. Different events can have different controllers.

Backgrounding, disconnecting or losing control stops automatic advancement and
the local clock. Returning refreshes the server state and requires **Take control**;
the stopped clock also needs a deliberate restart. Progression commands are
acknowledged directly instead of entering the durable offline queue. Obsolete
queued progression is cancelled without discarding legitimate judge scores.

**Install 1.2 (3) before operating the updated Control Room.** A website deployment
does not update the assets bundled in 1.1 (2). The new backend refuses legacy HTTP
finalisation without the current ownership token, including after a lease expires
or is released. Reading and judging remain available. Legacy cursor control is
restricted to an exclusively owned socket. This work retains the existing
single-process live-state architecture; it does not add unattended server-side
meet automation. See the [concurrency plan](mobile-concurrency-plan.md).

### Exact source and signed packages

Final source: `4c1cfbe838db63de4fe509b4d5624ffa88250243`.
Native functional acceptance used `c652c0f135cb7744fe2fbca08e342cc36bfd53a9`;
the final difference is the independently reviewed judge tour translations and
guide wording. The final source passed all required local gates again before
signing. Both commits are on `main`.

Artifacts and evidence are preserved under
`/Volumes/Storage/DivingHQ-releases/1.2-3/`. The signed-package manifest is
`verification/signed-artifacts.json`; its `storeUpload: "not performed"` field
records the signing checkpoint, before the later uploads described here.

| Package | Path within the release directory | SHA-256 |
|---|---|---|
| iOS | `ios/App.ipa` | `fa6a243d1a4e3db8a4df4a2ffa1ab3fda0118cc2329605384d3777d6dbc5dc54` |
| Android | `android/DivingHQ-1.2-3.aab` | `874347d0815c50916911b07d20f6805337b2b2bcb9dacaa3b068b39909c4ab13` |

All 288 shared native assets match between the platforms. Strict deep iOS
codesign verification passed with the existing distribution profile/team,
production APNs, `applinks:divinghq.app`, and iPhone/iPad families. Android passed
jarsigner and bundletool 1.18.3 validation with the existing upload certificate
and Firebase project `divinghq-3c01e`. FCM auto-init and analytics collection remain
disabled by default. Neither release enables debugging, cleartext traffic or
custom test trust; no local test origin or remote `server.url` wrapper is packaged.
The previously published 1.1 (2) artifact checksums remain unchanged.

### Automated and native verification

Both the functional change and the final copy follow-up passed `npm run lint`,
`npm run build`, **1,606 Node/integration tests**, and **456 Playwright tests**,
with zero failures or skips and no Playwright flakes. The browser run comprised
438 Chromium, 4 Firefox, 4 mobile Chrome and 10 mobile Safari cases. The final
copy also passed nine i18n/tour checks and four fresh-account rendered-tour checks
(English phone/tablet, French tablet and Arabic phone).

Evidence: `verification/verification.json` and
`verification/onboarding-copy/verification.json`. The final verified source
fingerprint is `c2eb86b33ecd9dd18aaa9101877a769dbfad3443f7f4329c9c7fde427d3477d8`.
The manifests record commands, runtime, guarded test database, logs and screenshots.
No integration tests ran against production.

Regression coverage includes independent event control, two devices on one
account, takeover/disconnect/expiry, UUID case normalization, stale and tokenless
finalisation refusal, hold/status guards, canonical roster restoration, stale
outbox cancellation, and judge selection/pending-score isolation. Independent
source and quality review passed. Persistence/finalisation ordering was reviewed
in source; an injected delay in persistence was not a separate regression test.

Native checks reused the existing Android API 36 emulator, iPhone 17 simulator
(iOS 26.5) and iPad Pro 13 M5 simulator (iPadOS 26.5):

- Android observed both events on opening, enforced exclusive ownership, and
  stopped both auto-next countdowns through a real OS Home action: neither event
  advanced during seven seconds away. Resume followed the changed server cursor,
  required explicit control and retained stopped clocks. Named takeover and judge
  choice/switch passed. A 1280×800 tablet layout had no document overflow.
- iPhone and iPad passed real Home/app-icon return with loss of ownership and a
  stopped clock. Another socket on the same account could claim control, and the
  canonical cursor was preserved. Judge choice and correct selected panels passed.
  The iOS auto-next countdown during Home was not separately exercised.
- Final production-origin startup passed on all three platforms after the copy
  update. Android's native health request returned 200 and document width matched
  the 411-pixel viewport.

Native evidence: `device-verification/android-acceptance.json`,
`device-verification/ios-acceptance.json` and screenshots in that directory.
The Android harness initially encountered an ordinary event-live toast over its
switch target; dismissing the visible toast corrected the harness. A tiled
Playwright capture immediately after density resizing was a capture artifact;
the retained Android OS screenshot showed the normal tablet surface.

A remaining cosmetic Control Room observation is recorded in
`verification/onboarding-copy/control-width-390.json`: the document and cards fit
390 pixels and the primary control remained accessible, while the inner workspace
had a 450-pixel scroll width, likely from hidden tooltip pseudo-elements. No
broader tooltip refactor was included in this release.

There is **no physical or store-installed 1.2 (3) acceptance claim**. The older
physical iOS push confirmation below remains valid for 1.1 (2) only. Device tests
used synthetic local fixtures. The fixtures, temporary trust and local services
were removed, production-origin bundles restored, Android size/density and ADB
reverse restored, app data cleared, and reused devices shut down. Cleanup is
recorded in `device-verification/cleanup-local.json` and
`verification/final-cleanup.json`; the final public smoke is recorded in
`verification/production-startup.json`.

### Store availability and backend rollout

Google Play published **1.2 (3) - simultaneous event control**, version code **3**,
on internal track `4701056953067005627` at **15:16 Sydney time on 9 October 2026
(04:16 UTC)**. Console readback reports **Active** and **Available to internal
testers**. The selected **DivingHQ Owner** list still contains exactly one owner;
no audience expansion was made. Minimum API 24 and target API 36 remain unchanged,
with no phone/tablet support losses. Preview reported no errors and two warnings:
missing deobfuscation mapping (`minifyEnabled false`) and native debug symbols.
Evidence: `verification/play-publication.json`,
`verification/play-1.2-3-published.png` and
`verification/play-1.2-3-owner-audience.png`.
The [existing internal opt-in link](https://play.google.com/apps/internaltest/4701056953067005627)
remains the installation route for that selected account. Availability does not
establish installation.

Apple processed build `4262884f-2af5-4bc7-a1a0-da72777fdbec`, version **1.2 (3)**,
as **VALID**, **INTERNAL_ONLY**, **IN_BETA_TESTING**, with external state
**NOT_APPLICABLE**, minimum iOS 15.0 and `usesNonExemptEncryption=false`.
What to Test was saved. The build is assigned explicitly to exactly the existing
**DivingHQ Internal** group (`08053825-a507-405d-b453-efdc3b687336`), with one
intended owner and `hasAccessToAllBuilds=false`. No new tester invitations or
public review were submitted. Evidence: `verification/asc-build3-final.json`,
`verification/asc-build3-beta-final.json`, `verification/asc-build3-groups-final.json`,
`verification/asc-owner-testers-final.json` and `verification/publication-final.json`.

The normal `deploy.sh` deployment completed at **15:19:05 Sydney time on
9 October 2026 (04:19:05 UTC)**, after both stores reported availability. A fresh
preflight at 04:18:02 UTC found **zero Live production events**. Production runs
exact source `4c1cfbe838db63de4fe509b4d5624ffa88250243`, schema **105**, with a
clean checkout and PM2 `dive-recorder` online. No schema migration was required.

The deployment's safe suite reported **1,045 passes, zero failures and three
expected skips** (the deferred locale check and two macOS-font checks on Linux).
This is distinct from the full local 1,606-test suite, which had zero skips.
Post-deployment readback at 04:19:43 UTC confirmed local and public health HTTP
200, anonymous socket-ticket rejection at 403 and malformed bearer rejection at
401. Feature flags remain payments/classes/maintenance off and signups on. Both
provider credential files remain present, with APNs still production-scoped.
Evidence: `verification/production-deploy-preflight.json`,
`verification/production-deploy.log` and `verification/production-postdeploy.json`.

The optional background translation process subsequently failed with an Anthropic
insufficient-credit response while checking 178 pre-existing stuck keys. Its
partial writes were discarded and the production checkout remained clean. This
is an ancillary translation-service follow-up, not a failed deployment or an
observed regression in the 1.2 tour translations; those passed the local checks
above.

## Historical corrective release — 1.1 (2)

Owner-only testing release: **1.1 (2)**, app identifier `app.divinghq.mobile`, production
API origin `https://divinghq.app`. Access remains limited to the previously
selected owner. No public production release is requested or claimed.

## Signed artifacts

Artifacts were built from source
`843466dfd29bb09c0c54621a85341ff9596ae1d9`. Changes since the verified corrective
source `48e10c4c` are documentation and the separate `ops/watch` service/tests;
the mobile implementation is unchanged. The Watch changes passed their targeted
suite: **121 tests, zero failures or skips**. At this historical checkpoint the
deployed app backend was `48e10c4c`, schema **105**, as verified in the
[corrective report](native-corrective-test-report-2026-10-08.md#production-backend-deployment).

Both packages contain identical native JavaScript assets and the explicit
production API origin. The signed-package record is
`/Volumes/Storage/DivingHQ-releases/1.1-2/verification/signed-artifacts.json`.
Its `storeUpload: "not performed"` field describes the signing checkpoint before
the later store uploads recorded below.

| Platform | Verified package properties |
|---|---|
| iOS | Strict deep codesign validation passed. Profile `DivingHQ App Store Native`, team `6MY34D5RKG`, production APNs entitlement and `applinks:divinghq.app`. iPhone/iPad families are included; debugging is disabled. |
| Android | Jarsigner verification and bundletool 1.18.3 validation passed. Firebase project `divinghq-3c01e`; FCM auto-init and analytics collection disabled by default. Debugging, cleartext traffic and custom trust are absent. The upload certificate is distinct from the Play App Signing distribution certificate. |

SHA-256 checksums:

- IPA: `b0fd5f75179c62958ef88b802cfcc7e660a7dd07c4cc732852d4c29dbedcbcd2`
- AAB: `c08006e9ee52dfd3e269b0159dd01c12978e0bead24b422b99895df4243a2200`

## Store processing

Apple committed the exact IPA upload and processed build
`67bcc23b-750d-43f6-aa06-64e501a1f8d2`, version **1.1 (2)**. App Store Connect
readback reports **VALID**, **INTERNAL_ONLY**, internal state
**IN_BETA_TESTING**, external state **NOT_APPLICABLE**, and
`usesNonExemptEncryption=false`. The minimum iOS version is 15.0.
The build is assigned to exactly the existing **DivingHQ Internal** group
(`08053825-a507-405d-b453-efdc3b687336`); its tester readback still contains only
the owner. The group has no public link or access to all builds, and Mac/Apple
Vision availability remains disabled. This store readback confirms availability
for the owner; the later owner-confirmed physical delivery check is recorded below.

Evidence: `verification/asc-upload.log`, `verification/asc-build2-final.json`,
`verification/asc-build2-group-assignment.json` and
`verification/asc-owner-testers-final.json` under the release directory above.

Google Play published release **1.1 (2) - native notifications and settings**,
version code **2**, to internal track `4701056953067005627` at **13:37 Sydney
time on 9 October 2026 (02:37 UTC)**. Console readback reports the track
**Active** and the release **Available to internal testers**. The audience was
read back again after publication: only **DivingHQ Owner**, containing one
existing owner account, was selected and the Save control was disabled. No
additional testers were added.
The [existing internal opt-in link](https://play.google.com/apps/internaltest/4701056953067005627)
remains the installation route for that selected account. Store installation and
physical Android receipt have not been independently observed.

The release preview had no errors. Its missing deobfuscation mapping warning is
expected with `minifyEnabled false`; it also reported absent native debug
symbols. Phone/tablet device support was retained. Evidence:
`verification/play-1.1-2-published.txt`, `.jpg` and
`verification/play-1.1-2-owner-audience.txt`.

## Provider provisioning and device acceptance

The legitimate Firebase project is `divinghq-3c01e`. A dedicated service identity,
send-only custom role and credential were created with the owner's approval.
The credential was installed outside the checkout in LXC 120, with a 0700
directory and 0600 file. Only `FCM_SERVICE_ACCOUNT_PATH` was added to the backend
environment; the application restarted through PM2 without a source pull or
deployment. Local and public health remained HTTP 200, schema 105.

At the initial FCM installation checkpoint, a fresh production provider instance
reported **Android configured / iOS unconfigured**. OAuth authentication succeeded.
An FCM `validate_only` request
using a synthetic, non-device token reached registration-token validation and
returned HTTP 400 `INVALID_ARGUMENT`; no notification was sent by this check.
This establishes credential loading/authentication, not device delivery.
Safe metadata is retained in
`verification/production-fcm-provider-2026-10-09.json`. No private credential, raw
device token or personal account address belongs in this report or the repository.

The reused Android emulator passed actual OS permission, genuine Google Play
services FCM registration, an authenticated self-test accepted by the provider,
background OS notification receipt, and tapping that notification to restore
Settings. This used a synthetic account in the guarded local test database;
no production user's notification was generated. Logout then returned HTTP 401
for the authenticated session read, disabled/revoked the device row and revoked
its installation tombstone. Persisted native state had `enabled=false`,
`owner=null`, `pendingRevoke=false` and `pendingUnregister=false`, confirming the
awaited SDK cleanup completed. This is real FCM delivery to an emulator, not
physical or Play-installed acceptance, and does not establish every
locked/terminated-state delivery scenario.

Evidence is under `1.1-2/fcm-device-proof/`: permission, enabled-state,
foreground-test, notification-shade and tap-to-Settings screenshots;
`background-provider-result.json`, `logout-revocation-result.json` and
`sdk-logout-result.json`. Synthetic database fixtures and installation records
were removed and the local server/proxy stopped. The production origin was
restored in `dist-native` and both platform bundles; local proxy references and
temporary Debug trust files were absent. Emulator app data and ADB reverse were
cleared, original size/density restored, and the reused emulator stopped.
`cleanup-result.json` records these checks. Exact signed IPA/AAB checksums remain
unchanged; no redundant platform compilation was needed for cleanup.

Apple APNs key `57V96TN77H` was subsequently created, downloaded and installed
outside the checkout. It is restricted to production and the topic
`app.divinghq.mobile`, under team `6MY34D5RKG`. The validated key is EC
`prime256v1`, with a 0600 credential file in a 0700 directory. Only the four APNs
environment keys (`APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_ENVIRONMENTS`) changed; other values were preserved. PM2 restarted online
without a source pull, and local/public health remained HTTP 200, schema 105.

The final production provider instance reports **iOS and Android configured**.
A request to Apple's production endpoint using a synthetic all-zero token and
zero expiry returned HTTP 400 `BadDeviceToken`. This is an endpoint/credential
configuration check, not evidence that a real device accepted a notification.
No production user's notification was sent by that check. This key does not
authorize sandbox delivery.

Evidence: `verification/apple-apns-key-created.jpg` and
`verification/production-apns-provider-2026-10-09.json`.

## Owner-confirmed physical iOS delivery

At **13:46 Sydney time on 9 October 2026 (02:46 UTC)**, one explicitly authorized
test targeted the owner's single eligible production iOS installation of
**TestFlight 1.1 (2)**. The normal notification service checked account/session
eligibility and cooldown; APNs accepted the request with no provider error.
The owner then confirmed: **“Arrived and opened Settings”**.

This is user-reported evidence of one real background notification received on
a physical iOS device and a successful tap into Settings. The specific device
model was not confirmed, so the result is not labelled iPhone or iPad. Evidence
is retained in `verification/ios-owner-push-test-2026-10-09.json`, with provider
acceptance and the owner's confirmation recorded separately. No account name or
contact address is included here.

This does not establish denied/re-enabled permission, locked/terminated-state
delivery, cold launch, logout/account-switching, or the complete physical-device
matrix. Physical Android and Play-installed delivery remain unverified. The
earlier test evidence and the remaining
permission, account-switching, background-delivery, app-link and accessibility
checks are preserved in the [corrective plan](mobile-corrective-plan.md#physical-store-build-acceptance).
