# Native testing releases

The current owner-only testing release is **1.2 (3)**, with bundled assets explicitly configured
for `https://divinghq.app`. Signed artifacts passed package review and both stores
report the release available to the existing owner-only internal audiences.
The matching backend is deployed and verified healthy. See the
[9 October release evidence](native-release-evidence-2026-10-09.md) for the exact
store and deployment checkpoint. Earlier 1.1 (2) notification proof is retained
there, and the original **1.0 (1)** release is recorded below as history.

Testers use live accounts and data. This is internal testing, not a public App
Store or Play production release. Implemented features, emulator checks, provider
delivery and physical store-installed acceptance are separate claims; see
[native apps](native-apps.md) and the release evidence before relying on a workflow.

On 9 October the owner confirmed one background notification received by
TestFlight 1.1 (2) on a physical iOS device, with its tap opening Settings.
The device model and remaining physical acceptance scenarios were not confirmed;
Android delivery evidence is from an emulator, not a Play-installed physical device.

## Registered destinations

- App identifier on both platforms: `app.divinghq.mobile`.
- Apple team: `6MY34D5RKG`; App Store Connect app `6820469893`, SKU
  `divinghq-mobile`, primary locale `en-AU`.
- iOS Release target uses the existing Apple Distribution identity and
  `DivingHQ App Store Native` provisioning profile (UUID
  `c7b6945b-1193-4c68-b97e-04073bcee5bd`), which permits production APNs and
  `applinks:divinghq.app`. Debug simulator builds need no
  distribution identity. The profile and private key stay outside the repo.
- Google Play uses the existing Christian Brooker developer account, DivingHQ
  app, and internal testing track. Play App Signing manages the distribution
  signing key; the dedicated local upload key signs submitted bundles.

## Build signed artifacts

Use Node 22, JDK 21, the Android SDK and Xcode. Reuse existing test devices and
Xcode's default DerivedData location as described in the native guide. Sync once
before both platform builds, and serialize shared build assets with anyone
running device tests.

The paths below identify the 1.2 (3) release. Preserve uploaded artifacts and
their checksums; use a new version/build directory for every future candidate
rather than overwriting a published package.

```sh
VITE_NATIVE_API_ORIGIN=https://divinghq.app npm run native:sync
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /Volumes/Storage/DivingHQ-releases/1.2-3/DivingHQ.xcarchive archive
xcodebuild -exportArchive \
  -archivePath /Volumes/Storage/DivingHQ-releases/1.2-3/DivingHQ.xcarchive \
  -exportOptionsPlist ios/ExportOptions-TestFlight.plist \
  -exportPath /Volumes/Storage/DivingHQ-releases/1.2-3/ios
```

The export options export locally and mark the build **TestFlight internal
only**. They do not upload or submit for public review. Version numbers are
explicit; increment both platform build numbers before a replacement upload.

For Android, set `DIVINGHQ_ANDROID_SIGNING_PROPERTIES` to an existing absolute
properties file **outside the repository**, containing `storeFile`,
`storePassword`, `keyAlias` and `keyPassword`. `storeFile` must also be an existing
absolute file outside the repository. Canonical checks reject symlinks back into
it. Protect the file and keystore with owner-only permissions, and back up both
in an approved encrypted location before relying on them for future updates.
Never commit either file or paste credentials into logs.

```sh
# Set the properties path in your local environment; it contains secrets.
cd android
./gradlew bundleRelease
```

The bundle is `android/app/build/outputs/bundle/release/app-release.aab`.
Release builds fail without signing configuration; Debug builds remain available
without it. Android Release also requires the legitimate Firebase client
configuration for `app.divinghq.mobile` in the correct project; the file remains
ignored. The repository contains no upload key, password or provider private key.

## Gates before distributing to testers

1. Run the required local CI and platform builds, then inspect packaged origin,
   signatures, privacy manifests, and absence of Debug CA/trust overrides.
