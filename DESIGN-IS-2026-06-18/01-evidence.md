# Evidence

Subagent evidence collection was attempted, but the available subagents returned usage-limit errors. This file is the orchestrator evidence pass from source scans, line reads, `npm run build`, and simple counts.

## Structural Evidence

- The app shell wraps opted-in authenticated routes with persistent sidebar, topbar, command palette, notification center, undo bar, confirm modal, and role tour in `src/App.vue:1-59`.
- Routing splits public, role-gated, shell, and chromeless scoreboard routes in `src/router/index.js:4-120`, including dashboard, manager, control, judge, profile, and scoreboard surfaces.
- The app shell exposes brand, role-aware nav groups, user menu, breadcrumb, search, theme toggle, guide, and notifications in `src/components/AppShell.vue:130-204`.
- Control Room imports a dense set of operational modules and modals in `src/views/ControlView.vue:1-37`, including socket state, offline outbox, shot clock, meet hold, readiness, judge panel, reflow, sponsor branding, Super Final panels, broadcast, late entry, random draw, check-in, and score correction.
- The scoped evidence set contains 343 interactive elements by static template count. Largest contributors: `src/views/ManagerView.vue` 101, `src/views/ControlView.vue` 69, `src/views/ScoreboardView.vue` 43, `src/components/control/BroadcastModal.vue` 22, `src/components/scoreboard/MeetsBrowser.vue` 21, and `src/components/control/SuperFinalPanels.vue` 21.
- Control Room primary operations include event selection and overflow actions in `src/views/ControlView.vue:2726-2875`, active diver/status/shot-clock state in `src/views/ControlView.vue:3229-3315`, workflow buttons in `src/views/ControlView.vue:3580-3635`, roster filtering/reordering/actions in `src/views/ControlView.vue:3910-4082`, and inline modal patterns in `src/views/ControlView.vue:4094-4176`.
- Scoreboard supports live event browsing, broadcast and overlay modes, judge score links, current performer state, standings tabs, export links, and completed recap in `src/views/ScoreboardView.vue:1036-1135`, `src/views/ScoreboardView.vue:1218-1346`, `src/views/ScoreboardView.vue:1271-1346`, `src/views/ScoreboardView.vue:1476-1555`, `src/views/ScoreboardView.vue:1600-1608`, and `src/views/ScoreboardView.vue:1696-1925`.

## Visual Evidence

- The app shell uses a restrained sidebar/topbar system with tokenized surface, border, radius, spacing, and icon button styles in `src/components/AppShell.vue:220-365`.
- Shared status badges, modal primitives, score chips, synchro judge groups, responsive rules, and instant tooltip styling live in `src/styles/app.css:487-515`, `src/styles/app.css:617-742`, `src/styles/app.css:755-830`, and `src/styles/app.css:1380-1438`.
- There is meaningful visual discipline: the shell, status pills, badges, tooltips, and score chips have shared primitives.
- There is also substantial view-local styling and visual vocabulary: Control Room, Dashboard pulse chips, Scoreboard, Meet Browser, and modal components define many transitions, animations, custom chips, glyphs, and row treatments. Static scan shows always-on or recurring animation sites in Dashboard pulse chips, scoreboard meet cells, judge panel tiles, signoff, random draw, and modal fade-ups.
- Motion reduction is only partially present. The global stylesheet has a `prefers-reduced-motion` block for tooltips at `src/styles/app.css:1508-1509`, but the broader scoped scan found many animation declarations outside that guard.

## Copy Evidence

- App shell navigation is clear and role-oriented at the top level: brand, nav groups, user identity, breadcrumb, "Search meets, divers, judges...", guide, and notifications appear in `src/components/AppShell.vue:133-199`.
- Dashboard pulse copy explains state changes and urgency through chips, popovers, "All quiet - nothing pending", and tab labels in `src/views/DashboardView.vue:1079-1180`.
- Control Room copy is operational and specific, but jargon-heavy. Examples include "Manual score entry", "Switch to a different event", "Sponsor branding", "Finalise event early", "Judge Analysis", "Start Event", "Dive Order", "Move up", "Change-of-dives (Article 6.7.4)", "Scratch / DNS / DNF", and "Pause Meet" across `src/views/ControlView.vue:2726-2875`, `src/views/ControlView.vue:3580-3635`, and `src/views/ControlView.vue:3910-4173`.
- Broadcast copy covers five scenarios in one chooser: operator broadcast, event audience broadcast, multi-event broadcast, OBS overlay, and venue hardware bridge in `src/components/control/BroadcastModal.vue:140-253`.
- OBS and Daktronics panels include long setup instructions and copyable fields in `src/components/control/BroadcastModal.vue:306-524`, useful for technicians but heavy inside a meet-day modal.
- Scoreboard public copy is spectator-oriented: "Scoreboard & Results", live/upcoming/completed counts, "Broadcast", "Stream overlay", "Current Performer", "On Deck - Up Next", "Standings", "Final", "By Round", and export labels in `src/views/ScoreboardView.vue:1079-1135`, `src/views/ScoreboardView.vue:1271-1346`, `src/views/ScoreboardView.vue:1495-1508`, and `src/views/ScoreboardView.vue:1600-1608`.

## Weight Evidence

- Production build passed. The initial module/preload JS referenced by `dist/index.html` totals approximately 358,818 raw bytes. All built JS assets total approximately 3,882,621 raw bytes.
- Route-level code splitting exists through dynamic imports in `src/router/index.js:4-120`.
- Shared socket state avoids duplicate Socket.IO connections through `src/composables/useSocket.js` (reviewed during the audit), and authenticated fetches use the cookie-aware `auth.apiFetch` pattern in `src/stores/auth.js:86-115`.
- Dashboard pulse polling and ticker behavior are visible in copy and comments at `src/views/DashboardView.vue:1079-1150`.
- Scoreboard fetches live data, judge rankings, archive/list data, sponsor logos, and socket state across its route lifecycle; the UI is rich but not lightweight.
- Sponsor rotation performs image fetch and timed rotation work in `src/components/scoreboard/SponsorRotation.vue` (reviewed during the audit).

## Accessibility Evidence

- App shell uses semantic landmarks and labels for breadcrumb, guide, and notifications in `src/components/AppShell.vue:181-199`.
- Dashboard pulse chips use `role="button"`, `tabindex="0"`, and Enter/Space keyboard activation because nested links make native buttons invalid in `src/views/DashboardView.vue:1094-1114`.
- Dashboard tabs use `role="tablist"` and `aria-selected` in `src/views/DashboardView.vue:1168-1180`.
- Control Room includes ARIA labels for roster grouping and uses native buttons/selects/inputs heavily in `src/views/ControlView.vue:2762-2770`, `src/views/ControlView.vue:3931-3932`, and `src/views/ControlView.vue:4042-4050`.
- Drag reordering has a keyboard-adjacent row action alternative through menu items "Move up" and "Move down" in `src/views/ControlView.vue:4059-4073`.
- Broadcast picker uses native checkbox rows in `src/components/control/BroadcastModal.vue:274-283`.
- Instant tooltips mirror content to accessibility labels via the `v-tip` directive and styling comments in `src/styles/app.css:1380-1404`.
- No global skip link was confirmed in the scoped source scan. Focus handling and modal trapping were not fully verified in a browser in this pass.

## Known Gaps

- No live browser screenshot pass was completed.
- No Figma/design source was provided.
- No competitor product comparison was performed.
- Static counts do not prove perceived complexity, but they are useful evidence of UI surface area.
- Vue SFC dead imports/unused props were not conclusively measured without a dedicated linter pass.
