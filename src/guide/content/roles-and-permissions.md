# Roles & Permissions

DivingHQ has eight role personas — seven `org_role` values plus a separate platform-level `is_system_admin` flag. Each role unlocks a different set of screens and actions. The dashboard is **role-aware**: every user sees only the tiles relevant to what they can actually do.

| Role | Tenancy | Primary view | What they care about |
|---|---|---|---|
| System administrator | Cross-org | Admin console + audit logs | Run the platform across every federation |
| Org admin | One federation | Manager view | Federation integrity: events, roles, records |
| Meet manager | Events they manage | Manager + Control | Run the meet on the day |
| Referee | Per event | Scoreboard + audit log | Defend panel integrity, authorise score edits |
| Judge | Per event | Judge view (phone) | Score dives over the socket |
| Coach | Linked divers | Diver Profile + Compare | Track diver form, manage templates |
| Diver | Self | Competitor view | Submit lists, watch own results |
| Spectator | Public | Scoreboard | Zero-friction live spectating |

Role-awareness in practice: the org admin below gets a Federation section in the sidebar and a row of role filter tabs. A diver signing in to the same federation sees neither — their dashboard opens on their own next dive and results.

![Org admin dashboard with role filter tabs, live and upcoming counts, and a "what needs your attention" list](/guide-screenshots/dashboard.png)

The full breakdown is below — pick the section that matches you.

## System administrator

The platform operator. Runs DivingHQ as a multi-tenant SaaS — the only person who sees across every federation. Set with a SQL `UPDATE` rather than a UI control, because the flag is powerful:

```sql
UPDATE users SET is_system_admin = true WHERE username = 'your_username';
```

Sign out and back in for the change to take effect — the JWT carries the flag. The bootstrap `admin` user (created by `init.sql`) already has it.

**Can:**
- Approve or reject new federation sign-ups (federations land in `pending` until then)
- Read the score audit log and role audit log across every org
- See every event in every org (no org filter)
- Override the org filter on read endpoints (edit any event regardless of `org_id`)
- Reset passwords and unlock accounts for any user
- Run database migrations and inspect `schema_meta` to confirm the deployed version

## Org admin

Top of the food chain inside one federation — the person whose name is on the records book. They don't usually run meets themselves but they decide who does: promoting meet managers, certifying judges, approving coach-diver links.

**Can:**
- Create events and meets
- Promote, demote, and remove org roles within their federation
- Approve or reject coach⇄diver linking requests
- Edit or delete any event in their org
- Set `entries_close_at` on events to enforce registration deadlines
- Sign off federation records
- Manage clubs and teams within the federation

### User Manager — per-user drawer

Clicking any row in User Manager slides out this drawer. It's where roles are actually granted and revoked, so it's the screen to know if you administer a federation.

