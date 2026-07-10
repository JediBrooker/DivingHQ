# Quick Start

This walks you from a fresh DivingHQ install to running your first meet end-to-end. About **ten minutes** if you have a database ready and an SMTP account for outbound email (the email steps degrade gracefully if you don't, so you can skip SMTP for a local trial).

## 0. Prerequisites

You need a running DivingHQ server — see the main README for installation. From here on we assume the app is reachable at `https://your-domain.example.com` (or `http://localhost:3000` locally).

## 1. Sign in or register your federation

![The DivingHQ login page](/guide-screenshots/login.png)

Go to `/login`. You have three options:

- **Sign in** — if your federation is already set up and an admin has given you an account.
- **Register here** — create a personal account inside an existing federation.
- **Register your org** — create a brand-new federation. Most first-time admins start here.

The system administrator (the person who set up the DivingHQ server) needs to **approve the federation** before you can sign in. New federations land in `pending` status until then. If you self-host, the bootstrap `admin` account (created by `init.sql`, password `admin`) can approve it from `/users` → org filter.

> **Change the bootstrap admin password the moment you log in.** It's `admin / admin` by default and that's a strong invitation for anyone who knows the project.

## 2. Open the dashboard

![The dashboard after signing in, showing live and upcoming counts and a list of things needing attention](/guide-screenshots/dashboard.png)

After signing in you land on `/dashboard`. The dashboard changes based on your role.

For a first meet, use these tiles:

| Tile | Use it for |
|---|---|
| **Meet Manager** | Create the meet, create events, add rosters, assign judges |
| **Schedule** | Plan boards, warmups, breaks, judge availability, and event start times |
| **Control Room** | Run the event on the day |
| **User Manager** | Create users and grant roles |
| **Scoreboard & Results** | Open the public spectator view |

The **Pulse strip** across the top shows urgent work: live events, upcoming events, pending role requests, judge assignments, and entries closing soon. Click a chip to jump to the relevant page.

You do not need to understand every dashboard card before running a trial meet. Start with Meet Manager, then Schedule, then Control Room.

> **Brand-new federation?** A first-run wizard kicks in automatically — see [§ 2a. First-run setup wizard](#2a-first-run-setup-wizard) below. If you've already created a club + an event (or dismissed it), you'll skip straight to the dashboard.

### 2a. First-run setup wizard

The very first time an org admin lands on the dashboard with zero events and zero clubs, DivingHQ redirects to `/setup` — a four-step wizard that gets a fresh federation productive in about five minutes:

1. **Welcome** — what's coming next.
2. **Create your first club** — name + an optional 3 – 6 char short code. Clicks through to a one-row club. (You can add more from the Clubs page later.)
3. **Invite your people** — copy a registration link to share in Slack / email / WhatsApp. Anyone who follows it signs up under your federation; you approve their role from User Manager.
4. **Build your first event** — opens Meet Manager with the New Event form ready.

Each step is skip-able. A `Skip setup →` link at the top bails out entirely. The wizard persists a localStorage stamp so it doesn't redirect you again on the next visit, even if you skipped without completing.

## 3. Add a few clubs (optional but realistic)

From the dashboard click **Clubs**. Create one or two clubs (e.g. "Capital Diving Club", "Coastal Aquatics"). Each gets a short code (3–6 chars, e.g. `NZL-1`) that surfaces as a cyan pill next to the club name on the scoreboard.

Clubs are optional — a federation can run a meet without any. They mostly matter for results archives and printed programs where the audience expects to see "who's representing whom".

## 4. Invite users (or let them self-register)

Two paths:

1. **Self-registration.** Send your federation's `/register` link to your divers and judges. They sign up; an admin approves their role from **User Manager**.
2. **Direct creation.** From `/users` click **+ New User**, fill in name + role + (optional) club. Send them their username + a temporary password.

For a quick trial, create at least:

- **5 judges** (panel size for a standard event)
- **3 – 4 divers**
- **1 referee** (used for the pre-meet sign-off)

See [Roles & Permissions](/guide/roles-and-permissions) for what each role can do.

## 5. Build your first event

![Meet Manager, listing the federation's meets and their events with per-event action buttons](/guide-screenshots/meet-manager.png)

Click **Meet Manager** from the dashboard. The layout is master-detail: a **left rail** lists your meets (All events / each meet / Ungrouped events); the **right pane** shows that selection's events with a search box and status filter chips. Use **+ New meet** on the rail to create a meet bundle; use **+ New event** or **+ Add event** in the right-pane header to create an event (optionally pre-bundled into the selected meet).

Minimum to get an event running (fill these in the New Event modal):

- **Event Name** — e.g. "Women 3 m Springboard"
- **Event Type** — Individual / Synchro Pair / Team
- **Gender** — Male / Female / Mixed (used for filters and headings)
- **Board / Platform Height** — 1 m, 3 m, 5 m, 7.5 m, 10 m
- **Judge Panel Size** — 5 for most individual events; **7, 9, or 11** for synchro, depending on the meet format
- **Rounds** — defined by the **Round dives editor**: click **+ Add Dive** to add a round row (one row = one round). The live badge shows "N rounds". Typically 5 or 6 rows for a final, 3 for a trial.

Optional but useful:

- **Meet** — bundle this event into a multi-event meet so they share a landing page and printable program.
- **Age Group** — free text (`U14`, `Open`, `Masters 30 – 34`).
- **Per-round DD limits** — common in junior events (rounds 1 – N capped to a max DD).
- **Save as Template** — once you've built a configuration you'll reuse, save it. Future events apply it with one click.

Click **Create Event**. The event lands in the right pane with status **Upcoming**.

## 6. Build the roster

From the event's row, click **Edit** and scroll down to the roster panel. Two ways to populate it:

- **Add divers individually** from your federation's user list.
- **Import from CSV** — paste a plain CSV (`username,round_number,dive_code,position`) and the server creates all the dive list rows in one transaction. Per-row errors are reported without failing the whole import.

Divers can also self-submit their lists from `/competitor` while the event is **Upcoming** and `entries_close_at` hasn't passed. See [Diver Portal](/guide/diver-portal).

## 7. Assign the judging panel

From the event row click **Assign Judges**. Pick a panel from your federation's `judge` users — order matters because judge_number is assigned by position (Judge 1 = panel slot 1).

![The Assign Judges page, with the federation's available judges on one side and the ordered panel slots on the other](/guide-screenshots/assign-judges.png)

For synchro events, the panel positions map to roles:

| Panel size | Exec A | Exec B | Sync |
|---|---|---|---|
| 7 | 1 – 2 | 3 – 4 | 5 – 7 |
| 9 | 1 – 2 | 3 – 4 | 5 – 9 |
| 11 | 1 – 3 | 4 – 6 | 7 – 11 |

Judges see their assigned role on the JudgeView so they know which slot they're filling.

## 8. Pick a referee

Add at least one referee to your federation (`User Manager` → grant `referee` role). They don't need to do anything pre-meet, but they're required for the **Sign Off** step in the Control Room before the event can flip to Live.

## 9. Schedule the session

Open **Schedule** from the dashboard or Meet Manager. Put the event onto a board, confirm the warmup, set the start time, and check for judge or board conflicts.

Warmups default to **45 minutes**. Change the value if your venue or meet bulletin uses a different warmup length.

For a one-event trial, the schedule can be simple:

| Time | Item |
|---|---|
| 08:15 | Warmup |
| 09:00 | Women 3 m Springboard |
| 10:15 | Medal ceremony |

Click **Publish** when the schedule is right. The public meet page, program export, dashboards, and iCal export now show the same plan.

See [Session Scheduler](/guide/session-scheduler) when you're planning multiple boards, breaks, or simultaneous sessions.

## 10. Open the Control Room

From the dashboard's "What needs your attention" panel, click your event's `Open Control Room →` card. (Alternatively, open Meet Manager and click the same primary button on the event's row, or navigate directly to `/control` and pick the event from the dropdown.) This is the operator's cockpit during the meet.

Pre-meet, the centre shows a **readiness checklist** and, beneath it, a single button offering the next thing you can do. Work through them in order:

1. **✓ Check In Divers.** Opens the check-in modal; tick everyone present, click Continue.
2. **🎲 Randomise Dive Order.** Click opens a confirm dialog spelling out what'll happen.
3. **📋 Referee Sign Off.** A referee scans a QR code on the manager's screen with their phone (or taps a push notification, types a 6-digit handoff code, or enters credentials directly) to confirm the panel is valid.
4. **▶ Start Event.** Flips status Upcoming → Live; the spectator scoreboards start broadcasting immediately.

Items tick green as you satisfy them, and the chip at the top counts what's left, so a new operator never has to remember what comes next.

![Control Room before an event starts, showing the readiness checklist above its contextual action button](/guide-screenshots/control-room-premeet-checklist.png)

See [Running a Meet](/guide/running-a-meet) for the full operator playbook including hold/resume, score correction with live preview, late entries, the auto-advance timer, the toast feedback strip (success / error notifications for every async action), and the undo snackbar that catches misclicks (withdraw / finalise).

## 11. Watch the scoreboard

Open `/scoreboard/<event-id>` in another browser window (or another machine on the same network). This is the audience-facing live scoreboard — current performer, live judge scores, standings, catch-up math, Up Next list. Add `?broadcast=1` (or use the **Broadcast** button in the header) for a kiosk-style version that hides the chrome and scales fonts up for a venue projector.

![The live scoreboard: the current performer in the centre column, judge scores beneath, and live standings alongside](/guide-screenshots/scoreboard-live.png)

For a phone-friendly spectator URL, the same `/scoreboard/<event-id>` route is responsive — it collapses to a single column on narrow screens.

## 12. After the meet

When the last dive of the last round is scored, the operator clicks **Finalise Event**. Status flips to Completed and:

- The scoreboard switches to a recap layout (podium spotlight, full standings, dive-by-dive breakdown).
- The event appears in the public **Results Archive** (`/scoreboard` with no event id).
- PDFs (program, start list, score sheet, results) are one click away.
- Per-diver profiles update with new PBs, score-trend sparklines, and any new records.

## Next steps

- [Setting Up a Meet](/guide/setting-up-a-meet) — deeper dive on event configuration: synchro events, team events, multi-stage progression (prelim → semi → final), event templates, multi-event meet bundles.
- [Session Scheduler](/guide/session-scheduler) — plan boards, warmups, breaks, officials, and delays.
- [Running a Meet](/guide/running-a-meet) — the full operator playbook.
- [Admin Tasks](/guide/admin-tasks) — managing users, clubs, teams, audit logs.
