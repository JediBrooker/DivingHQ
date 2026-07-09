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
| Same-org club change | The diver's current org admin |
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

## Multiple roles per user

A user can hold more than one `org_role` at the same time — e.g. a person who's a `meet_manager` for one event and a `judge` on the panel of another. The dashboard merges the tiles they have access to. Org admins (and the system administrator) manage role assignments from the **User Manager** drawer (see [Admin Tasks](/guide/admin-tasks)).
