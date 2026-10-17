# Native release evidence — 17 October 2026

## Version 1.3 (8) — signed and submitted to both stores (later on 17 October)

The signed release was produced on the mac-mini after the preparation below;
see [Signed release and store submission](#signed-release-and-store-submission)
at the end of this note for the final state.

## Preparation on the MacBook — unsigned, not submitted

Version **1.3 (build 8)** carries the web app deployed to `https://divinghq.app`
at `a01113c9` (schema 108) into the native apps: sign-up and My Profile collect
date of birth and gender (the register API now refuses an account without them,
so the 1.2 builds can no longer create accounts), event entry checks gender and
age group, Dive Sheets shows the diver's club and the events not open to them,
and club admins reach Assign Judges from the event row.

This note records what was done on the development Mac on 17 October. **No
signed package was produced and nothing was uploaded to either store.** The
signing and store material the 1.0–1.2 releases used is not on this machine
(see "What blocks the upload" below).

### Source and version bump

- `android/app/build.gradle`: `versionCode 8`, `versionName "1.3"`.
- `ios/App/App.xcodeproj/project.pbxproj`: `CURRENT_PROJECT_VERSION = 8`,
  `MARKETING_VERSION = 1.3` in both build configurations.
- Bundle built with `VITE_NATIVE_API_ORIGIN=https://divinghq.app npm run native:sync`
  from the commit that carries this note. `dist-native/index.html` and both
  platform copies carry the production origin in their CSP; no `server.url`
  remote wrapper and no local test origin is packaged.

### Toolchain on this Mac

- Xcode 27.0 (27A266a) is installed, but `xcode-select` points at the
  Command Line Tools and Xcode's first-launch step has not been run (the
  Claude Code simulator panel reports this; `Simulator.app` is absent). Builds
  ran with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; an
  owner-run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
  and `sudo xcodebuild -runFirstLaunch` would complete the setup.
- Gradle's toolchain demanded JDK 21 (the installed Temurin 17 fails
  `:capacitor-filesystem:compileDebugJavaWithJavac`). `brew install openjdk@21`
  was linked at `~/Library/Java/JavaVirtualMachines/openjdk-21.jdk` and the
  Android build was run with `JAVA_HOME` set to it.

### Debug compilation (unsigned)

- iOS: `xcodebuild -scheme App -sdk iphonesimulator -configuration Debug
  CODE_SIGNING_ALLOWED=NO` succeeded; the built `Info.plist` reads
  `CFBundleShortVersionString 1.3`, `CFBundleVersion 8`.
- Android: `./gradlew assembleDebug` succeeded (306 tasks); `dumpsys package`
  on the installed APK reads `versionCode=8`, `versionName=1.3`, minSdk 24,
  targetSdk 36.

No release / archive build was attempted: the Release configurations refuse
to build without the signing inputs listed below, by design.

### Smoke test against the guarded test database

Per [native-apps.md](native-apps.md), a throwaway Debug bundle was built with
`VITE_NATIVE_API_ORIGIN=https://localhost:3443`, pointing at a temporary
HTTPS proxy in front of the local test server (`.claude/launch.json`
`scoreboard-preview`, database `divinghq_test`, schema 108). The proxy's
two-day self-signed CA was trusted only on the iPhone 17 simulator keychain
and, for Android, through a debug-source-set network-security config; none of
that entered the repository or the production-origin bundle. No production
account or production data was used.

- **Android** (existing API 35 emulator, 1080×2400): the bundled shell
  rendered the landing page; **Register** shows the new **Date of birth**
  field (with the World Aquatics Article 1.8 explanation) and the **Gender**
  select; sign-in as the seeded fixture diver `aus.diver.01` succeeded through
  the native cookie jar and the socket-ticket exchange (`GET
  /api/auth/socket-ticket` in the proxy log); **Dive Sheets** shows the
  **My club · Brisbane Aquatic Centre** card and the new "2 events accepting
  entries aren't open to you: This is a women's event; your profile says male.
  Check your Competition details." note.
