# Roles & Permissions

Everyone on DivingHQ has an account in their country's organisation, and one or more roles in it. On top of those roles sit the admins of a club, a region (a state, province or home nation) and the federation, each running their own level and the ones beneath it, never sideways. The dashboard is **role-aware**: every user sees only the tiles relevant to what they can actually do.

| Role | Scope | Primary view | What they care about |
|---|---|---|---|
| System administrator | All of DivingHQ | Admin console + audit logs | Run the platform; decide claims |
| Federation admin (org admin) | One country | User Manager + Meet Manager | The country's clubs, roles and records |
| Region admin | One state, province or home nation | My region + Meet Manager | The region's championships and clubs |
| Club admin | One club | My club + Meet Manager | The club's meets and members |
| Meet manager | Events they manage | Manager + Control | Run the meet on the day |
| Referee | Per event | Scoreboard + audit log | Defend panel integrity, authorise score edits |
| Judge | Per event | Judge view (phone) | Score dives over the socket |
| Coach | Linked divers | Diver Profile + Compare | Track diver form, manage templates |
| Diver | Self | Competitor view | Submit lists, watch own results |
| Spectator | Public | Scoreboard | Zero-friction live spectating |

Role-awareness in practice: the federation admin below gets an admin section in the sidebar and a row of role filter tabs. A diver signing in to the same country sees neither: their dashboard opens on their own next dive and results.

![Org admin dashboard with role filter tabs, live and upcoming counts, and a "what needs your attention" list](/guide-screenshots/dashboard.png)

## Countries, regions and clubs

A country's account on DivingHQ is in one of two states, and it changes who does what.

