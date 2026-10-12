# Store listing assets — 12 October 2026

`en-AU.json` holds the reviewed Australian English store text. Fields fit Apple's
30-character subtitle, 100-character keywords, 170-character promotional text and
4,000-character description limits, plus Google's 80-character short description.
The `/support` and privacy pages must be deployed before submission.

Assets and capture evidence live outside Git at:
`/Volumes/Storage/DivingHQ-releases/distribution-2026-10-12/store-assets/`.

- `apple/`: three genuine iPhone 17 Pro Max simulator captures (1320×2868) and
  two iPad Pro 13-inch simulator captures (2752×2064).
- `google/`: four genuine Android API 36 emulator phone captures (1080×1920),
  four tablet captures (1920×1080), a 512×512 icon from the existing app mark,
  and an original 1024×500 feature graphic.
- `evidence/assets.json`: image dimensions, source, transformations and SHA-256.
- `evidence/contact-sheet-compact.png`: review sheet, not an upload asset.
- `evidence/cleanup.json`, `fixture-cleanup-final.json`, `ios-final-cleanup.json`:
  exact fixture removal, device and temporary trust cleanup evidence.
- `superseded/`: earlier captures excluded from the final upload sets.

All screenshots were captured on 12 October from the actual native app using
local HTTPS and fictional Harbour Spring Meet data: twelve divers, five judges,
one organiser, two live events and 58 judge score entries. Payments and classes
were off. Native source had version 1.2 functionality and build 4 metadata,
including the updated public support and privacy pages. App UI was not mocked
or replaced. Upload images only had alpha removed; they were not resized,
cropped or composited. No real user's private information appears in the assets.

After capture, all owned test rows were removed from the guarded local
`divinghq_test` database; counts of other rows were unchanged. Temporary native
apps, test CA trust, fixture credentials and local servers were removed. The
user-authorised temporary Android AVD was deleted; the original emulator was
untouched. Existing iOS simulators were shut down. Shared native bundles were
restored to `https://divinghq.app` for release builds.

Screenshots do not establish physical-device acceptance. Judging images show
an entered score before submission; they do not represent a published result.

Apple display requirements and Google's dimensions were checked against the
[current Apple specification](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
and [Google preview asset guidance](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en)
on 12 October 2026. App Store Connect processed all five final Apple screenshots
with status `COMPLETE`. The Google Play listing, including the final assets,
was saved with status `Ready to send for review`. These statuses confirm asset
processing and draft preparation; they do not mean the apps were submitted,
approved, published or accepted on physical devices.