![User Manager with a member's drawer open, showing their details, account lifecycle actions, and editable role pills](/guide-screenshots/user-manager-drawer.png)

From **User Manager** (`/users`), an org admin can open any member's drawer and:

- **Edit personal & competition details** — full name, date of birth, gender, nationality
- **Manage account lifecycle**:
  - **Suspend** — blocks the user at login until reactivated
  - **Reactivate** — lifts a suspension
  - **Resend email verification** — re-sends the verification link (useful for users who never confirmed their address)
  - **Send password reset** — emails a reset link
- **Edit org roles** — add or remove role pills (the full set: org admin, meet manager, referee, judge, coach, diver, spectator)

All role changes are written to the role audit log.

### Club-change and cross-org transfer requests

A diver requests a club change from the "My club" card on their own profile. The request lands in **User Manager → Requests tab** for the org admin to action.

| Request type | Who must approve |
|---|---|
| Same-org club change | The diver's current org admin. Where the country has no federation on DivingHQ yet, an admin of the club being joined (or of its region) on **My club** / **My region** |
| Cross-org transfer | Source-org admin **+** target-org admin **+** the diver's own confirmation (3-way handshake) |

For cross-org transfers the Requests tab shows which of the three approvals have been received (Source / Target / Diver). The transfer only completes when all three are in. Everything is audit-logged.

## Meet manager

The person actually running the meet on the day. Lives in the Control Room view for those eight hours.

**Can:**
- Schedule events (`scheduled_at`) and set the registration deadline (`entries_close_at`)
- Build the day timeline in the [Session Scheduler](/guide/session-scheduler): boards, warmups, event starts, breaks, ceremonies, conflict warnings, live re-flow on event completion, and duplicate-to-next-day
- Import a roster from CSV
- Lock the dive order, drag-reorder pre-meet, or randomise starts
- Drive the Control Room during the meet — advance divers round by round
- Flip event status: Upcoming → Live → Completed
- Add a late-arriving diver via the late-entry override (works after entries close)
- Edit a team's bulk dive list
- Withdraw or scratch divers mid-event

See [Running a Meet](/guide/running-a-meet) for the operator playbook.

## Referee

The licensed official on deck. Doesn't score dives themselves — supervises the panel that does. Confirms the panel is valid pre-meet (the **yellow Sign Off** step in the Control Room workflow), watches the scoreboard for anomalies, and adjudicates when a coach challenges a score.

**Can:**
- View the live scoreboard for any event they're assigned to
- Read the per-event score audit log to see who entered or changed each score
- Authorise a score correction (the audit row records them as the actor)
- Confirm synchro panels have valid Exec A / Exec B / Sync subgroups (7, 9, or 11 judges)
- Edit the [Session Scheduler](/guide/session-scheduler) — same write access as a meet manager

The Sign Off step accepts either a **password** or an **approved push notification** on the referee's phone — both write the same row to the audit log.

## Judge

Part-time scoring staff who work meet by meet. Usually on a phone in landscape mode.

**Can:**
- Log into the judge view on phone for any event they're assigned to
- See the current diver, their dive code, position, and DD as it changes round by round
- Tap a half-point score (0.0 → 10.0)
- Submit the score over the socket (rate-limited per-judge to prevent double-taps)
- See their own submitted score reflected immediately

See [Judging](/guide/judging) for the full UX.

## Coach

Works closely with individual diver data. Spots trends across meets, compares two divers head-to-head, and saves dive-list templates so a 3 m optionals list isn't retyped every weekend.

**Can:**
- Request to be linked to a diver via `coach_diver_links` (subject to org admin approval)
- View each linked diver's full profile: recent form, judges' individual scores, PBs by board height
- Compare two divers head-to-head in the Compare view
- Save and re-use dive-list templates, scoped per board height
- See historical scores at the dive-code-and-position level (e.g. their last ten 105Bs)

## Diver

Phone-native and impatient. The night before each meet they submit their list; during the meet they watch their own scoreboard between rounds and review judges' scores after each round to calibrate against the panel.

**Can:**
- Submit a dive list for an event — only while the event is Upcoming **and** `entries_close_at` hasn't passed
- Save the current list as a named template, scoped to the event's board height
- Load a saved template and tweak before submitting
- Pick a synchro partner via the autocomplete (filters fellow divers in the org)
- Watch the live scoreboard for any event they're in
- Review own profile: recent form, individual judges' scores, PBs by board height

See [Diver Portal](/guide/diver-portal).

## Spectator

Friends, family, sponsors. Often anonymous — no account, no token. Frequently watching from a phone on patchy 4G.

**Can (without logging in):**
- Open any public scoreboard URL
- Watch scores update live over the socket as judges submit
- See only events in Live or Completed status
- See published records (personal, club, federation)
- Browse the Results Archive of completed meets

**Cannot:**
- See anyone's dive list before the event goes Live (locked to authenticated users)
- Submit anything

## Club and region admins (no federation yet)

In a country whose federation isn't on DivingHQ yet, the clubs run themselves. Whoever founds a club is its first **club admin**; a state, province or home nation can have **region admins** above its clubs (appointed by DivingHQ, or a state body whose claim on the region passed). Both run the meets their club or region hosts from Meet Manager and the Control Room. On **My club** and **My region** they:

- Approve their members' role requests for **diver, judge and coach**. Referee requests go to DivingHQ instead: a referee can act at any club's meet in the country, so no single club hands that out. Nobody approves their own request for anything but diver.
- Approve **join requests**. Nobody lands in a club without asking: the person picks the club under **Change Club** on their profile, and the club's admins (or its region's) say yes or no. Nobody approves their own.
- Add and remove **co-admins** from their own members. A club or region always keeps at least one live admin: deleted or suspended accounts don't count, and two admins removing each other at the same moment can't leave it with none. A region whose admins have all gone can be claimed again.
- Pick the club's **region**. Between regions nobody has claimed, that's the club's call. A region its state body has claimed decides which clubs it takes: the club's admin asks, the region's admin accepts or declines on **My region**, and only the region can take a club back out. If a claimed region's admins have all gone, it has no say until someone claims it again.

Once the federation arrives and its claim passes, all of this goes back to the org admin.

## Multiple roles per user

A user can hold more than one `org_role` at the same time — e.g. a person who's a `meet_manager` for one event and a `judge` on the panel of another. The dashboard merges the tiles they have access to. Org admins (and the system administrator) manage role assignments from the **User Manager** drawer (see [Admin Tasks](/guide/admin-tasks)).

## Asking for a role

Everyone starts as a spectator. You can ask for a role when you sign up (diver, coach, judge, referee, or meet manager under a federation), and any time after that from your own profile: open **My Profile** and press **Request a role**. The dialog lists what you can still ask for, what you already hold, and how your earlier requests went.

Who says yes depends on where you are:

| Your country | Diver, judge, coach | Referee | Meet manager |
|---|---|---|---|
| Has a federation on DivingHQ | The org admins | The org admins | The org admins |
| No federation yet (clubs run themselves) | Your club's admins, or its region's if the club has none | DivingHQ | Not requestable: clubs appoint a manager per meet |

A referee can act at any club's meet in the country, which is why a club can't hand it out. Nobody approves their own request for anything but diver, so a club founder asking to coach goes to the region or to DivingHQ. If you're not in a club yet, DivingHQ reviews it; ask to join a club first (Change Club on your profile) if you'd rather your club decided.

You get an email when it's decided. One open request per role at a time, and if a request is turned down you can ask again the next day.
