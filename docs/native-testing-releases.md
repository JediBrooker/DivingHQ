# Native testing releases

The first store testing build is version 1.0, build/versionCode 1, with bundled
assets explicitly configured for `https://divinghq.app`. Testers use live accounts
and data. This is internal testing, not a public App Store or Play production
release. Native push, app links, downloads/sharing and payment redirects remain
outside the verified workflows; see [native apps](native-apps.md).

## Registered destinations

- App identifier on both platforms: `app.divinghq.mobile`.
- Apple team: `6MY34D5RKG`; App Store Connect app `6820469893`, SKU
  `divinghq-mobile`, primary locale `en-AU`.
- iOS Release target uses the existing Apple Distribution identity and
  `DivingHQ App Store` provisioning profile. Debug simulator builds need no
  distribution identity. The profile and private key stay outside the repo.
- Google Play uses the existing Christian Brooker developer account, DivingHQ
  app, and internal testing track. Play App Signing manages the distribution
  signing key; the dedicated local upload key signs submitted bundles.

## Build signed artifacts

Use Node 22, JDK 21, the Android SDK and Xcode. Reuse existing test devices and
Xcode's default DerivedData location as described in the native guide. Sync once
before both platform builds, and serialize shared build assets with anyone
running device tests:

```sh
VITE_NATIVE_API_ORIGIN=https://divinghq.app npm run native:sync
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /Volumes/Storage/DivingHQ-releases/1.0-1/DivingHQ.xcarchive archive
xcodebuild -exportArchive \
  -archivePath /Volumes/Storage/DivingHQ-releases/1.0-1/DivingHQ.xcarchive \
  -exportOptionsPlist ios/ExportOptions-TestFlight.plist \
  -exportPath /Volumes/Storage/DivingHQ-releases/1.0-1/ios
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
without it. The repository contains no upload key or password.

## Gates before distributing to testers

1. Run the required local CI and platform builds, then inspect packaged origin,
   signatures, privacy manifests, and absence of Debug CA/trust overrides.
2. Verify public startup on production-origin Android/iPhone/iPad builds.
3. Deploy the matching backend through the normal `deploy.sh` workflow. An
   unauthenticated `GET /api/auth/socket-ticket` must return 401 rather than 404;
   native sign-in needs this endpoint for authenticated live sockets. Verify
   production health and deployed commit, not only the local source state.
4. Upload for processing to the existing TestFlight app and Play internal track.
   Uploading alone must not assign testers, notify people or submit a public
   release. Distribute only after backend compatibility is confirmed and the
   tester audience has been selected by the owner.

The app uses operating-system HTTPS/TLS and declares no non-exempt encryption
in iOS `Info.plist`. Reassess that declaration if bundled encryption changes.
SDK privacy manifests do not describe DivingHQ's server-side data collection:
use the [privacy policy](privacy-policy.md) and actual app behaviour for store
data declarations. Internal testing does not establish complete role coverage,
physical-device reliability, or readiness for use at a live meet.

## Store status — 8 October 2026

The signed version 1.0/build 1 candidates passed local artifact review; exact
hashes and verification results are in the [test report](native-test-report-2026-10-08.md).
The App Store Connect upload was committed and was awaiting build discovery and
processing at this checkpoint. No TestFlight group or testers were assigned.
Google Play accepted bundle 1 (1.0), showing minimum API 24 and target API 36;
release `1` was saved as a draft on internal track `4701056953067005627`.
It was not rolled out or distributed. Neither upload is a public store release.
Play's release preview showed no errors, with warnings for the unselected tester
audience and absent deobfuscation mapping. The latter is expected with the current
`minifyEnabled false` release build.

Tester distribution remains held until the matching backend is deployed and the
owner selects the audience. At the readiness check, the production socket-ticket
endpoint returned 404 and the normal server deployment was waiting for the
owner's Tailscale SSH authentication check.

Official references: [Apple TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/),
[Google Play testing](https://support.google.com/googleplay/android-developer/answer/9845334),
[Android signing](https://developer.android.com/studio/publish/app-signing), and
[Apple encryption requirements](https://developer.apple.com/documentation/Security/complying-with-encryption-export-regulations).
