# Features

A scannable map of every feature in DivingHQ, organised so the reader can answer "what can I do as a *<role>*?" and "what's available on the *<screen>*?" without scrolling through every page.

The first section groups features **by persona** — pick your role to see what you can do. The second section groups the same features **by section of the app** — pick a screen if you already know which surface you're on. Every row links to the wiki page that explains it in detail.

> **How to read this:** each row is one feature. "Where" is the wiki page the feature is documented on (with an anchor when relevant). Personas use the same names as [Roles & Permissions](/guide/roles-and-permissions). Sections match the wiki sidebar.

---

## By persona

### 🌐 Spectator (no login required)

| Section | Feature | Where |
|---|---|---|
| Public meet page | Browse a meet's hero, dates, venue, sponsor branding | [Scoreboard → Public meet landing page](/guide/scoreboard#public-meet-landing-page) |
| Public meet page | See visiting federations chip strip on international meets | [Scoreboard → Public meet landing page](/guide/scoreboard#public-meet-landing-page) |
| Public meet page | Click into any event for live broadcast or recap | [Scoreboard → Public meet landing page](/guide/scoreboard#public-meet-landing-page) |
| Public meet page | Download customisable program (PDF or CSV) | [Scoreboard → Program export](/guide/scoreboard#program-export) |
| Public meet page | Subscribe to the day-by-day schedule in Apple / Google / Outlook calendar (`.ics`) | [Session Scheduler → iCal export](/guide/session-scheduler#ical-export) |
| Public meet page | Read the public session schedule — warmups, event starts, breaks, re-flowed in real time | [Session Scheduler → Public schedule](/guide/session-scheduler#public-schedule) |
| Live scoreboard | Watch a 3-column live broadcast (completed dives · current performer · standings) | [Scoreboard → Live broadcast layout](/guide/scoreboard#live-broadcast-layout) |
| Live scoreboard | See the live judge-tile strip as each judge submits | [Scoreboard → Live broadcast layout](/guide/scoreboard#live-broadcast-layout) |
| Live scoreboard | Read the catch-up projection (what each diver needs to overtake) | [Scoreboard → Catch-up projection](/guide/scoreboard#catch-up-projection) |
| Live scoreboard | Switch standings between **Final** (running total) and **By Round** | [Scoreboard → Live broadcast layout](/guide/scoreboard#live-broadcast-layout) |
| Live scoreboard | Click any judge score chip → open that judge's public analysis | [Scoreboard → Click any judge score](/guide/scoreboard#click-any-judge-score-to-see-the-judges-analysis) |
| Live scoreboard | See the Hold / Resume banner when the meet is paused | [Scoreboard → Hold / Resume banner](/guide/scoreboard#hold--resume-banner) |
| Live scoreboard | See the Connection-lost banner if wifi drops (no silent stale data) | [Scoreboard → Connection-lost banner](/guide/scoreboard#connection-lost-banner) |
| Live scoreboard | "Add to home screen" — PWA install for faster reloads, resilient on flaky 4G | [Scoreboard → Spectator-side performance](/guide/scoreboard#spectator-side-performance) |
| Recap | View the podium spotlight + full standings + dive-by-dive breakdown | [Scoreboard → Recap layout](/guide/scoreboard#recap-layout-completed-events) |
| Recap | See the **Judge Ranking Analysis** matrix (per-judge hypothetical rankings) | [Scoreboard → Judge Ranking Analysis](/guide/scoreboard#judge-ranking-analysis-completed-events) |
| Recap | Download per-event PDFs (program, start list, score sheet, results) and CSV | [Scoreboard → Recap layout](/guide/scoreboard#recap-layout-completed-events) |
| Results Archive | Browse every completed meet — filter by country, year, height, club, status | [Scoreboard → Results Archive](/guide/scoreboard#completed-meets-index-scoreboard) |
| Results Archive | Search across event name, org name, country | [Scoreboard → Results Archive](/guide/scoreboard#completed-meets-index-scoreboard) |
| Results Archive | CSV export of the filtered list | [Scoreboard → Results Archive](/guide/scoreboard#completed-meets-index-scoreboard) |
| Results Archive (DiveRecorder) | Browse decades of historical UK/AUS results imported from DiveRecorder Meet Explorer — by meet, by diver, by date range (`/results-archive`) | [Scoreboard → Results Archive (DiveRecorder)](/guide/scoreboard#results-archive-diverecorder-historical-results) |
| Judge profile | Open any judge's public analysis page from a score chip | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |
| Judge Analysis | **By Event** tab (`/judge-analysis`) — pick a Completed event, see the per-judge ranking matrix (where each diver/pair/team would place under each judge's scores alone); synchro events segmented into Exec A / Exec B / Sync; CSV + PDF export | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |
| Judge Analysis | **By Judge** tab — search the public judge directory, open any judge's `/judge-profile` analytics | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |
| Diver profile | Open any diver's public profile (history + analytics widgets) | [Diver Portal → Diver Profile](/guide/diver-portal#diver-profile) |
| Diver compare | Side-by-side compare any two divers | [Diver Portal → Compare two divers](/guide/diver-portal#compare-two-divers) |

### 🏊 Diver

| Section | Feature | Where |
|---|---|---|
| Meet day view | Phone-deck view of the diver's current state (next dive, queue position, rank, needs-to-score) | [Diver Portal → Meet day view](/guide/diver-portal#meet-day-view) |
| Meet day view | Real-time round/rank/needs updates over socket | [Diver Portal → Real-time updates](/guide/diver-portal#real-time-updates) |
| Dive list submission | Submit a per-round dive list before the entries-close deadline | [Diver Portal → Submitting a dive list](/guide/diver-portal#submitting-a-dive-list) |
| Dive list submission | Honour per-round DD limits + operator-prescribed dives + section bulletins | [Diver Portal → Per-round DD limits](/guide/diver-portal#per-round-dd-limits) |
| Dive list submission | Synchro pair entry (one diver submits, partner inherits) | [Diver Portal → Synchro entries](/guide/diver-portal#synchro-entries) |
| Dive list templates | Save a dive list as a template; reuse on future events | [Diver Portal → Templates](/guide/diver-portal#templates) |
| Profile | Headline stats (best total, recent finishes, current streak) | [Diver Portal → Diver Profile](/guide/diver-portal#diver-profile) |
| Profile | 13-widget self-serve analytics dashboard (toggleable + drag-reorderable) | [Diver Portal → Self-serve analytics dashboard](/guide/diver-portal#self-serve-analytics-dashboard) |
| Profile | Date-range filter on every analytics widget | [Diver Portal → Date range filter](/guide/diver-portal#date-range-filter) |
| Profile | Export the whole dashboard as a PDF | [Diver Portal → Export Dashboard PDF](/guide/diver-portal#export-dashboard-pdf) |
| Profile | Compare against another diver in a side-by-side view | [Diver Portal → Compare two divers](/guide/diver-portal#compare-two-divers) |
| Profile | Cross-org browse — view any public profile across all federations | [Diver Portal → Cross-org browse](/guide/diver-portal#cross-org-browse) |
| Profile | Public sharing — `/profile/<id>` URL for anyone | [Diver Portal → Public sharing](/guide/diver-portal#public-sharing) |
| Profile | Grant a coach read-only access | [Diver Portal → Coach access](/guide/diver-portal#coach-access) |
| Profile | Request a club change from the "My club" card (same-org changes need admin approval; cross-org transfers are a 3-way handshake: source-org admin + target-org admin + diver confirmation) | [Diver Portal → Diver Profile](/guide/diver-portal#diver-profile) |
| Notifications | In-app inbox + push notifications (meet starting, results posted, reserve promoted, etc.) | [Admin Tasks → Notifications](/guide/admin-tasks#notifications) |
| Schedule | Subscribe to the meet schedule in Apple / Google / Outlook calendar | [Session Scheduler → iCal export](/guide/session-scheduler#ical-export) |
| Auth | Sign in, forgot password, email verification | [FAQ → Authentication](/guide/faq#authentication) |

### 🧑‍⚖️ Judge

| Section | Feature | Where |
|---|---|---|
| Judging | Sign in, pick the active event, see the auto-advancing active diver | [Judging → The judge view](/guide/judging#the-judge-view) |
| Judging | Submit a score in half-point precision (10 → 0) | [Judging → Half-point precision](/guide/judging#half-point-precision) |
| Judging | Re-submit a corrected score during the same dive window | [Judging → Re-submitting a corrected score](/guide/judging#re-submitting-a-corrected-score) |
| Judging | Synchro sub-panel awareness (Exec A / Exec B / Sync) | [Judging → Synchro events](/guide/judging#synchro-events) |
| Judging | Hold / Resume banner with auto-pause of the input | [Judging → Hold / Resume](/guide/judging#hold--resume) |
| Judging | Connection drop handling (queue locally, sync when back) | [Judging → Connection drops](/guide/judging#connection-drops) |
| Judging | Privacy — scores stay anonymous on the live feed | [Judging → Privacy](/guide/judging#privacy) |
| Judge Analysis | Public analysis page (per-board height bias, country-correlation, dropped-score rate) | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |
| Judge Analysis | Date-range filter | [Judging → Date-range filter](/guide/judging#date-range-filter) |
| Judge Analysis | **Panel deviation** stat — how often you differ from the panel kept-mean per dive + per event | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |

### 🎯 Referee

| Section | Feature | Where |
|---|---|---|
| Cut 3 sign-off | Type the 6-digit handoff code generated on the meet manager's device | [Admin Tasks → System admin tasks](/guide/admin-tasks) |
| Cut 3 sign-off | Scan a QR code → land directly on `/sign-off-codes?code=…` (deep-link bounce through `/login`) | [Admin Tasks](/guide/admin-tasks) |
| Score Audit Log | Open the Score Audit Log for any event in the federation | [Admin Tasks → Score Audit Log](/guide/admin-tasks#score-audit-log) |
| Control Room | Optionally drive a meet from the Control Room (referee can run a meet too) | [Running a Meet](/guide/running-a-meet) |
| Schedule | Edit the session schedule — same write access as a meet manager | [Session Scheduler → Permissions](/guide/session-scheduler#permissions) |

### 🎓 Coach

| Section | Feature | Where |
|---|---|---|
| Linked diver access | Read-only view of every diver who granted access (their dashboard widgets, meet history) | [Diver Portal → Coach access](/guide/diver-portal#coach-access) |
| Public profiles | Same cross-org browse as a diver | [Diver Portal → Cross-org browse](/guide/diver-portal#cross-org-browse) |
| Compare | Side-by-side compare two divers | [Diver Portal → Compare two divers](/guide/diver-portal#compare-two-divers) |
| Schedule | Subscribe to a meet's session schedule (iCal) to track every linked diver's call-times | [Session Scheduler → iCal export](/guide/session-scheduler#ical-export) |

### 🎮 Meet manager

| Section | Feature | Where |
|---|---|---|
| Meet setup | Create a meet bundle (name, dates, venue, sponsor logo + link, description) | [Setting Up a Meet → Creating a meet](/guide/setting-up-a-meet#creating-a-meet-the-bundle) |
| Meet setup | Create events (gender, age group, height, total rounds, judges, format) | [Setting Up a Meet → Creating events](/guide/setting-up-a-meet#creating-events) |
| Meet setup | Event types — individual, synchro pair (7, 9, or 11 judges), team | [Setting Up a Meet → Event types](/guide/setting-up-a-meet#event-types) |
| Meet setup | Operator-prescribed round dives (lock specific dives per round) | [Setting Up a Meet → Operator-prescribed round dives](/guide/setting-up-a-meet#operator-prescribed-round-dives) |
| Meet setup | Round-structure rules — multi-section dive-list bulletins | [Setting Up a Meet → Round-structure rules](/guide/setting-up-a-meet#round-structure-rules) |
| Meet setup | Apply a World Aquatics-aligned template (one click) | [Setting Up a Meet → Suggested templates](/guide/setting-up-a-meet#suggested-templates-world-aquatics-aligned) |
| Meet setup | Save and reuse event templates | [Setting Up a Meet → Event templates](/guide/setting-up-a-meet#event-templates) |
| Meet setup | Multi-stage progression (prelim → semi → final, semi/final auto-seeded from advance) | [Setting Up a Meet → Multi-stage progression](/guide/setting-up-a-meet#multi-stage-progression) |
| Meet setup | Mixed-board events (1 m + 3 m, with per-row board height per dive) | [Setting Up a Meet → Mixed-board events](/guide/setting-up-a-meet#mixed-board-events) |
| Meet setup | CSV roster import | [Setting Up a Meet → CSV roster import](/guide/setting-up-a-meet#csv-roster-import) |
| Meet setup | Assign the judging panel + pick a referee | [Setting Up a Meet → Setting up the panel](/guide/setting-up-a-meet#setting-up-the-panel) |
| Schedule | Plan a whole championship day across boards, warmups, starts, breaks, and ceremonies | [Session Scheduler → Quick path](/guide/session-scheduler#quick-path) |
| Schedule | Conflict warnings for board, judge, diver, and referee overlaps | [Session Scheduler → Conflict detection](/guide/session-scheduler#conflict-detection) |
| Schedule | Publish public schedule + iCal export | [Session Scheduler → Public schedule](/guide/session-scheduler#public-schedule) |
| Schedule | Re-flow later sessions when delays happen | [Session Scheduler → Live re-flow](/guide/session-scheduler#live-re-flow) |
| Meet setup | Pre-meet checklist (panel filled, referee picked, roster non-empty, dive lists submitted) | [Setting Up a Meet → Pre-meet checklist](/guide/setting-up-a-meet#pre-meet-checklist) |
| Meet setup | Search + status-filter the events list (Upcoming / Live / Completed) | [Setting Up a Meet → Searching the events list](/guide/setting-up-a-meet#searching-the-events-list) |
| Schedule | Day timeline — one column per board, 30-min gridlines, blocks for warmups / event starts / breaks / ceremonies | [Session Scheduler → The day timeline](/guide/session-scheduler#the-day-timeline) |
| Schedule | Auto-seeded warmup + event blocks from each event's `scheduled_at` (editable) | [Session Scheduler → Auto-seeded from events](/guide/session-scheduler#auto-seeded-from-events) |
| Schedule | Edit mode — drag to move, drag edges to resize, click empty cell to insert, hover-× to delete | [Session Scheduler → Edit mode](/guide/session-scheduler#edit-mode) |
| Schedule | Conflict warnings — judge / board / diver / referee double-bookings, hard (red) vs soft (amber) | [Session Scheduler → Conflict detection](/guide/session-scheduler#conflict-detection) |
| Schedule | Per-conflict dismissal with audit trail; resurfaces if windows or resource membership change | [Session Scheduler → Dismissing a conflict](/guide/session-scheduler#dismissing-a-conflict) |
| Schedule | Judge availability badge in the Judge Panel Modal (green available / amber busy) | [Session Scheduler → Conflicts from the Judge Panel Modal](/guide/session-scheduler#conflicts-from-the-judge-panel-modal) |
| Schedule | Live re-flow on event completion — "Reschedule downstream" modal with per-block checkboxes | [Session Scheduler → Live re-flow](/guide/session-scheduler#live-re-flow) |
| Schedule | Duplicate session to next day (preserves shape, clears event references) | [Session Scheduler → Duplicate to next day](/guide/session-scheduler#duplicate-to-next-day) |
| Schedule | Public iCal feed per meet (`/api/meets/<id>/schedule.ics`) — coaches / federations subscribe | [Session Scheduler → iCal export](/guide/session-scheduler#ical-export) |
| Control Room | 3-column live operator layout (history · active diver · queue) | [Running a Meet → Layout](/guide/running-a-meet#layout) |
| Control Room | Pre-Flight Review modal (last-chance roster / panel / referee / warnings summary) | [Running a Meet → Pre-Flight Review modal](/guide/running-a-meet#pre-flight-review-modal) |
| Control Room | Set the active diver (any roster row, in any order) | [Running a Meet → Setting the active diver](/guide/running-a-meet#setting-the-active-diver) |
| Control Room | Shot clock with reset / pause / extend (World Aquatics Article 8.5.5) | [Running a Meet → The shot clock](/guide/running-a-meet#the-shot-clock) |
| Control Room | Auto-advance toggle (Manual / 5s / 10s / 15s after last judge submits) | [Running a Meet → Auto-advance](/guide/running-a-meet#auto-advance) |
| Control Room | Hold / Resume meet (amber banner pushed to all clients) | [Running a Meet → Hold / Resume](/guide/running-a-meet#hold--resume) |
| Control Room | Adjust ▾ — Failed Dive · Cap Score · Re-Dive (referee actions) | [Running a Meet → Referee actions](/guide/running-a-meet#referee-actions-adjust-) |
| Control Room | Score correction modal with live preview of the impact on standings | [Running a Meet → Correcting a score](/guide/running-a-meet#correcting-a-score) |
| Control Room | Late entries during a Live event | [Running a Meet → Late entries](/guide/running-a-meet#late-entries) |
| Control Room | Withdraw / scratch a diver mid-meet | [Running a Meet → Withdrawing or scratching a diver](/guide/running-a-meet#withdrawing-or-scratching-a-diver) |
| Control Room | Undo a misclick (one-tap rescue toast on every state change) | [Running a Meet → Undoing a misclick](/guide/running-a-meet#undoing-a-misclick) |
| Control Room | Synchro event handling (role-segregated panel) | [Running a Meet → Synchro events](/guide/running-a-meet#synchro-events) |
| Control Room | Team event handling | [Running a Meet → Team events](/guide/running-a-meet#team-events) |
| Control Room | Round-end leaderboard pop ("Announce standings" prompt) | [Running a Meet → Round-end behaviour](/guide/running-a-meet#round-end-behaviour) |
| Control Room | Finalise event (publishes recap + sends "results posted" emails) | [Running a Meet → Finalising the event](/guide/running-a-meet#finalising-the-event) |
| Control Room | Open Judge Ranking Analysis modal on a Completed event | [Running a Meet → Judge Ranking Analysis button](/guide/running-a-meet#judge-ranking-analysis-button) |
| Control Room | DWC Super Final flow — H2H / SF / F seeding, pair results, tie-break dive-offs | [Running a Meet → Diving World Cup Super Final](/guide/running-a-meet#diving-world-cup-super-final) |
| Control Room | Synchro reserve replacement (pre-H2H only) | [Running a Meet → Synchro reserve replacement](/guide/running-a-meet#synchro-reserve-replacement-pre-h2h-only) |
| Control Room | Confirm dialogs + toast feedback on every state change | [Running a Meet → Confirm dialogs and toast feedback](/guide/running-a-meet#confirm-dialogs-and-toast-feedback) |
| Control Room | Survives server restart (active diver + meet hold rehydrate from `event_live_state`) | [Running a Meet → Meets survive server restart](/guide/running-a-meet#meets-survive-server-restart) |
| Control Room | Per-pool keyboard shortcuts (1-9 focus / Space / → / H / L / F / R / C) | [Keyboard Shortcuts → Control Room](/guide/keyboard-shortcuts#control-room-control) |
| Broadcast | Operator kiosk mode (`/control?broadcast=1`) | [Scoreboard → Broadcast mode](/guide/scoreboard#broadcast-mode-venue-projector) |
| Broadcast | Single-event audience broadcast in a new window | [Scoreboard → Broadcast mode](/guide/scoreboard#broadcast-mode-venue-projector) |
| Broadcast | Multi-event `/broadcast/all` auto-grid (with subset picker) | [Scoreboard → Multi-event broadcast](/guide/scoreboard#multi-event-broadcast-broadcastall) |
| Broadcast | Stream Overlay (chroma-key Browser Source for OBS / Streamlabs / vMix) | [Scoreboard → Stream Overlay](/guide/scoreboard#stream-overlay-for-obs--live-streaming-apps) |
| Broadcast | In-app OBS setup wizard (Control Room → 📺 Broadcast → 🎬 Stream to OBS) with Copy URL + 5-step Browser Source recipe | [Scoreboard → Getting the URL from the Control Room](/guide/scoreboard#getting-the-url-from-the-control-room) |
| Broadcast | In-app Daktronics bridge commands for venue hardware | [Venue Integration → Enable from the Control Room](/guide/venue-integration#enable-from-the-control-room) |

### 🖥️ Venue technician / broadcaster

| Section | Feature | Where |
|---|---|---|
| Venue hardware | Copy event-specific Daktronics RTD / ERTD bridge commands from Control Room | [Venue Integration → Enable from the Control Room](/guide/venue-integration#enable-from-the-control-room) |
| Venue hardware | Run a one-shot RTD frame test before connecting to the board | [Venue Integration → Testing without hardware](/guide/venue-integration#testing-without-hardware) |
| Venue hardware | Send live scoreboard state over UDP, TCP, serial, stdout, or file output | [Venue Integration → Daktronics bridge quick commands](/guide/venue-integration#daktronics-bridge-quick-commands) |
| Streaming | Use OBS / Streamlabs / vMix Browser Source overlay | [Scoreboard → Stream Overlay](/guide/scoreboard#stream-overlay-for-obs--live-streaming-apps) |

### 🏛️ Org admin

Includes everything a meet manager can do, plus:

| Section | Feature | Where |
|---|---|---|
| User Manager | List every user in the org with name + email + roles + clubs | [Admin Tasks → User Manager](/guide/admin-tasks#user-manager) |
| User Manager | Click-row-to-edit any user | [Admin Tasks → Click-row-to-edit](/guide/admin-tasks#click-row-to-edit) |
| User Manager | Edit personal & competition details from the per-user drawer (full name, date of birth, gender, nationality) | [Admin Tasks → User Manager](/guide/admin-tasks#user-manager) |
| User Manager | Account lifecycle — suspend / reactivate (suspended users are blocked at login), resend email verification, send password reset | [Admin Tasks → User Manager](/guide/admin-tasks#user-manager) |
| User Manager | Grant / revoke roles (multi-role per user supported) | [Admin Tasks → Granting and revoking roles](/guide/admin-tasks#granting-and-revoking-roles) |
| User Manager | Link a coach to a diver (or vice-versa) | [Admin Tasks → Coach ↔ Diver links](/guide/admin-tasks#coach--diver-links) |
| User Manager | Action club-change and cross-org transfer requests in the **Requests tab** | [Admin Tasks → User Manager](/guide/admin-tasks#user-manager) |
| Clubs | Create / edit / delete clubs (with short code + colour for chip rendering) | [Admin Tasks → Clubs](/guide/admin-tasks#clubs) |
| Teams | Create teams + assign divers; per-team dive lists | [Admin Tasks → Teams](/guide/admin-tasks#teams) |
| Score Audit Log | Read every score-related event for any meet in the federation | [Admin Tasks → Score Audit Log](/guide/admin-tasks#score-audit-log) |
| Role Audit Log | Federation-wide log of role grants / revocations / promotions | [Admin Tasks → Role Audit Log](/guide/admin-tasks#role-audit-log) |
| Federation records | Submit federation records for federation-wide tracking | [Admin Tasks → Federation records](/guide/admin-tasks#federation-records) |
| International | Invite other federations to host or visit a meet | [Admin Tasks → Hosting an international meet](/guide/admin-tasks#hosting-an-international-meet) |
| International | Country medal table on the meet recap | [Admin Tasks → Country medal table](/guide/admin-tasks#country-medal-table) |
| Bulk operations | Bulk-promote reserves, bulk-update roster | [Admin Tasks → Bulk operations](/guide/admin-tasks#bulk-operations) |
| Notifications | Send broadcast notifications to a federation (e.g. "meet starts in 24h") | [Admin Tasks → Notifications](/guide/admin-tasks#notifications) |
| First-run | `/setup` wizard for brand-new federations | [Quick Start → 2a. First-run setup wizard](/guide/quick-start#2a-first-run-setup-wizard) |

### 🛠️ System administrator

Includes everything an org admin can do, **across every federation**, plus:

| Section | Feature | Where |
|---|---|---|
| Federation approvals | Approve / suspend new federations on signup | [Admin Tasks → Approving new federations](/guide/admin-tasks#approving-new-federations) |
| System records | Approve system-wide records (continental + global) | [Admin Tasks → Approving system-wide records](/guide/admin-tasks#approving-system-wide-records) |
| Cross-org user lookup | Search any user in the platform | [Admin Tasks → Cross-org user lookup](/guide/admin-tasks#cross-org-user-lookup) |
| Password reset | Force a password reset for any user | [Admin Tasks → Resetting a password](/guide/admin-tasks#resetting-a-password) |
| Migrations | Apply / inspect schema migrations | [Admin Tasks → Migrations](/guide/admin-tasks#migrations) |
| All-orgs audit filter | "All orgs" filter inside the audit log view | [Admin Tasks → Score Audit Log](/guide/admin-tasks#score-audit-log) |
| Continental records | Approve and track continental records | [Admin Tasks → Continental records](/guide/admin-tasks#continental-records) |
| Federation removal | Remove a federation (with safety checks for hosted meets) | [Admin Tasks → Removing a federation](/guide/admin-tasks#removing-a-federation) |

---

## By section

### Auth & accounts

| Persona | Feature | Where |
|---|---|---|
| Anyone | Register an account (or federation if first user) | [Quick Start → 1. Sign in or register](/guide/quick-start#1-sign-in-or-register-your-federation) |
| Anyone | Email verification | [FAQ → Setup](/guide/faq#setup) |
| Anyone | Forgot password / reset link | [FAQ → "I forgot my password"](/guide/faq#i-forgot-my-password) |
| Anyone | "Log out everywhere" | [FAQ → "I need to log out everywhere"](/guide/faq#i-need-to-log-out-everywhere) |
| Anyone | Two-factor authentication (TOTP) | [FAQ → Two-factor authentication?](/guide/faq#two-factor-authentication) |
| Anyone | SSO / OAuth for org-managed federations | [Roles & Permissions](/guide/roles-and-permissions) |
| Org admin | First-run `/setup` wizard | [Quick Start → 2a](/guide/quick-start#2a-first-run-setup-wizard) |

### Meet setup

See the [Meet manager](#-meet-manager) section above for the full list — meet creation, event configuration, event types, prescribed round-dives, round-structure rules, templates, multi-stage progression, mixed-board, CSV roster import, panel assignment, pre-meet checklist, events-list search/filter.

### Session schedule

See [Session Scheduler](/guide/session-scheduler) for board lanes, warmups, event starts, breaks, ceremonies, conflict warnings, delay re-flow, publishing, and iCal export.

### Running a meet (Control Room)

See the [Meet manager](#-meet-manager) and [Referee](#-referee) sections above.

### Judging

See the [Judge](#-judge) section above.

### Judge Analysis (`/judge-analysis`)

Public-accessible (no login required). Signed-in users see it in the sidebar.

| Persona | Feature | Where |
|---|---|---|
| Anyone | **By Event** tab — pick a Completed event; see the per-judge ranking matrix (where each diver, pair, or team would place under each individual judge's scores alone) | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |
| Anyone | Synchro events segmented into Exec A / Exec B / Sync columns in the matrix | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |
| Anyone | CSV + PDF export of the ranking matrix | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |
| Anyone | **By Judge** tab — search the public judge directory; open any judge's `/judge-profile` analytics | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |
| Anyone | Deep-link to a specific event's matrix via `?event=<id>` | [Judging → Judge Analysis](/guide/judging#judge-analysis--how-am-i-tracking) |

### Scoreboard (live + recap + archive)

See the [Spectator](#-spectator-no-login-required) section above for the public surface; the [Meet manager](#-meet-manager) section for broadcast / kiosk options.

### Diver Portal & Profile

See the [Diver](#-diver) and [Coach](#-coach) sections above.

### Admin Tasks

See the [Org admin](#-org-admin) and [System administrator](#-system-administrator) sections above.

### PDF + CSV exports

| Persona | Feature | Where |
|---|---|---|
| Spectator | Meet program PDF (with optional dive lists, judges, timing estimate at 30/45/60s per dive) | [Scoreboard → Program export](/guide/scoreboard#program-export) |
| Spectator | Meet program CSV (same options, `section` column for filtering) | [Scoreboard → Program export](/guide/scoreboard#program-export) |
| Spectator | Per-event PDFs from the recap (program, start list, score sheet, results) | [Scoreboard → Recap layout](/guide/scoreboard#recap-layout-completed-events) |
| Spectator | Event results CSV (one row per dive) | [Scoreboard → Recap layout](/guide/scoreboard#recap-layout-completed-events) |
| Spectator | Per-diver score-sheet PDF | [Scoreboard → Recap layout](/guide/scoreboard#recap-layout-completed-events) |
| Spectator | Judge Ranking Analysis CSV + PDF | [Scoreboard → Judge Ranking Analysis](/guide/scoreboard#judge-ranking-analysis-completed-events) |
| Spectator | Results-Archive filtered CSV | [Scoreboard → Results Archive](/guide/scoreboard#completed-meets-index-scoreboard) |
| Diver | Dashboard PDF (every enabled widget, with date-range filter applied) | [Diver Portal → Export Dashboard PDF](/guide/diver-portal#export-dashboard-pdf) |
| Meet manager | Start list PDF (`/api/events/:id/start-list.pdf`) | [Setting Up a Meet → CSV roster import](/guide/setting-up-a-meet#csv-roster-import) |

### Notifications

| Persona | Feature | Where |
|---|---|---|
| Diver | "Meet day reminder" push | [Admin Tasks → Notifications](/guide/admin-tasks#notifications) |
| Diver | "Results posted" email when a meet is finalised | [Running a Meet → Finalising the event](/guide/running-a-meet#finalising-the-event) |
| Diver | "You've been promoted into <event>" push when a reserve is promoted | [Running a Meet → Withdrawing or scratching a diver](/guide/running-a-meet#withdrawing-or-scratching-a-diver) |
| Diver | Personal best alert | [Admin Tasks → Notifications](/guide/admin-tasks#notifications) |
| Judge | "Assigned to <event>" push | [Admin Tasks → Notifications](/guide/admin-tasks#notifications) |
| Org admin | "Federation invited to host <meet>" push | [Admin Tasks → Notifications](/guide/admin-tasks#notifications) |
| All | In-app inbox (`/inbox`) listing every push + banner the user received | [Admin Tasks → Notifications](/guide/admin-tasks#notifications) |

### Keyboard shortcuts

| Persona | Feature | Where |
|---|---|---|
| Meet manager | Per-pool Control Room shortcuts (1-9 focus / Space / → / H / L / F / R / C) | [Keyboard Shortcuts → Control Room](/guide/keyboard-shortcuts#control-room-control) |
| All | Browser-level shortcuts (Cmd+K command palette etc.) | [Keyboard Shortcuts → Browser-level shortcuts](/guide/keyboard-shortcuts#browser-level-shortcuts-worth-knowing) |

### Performance + offline

| Persona | Feature | Where |
|---|---|---|
| Spectator | PWA install — service-worker cache, chromeless launch, resilient on flaky 4G | [Scoreboard → Spectator-side performance](/guide/scoreboard#spectator-side-performance) |
| Spectator | Last-good-state-stays-painted on connection drop (no silent stale data) | [Scoreboard → Connection-lost banner](/guide/scoreboard#connection-lost-banner) |
| Spectator | Cached-data banner while a fresh refresh is in flight | [Scoreboard → Results Archive](/guide/scoreboard#completed-meets-index-scoreboard) |
| Judge | Local score queue on connection drop, syncs when back online | [Judging → Connection drops](/guide/judging#connection-drops) |
| Meet manager | Live state survives a server restart | [Running a Meet → Meets survive server restart](/guide/running-a-meet#meets-survive-server-restart) |

### Languages & translation

| Persona | Feature | Where |
|---|---|---|
| All | 26 supported languages — every page can render in any of them | [Languages & Translation](/guide/languages) |
| All | In-app language switcher on public pages (Home, Login) | [Languages → Switching language](/guide/languages#switching-language) |
| All | Choice persists across sign-in / sign-out via localStorage | [Languages → What persists](/guide/languages#what-persists) |
| All | First-visit auto-detect from `navigator.language` (a phone set to French lands on French) | [Languages → First-visit auto-detect](/guide/languages#first-visit-auto-detect) |
| Arabic-speakers | Full RTL layout flip — `<html dir="rtl">` set in lockstep with the locale, page chrome mirrors automatically | [Languages → Right-to-left (Arabic)](/guide/languages#right-to-left-arabic) |
| Org admin / developer | AI-assisted translation pipeline — `npm run translate` fans out to Anthropic's API to fill in new keys for every locale | [Languages → Refreshing existing translations](/guide/languages#refreshing-existing-translations) |
| Org admin / developer | Adding a brand-new language is a 4-step process — register, target, translate, build | [Languages → Adding a new language](/guide/languages#adding-a-new-language) |

---

## See also

- [Roles & Permissions](/guide/roles-and-permissions) — the source of truth for what each role can / can't do
- [Quick Start](/guide/quick-start) — register a federation and run your first meet in ten minutes
- [FAQ & Troubleshooting](/guide/faq) — "why is X greyed out / not showing"
- The main repository README — feature highlights and architecture
