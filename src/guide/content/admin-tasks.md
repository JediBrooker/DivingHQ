# Admin Tasks

This page covers everything an org admin (or system admin) does when they're NOT actively running a meet — managing users, clubs, teams, audit logs, and federation records.

## Which admin task do I need?

| If you need to… | Go to |
|---|---|
| Approve users, grant roles, reset passwords | [User Manager](#user-manager) |
| Approve club changes and org transfers | [Club-change requests](#club-change-and-cross-org-transfer-requests) |
| Create clubs or assign club codes | [Clubs](#clubs) |
| Create team entries | [Teams](#teams) |
| Review score changes | [Score Audit Log](#score-audit-log) |
| Review role changes | [Role Audit Log](#role-audit-log) |
| Set up an international meet | [Hosting an international meet](#hosting-an-international-meet) |
| Plan boards, warmups, and event timing | [Session Scheduler](/guide/session-scheduler) |
| Approve new federations or run migrations | [System admin tasks](#system-admin-tasks) |

Org admins work inside one federation. System admins work across every federation and should treat cross-org actions as production operations.

## The dashboard at a glance

The dashboard's **Pulse strip** is the operator's first signal of "what's happening across the federation right now". For org admins it surfaces three kinds of pending work — each as a clickable, hoverable chip:

- **`👥 N PENDING`** — pending role requests across all your users (and, for system admins, pending federation registrations awaiting approval). Hover the chip to see the requester names + which role they're asking for; click any one to jump straight into User Manager. Items older than 7 days get a red "overdue" pill so you can spot the stragglers in a long list.
- **`🔴 N LIVE`** — events currently live across your federation. Hover to see the event names; click any to drop into the Control Room with that event preselected. The chip breathes gently while there are live events.
- **`📅 N UPCOMING`** — events with status Upcoming, sorted by closest entries-close. Items with entries closing within 24 h get an amber "closing soon" pill.

The strip is socket-driven — counts update the moment something happens (an event flips Live, a new role request lands), and the affected chip flashes cyan so your eye lands on the change. A 30-second poll keeps everything in sync as a fallback.

For system admins, the strip also includes pending org registrations in the `👥 PENDING` count.

The right edge of the strip carries an **activity ticker** — a single auto-cycling chip showing the most recent audit row across the federation (`⚡ Avery Ueno withdrawn from R3 · 2h ago` style). Click → opens the full [Audit Log](#).

### Drilling deeper

When a chip's count is more than a glance can absorb, click the chip itself (rather than a popover item) to switch to the **Org Admin tab**. That tab carries the same items as full attention cards — one card per live event, one per upcoming event, plus a 7-day recent-activity feed of every score correction, role change, and event-lifecycle audit row.

## User Manager

`/users` — the central screen for managing your federation's users.

![User Manager](/guide-screenshots/user-manager.png)

### What you see

- **Search box** at the top — matches on full name or username
- **Role filter chips** — Diver, Coach, Judge, Referee, Meet Manager, Org Admin (multi-select)
- **Org filter** (system admins only) — pick a federation to see only its users
- **Group by org** toggle (system admins only) — collapses the list into per-federation sections
- **Bulk role apply** — tick rows, click a role chip in the bulk bar, all ticked users get that role

### Click-row-to-edit

Click any user's row to open the **edit drawer** on the right. The drawer shows:

- **Club assignment** — pick from the org's existing clubs or create a new one inline; saving is immediate.
- **Personal & competition details** — full name, date of birth, gender, nationality. Saved as a single PUT; blank fields clear the stored value.
- **Account lifecycle** — four actions, each available to an org admin:
  - **Suspend account** — requires confirmation; the user is blocked at login immediately. Suspended accounts show a badge and a **Reactivate** button instead.
  - **Resend verification email** — only shown when the user's email is unverified.
  - **Send password reset** — emails a single-use reset link to the user (requires SMTP; without it the URL is returned in the response for manual delivery).
- **Roles** — current roles in this org, toggled as checkboxes; each change saves automatically and updates the role audit log.
- **Role audit history** — every grant/revoke ever applied to this user, with actor + timestamp.
- **Coach links** — list of coach ↔ diver links involving this user, with add/remove controls.

### Granting and revoking roles

Tick the role chip → grant. Untick → revoke. Both write to the role audit log automatically. The user's JWT becomes invalid the moment a role changes (token version is bumped); they're forced to sign in again, picking up the new role.

### Coach ↔ Diver links

Coach role users can request to be linked to a diver from their own dashboard. The request lands as a pending row in the diver's User Manager record; an org admin approves or rejects. Once linked, the coach sees the diver's full profile + analytics + templates.

A diver can have multiple coaches over time; a coach can mentor multiple divers. The link is bidirectional but **gated on org-admin approval** — divers can't be silently surveilled by anyone who claims to be their coach.

### Club-change and cross-org transfer requests

Divers initiate club changes from their own profile ("My club" card). Org admins action the resulting requests in **User Manager → Requests tab**.

The Requests tab shows two sections:

- **Role requests** — pending role grant requests, approve or deny each.
- **Club change requests** — pending club or org moves, with type badges (`club change` or `transfer`).

For **same-org club changes** (diver moving from one club to another within your federation), a single org-admin approval completes the move.

For **cross-org transfers** (diver moving to a different federation), a **three-way handshake** is required — each approval step is visible as a status chip on the request card:
- **Source ✓** — the diver's current org admin has approved.
- **Target ✓** — the receiving org admin has approved.
- **Diver ✓** — the diver themselves has confirmed the transfer.

The move only finalises once all three are in. Every approval and the final transfer are audit-logged.

## Clubs

`/clubs` — the federation's club registry.

- **List** — every club in your org, with member counts derived from `users.club_id`
- **+ New Club** — name + short code (3 – 6 chars; surfaces as the cyan pill in scoreboards)
- **Edit** — rename, change short code
- **Delete** — non-destructive; clubs with members can't be deleted (prevents orphaning users)

The short code matters more than you'd think — it's the cyan pill that shows next to the diver's name on the scoreboard, history cards, and Up Next tile. Pick something distinctive (e.g. `NZL-WLG` for "NZ Wellington" instead of just `WLG`).

## Teams

`/teams` — for World Aquatics Team Event entries.

- **List** — every team in your org, with member counts and a list of events the team is enrolled in
- **+ New Team** — name + optional short code
- **Edit** — rename, change short code, manage members via the inline drawer
- **Delete** — non-destructive (preserves history); a deleted team's existing dive lists keep referencing the team via `ON DELETE SET NULL`

The members drawer lets you add or remove divers, with a search across your federation's users. A diver can belong to multiple teams over time (e.g. an Auckland senior who later moves to a Christchurch club).

Team names show as a **purple chip** in history cards and the active-diver block — it's the visual signal that this is a team event entry.

## Score Audit Log

`/events/<id>/audit` — every score insert, update, and delete for one event.

You can also reach this from the event row in Meet Manager via the **Audit Log** button.

### What it logs

For every score event:

- Action — `insert` / `update` / `delete`
- Actor — which user triggered it (judge submitting, meet manager correcting)
- Old value + new value (for updates)
- Reason text (for corrections — required field)
- Timestamp
- IP address + user agent

### Who can read it

- System admins — across every event, every org
- Org admins — events in their own federation
- Referees — events they're assigned to
- Meet managers — events they manage

Divers and judges **cannot** read the audit log — it's an integrity tool for officials.

### Retention

Audit rows are kept for 30 days by default (configurable via `purge_audit_logs(retention_days)` which runs on server boot). After the retention window, scoreboards and standings still work normally — only the per-row "who edited what when" history is pruned.

### Long-term archive

For legal disputes / compliance reviews that need history older than 30 days, the operator has two paths:

1. **Streaming CSV export.** `GET /api/audit/export.csv?kind=scores|roles|activity&from=<iso>&to=<iso>&org_id=<uuid>` returns the full date-range as CSV with no row cap. Org-admin gated; sysadmin can scope across orgs via the `org_id` query param. The Audit Log view's per-tab CSV button uses the same data shape but only for the rows currently loaded in the page (capped at 100 per request).

2. **Daily snapshot job.** When `AUDIT_SNAPSHOT_DIR=/path/to/audit-archives` is set in the server's `.env`, the server's bootChecks (which runs the daily purge) writes the past 24 h of all three audit tables to JSONL files in that directory BEFORE the purge runs. One file per table per day:

    ```
    /path/to/audit-archives/score_audit_2026-03-14.jsonl
    /path/to/audit-archives/role_audit_2026-03-14.jsonl
    /path/to/audit-archives/audit_2026-03-14.jsonl
    ```

    Push the directory to S3 / off-site backup via your own cron / systemd job — the server doesn't ship the rows anywhere on its own. Without `AUDIT_SNAPSHOT_DIR` set the snapshot is a no-op (dev / single-node deployments don't need it).

## Role Audit Log

The role audit log lives **inside the User Manager drawer** — click any user's row, scroll down to the role audit history section.

For every role grant or revoke:

- Action — granted / revoked
- Role — the specific role (judge / coach / etc.)
- Actor — which admin made the change
- Timestamp

System admins can also query the table directly via `role_audit_log` if needed for cross-org analytics.

## Federation records

`/records/<federation-slug>` — the public records book for your federation.

Records are tracked at three levels:

- **Personal** — per-diver, per `(dive_code, position, board_height)`. Auto-set on every score insert via `checkAndApplyRecords`.
- **Club** — per-club; auto-set when a member breaks the club's existing best
- **Federation** — same shape but federation-wide; auto-set on the same trigger.

If a federation needs an approval workflow before publishing a national record (so a panel error or a one-off score correction doesn't immediately publish a "new national record" the audience would later see retracted), that's a future enhancement — see the project README's roadmap.

## System admin tasks

The system admin (set via `is_system_admin = true` in the DB) has a few extra surfaces:

### Approving new federations

When someone clicks "Register your org" on the login page, their federation lands in `pending` status. The system admin sees pending orgs from User Manager → org filter → status = pending. Click → review name + country code + admin's contact email → approve or reject.

Approved orgs are immediately usable; rejected orgs send a notification email and stay in the database in `rejected` status (for audit purposes).

### Approving system-wide records

Some records (e.g. cross-federation continental records) are approved at the system-admin level. The same pending → approve flow as federation records, but visible only to system admins.

### Cross-org user lookup

System admins can see every user across every federation via the User Manager. Useful when:

- A user is locked out and the org admin can't reach them
- A judge appears on a panel for a federation they don't belong to (data error or fraud — the audit log will show)
- Migrating a user between federations

### Resetting a password

System admins (and org admins for their own federation's users) can send a password reset from the User Manager drawer — click the user's row, then **Send password reset** in the Account section. The user is emailed a single-use reset link (or, if SMTP isn't configured, the reset URL is returned in the response for manual delivery). The user's existing tokens are invalidated once they complete the reset.

### Migrations

System admins are the only ones who run database migrations — see the main README for the deploy script. The `/api/health` endpoint reports the current `schema_version`; an outdated version blocks new code paths.

## Hosting an international meet

When you want to run a competition that includes divers from other federations (Pacific Junior Championships, World Aquatics Grand Prix stops, bilateral invitationals), you do NOT need to create shadow accounts for foreign divers in your own federation. The system supports multi-federation events out of the box:

1. Create the event in Meet Manager as you normally would. The event belongs to your federation (host org) — that's still the authority for meet_manager / referee / score correction / audit log.
2. Click the event's **⋯** overflow menu → **Federations…**.
3. In the modal, pick another federation from the dropdown and click **Invite**. Repeat for every country sending divers. The host federation is implicit — don't add it.
4. Once invited, divers from those federations can:
   - See your event in their `/scoreboard` and Meet Manager listings (event_participating_orgs entry surfaces it).
   - Self-submit a dive list via the standard entry flow (the diver picker, synchro-partner picker, and roster import all consult the participating list).
5. The **🌐 International (N)** chip appears on the event row in Meet Manager so you can see at a glance which events are multi-federation. Click it to re-open the modal.

### What happens to records

A foreign diver setting a personal best at your meet:
- ☑ Writes to **their** personal best history (their home federation's profile page reflects it).
- ☑ Writes to **their home federation's** records book (not yours) — `lib/records.js` already keys federation records off `users.org_id`, so this just works.
- ☑ Counts toward their home club's record book (if they belong to a club in their home federation).
- ✗ Does NOT pollute your federation's records book with foreign holders.

### What stays host-only

- Meet manager / referee / score correction permissions — visiting federations don't get these.
- The audit log perimeter — only your org admins / event managers can read it.

### Foreign judges + international panels

When you assign judges via Assign Judges, the picker now pulls from every participating federation, not just yours. Each judge tile shows a country chip (e.g. **NZL**) so you can build a balanced international panel — typically 2 judges per country plus the referee. The save endpoint validates that every judge belongs to either your host org or one of the participating federations; if a judge somehow isn't on either, the save 400s with a pointer to add their federation first.

### Notifications

When you click **Invite** in the Federations modal, every org_admin in the invited federation receives an in-app banner + push notification (if they've subscribed). The notification deep-links to their Meet Manager view of the event. Same channel fires when a federation is removed (or self-withdraws), telling the host's admins their roster expectation just changed.

### Country medal table

Once any event in the meet has finalised with ≥2 distinct countries on the standings, the public recap automatically grows an Olympic-style country medal table card alongside the per-diver leaderboard — sorted by gold count, then silver, then bronze. Spectators see who topped the federation count without you doing anything extra.

### Continental records

Migration 037 added a fourth records scope alongside personal / club / federation. Each federation now has a **continent** field (`africa`, `americas`, `asia`, `europe`, `oceania`) — sysadmin sets this once per federation. When a diver whose home federation is classified sets a personal best, the dive is also compared against the continental record book. A junior setting an Oceania record at a Pacific Junior Champs now has a real place to land it; the records page (`/records/:slug`) gains a Continental tab.

If your federation hasn't been classified yet, ask the sysadmin to set it.

### Removing a federation

If a country withdraws before the event goes Live, click **Remove** on their row in the Federations modal. The button is destructive (red) — but it's safe: existing roster entries from their divers stay intact (they keep competing), and only NEW entries are blocked. The audit row records who removed whom.

### Joining as a visiting federation

If you're an org admin whose federation has been **invited** to a foreign-hosted event:

1. The 🌐 INVITED pulse chip on your dashboard counts unaccepted invites.
2. The event shows up in your normal Meet Manager listing (because your org is on the participating list). Use it to brief your divers, who will see the same event in their personal listings.
3. Your divers can self-enter their dive lists exactly as they would for a domestic event — the host's `event_participating_orgs` row is your authorisation.
4. To withdraw your federation entirely (e.g. travel ban, funding cut), open the event's overflow menu (⋯) → **Withdraw participation**. The host's admins get a notification. Existing dive lists from your divers stay intact — only NEW entries are blocked.

## Bulk operations

A few bulk paths worth knowing about:

- **CSV roster import** (per-event) — paste a CSV, the server creates dive list rows in one transaction
- **CSV results export** (federation-wide) — Results Archive → Filter → Export CSV
- **Bulk role apply** — User Manager → tick rows → click a role chip
- **PDF program export** — meet landing page → Print Program

Anything more bespoke (mass user import from a federation database, CSV-driven event creation) needs to go through the API directly. See the API documentation in the main README.

## Notifications

Email notifications fire automatically (best-effort, never block the response):

| Trigger | Recipient |
|---|---|
| User registers | The new user (welcome email) |
| Role request | All org admins |
| Role decision | The applicant |
| Password changed | The user |
| Password reset link | The user |
| Meet went Live | Every competitor in any event of the meet |
| Results posted | Every competitor in the finalised event |

Without `SMTP_HOST` configured, all email helpers silently no-op. Registrations + password changes still work; just no email.

### In-app inbox

Beyond email, every push notification and in-app banner is retained in the user's **Inbox** (`/inbox`, bell icon in the header) so a missed phone alert isn't lost. Users filter by category (Action required, Coach & team, Results, Operations), toggle unread-only, and **Mark all read**; each row deep-links to the relevant scoreboard, event, or approval queue.

![Notifications inbox](/guide-screenshots/inbox.png)

## Common admin pitfalls

- **Promoting a meet manager too late.** Until they have the role, they can't open the Control Room. Promote them at least the day before.
- **Forgetting the referee.** The Sign Off step in the Control Room blocks Start Event without one — no referee, no Live event.
- **Deleting a club mid-meet.** The UI prevents this (members must be reassigned first), but a direct API call could orphan users. Don't.
- **Trying to delete an event with recorded scores.** The server refuses with `409 Refusing to delete: event has N recorded scores`. Cancel or finalise the event instead — the event row is the anchor for its audit trail and result history. (System admins can override with `?force=1` if there's a legitimate reason; the override is recorded in the audit log.)
- **Suspending an org during an active meet.** The org status flip is immediate — judges and the scoreboard would lose access mid-event. Wait for the meet to complete.