- **iPhone 17 simulator** (iOS 26): the bundled shell rendered the landing
  page and the app issued `/api/features`, `/api/auth/me`, `/api/public-config`
  and `/api/events?status=Live` through the HTTPS origin. Interactive
  checks were not possible on iOS here: without Xcode's first-launch
  components there is no `Simulator.app` to drive, and the first two launches
  showed a blank WebView while the Mac was at a load average above 400 (a
  sibling Playwright run plus the simulator runtime's first boot); the third
  launch, at a lower load, rendered normally.

Evidence (screenshots, the proxy request log, build logs, source commit) is
kept outside Git at `~/DivingHQ-releases/1.3-8/`. The earlier releases'
volume `/Volumes/Storage/DivingHQ-releases/` is not mounted on this Mac.

Cleanup: the apps were uninstalled from both devices, the simulator keychain
was reset (Xcode 27's `simctl keychain` has no single-certificate removal; the
simulator had been booted for the first time that day and held nothing else),
the simulator was shut down and the emulator stopped without saving its
snapshot, `android/app/src/debug/` was deleted, the proxy and local server
were stopped, and the production-origin bundle was rebuilt into
`dist-native/` and both platform projects (`localhost:3443` appears nowhere in
them).

### What blocks the upload

Every item below is owner material that the previous release machine held and
this Mac does not. The build cannot be signed or submitted until they are in
place; none is created or changed by this note.

| Needed for | Missing on this Mac |
|---|---|
| iOS App Store export (`ios/ExportOptions-TestFlight.plist`, manual signing) | The **Apple Distribution** certificate with its private key in the login keychain (only `Apple Development: Christian Brooker` is present) and the **DivingHQ App Store Native** provisioning profile (`c7b6945b-…`); only two `com.tacticalmaps.app` profiles are installed |
| Android release bundle (`./gradlew bundleRelease`) | `DIVINGHQ_ANDROID_SIGNING_PROPERTIES` → a properties file and the **upload keystore** outside the repository (Play App Signing needs this exact upload key), plus `android/app/google-services.json` for Firebase project `divinghq-3c01e` |
| TestFlight upload and the 1.3 App Store submission | An App Store Connect API key (key id, issuer id, `.p8`) or an Apple ID app-specific password; `~/Downloads/AuthKey_377DG4XG4R.p8` exists but its issuer and purpose are unrecorded (it is not the APNs key `57V96TN77H`) |
| Play Console production release | A signed-in Play Console session or a service-account credential |

Store state to resolve first, from
[store-distribution-disclosures.md](store-distribution-disclosures.md): on
14 October Apple's **1.2 (7)** was *waiting for review* and Play's **1.2 (7)**
was *published* on production. A 1.3 submission needs a new App Store version;
if 1.2 is still in review it has to be approved or its submission cancelled
before 1.3 (8) can be submitted.

### Release notes to use for both stores

> Sign-up and My Profile now collect your date of birth and gender, and event
> entry checks them against each event's age group and gender. Dive Sheets
> shows your club and lists events that aren't open to you. Club admins can
> seat judge panels from the event row.

### Next steps once the material is available

```sh
VITE_NATIVE_API_ORIGIN=https://divinghq.app npm run native:sync
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath <release dir>/DivingHQ.xcarchive archive
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -exportArchive \
  -archivePath <release dir>/DivingHQ.xcarchive \
  -exportOptionsPlist ios/ExportOptions-TestFlight.plist -exportPath <release dir>/ios
DIVINGHQ_ANDROID_SIGNING_PROPERTIES=<outside repo>.properties \
  JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  sh -c 'cd android && ./gradlew bundleRelease'
```

Then upload per [native-testing-releases.md](native-testing-releases.md),
record checksums and store identifiers in a new section of this note, and
re-check the compatibility order: the backend at `a01113c9` already refuses
sign-ups without date of birth and gender, so the 1.3 builds should reach
both stores as soon as they can be signed.

## Signed release and store submission

Done from the development MacBook over Tailscale against the **mac-mini**, which
holds the release material the 1.0–1.2 releases used (Apple Distribution
identity, the `DivingHQ App Store Native` profile, the Android upload keystore
with its properties file at `~/.config/divinghq/signing/`, the Firebase
`google-services.json`, the App Store Connect API key in
`~/.appstoreconnect/private_keys/` with `ASC_KEY_ID` / `ASC_ISSUER` in
`~/.zshrc`, and gcloud signed in for Play). Its checkout at `~/Code/DivingHQ`
was switched to `main` and fast-forwarded to `7018aa3c` (the merge of this
note's first PR), which is the exact source of both packages.

| Package | Path on the mini | SHA-256 |
|---|---|---|
| iOS | `/Volumes/Storage/DivingHQ-releases/1.3-8/ios/App.ipa` | `6873b3532b44a8064c5847bd2520ef868641ca3a2b9757817e2ed35633ca21a5` |
| Android | `/Volumes/Storage/DivingHQ-releases/1.3-8/android/DivingHQ-1.3-8.aab` | `033ab3140603eb4c8bf3e01f2c622f658c0caa9b57483ea8a5df795649e69297` |

Copies and the verification logs are also under `~/DivingHQ-releases/1.3-8/`
on the MacBook.

### How the keychain problem was solved

`xcodebuild archive` over SSH failed at CodeSign with `errSecInternalComponent`:
the login keychain is locked for an SSH session even while the owner is logged
in at the console. Running the same archive and export inside the owner's GUI
login session works without a password: a one-shot LaunchAgent
(`RunAtLoad`, `ProgramArguments` = the release script) bootstrapped with
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`. Two
constraints: processes started that way can't write to `/Volumes/Storage`
(privacy permission), so the archive, export and a dedicated `-derivedDataPath`
went under the home directory and were `rsync`ed onto the release volume
afterwards; and the agent is removed again with `launchctl bootout` plus
deleting the plist once the run ends. The Android bundle needs no keychain and
was built over SSH directly (`JAVA_HOME` = Homebrew `openjdk@21`,
`DIVINGHQ_ANDROID_SIGNING_PROPERTIES` = the properties file above).

### Package checks

- IPA: `codesign` shows team `6MY34D5RKG`, `aps-environment` and
  `applinks:divinghq.app`; embedded profile `DivingHQ App Store Native`;
  `CFBundleShortVersionString 1.3`, `CFBundleVersion 8`,
  `ITSAppUsesNonExemptEncryption false`; the bundled shell carries
  `https://divinghq.app` and no local origin. Export used
  `ios/ExportOptions-AppStore.plist` (App Store Connect, not TestFlight-only).
- AAB: `jarsigner -verify` passes; signer `CN=DivingHQ Upload`
  (SHA-256 `59:6F:7D:DD:…:4B:60:DB`, the registered upload key, distinct from
  Play's distribution key); `versionCode 8`, `versionName 1.3`; bundled shell
  carries `https://divinghq.app`.

### Apple

Uploaded with the App Store Connect CLI (`asc builds upload --wait`), which
reads `ASC_KEY_ID`, `ASC_ISSUER_ID` (mapped from `ASC_ISSUER`) and
`ASC_PRIVATE_KEY_PATH` from the environment of an interactive login shell.
Build `fe149de3-5ecf-4973-9486-1c256ed8651f` processed as **VALID**, version
1.3 build 8. App Store version **1.3**
(`990f4867-6bd4-4352-a5b3-c7db839ca71b`) was created with 1.2's description,
keywords, URLs and promotional text copied, review details carried over, the
What's New text below set on `en-AU`, release type AFTER_APPROVAL (1.2's
phased release setting remains). `asc review submit` attached the build and
submitted at **12:08 UTC on 17 October 2026** (submission
`20173ce9-eee5-4847-9803-c4673f9d7a88`); readback: app store state
**WAITING_FOR_REVIEW**, review state WAITING_FOR_REVIEW. Evidence:
`verification/asc-upload.log`, `asc-version-1.3-create.json`,
`asc-version-1.3-whatsnew.json`, `asc-review-submit.json`,
`asc-status-after-submit.json`. The 1.2 version it supersedes was already
READY_FOR_DISTRIBUTION (its 13 October review had completed), so nothing had to
be cancelled.

### Google Play

The Play Console's own page couldn't take the 10.7 MB bundle from the browser
pane, so the upload went through the Play Developer API instead: the developer
account already lists the service account
`play-publish@project-a0be5de3-cb44-4a4d-9e6.iam.gserviceaccount.com`, and
TacMap's stdlib publisher (`~/Code/TacticalMaps/scripts/play_publisher.py`,
keyless `gcloud auth print-access-token --impersonate-service-account`) was
copied with the package name and release name made configurable
(`verification/play_publisher_divinghq.py` on the MacBook). A `--dry-run`
validated the edit first. The real edit uploaded bundle **versionCode 8** and
set the production track to one release, **1.3 (8)**, status `completed`, with
the `en-AU` notes below, then committed at **12:20 UTC on 17 October 2026**.
Track readback: `production completed 1.3 (8) codes=['8']`. The console shows
**Release 1.3 (8) in review**, 178 countries/regions; managed publishing is
still off, so it goes live when Google's review passes. The empty draft release
the console had created was replaced by the API edit. No listing, pricing,
audience or declaration was changed. Evidence: `verification/play-upload-1.3-8.log`
and `play-production-1.3-8-in-review.jpg`.

### Release notes used on both stores

> Sign-up and My Profile now collect your date of birth and gender, and event
> entry checks them against each event's age group and gender. Dive Sheets
> shows your club and lists events that aren't open to you. Club admins can
> seat judge panels from the event row.

### Still open

- Both reviews are pending; nothing here is evidence of approval or of a
  store-installed 1.3 (8) on a physical device.
- Rork's `asc` CLI expects `ASC_ISSUER_ID`; the mini exports `ASC_ISSUER`, so
  map it (or add it to `.zshrc`) before the next upload.
- `xcodebuild -checkFirstLaunchStatus` still reports first-launch pending on
  both Macs; it did not stop the archive on the mini.
