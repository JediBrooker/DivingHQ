# Native release evidence — 9 October 2026

Release candidate: **1.1 (2)**, app identifier `app.divinghq.mobile`, production
API origin `https://divinghq.app`. Access remains limited to the previously
selected owner. No public production release is requested or claimed.

## Signed artifacts

Artifacts were built from source
`843466dfd29bb09c0c54621a85341ff9596ae1d9`. Changes since the verified corrective
source `48e10c4c` are documentation and the separate `ops/watch` service/tests;
the mobile implementation is unchanged. The Watch changes passed their targeted
suite: **121 tests, zero failures or skips**. The deployed app backend remains
`48e10c4c`, schema **105**, as verified in the
[corrective report](native-corrective-test-report-2026-10-08.md#production-backend-deployment).

Both packages contain identical native JavaScript assets and the explicit
production API origin. The signed-package record is
`/Volumes/Storage/DivingHQ-releases/1.1-2/verification/signed-artifacts.json`.
Its `storeUpload: "not performed"` field describes the signing checkpoint before
the later Apple upload recorded below.

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
Vision availability remains disabled. This confirms availability for the owner,
not installation of 1.1 (2) or observed push delivery.

Evidence: `verification/asc-upload.log`, `verification/asc-build2-final.json`,
`verification/asc-build2-group-assignment.json` and
`verification/asc-owner-testers-final.json` under the release directory above.

The Android bundle is signed and validated. A replacement Play upload or release
has not yet been verified at this checkpoint; the prior owner-only internal
track remains the distribution destination.

## Provider provisioning and device acceptance

The legitimate Firebase project is `divinghq-3c01e`. A dedicated service identity,
send-only custom role and credential were created with the owner's approval.
The credential was installed outside the checkout in LXC 120, with a 0700
directory and 0600 file. Only `FCM_SERVICE_ACCOUNT_PATH` was added to the backend
environment; the application restarted through PM2 without a source pull or
deployment. Local and public health remained HTTP 200, schema 105.

A fresh production provider instance reports **Android configured / iOS
unconfigured**. OAuth authentication succeeded. An FCM `validate_only` request
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

The Apple APNs registration action was attempted, but the browser window closed
before the key could be downloaded. The resulting key's identity and usable
credential have not yet been confirmed. No production APNs readiness or delivery
is claimed.

Physical iPhone/iPad and Android store-installed acceptance remains separate from
simulator/emulator verification. The earlier test evidence and the remaining
permission, account-switching, background-delivery, app-link and accessibility
checks are preserved in the [corrective plan](mobile-corrective-plan.md#physical-store-build-acceptance).
