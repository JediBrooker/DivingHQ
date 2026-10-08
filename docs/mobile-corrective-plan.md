# Mobile corrective work — 8 October 2026

The first 1.0 (1) testing builds were a Capacitor prototype: bundled shared
Vue screens plus native HTTP sessions. They did not implement native push,
native export/sharing or a complete phone/tablet experience. Passing browser
checks is not evidence that a store-installed build delivers push while locked.

## Experience changes

- Phones and narrow tablet windows have persistent Home, Work, Inbox, Menu and
  Settings tabs. Work resolves to an accessible poolside destination using the
  same permission-filtered menu as every other navigation entry.
- Menu retains every permitted role tool, is searchable, traps keyboard focus,
  makes the background inert, closes on navigation/Escape/device Back, and
  restores focus to its opener. Disabled features stay absent.
- Native tablets keep a labelled sidebar instead of hover-dependent icon
  flyouts. Child screens have a Back action. Phone landscape and tablet split
  windows adapt to their available width.
- Narrow User Manager tables become stacked member rows with full identity,
  roles/status, labelled selection and bulk selection; detail forms become one
  column and clear the device notch. Coaching cards wrap full diver names, with
  touch-sized Dive Lists actions. Wide tables remain available on tablets.
- The native Judge Terminal uses OS haptics for button feedback and native idle
  timer control while an event is open. It releases on background/unmount and
  serializes requests so a late enable cannot outlive leaving the screen.
- Scoreboard Share opens the native share sheet with a canonical HTTPS result
  link; private/session query parameters are not included.
- Settings exposes account/profile, device notification controls, appearance,
  help, privacy, terms and sign out. It is always available to signed-in roles.
- Phone controls use at least 44-pixel navigation targets; editable controls use
  16-pixel text to avoid iOS focus zoom. The content scroll area excludes bottom
  tabs and system safe areas. Visual viewport changes keep the app above the
  keyboard, hide tabs during editing, and restore them after dismissal.

## Workflow and evidence matrix

“Automated layout” below means browser automation against the shared UI with
fixture identities. It does not mean real-device or store-build verification.

| Workflow | Implementation scope | Required verification |
|---|---|---|
| Spectator results | Results work tab, full directory/records menu | Phone/tablet portrait and landscape; long result lists |
| Diver sheets | Dive Sheets work tab, all existing entry routes | Real account submit/edit flow; keyboard and rotation |
| Judge terminal | Judge work tab; existing dedicated pad remains outside shell | Native screen awake, haptics, score submit/reconnect, background/resume |
| Coach | Coaching work tab, existing roster/editor access | Select diver, edit sheet, native export; keyboard |
| Referee | Control Room work tab | Sign-off notification foreground/background/tap; expired request |
| Meet manager | Control Room work tab, Meets & events menu | Event setup/manage, live operations, exports/share |
| Club/region admin | Delegate gates preserved on club/region/manager/control links | Automated layout plus real delegated backend permissions |
| Federation/system admin | Existing privileged tools and feature gates | Tablet dense views, phone search, settings |
| Notifications | Native provider registration, permissions, settings and tap routing owned by push implementation | iOS and Android real devices, locked/terminated foreground, permission denied/re-enabled |
| Sharing/downloads | Platform share sheet/file export and safe external links owned by native integrations | PDF/CSV and links on physical phone/tablet, cancel/errors |
| Sign out/account change | Shared sign-out handler from Settings | No previous account push, inbox, cache or export leakage |
| Keyboard/accessibility | Focus/inert menu, visible labels, scalable content, viewport resizing | Automated focus/geometry; real VoiceOver/TalkBack, large text, software keyboard |

## Verification ledger

- Focused ESLint passed (no errors; three existing warnings in touched legacy
  views). Web production build passed on Node 22.23.1.
- `native-poolside.test.js`: **2/2 passed**, including leaving during asynchronous
  plugin loading and release after a failed enable. These are bridge ordering
  tests, not a claim that a physical device stayed awake.
