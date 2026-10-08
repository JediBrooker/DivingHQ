# Native documents, links and outbound flows

Implemented for mobile version **1.1 (2)**. Platform/device acceptance is a
separate release gate; this document describes the code, not a claim that the
store-installed build has passed those checks.

## Documents

API links ending in PDF, CSV or ICS, and CSV/PDF `format` query exports, pass
through the existing native HTTP session boundary. The app refuses redirects,
foreign origins and unexpected MIME types. It supports PDF, CSV and calendar
files up to 25 MB. Server permission checks still decide which files may be read.

Client-side CSV actions use the same Save/Share sheet. Files are written under
`Cache/divinghq-exports/<random id>/` with a safe filename; Android FileProvider
exposes only that subtree. It no longer grants the template's external-storage
root. Files are removed on launch, account change and after one hour while the
app is running. User-chosen saved/shared copies remain with their destination.
Session-generation checks cover fetch, body read, encoding and filesystem write
so logout cannot export a previous account's pending document.

Profile dashboards and payment histories use the native print framework, which
provides platform print/PDF destinations, preserving the existing translated
content and print styles. The document bridge accepts app-generated HTML or the
current app WebView, never a remote URL or arbitrary filesystem path.

Official APIs: [Share](https://capacitorjs.com/docs/apis/share),
[Filesystem](https://capacitorjs.com/docs/apis/filesystem),
[Apple print](https://developer.apple.com/documentation/uikit/uiprintinteractioncontroller),
[Android HTML print](https://developer.android.com/training/printing/html-docs).

## Verified links

The server serves JSON without redirects at
`/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`.
Apple identifies `6MY34D5RKG.app.divinghq.mobile`. Android uses the **Play App
Signing certificate**, independently read from the Play Console (not the upload
certificate):
`31:91:94:E5:72:A2:43:76:8D:C3:27:73:21:0A:55:8D:B8:C7:E3:FE:7B:1D:80:61:62:4C:0E:46:35:56:ED:2F`.

Both manifests select app screens on `https://divinghq.app`; API and infrastructure
paths are excluded. The app checks the exact configured HTTPS origin, clean path
and registered route, then uses the existing auth/role/feature router guards.
Cold and warm URLs use the same handler. Protected routes preserve their local
path through login, and the login continuation rejects external, malformed and
unknown destinations. Account changes discard pending native navigation.

Official guidance: [Capacitor deep links](https://capacitorjs.com/docs/guides/deep-links)
and [Android verified App Links](https://developer.android.com/training/app-links/add-applinks).

Apple bundle capabilities PUSH_NOTIFICATIONS and ASSOCIATED_DOMAINS were enabled.
The new profile **DivingHQ App Store Native**, profile ID `9XCB225MX4`, UUID
`c7b6945b-1193-4c68-b97e-04073bcee5bd`, is installed in Xcode's default profile
folder. It permits production APNs and associated domains. The previous profile
was not revoked.

## External browser and returns

HTTPS external anchors and checkout/onboarding handoffs use the system-backed
Capacitor Browser; they do not replace the bundled app WebView. API credentials
stay in the native HTTP cookie jar. Returning to an associated DivingHQ link
closes the browser where supported and follows the normal route guards. Payment
and class feature flags are unchanged; no real payment transaction was exercised.
Public links generated inside the app use the configured public origin, not
`capacitor://localhost` or `https://localhost`.

[Browser plugin](https://capacitorjs.com/docs/apis/browser) documents the platform
close support; Android browser dismissal remains an OS/user action where its
plugin does not implement `close()`.

## Verification

`node --test test/native-integrations.test.js test/native-transport.test.js`
passes 16 tests. These cover authenticated transport, file privacy boundaries,
logout during body/encoding/write, unexpected HTML/errors, unknown/external
links, warm navigation, cold-link cleanup and association HTTP responses.
Full ESLint passes with 62 pre-existing warnings.

Release acceptance still requires platform compilation, simulator/emulator
presentation and real store-installed device checks for Save/Share, print,
verified link opening, protected-link login continuation and account switching.
Android release builds must use the real Firebase client configuration; native
push provider readiness is tracked separately. No build/upload is claimed here.