- **Started by its clubs (no federation yet).** Clubs can join before their federation does. Each club is run by its **club admins**: the person who created it, plus any co-admins they add. They run their own meets and approve their own members. Anything that needs someone above the club goes to DivingHQ.
- **Run by its federation.** Once the national federation is on DivingHQ (it registered first, or its [claim](#claims) was approved), its **federation admins** manage the country: they approve role requests, appoint club and region admins, and can run any meet. Club and region admins keep running their own meets.

Countries with states, provinces or home nations (Australia, Canada and the UK so far) also have **regions**. A club says which region it's in, and a **region admin** looks after every club in it.

The full breakdown is below. Pick the section that matches you.

## System administrator

DivingHQ's own operators, the only people who see across every country. On divinghq.app that's the DivingHQ team; write to [support@divinghq.app](mailto:support@divinghq.app) when you need one. (Running your own copy? The README's self-hosting notes cover setting one up.)

**Can:**
- Approve or reject new federation registrations
- Decide [claims](#claims) that go to DivingHQ, and revoke an approved one
- Approve role requests and club changes that have nobody else to review them
- Read the score audit log and role audit log across every organisation
- See and edit every event in every organisation
- Reset passwords and unlock accounts for any user
- Tune the claim-vote rules and switch features on and off

## Federation admin (org admin)

Top of the food chain inside one country, the person whose name is on the records book. They don't usually run meets themselves but they decide who does: promoting meet managers, certifying judges, appointing club and region admins, approving coach-diver links.

**Can:**
- Create events and meets
- Promote, demote, and remove org roles within their federation
- Approve or reject coach⇄diver linking requests
- Edit or delete any event in their org
- Set `entries_close_at` on events to enforce registration deadlines
- Claim the country's account so its national record book reads as official (records themselves are automatic, there's nothing to sign off)
- Manage clubs and teams within the federation, and appoint each club's and region's admins from **Clubs**
- Approve or reject the clubs people start when they sign up in the country, or let new clubs join automatically (**Clubs**)
- Approve role requests from every member in the country
- Decide a state body's claim on one of its regions

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

A diver requests a club change from the "My club" card on their own profile. The request lands in **User Manager → Requests tab** for the org admin to action. In a country with no federation on DivingHQ yet, DivingHQ reviews it.

| Request type | Who must approve |
|---|---|
| Same-org club change | The diver's current org admin. Where the country has no federation on DivingHQ yet, an admin of the club being joined (or of its region) on **My club** / **My region** |
| Cross-org transfer | Source-org admin **+** target-org admin **+** the diver's own confirmation (3-way handshake) |

For cross-org transfers the Requests tab shows which of the three approvals have been received (Source / Target / Diver). The transfer only completes when all three are in. Everything is audit-logged.

## Club admin

Runs one club. In a country whose federation isn't on DivingHQ yet, a club admin is the person who created the club, plus the co-admins they add on **My club**. Under a federation, the federation appoints club admins. A club someone creates at signup there waits for the federation to approve it first, and approving it normally makes the founder its admin.

**Can:**
- Create meets hosted by their club and run them end to end: events, entries, judging panels, the schedule and the Control Room
- Where there's no federation yet, approve their members' requests to dive, judge or coach on **My club** (under a federation, its admins review them). Referee requests go to DivingHQ where the country has no federation yet, since a referee can act at any club's meet in the country. Nobody approves their own request for anything but diver: that goes to another admin, the region, or DivingHQ
- Add and remove co-admins, and say which region the club is in (while the country has no federation; under one, the federation does both)
- Vote on a [claim](#claims) when a federation or state body applies to take over

Club admins see their own members' names, usernames and role requests, not the rest of the country.

## Region admin

Looks after a state, province or home nation. The federation appoints region admins from **Clubs**; where there's no federation yet, DivingHQ does. A state body can also apply to run its region from [Register your org](/register-org), which opens a [claim](#claims).

**Can:**
- See every club in the region and who runs it, on **My region**
- Create the region's championships in Meet Manager, hosted by the region, and step in on any of its clubs' meets
- Where there's no federation yet, approve role requests from members of the region's clubs (under a federation, its admins review them)
- Vote on a national claim, once the region itself is claimed

## Claims

A claim is how a federation or state body takes over a country or region that its clubs started on DivingHQ. Nothing is copied or moved: the body gets the admin seat on the account the clubs are already in, and every meet, result, record and member stays where it is.

1. **Apply.** The body registers at [Register your org](/register-org) and picks its country, and its region for a state body. If clubs from there are already on DivingHQ, that opens a claim rather than a second account.
2. **Confirm the email.** Nothing happens, and nobody is told, until the applicant confirms their email address. An unconfirmed claim is withdrawn after a week.
3. **Vote.** The club admins affected are notified by email and in the app, with the body's name, its website, and whether the applicant's email is on that website's domain. They vote on **Claims**. For a national claim, the regions whose state bodies are already on DivingHQ vote instead, if there are enough of them.
   - Enough approvals passes it straight away: by default, more than half the eligible voters and at least two.
   - Any objection sends it to DivingHQ, with the reason given.
   - When the voting window closes (two weeks by default) without reaching that bar, it goes to DivingHQ. A claim never passes on the clock alone.
   - If there aren't enough eligible voters to begin with, DivingHQ decides. By default a club gets a vote once it has an admin, has been on DivingHQ for a month, and has hosted a meet or has at least five members with confirmed emails.
   - A state body's claim in a country whose federation already runs DivingHQ is the federation's call.
4. **Approved.** The applicant becomes the federation admin (or region admin), and the clubs are told who now runs it. From then on role requests go to them, and they appoint club and region admins. Club admins keep running their own club's meets.

DivingHQ can **revoke** an approved claim, for example if a body turns out not to be who it said it was. The country or region goes back to being run by its clubs, and the admin seat the claim gave is removed. If you think a claim affecting your club is wrong, object with a reason, or write to [support@divinghq.app](mailto:support@divinghq.app).

## Divers represent

Each meet decides what the chip next to a diver's name shows on the scoreboard, results and PDFs, and what the medal table groups by. Set it on the meet's **Edit** dialog in Meet Manager, under **Divers represent**:

| Setting | Shows | Use it for |
|---|---|---|
| Their country | `AUS`, `CAN` | International meets |
| Their state / province | `NSW`, `QC` | National championships |
| Their club | The club's short code | Club and inter-club meets |

A diver without a state or club code falls back to their country. What a diver represents is taken when they enter, so a later club move doesn't rewrite an old meet's results.

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
- Browse the record books at `/records` (national, state, club, continental) and each diver's personal bests on their profile
- Browse the Results Archive of completed meets

**Cannot:**
- See anyone's dive list before the event goes Live (locked to authenticated users)
- Submit anything

## Club and region admins (no federation yet)

In a country whose federation isn't on DivingHQ yet, the clubs run themselves. Whoever founds a club is its first **club admin**; a state, province or home nation can have **region admins** above its clubs (appointed by DivingHQ, or a state body whose claim on the region passed). Both run the meets their club or region hosts from Meet Manager and the Control Room. On **My club** and **My region** they:

- Approve their members' role requests for **diver, judge and coach**. Referee requests go to DivingHQ instead: a referee can act at any club's meet in the country, so no single club hands that out. Nobody approves their own request for anything but diver.
- Approve **join requests**. People who pick your club when they sign up (or use your invite link) join it straight away, and their role requests come to you as usual. Anyone already on DivingHQ who wants to move in asks with **Change Club** on their profile, and the club's admins (or its region's) say yes or no. Nobody approves their own.
- Add and remove **co-admins** from their own members. A club or region always keeps at least one live admin: deleted or suspended accounts don't count, and two admins removing each other at the same moment can't leave it with none. A region whose admins have all gone can be claimed again.
- Pick the club's **region**. Between regions nobody has claimed, that's the club's call. A region its state body has claimed decides which clubs it takes: the club's admin asks, the region's admin accepts or declines on **My region**, and only the region can take a club back out. If a claimed region's admins have all gone, it has no say until someone claims it again.

Once the federation arrives and its claim passes, all of this goes back to the org admin.

## Multiple roles per user

A user can hold more than one role at the same time, e.g. a person who's a `meet_manager` for one event and a `judge` on the panel of another, or a club admin who also dives. The dashboard merges the tiles they have access to. Federation admins (and the system administrator) manage role assignments from the **User Manager** drawer (see [Admin Tasks](/guide/admin-tasks)); club and region admins approve their members' requests on **My club** and **My region**.

## Asking for a role

Everyone starts as a spectator. You can ask for a role when you sign up (diver, coach, judge, referee, or meet manager under a federation), and any time after that from your own profile: open **My Profile** and press **Request a role**. The dialog lists what you can still ask for, what you already hold, and how your earlier requests went.

Who says yes depends on where you are:

| Your country | Diver, judge, coach | Referee | Meet manager |
|---|---|---|---|
| Has a federation on DivingHQ | The org admins | The org admins | The org admins |
| No federation yet (clubs run themselves) | Your club's admins, or its region's if the club has none | DivingHQ | Not requestable: clubs appoint a manager per meet |

A referee can act at any club's meet in the country, which is why a club can't hand it out. Nobody approves their own request for anything but diver, so a club founder asking to coach goes to the region or to DivingHQ. If you're not in a club yet, DivingHQ reviews it; ask to join a club first (Change Club on your profile) if you'd rather your club decided.

You get an email when it's decided. One open request per role at a time, and if a request is turned down you can ask again the next day.
