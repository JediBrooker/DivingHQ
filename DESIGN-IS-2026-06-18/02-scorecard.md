# Rams Scorecard

Scoring: 0 = absent or harmful, 1 = weak, 2 = adequate, 3 = strong.

| # | Principle | Score | Evidence and reasoning |
|---|---|---:|---|
| 1 | Good design is innovative | 2 | DivingHQ combines live scoring, role-aware operations, public scoreboards, offline handling, broadcast/OBS, and venue bridge flows in one product. Evidence: `src/App.vue:1-59`, `src/views/ControlView.vue:1-37`, and `src/components/control/BroadcastModal.vue:140-253`. The innovation is practical, not yet pared into a clearly new interaction model. |
| 2 | Good design makes a product useful | 2 | The product supports real meet-day tasks across managers, referees, judges, spectators, and broadcast operators. However the scoped surfaces contain 343 interactive elements, including 101 in Manager and 69 in Control. The usefulness is real, but buried in density. |
| 3 | Good design is aesthetic | 1 | Shared tokens, badges, modal primitives, and shell structure are present in `src/components/AppShell.vue:220-365` and `src/styles/app.css:487-742`. The experience still reads as several overlapping visual systems: shell, pulse strip, Control Room, Scoreboard, modal variants, emoji/glyph actions, and recurring animation treatments. |
| 4 | Good design makes a product understandable | 1 | Top-level app-shell language is clear, but the live operator path depends on dense domain and system jargon: H2H, SF, DD, DNS, DNF, OBS, Daktronics, JRA-style judge analysis, change-of-dives articles, and split broadcast scenarios. Tooltips help, but too much comprehension is outsourced to hidden hover copy. Evidence: `src/views/ControlView.vue:2726-2875`, `src/views/ControlView.vue:3580-3635`, and `src/components/control/BroadcastModal.vue:306-524`. |
| 5 | Good design is unobtrusive | 1 | The design often competes with the task: pulse chips, live badges, hold banners, connection chips, shot clocks, sponsor rotation, roster menus, workflow buttons, broadcast options, and modal instruction panels all ask for attention. Evidence: `src/views/DashboardView.vue:1079-1164`, `src/views/ScoreboardView.vue:1036-1135`, and `src/views/ControlView.vue:3229-3315`. |
| 6 | Good design is honest | 3 | No deceptive copy or misleading interaction pattern was found. Labels generally describe consequences directly, including "Finalise event early", "Pause Meet", "Start order locked", and export/broadcast labels. Evidence: `src/views/ControlView.vue:2816-2848`, `src/views/ControlView.vue:3910-4082`, and `src/views/ScoreboardView.vue:1600-1608`. |
| 7 | Good design is long-lasting | 1 | The operational model is durable, but the presentation carries dated signals: emoji/glyph action labels, neon-like pulse strips, recurring animated urgency, and many specialized visual treatments. Evidence: `src/views/DashboardView.vue:1151-1164`, `src/views/DashboardView.vue:1457-1679`, `src/views/ControlView.vue:3580-3635`, and the animation scan in `01-evidence.md`. |
| 8 | Good design is thorough down to the last detail | 2 | Many details are thoughtful: stable scoreboard layout reservations, keyboard handling for non-native pulse chips, mobile modal scroll fixes, tooltip accessibility mirroring, and keyboard alternatives for roster reordering. Gaps remain: no confirmed skip link, partial reduced-motion coverage, and no browser verification in this pass. |
| 9 | Good design is environmentally friendly | 1 | Route splitting exists and initial JS is under 500 KB raw, but all built JS is about 3.88 MB raw and there are many always-on animation sites outside a broad reduced-motion guard. The design asks devices to keep doing visual work during live-operation screens. |
| 10 | Good design is as little design as possible | 1 | The product has accreted multiple entry points and repeated patterns. The scoped template count found 343 interactive elements, and Control Room alone carries event selection, status, workflow, active diver, roster, score editing, broadcast, sponsor, check-in, signoff, random draw, and hold flows. Evidence: `src/views/ControlView.vue:1-37`, `src/views/ControlView.vue:2726-2875`, and `src/views/ControlView.vue:3910-4176`. |

## Total

15 / 30

## Mechanical Verdict

REDESIGN. The total is below 20, and a load-bearing principle, #4 Understandable, scored 1.
