# Admin Tasks

This page covers everything a federation (org), region or club admin, or a system admin, does when they're NOT actively running a meet — managing users, clubs, teams, claims, audit logs, and record books.

## Which admin task do I need?

| If you need to… | Go to |
|---|---|
| Approve users, grant roles, reset passwords | [User Manager](#user-manager) |
| Approve club changes and org transfers | [Club-change requests](#club-change-and-cross-org-transfer-requests) |
| Create clubs or assign club codes | [Clubs](#clubs) |
| Appoint club and region admins | [Clubs](#clubs) |
| Run your club: members, co-admins, region | [Club admins](#club-admins) |
| Look after a state, province or home nation | [Region admins](#region-admins) |
| Vote on or decide a claim | [Claims](#claims) |
| Create team entries | [Teams](#teams) |
| Review score changes | [Score Audit Log](#score-audit-log) |
| Review role changes | [Role Audit Log](#role-audit-log) |
| Set up an international meet | [Hosting an international meet](#hosting-an-international-meet) |
| Plan boards, warmups, and event timing | [Session Scheduler](/guide/session-scheduler) |
| Approve new federations or run migrations | [System admin tasks](#system-admin-tasks) |

Org admins work inside one federation, region admins inside one region, and club admins inside one club. System admins work across every federation and should treat cross-org actions as production operations.

## The dashboard at a glance

The dashboard's **Pulse strip** is the operator's first signal of "what's happening across the federation right now". For org admins it surfaces three kinds of pending work — each as a clickable, hoverable chip:

- **`👥 N PENDING`** — pending role requests across all your users (and, for system admins, pending federation registrations awaiting approval). Hover the chip to see the requester names + which role they're asking for; click any one to jump straight into User Manager. Items older than 7 days get a red "overdue" pill so you can spot the stragglers in a long list.
- **`🔴 N LIVE`** — events currently live across your federation. Hover to see the event names; click any to drop into the Control Room with that event preselected. The chip breathes gently while there are live events.
- **`📅 N UPCOMING`** — events with status Upcoming, sorted by closest entries-close. Items with entries closing within 24 h get an amber "closing soon" pill.

Club and region admins in a country whose federation isn't on DivingHQ yet get the same **PENDING** chip for their own members' role requests. It links to **My club** (or **My region**), which is where they approve. Org admins (and system admins, across every country) see **`🏛 N NEW CLUBS`** while clubs started at signup wait for their approval on **Clubs**, and the person who started one sees **`🏛 1 CLUB AWAITING APPROVAL`** until it's decided. Anyone with a vote on a claim sees **`⚖ N CLAIMS`**. Whoever filed a claim sees **`⚖ N OPEN CLAIM`** with where it stands (when voting closes, or that DivingHQ has it) until it's decided, and **Claims** stays in their sidebar afterwards so they can check how it went.

The strip is socket-driven — counts update the moment something happens (an event flips Live, a new role request lands), and the affected chip flashes cyan so your eye lands on the change. A 30-second poll keeps everything in sync as a fallback.

For system admins, the strip also includes pending org registrations in the `👥 PENDING` count.

The right edge of the strip carries an **activity ticker** — a single auto-cycling chip showing the most recent audit row across the federation (`⚡ Avery Ueno withdrawn from R3 · 2h ago` style). Click it to open the full [Audit Log](/audit).

### Drilling deeper

When a chip's count is more than a glance can absorb, click the chip itself (rather than a popover item) to switch to the **Org Admin tab**. That tab carries the same items as full attention cards — one card per live event, one per upcoming event, plus a 7-day recent-activity feed of every score correction, role change, and event-lifecycle audit row.

## User Manager

`/users` — the central screen for managing your federation's users.

![The User Manager table, listing every member of the federation with their roles and account status](/guide-screenshots/user-manager.png)

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
  - **Send password reset** — emails a single-use reset link to the user (requires email to be configured; see [Notifications](#notifications)).
- **Roles** — current roles in this org, toggled as checkboxes; each change saves automatically and updates the role audit log.
- **Role audit history** — every grant/revoke ever applied to this user, with actor + timestamp.
- **Coach links** — list of coach ↔ diver links involving this user, with add/remove controls.

### Granting and revoking roles

Tick the role chip → grant. Untick → revoke. Both write to the role audit log automatically. The user's JWT becomes invalid the moment a role changes (token version is bumped); they're forced to sign in again, picking up the new role.

Your federation always keeps at least one live **Org Admin**. Unticking it on the last one (yourself included) is refused with a message, and the box ticks itself back; appoint another admin first, or write to DivingHQ support. The same goes for suspending the last one, and for the last one deleting their own account or transferring out. Suspended and deleted accounts don't count as admins.

### Coach ↔ Diver links

Coach role users can request to be linked to a diver from their own dashboard. The request lands as a pending row in the diver's User Manager record; an org admin approves or rejects. Once linked, the coach sees the diver's full profile + analytics + templates.

A diver can have multiple coaches over time; a coach can mentor multiple divers. The link is bidirectional but **gated on org-admin approval** — divers can't be silently surveilled by anyone who claims to be their coach.

### Club-change and cross-org transfer requests

Divers initiate club changes from their own profile ("My club" card). Org admins action the resulting requests in **User Manager → Requests tab**.

The Requests tab shows these sections:

- **Role requests** — pending role grant requests, approve or deny each.
- **Club change requests** — pending club or org moves, with type badges (`club change` or `transfer`).
- **Guardian link requests** — a parent asking to pay on a child's behalf, with the child's age. Only shown while payments is switched on.

For **same-org club changes** (diver moving from one club to another within your federation), a single org-admin approval completes the move.

For **cross-org transfers** (diver moving to a different federation), a **three-way handshake** is required — each approval step is visible as a status chip on the request card:
- **Source ✓** — the diver's current org admin has approved.
- **Target ✓** — the receiving org admin has approved.
- **Diver ✓** — the diver themselves has confirmed the transfer.

The move only finalises once all three are in. Every approval and the final transfer are audit-logged.

## Clubs

`/clubs` — the federation's club registry.

![Clubs registry listing every club in the federation with its short code and member count](/guide-screenshots/clubs.png)

- **List** — every club in your org, with member counts derived from `users.club_id`
- **+ New Club** — name + short code (up to 8 letters, numbers or dashes, unique among the federation's clubs; surfaces as the cyan pill in scoreboards)
- **Edit** — rename, change short code
- **Delete** — non-destructive; clubs with members can't be deleted (prevents orphaning users). Anyone still waiting on a request to join the club has it closed and gets a note saying why.
- **Admins** — appoint or remove the club's admins (see [Club admins](#club-admins))
- **Regions** — the strip above the list shows your states, provinces or home nations with their club counts; click one to appoint its admins. If your country has no regions yet, **Set up regions** loads the standard list for Australia, Canada or the UK
- **Waiting for approval** — clubs someone started when they signed up in your country. Each shows who started it (with their username and email, which they've verified), when they asked, and a **Looks like …** warning when an existing club has the same code or much the same name. Until you decide, the club is hidden from every club list, nobody can join it and it can't host meets. **Approve** lets you fix the name, short code and region first, and makes the founder the club's admin unless you untick the box. **Reject** deletes the club, optionally moves its members into an existing club (the look-alike is picked for you), and sends the founder your reason. Either way the founder keeps their account and is told by email. The **`🏛 N NEW CLUBS`** chip on your dashboard counts what's waiting.
- **New clubs from signup** — *Wait for my approval* (the default) or *Join automatically*. With join automatically, a new club is live as soon as it's created and you just get a heads-up in your inbox; you still appoint its admins. Switching it on doesn't approve clubs that are already waiting.

The short code matters more than you'd think — it's the cyan pill that shows next to the diver's name on the scoreboard, history cards, and Up Next tile. Pick something distinctive (e.g. `NZL-WLG` for "NZ Wellington" instead of just `WLG`).

## Club admins

`/club` (**My club** in the sidebar), for anyone who admins a club.

- **Role requests** — members asking to dive, judge or coach. Approve or reject each one. (Referee requests go to DivingHQ, since a referee can act at any club's meet in the country.) In a country with no federation on DivingHQ yet this is where they land; under a federation they go to the federation's admins instead.
- **Admins** — the club's admins. While the country has no federation you can add co-admins from your members and remove them. The last admin can't step down: their **Remove** stays greyed out until there's a co-admin. Under a federation this list is read-only, because the federation appoints club admins.
- **Region** — which state, province or home nation the club is in, in countries that have them. Same rule: yours to set until a federation arrives.

A club admin also runs the club's meets. In Meet Manager, **+ New meet** creates a meet hosted by your club, and from there you have the same tools as a meet manager for that meet's events: entries, panels, the schedule and the Control Room. **Save as template** in the New Event form keeps the settings for next time. Those templates are your club's: your co-admins see them, your region and federation don't.

## Region admins

`/region` (**My region** in the sidebar), for anyone who admins a region.

- Every club in the region, with who runs it.
- The region's own admins. While the country has no federation you add and remove co-admins here, and as with clubs the last one can't step down.

Region admins approve role requests from any club in the region (in a country with no federation yet), create the region's championships in Meet Manager, and can step in on any of the region's clubs' meets. The event templates they save belong to the region and are shared with its other admins only (a club's templates stay the club's). Federation admins appoint them from **Clubs** → the regions strip; a state body can also apply for its region from [Register your org](/register-org), which opens a claim.

## Claims

`/claims` (**Claims** in the sidebar). A claim is a federation or state body applying to take over a country or region that its clubs started. [Roles & Permissions → Claims](/guide/roles-and-permissions#claims) has the full rules; here's what each admin does with them.

- **Club admins** (or, for a national claim, the admins of regions already claimed) see the claims they can vote on, with the body's name, its website, and whether the applicant's email is on that website's domain. **Approve**, or **Object** with a reason. An objection sends the claim to DivingHQ.
- **Federation admins** decide a state body's claim on one of their regions.
- **System admins** decide claims with too few voters, objected claims, and claims whose vote ran out without passing. They can also **revoke** an approved claim, which hands the country or region back to its clubs and removes the admin seat the claim gave.

The dashboard's pulse strip counts claims waiting on you.

## Teams

`/teams` — for World Aquatics Team Event entries.

![Teams page listing each team with its short code, member count, and enrolled events](/guide-screenshots/teams.png)

- **List** — every team in your org, with member counts and a list of events the team is enrolled in
- **+ New Team** — name + optional short code
- **Edit** — rename, change short code, manage members via the inline drawer
- **Delete** — non-destructive (preserves history); a deleted team's existing dive lists keep referencing the team via `ON DELETE SET NULL`

The members drawer lets you add or remove divers, with a search across your federation's users. A diver can belong to multiple teams over time (e.g. an Auckland senior who later moves to a Christchurch club).

Team names show as a **purple chip** in history cards and the active-diver block — it's the visual signal that this is a team event entry.

On the standings, recap and results PDF a team's row gets the same kind of chip its divers would. It follows the meet's **Divers represent** setting: if every diver on the team is from one state (or one club, in a club meet) the team shows that code, and a team mixing states or clubs shows its country. The team's short code sits underneath. It's worked out from who the divers were when they were entered, so a diver moving club later doesn't change an old result.

## Score Audit Log

`/events/<id>/audit` — every score insert, update, and delete for one event.

You can also reach this from the event row in Meet Manager via the **Audit Log** button.

![Score Audit Log listing each score action with its actor, old and new values, and reason](/guide-screenshots/score-audit.png)

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

Audit rows are kept for 30 days by default (`purge_audit_logs(retention_days)`, which the server runs at startup and then once a day). After the retention window, scoreboards and standings still work normally — only the per-row "who edited what when" history is pruned.

### Long-term archive

For legal disputes / compliance reviews that need history older than 30 days, the operator has two paths:

1. **Streaming CSV export.** `GET /api/audit/export.csv?kind=scores|roles|activity&from=<iso>&to=<iso>&org_id=<uuid>` returns the full date-range as CSV with no row cap. Org-admin gated; sysadmin can scope across orgs via the `org_id` query param. The Audit Log view's per-tab CSV button uses the same data shape but only for the rows currently loaded in the page (capped at 100 per request).

2. **Daily snapshot job.** When `AUDIT_SNAPSHOT_DIR=/path/to/audit-archives` is set in the server's `.env`, the server copies all three audit tables to JSONL files in that directory at startup and then once a day, always BEFORE the purge runs. Each run picks up where the last one stopped (the directory keeps a small `.snapshot-marks.json`), so no row is missed however long the server stays up or however far apart restarts are; the very first run copies everything still in the database. Rows are copied once they're five minutes old. One file per table per day:

    ```
    /path/to/audit-archives/score_audit_2026-03-14.jsonl
    /path/to/audit-archives/role_audit_2026-03-14.jsonl
    /path/to/audit-archives/audit_2026-03-14.jsonl
    ```

    Push the directory to S3 / off-site backup via your own cron / systemd job — the server doesn't ship the rows anywhere on its own. Keep `.snapshot-marks.json` with the files: delete it and the next run copies everything still in the database again. If the directory can't be written (permissions, a full disk) the server logs a warning and carries on serving; the next run retries from the same point. Without `AUDIT_SNAPSHOT_DIR` set the snapshot is a no-op (dev / single-node deployments don't need it).

## Role Audit Log

The role audit log lives **inside the User Manager drawer** — click any user's row, scroll down to the role audit history section.

For every role grant or revoke:

- Action — granted / revoked
- Role — the specific role (judge / coach / etc.)
- Actor — which admin made the change
- Timestamp

System admins can also query the table directly via `role_audit_log` if needed for cross-org analytics.

## Records

Records keep themselves. There's nothing to submit and nothing to approve: when the last judge's score for an individual dive lands, whether from the judges' phones or typed in through manual entry, DivingHQ checks the dive against every book its diver belongs to and replaces any mark it beats.

The books are public at [`/records`](/records) (**Records** in the sidebar's Competition menu), no sign-in needed:

- **National** — your federation's book, for divers whose home federation is yours.
- **State / province / region** — the region the diver was entered from, labelled with your country's own word for it. Only shown for countries that have regions.
- **Club** — the diver's club.
- **Continental** — every diver whose federation the system admin has given a continent (see [Continental records](#continental-records)).
- **Personal bests** aren't a book. They live on each diver's profile.

Every book is split into **Women's** and **Men's**, and each record is one board height, dive code and position, so a 105B from 3 m and a 105B from 1 m are separate records. Only individual events count: a synchro dive is two people's work credited to one of them, so synchro and team events never set records. A Mixed event files each dive under the diver's own profile gender, and skips the dive if the profile doesn't give one. Rehearsal events never touch the books, and nor do scores typed in through manual entry while an event is still Upcoming (that's somebody trying the Control Room out, not a competition).

Each club links to its book from **My club**, and each region from **My region**.

**Unofficial marks.** A national or state book whose governing body hasn't claimed its account on DivingHQ yet (a country the clubs started, or a state nobody has claimed) carries one **Unofficial** note with a link to the claim flow. The marks don't change when the claim is approved, they simply become official. Club and continental books always read as official.

**Corrections and deletions don't re-check records.** A score corrected after the fact leaves the books as they were, and so does deleting an event: a record the original score set stands until somebody beats it, and a deleted event's records stay with their holder (the *Set at* column goes blank). If a book needs putting right, the system admin can [rebuild it from the scores](#rebuilding-the-record-books).

There's no approval step before a national record shows publicly. If your federation needs one, that's a future enhancement.

## System admin tasks

The system admin (set via `is_system_admin = true` in the DB) has a few extra surfaces:

### Approving new federations

A national federation or state body registering from a real country doesn't wait in a queue any more: it opens a **claim** on that country's account (or its region), and when nobody from the country is on DivingHQ yet, the account is started for it and the claim comes to you. Decide those on the **Claims** page (`/claims`).

Only an organisation registered with a code outside the country list still lands in `pending` status. Those, and any left over from before, show under User Manager → **Pending requests** → *Federation registrations*, with the admin's contact email. Approve or deny from there. Two rules protect the country lookup that signups rely on:

- An organisation with **no country** can't be approved. Pick its country on the card and click **Set country** first.
- If clubs have already started that country's account, approving would give the country two. The card says so and Approve stays off: deny it and have the federation claim the clubs' account from Register organisation instead.

Approved orgs are immediately usable; denied orgs are suspended, the admin gets a notification email, and the row stays in the database for audit purposes.

### Organisations without a country

Signups find their federation by country, so a live organisation with no country (or a code that isn't on the list, like an old 2-letter code or an IOC code such as `GER`) is one nobody can join. User Manager → **Pending requests** lists them under *Organisations without a country*. Pick the country and click **Set country**; the change is audit-logged. An account the clubs started keeps the country it was started for.

### Rebuilding the record books

Records are written as scores land, and when a dive that's already scored changes (the referee fails or caps it, a score is corrected, a conflict is resolved, a redive is scored again) its books are replayed, so a record goes back to whoever held it before. A book can still drift from the scores behind it, mostly books written before migration 094 split them by gender (back then a man's dive could replace a woman's club record, and synchro dives counted). The system admin can replay every book from the scores themselves:

```
node scripts/rebuild-records.js                  # dry run: counts per book, writes nothing
node scripts/rebuild-records.js --verbose        # ...plus the first rows that would change
node scripts/rebuild-records.js --org <uuid>     # one federation's books (continental is skipped)
node scripts/rebuild-records.js --apply          # actually write it
```

Nothing is written without `--apply`. With it, every row that's replaced or removed is copied to the matching history table first, and the whole rebuild runs in one transaction with the record tables locked, so a dive finishing mid-rebuild just waits for it. Records whose event has since been deleted can't be checked against scores, so they're left alone unless the replay beats them. A dive counts for the club and state its diver was entered from, the same as when it was scored live, and a club still waiting for its federation's approval gets no club records.

### Cross-org user lookup

System admins can see every user across every federation via the User Manager. Useful when:

- A user is locked out and the org admin can't reach them
- A judge appears on a panel for a federation they don't belong to (data error or fraud — the audit log will show)
- Migrating a user between federations

### Resetting a password

System admins (and org admins for their own federation's users) can send a password reset from the User Manager drawer — click the user's row, then **Send password reset** in the Account section. The user is emailed a single-use reset link, so this only works when email is configured on the server. The user's existing tokens are invalidated once they complete the reset.

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

A foreign diver's dive at your meet:
- ☑ Counts toward **their** personal bests (their profile reflects it).
- ☑ Counts toward **their home federation's** national book (not yours) — `lib/records.js` keys national records off `users.org_id`, so this just works.
- ☑ Counts toward their own club's and state's books, and their continent's if their federation has one.
- ✗ Does NOT pollute your federation's record books with foreign holders.

### What stays host-only

- Meet manager / referee / score correction permissions — visiting federations don't get these.
- The audit log perimeter — only your org admins / event managers can read it.

### Foreign judges + international panels

When you assign judges via Assign Judges, the picker now pulls from every participating federation, not just yours. Each judge tile shows a country chip (e.g. **NZL**) so you can build a balanced international panel — typically 2 judges per country plus the referee. The save endpoint validates that every judge belongs to either your host org or one of the participating federations; if a judge somehow isn't on either, the save 400s with a pointer to add their federation first.

### Notifications

When you click **Invite** in the Federations modal, every org_admin in the invited federation receives an in-app banner + push notification (if they've subscribed). The notification deep-links to their Meet Manager view of the event. Same channel fires when a federation is removed (or self-withdraws), telling the host's admins their roster expectation just changed.

### Country medal table

Once any event in the meet has finalised with ≥2 distinct countries on the standings, the public recap automatically grows an Olympic-style country medal table card alongside the per-diver leaderboard — sorted by gold count, then silver, then bronze. Spectators see who topped the federation count without you doing anything extra.

The table groups by whatever the chips next to each diver show, so it follows the meet's **Divers represent** setting. A national championship set to states gets a state medal table (called a province or home-nation table where that's what the country uses), a club meet gets a club medal table, and the heading says which. Team events count too: each team sits under the state, club or country its divers share.

### Continental records

Each federation has a **continent** field (`africa`, `americas`, `asia`, `europe`, `oceania`, migration 037) — the sysadmin sets this once per federation. Every record-eligible dive by a diver whose home federation is classified is also checked against that continent's book, so a junior setting an Oceania record at a Pacific Junior Champs has a real place to land it. The book is the **Continental** tab on [`/records`](/records), which opens on the chosen country's continent.

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
| Role request | Whoever reviews it: the federation's admins, or in a country with no federation yet, the requester's club or region admins |
| Claim opened, voted on or decided | The club (or region) admins voting, the claimant, and DivingHQ when it has to decide |
| Role decision | The applicant |
| Password changed | The user |
| Password reset link | The user |
| Meet went Live | Every competitor in any event of the meet |
| Results posted | Every competitor in the finalised event |

Without `CF_ACCOUNT_ID` and `CF_EMAIL_TOKEN` configured (Cloudflare Email Sending), all email helpers silently no-op. Registrations + password changes still work; just no email.

### In-app inbox

Beyond email, every push notification and in-app banner is retained in the user's **Inbox** (`/inbox`, bell icon in the header) so a missed phone alert isn't lost. Users filter by category (Action required, Coach & team, Results, Operations), toggle unread-only, and **Mark all read**; each row deep-links to the relevant scoreboard, event, or approval queue.

![The notifications inbox, listing recent notifications with their category and timestamp](/guide-screenshots/inbox.png)

## Common admin pitfalls

- **Promoting a meet manager too late.** Until they have the role, they can't open the Control Room. Promote them at least the day before.
- **Forgetting the referee.** The Sign Off step in the Control Room blocks Start Event without one — no referee, no Live event.
- **Deleting a club mid-meet.** The UI prevents this (members must be reassigned first), but a direct API call could orphan users. Don't.
- **Trying to delete an event with recorded scores.** The server refuses with `409 Refusing to delete: event has N recorded scores`. Cancel or finalise the event instead — the event row is the anchor for its audit trail and result history. (System admins can override with `?force=1` if there's a legitimate reason; the override is recorded in the audit log.)
- **Suspending an org during an active meet.** The org status flip is immediate — judges and the scoreboard would lose access mid-event. Wait for the meet to complete.