- New `test/e2e/mobile-app-navigation.spec.js` covers notification-settings
  discoverability at 390×844, 844×390, 820×1180 and 1180×820; navigation for
  spectator/diver/judge/coach/referee/meet manager/org admin and club/region
  delegates; feature gates; menu search/focus; touch sizes; content/tab overlap;
  modeled keyboard viewport changes. Execution results are recorded below when
  run against the completed implementation. **14/14 passed** on Chromium.
- Populated test DB workflows: manager event row/overflow actions and federation
  members at 390×844 and 1180×820; coach roster and selected diver dive sheet at
  both sizes; phone member selection/select-all/clear and editable detail drawer.
  **4/4 passed**. Real test HTTP login/API data was used, with isolated test
  organisations cleaned afterwards. No live meet was altered.
- Existing judge pad fit and manager row actions regressions: **2/2 passed**.
  Combined final targeted Chromium run: **20/20 passed**. The first populated
  run caught tablet coaching-name truncation, which was fixed before rerunning.
- Nine populated screen captures were inspected and preserved outside the repo
  at `/Volumes/Storage/DivingHQ-releases/corrective-mobile/experience-2026-10-08/`,
  alongside build/e2e/lint logs. The browser screenshots have no native system
  safe-area inset; native inset/device testing remains a separate requirement.
- Evidence correction: the first saved member-detail capture caught the drawer
  during its entry transition. The test now waits for its left edge at the
  viewport boundary, the populated full-name field and Save details visible
  inside the viewport. A separate isolated test DB rerun **1/1 passed**; the
  replacement `member-details-phone.png` was visually inspected and shows the
  complete single-column editable form. `member-detail-recheck.log` records it.
- Native OS and physical-device results must be recorded separately, including
  device/OS/build number and exact scenario. No physical device run has been
  performed by this UI workstream.

## Physical store-build acceptance

Use the replacement internal releases on the owner's real devices, connected to
https://divinghq.app. Do not generate operational notices to other people or
modify live meet scoring as a test. Use owner-targeted test notifications and a
controlled test event/account if operational testing is needed.

1. Fresh install: log in, discover Settings, decline push, enable later in OS
   settings, return to the app and confirm displayed state is refreshed.
2. Receive a test notification foreground, background, locked and after normal
   termination. Tap each; confirm correct signed-in destination. Record that
   delivery after force-stop is OS-dependent rather than claiming it works.
3. Sign out, send a test notification, switch account, repeat; previous-user
   content must not appear. Test expiry/revocation separately.
4. Open a safe app link while closed and running, with and without a session;
   preserve intended destination through login. Reject malformed/external links.
5. Share/download a PDF, CSV and result link; save to Files/Downloads and cancel
   the share sheet. Check actual file name/content and error handling offline.
6. Exercise phone portrait/landscape, tablet portrait/landscape and split view,
   system text size, VoiceOver/TalkBack, form keyboard, safe areas and back.
7. Judge a controlled test event: awake screen, haptic confirmation, reconnect
   after network loss and resume after locking. No scoring-rule changes belong
   in this mobile work.

### Simulator finding: standalone onboarding

The iPhone simulator exposed clipped setup branding and actions. Two layout
causes were fixed: the wizard's stepper had a minimum width wider than a phone,
and lazy auth views styled `body` globally so centered form layout persisted
after sign-in. Six auth views now use `AuthLayout.vue`, which owns its scroll
area and safe-area padding; setup owns its viewport and adapts its stepper,
frame and invite actions to narrow widths. This also prevents auth CSS from
changing unrelated standalone pages after navigating away.

`mobile-onboarding-layout.spec.js` adds actual Chromium safe-area environment
inset emulation for portrait and landscape, sign-in to all four setup steps,
and all six auth screens. At handoff the new source passed focused lint and
whitespace checks; the CI and native-device workstreams are performing rebuilt
browser tests and new simulator captures. Those results must be added before
claiming the simulator defect verified fixed.