2. Verify public startup on production-origin Android/iPhone/iPad builds.
3. Confirm the backend/client compatibility order and selected audience before
   publication. For 1.2 (3), make both native updates available to the existing
   owner before deploying enforcement that 1.1 cannot satisfy. Follow the
   [concurrency rollout gates](mobile-concurrency-plan.md#rollout-gates).
4. Upload for processing to the existing TestFlight app and Play internal track.
   Uploading alone must not assign testers, notify people or submit a public
   release. Publish only to the selected audience after the compatibility plan is
   confirmed. Add testers or send invitations only after the owner selects them.
5. Re-check that no production event is Live immediately before the 1.2 backend
   deployment, then use the normal `deploy.sh` workflow. Verify production health
   and deployed commit, not only local source. Native sign-in needs
   `GET /api/auth/socket-ticket`: anonymous requests must return 403 rather than
   404, and a malformed bearer token must return 401.

The app uses operating-system HTTPS/TLS and declares no non-exempt encryption
in iOS `Info.plist`. Reassess that declaration if bundled encryption changes.
SDK privacy manifests do not describe DivingHQ's server-side data collection:
use the [privacy policy](privacy-policy.md) and actual app behaviour for store
data declarations. Internal testing does not establish complete role coverage,
physical-device reliability, or readiness for use at a live meet.

## Original 1.0 release — 8 October 2026

The signed version 1.0/build 1 candidates passed local artifact review; exact
hashes and verification results are in the [test report](native-test-report-2026-10-08.md).
App Store Connect finished processing build
`c5516ea9-7145-421c-becd-e455c61eef81`, version **1.0 (1)**, with status **VALID**
and audience **INTERNAL_ONLY**. It expires on 6 January 2027. The build reports
`usesNonExemptEncryption=false`, and the `en-AU`
What to Test text was saved. After backend verification, the build was assigned
to the **DivingHQ Internal** group (`08053825-a507-405d-b453-efdc3b687336`). API
readback confirmed exactly this build and **one tester: the owner**, with internal
state `IN_BETA_TESTING` and external state `NOT_APPLICABLE`. The owner was invited
through App Store Connect; subsequent API readback reported `INSTALLED` for
version 1.0 (1). This confirms store installation, not authenticated workflow
testing. The group has no public link or access to all builds. Apple silicon Mac
and Apple Vision
availability are disabled for this phone/tablet test group. No other testers
were added or invited.

Google Play accepted bundle 1 (1.0), showing minimum API 24 and target API 36;
release `1` was published on internal track `4701056953067005627` at 22:00 Sydney
time on 8 October. Play reports **Available to internal testers** for 1.0 (1).
The track is **Active**, with only the **DivingHQ Owner** email list selected;
that list contains the owner's existing Google developer account and shows one
user. The saved selection was verified in Play Console. Its
[internal opt-in link](https://play.google.com/apps/internaltest/4701056953067005627)
does not grant access to an unselected account. Neither platform has a public
production release. Android opt-in and installation have not been independently
verified. Play's initial release preview showed no errors; the warning about
absent deobfuscation mapping is expected with the current `minifyEnabled false`
release build.

The matching backend was deployed on 8 October 2026 at 10:57:50 UTC
(`8cbd5b95`, schema 104). Public health/features returned 200 with feature flags
unchanged; the socket-ticket endpoint rejected anonymous requests with 403 and
malformed bearer tokens with 401. Testing access is limited to the owner as
requested.

## Install an available owner testing build

- **iPhone or iPad:** install Apple's TestFlight app, then open the DivingHQ
  invitation sent to the owner's Apple account. Open DivingHQ in TestFlight and
  install **1.2 (3)**, which is assigned to the existing owner-only group.
- **Android phone or tablet:** sign in to Google Play with the selected owner
  account, open the internal opt-in link above, join the test, and follow its
  Google Play installation link for **1.2 (3)**.

Both builds connect to `https://divinghq.app` and use live accounts and data.
Update to 1.2 (3) before using the updated Control Room: 1.1 (2) does not have the
new ownership token required to finalise a Live event. Reading and judging remain
available in the older build.

Official references: [Apple TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/),
[Google Play testing](https://support.google.com/googleplay/android-developer/answer/9845334),
[Android signing](https://developer.android.com/studio/publish/app-signing), and
[Apple encryption requirements](https://developer.apple.com/documentation/Security/complying-with-encryption-export-regulations).
