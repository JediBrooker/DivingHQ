# Native notification delivery

The native apps use APNs directly on iOS and Firebase Cloud Messaging HTTP v1 on Android. Browser Web Push and the existing authenticated inbox/socket banners remain independent. Native permission is requested only when the user chooses **Settings → Notifications → Enable notifications**.

## Provisioning

Backend environment (dedicated credentials outside the repository, readable only by the service account):

- `APNS_KEY_PATH`: absolute path to an Apple `.p8` push signing key.
- `APNS_KEY_ID`, `APNS_TEAM_ID`: its Apple identifiers. The topic is fixed to `app.divinghq.mobile`.
- `APNS_ENVIRONMENTS=production`: default for a production-scoped key. Add `development` only when the key is explicitly authorised for sandbox delivery. TestFlight uses production; Debug uses development.
- `FCM_SERVICE_ACCOUNT_PATH`: absolute path to a Firebase service-account JSON for the DivingHQ project, with permission to send FCM messages. Enable Firebase Cloud Messaging API v1. No ambient Google credentials are used.

Set up the Android client for exactly `app.divinghq.mobile`. Put its legitimate `google-services.json` in `android/app/`; its project must match the backend service account. Release Gradle refuses a missing configuration or a client/package mismatch. Debug can build without credentials but notification registration cannot succeed. Do not fabricate Firebase configuration to satisfy the build.

Enable Apple Push Notifications and Associated Domains on the bundle identifier. Use the refreshed **DivingHQ App Store Native** provisioning profile. App entitlements include `aps-environment` (Debug development, Release production) and `applinks:divinghq.app`. Refresh a development profile separately for physical Debug testing; never use production keys against sandbox tokens.

Apply migration 105 before deploying the server. Startup validates credential file/key shape, and unconfigured platforms are reported as unavailable in Settings. A configured key is not proof that its remote permissions work: the **Send test notification** action requires actual provider acceptance. Errors remain visible and invalid provider tokens are retired.

## Delivery and privacy

Settings shows this installation's OS permission, opt-in, provider availability and last provider acceptance. Android notification-channel disabling is included in the permission check. Device settings opens the app's OS notification page. App foreground delivery uses the existing in-app banner and inbox; background delivery uses a standard visible OS alert. The foreground OS alert is suppressed to avoid duplicate banners. The channel is named **DivingHQ updates**. Android disables FCM auto-initialisation and Analytics collection in the manifest until explicit notification opt-in. Analytics remains disabled. Logout uses an app bridge that waits for Firebase `deleteToken()` to complete, with auto-init disabled first; native token operations are serialised so a new account cannot register while an older deletion is in flight. Failed OS cleanup persists and retries after restart or reconnection, and must finish before re-enabling delivery.

The OS payload contains only “DivingHQ”, generic new-notification text and a UUID. No account names, meet information or action URL goes through the provider. Receipt/tap fetches the real notification through the current authenticated session; another account or an expired notification gets no contents. Taps navigate through the common native URL validator and keep existing route/API authorisation. Referee sign-off is opened for an explicit decision, never approved by tapping an OS notification.

Each installation has a random ID, a random revoke-only key (hashed server-side) and monotonically increasing revision. Preferences stores these plus the opt-in/account identity; it stores no session JWT. Enable/register requires authenticated identity matching the requested owner. Disable/logout first persists a disabled state, unregisters with the OS and clears delivered notifications. Offline revocation is queued durably and retried when connected, including after the session has expired. The unauthenticated revoke endpoint can only disable that specific unguessable installation; it is rate limited and remains available during maintenance.

A persistent revocation tombstone blocks delayed registration after logout even when revocation arrives first. Older revisions cannot disable or rebind a newer account session. Provider delivery checks current user suspension, deletion, organisation status, token version, session expiry and device enablement. Already accepted provider alerts cannot be recalled reliably; their generic content avoids disclosure after logout. Tapping one still requires current authorisation.

## Verification

`node --test test/native-push-provider.test.js test/native-push-client.test.js` covers invalid credentials, production/sandbox scope, OS denial, explicit consent, resume overlap, offline logout, late registration and account changes. `DB_DATABASE=divinghq_test node --test test/native-push.integration.test.js` runs ownership/revision/token rotation/provider failure tests against the guarded test database and real HTTP auth middleware.

Before declaring store delivery verified, test the store-installed build on actual iPhone/iPad and Android hardware: allow and deny permission, change OS settings and return, send a self-test in foreground/background/locked state, cold/warm tap, expire a sign-off, offline logout, switch account and retry. Record provider acceptance separately from observed device delivery. Simulator injection or emulator UI checks do not prove APNs delivery to the installed TestFlight app.
