# FAQ & Troubleshooting

Common questions, error states, and "why is X happening" answers, plus a glossary of terms used elsewhere in the guide.

## Find the right fix

| If the problem is about… | Start here |
|---|---|
| Signing up, confirming your email, signing in | [Getting started](#getting-started) |
| Clubs, regions, federations and claims | [Clubs and federations](#clubs-and-federations) |
| Start Event, Control Room, scoring, judges | [Running a meet](#running-a-meet) |
| Boards, warmups, judge overlaps, delays | [Session scheduler](#session-scheduler) |
| Synchro panels and partners | [Synchro events](#synchro-events) |
| Passwords, two-factor, signing out everywhere | [Authentication](#authentication) |
| Scoreboard, PDFs, performance | [Performance](#performance) |

Can't find it here? Write to [support@divinghq.app](mailto:support@divinghq.app) and a person will answer.

## Getting started

### "I signed up, but I can't sign in yet"

Confirm your email address first. As soon as you sign up we send a "confirm your email" message with a link; click it, then sign in. The link lasts 24 hours.

Nothing arrived? Give it a few minutes and check your spam or junk folder. Then try to sign in anyway: the sign-in page tells you the address isn't confirmed yet and offers **Send a new verification link**.

Roles don't hold up signing in. Everyone starts as a spectator, and the role you asked for (diver, judge, coach, referee) arrives once whoever reviews it approves it: your club admin, your federation, or DivingHQ. Until then you can sign in and look around.

### "I registered a federation and it says it's waiting for approval"

Every federation registration from a listed country opens a **claim** on that country's account. When nobody from your country is on DivingHQ yet, DivingHQ reviews it, so nobody can become a country's governing body just by saying so, and you'll get an email as soon as it's decided. You can sign in meanwhile.

If clubs or state bodies from your country were already on DivingHQ, they vote on it instead. See [Roles & Permissions → Claims](/guide/roles-and-permissions#claims).

### "I just signed up as a federation admin and the dashboard sent me to /setup. What is that?"

The **first-run setup wizard**. A new federation starts with an empty dashboard and no obvious first step, so DivingHQ sends a federation admin with no events and no clubs to a four-step wizard: Welcome → Create your first club → Invite your people (with a registration link to copy) → Build your first event. Every step can be skipped, and the `Skip setup →` link at the top leaves it entirely. It only redirects you once: your browser remembers you've been.

### "My members aren't getting our emails"

Every DivingHQ email comes from the same sender, so ask them to check spam or junk first, and to add the sender to their contacts. Most missing emails are sitting there. A member waiting on a confirmation link can get a fresh one from the sign-in page, and a federation admin can resend it from the member's row in **User Manager**.

Still nothing, or the address was mistyped at sign-up? Write to [support@divinghq.app](mailto:support@divinghq.app) with the address and we'll look into it.

## Clubs and federations

### "Our federation isn't on DivingHQ. Can our club still use it?"

Yes. Clubs can start before their federation. [Create an account](/register), pick your country and choose **+ Create a new club**; in a country with no federation on DivingHQ yet, that makes you the club's admin. You can run your own meets, approve your members and add co-admins from **My club**. See the [Quick Start](/guide/quick-start).

### "I created a club and it says it's waiting for approval"

Your country's federation is on DivingHQ, and it approves new clubs before they go live. It hears about your club once you've confirmed your email. Until then (and until it decides) the club doesn't show in anyone's club list and can't host meets, but you can sign in, follow meets and enter as an individual. You'll get an email when it's decided: approved, usually with you as the club's admin, or not, in which case your account stays and you may be moved into a club that's already on DivingHQ.

### "Who approves my role request?"

It depends on who runs your country on DivingHQ:

- **No federation yet:** your club's admins, on **My club**, or the admins of your club's region. They can approve divers, judges and coaches; referee requests go to DivingHQ. Nobody can approve themselves for anything but diver, so a club admin's own judge or coach request goes to another admin, the region, or DivingHQ. If your club has no admin at all, DivingHQ reviews it.
- **Under a federation:** the federation's admins, in **User Manager**.

Either way you can sign in while you wait. You're a spectator until it's approved.

### "Our federation (or state body) wants to take over. How does that work?"

It registers at [Register your org](/register-org). Because your clubs are already here, that opens a **claim** instead of a second account. The club admins affected are told by email and in the app, and vote on it on **Claims**. Any objection sends it to DivingHQ to decide. Once it's approved the body runs the country or region, and your club keeps all its meets, results, records and members. The full rules are in [Roles & Permissions → Claims](/guide/roles-and-permissions#claims).

### "What changes for our club after a claim is approved?"

Your club admins keep running your club's meets. What moves to the federation (or state body) is the paperwork above the club: approving role requests, appointing club admins, and seeing members across the whole country or region. Nothing you've built is copied or moved. If you think a claim was wrong, write to [support@divinghq.app](mailto:support@divinghq.app).

### "Why does the scoreboard show a club code instead of a country?"

That's the meet's **Divers represent** setting, on the meet's **Edit** dialog in Meet Manager. A club meet usually shows each diver's club, a national championship their state or province, and an international meet their country. It also decides what the medal table groups by. See [Roles & Permissions → Divers represent](/guide/roles-and-permissions#divers-represent).

### "I signed up as a diver, now I want to judge (or coach)"

Open **My Profile** and press **Request a role**. Pick the role, add a note for whoever reviews it if you like, and send. Your federation's admins decide, or where there's no federation on DivingHQ yet, your club's admins (DivingHQ for referee). [Roles & Permissions → Asking for a role](/guide/roles-and-permissions#asking-for-a-role) has the full table.

## Running a meet

### "I can't find the Start Event button"

There isn't a permanently visible one. The Control Room's pre-meet view shows a **readiness checklist** and a single button that offers only the next action you can take. Until every item on the checklist ticks green, that button says something else — `✓ Check In Divers`, `🎲 Randomise Dive Order`, or `📋 Referee Sign Off`. The status chip at the top tells you how many blockers are left, and the **Next:** hint beside it names the one in the way.

Work down the checklist and the button eventually becomes `▶ Start Event`. Clicking it flips the event Live straight away — there's no separate confirmation step, because the checklist has already done that job.

![Control Room before an event starts, with the readiness checklist showing which steps are still outstanding](/guide-screenshots/control-room-premeet-checklist.png)

### "Where did the Finalise Event button go mid-meet?"

It's intentionally hidden during a Live meet that hasn't reached its last dive — having a prominent "Finalise" affordance always visible was misleading at the start of an event. You'll find it in the header `⋯` menu as `✓ Finalise event early…` if you genuinely need to cut a meet short (postponement, equipment failure). Once the last dive of the last round is scored, the prominent header **Finalise Event ✓** button reappears AND the centre-column Next Diver button morphs into `✓ Event Complete — Finalise & View Results`.

### "I can't add a diver — entries closed"

Past `entries_close_at`, divers can't self-submit lists. The meet manager has the **late-entry override** at the top of the Dive Order panel (**+ Add**). It works after entries close.

### "A judge isn't seeing the active diver update"

Check their connection pill (top of the judge view). If it's amber for more than a few seconds, they've lost the socket. Common causes:

- Phone went to sleep — keep the screen on or use the PWA-installed app
- Wifi flake — try mobile data or a different access point
- Two devices logged in for the same judge — one will be kicked, ask them to use only one

If their pill is green but they're not seeing updates, the meet manager can verify the panel assignment is correct (the judge might be on the wrong event).

### "A score landed wrong — how do I fix it?"

In the Control Room, click the dive's history card on the left column. The **Score Correction** modal opens with editable per-judge scores and a required reason field. As you type the new score, a **live preview** shows the impact on the trim sum and dive points (with the WA × 0.6 synchro factor where applicable) — `Trim sum 27.0 → 24.5`, `Dive points 64.80 → 58.80 −6.00`. A note flags when the edit shifts which judge's score gets dropped from the trim. Enter the correct value + reason, click Apply. The change is audit-logged and a success toast confirms the save.

### "An entire round needs to be re-done"

Open the **Adjust ▾** menu next to Prev → click **Re-Dive** (or press **R** without opening the menu). Wipes the current round's scores; the diver redives. The original attempt stays in the audit log with an "amended" marker.

For a whole panel mistake (wrong judges seated, wrong dive code), open the audit log and contact your org admin — bigger corrections need a paper trail.

### "I have 30+ events in Meet Manager — how do I find a specific one?"

A **search box + status filter chips** appear above the events list once your federation has 4+ events:

- The search box matches event name, age group, venue, and the linked meet name.
- The chips (`All / Upcoming / Live / Completed`) filter by status; each chip shows the per-status count.

Filters compose with the existing sysadmin org filter. If the active filters hide everything, the empty state shows a `Clear filters` link.

### "What's the little popup that appears at the bottom of the screen after I do something?"

A **toast notification**. After every async action (import roster, save score correction, add a late entry, finalise an event, …) a short popup appears at the bottom-centre of the screen confirming what happened — green for success, red for errors, cyan for info, amber for warnings. They auto-dismiss after a few seconds; click the ✕ to close immediately, or click `Undo` (when available) to reverse the action.

### "The confirm dialogs look different from a regular browser confirm — why?"

DivingHQ replaced the browser's native `Are you sure?` popup with a styled modal that can spell out what'll actually happen — instead of just "OK / Cancel", you see a list of consequences ("results emails go out to N competitors", "historical scores stay intact"). The confirm button is colour-coded by severity: cyan for routine actions, amber for warnings, red for destructive ones. Esc cancels, Enter confirms.

### "The shot clock is wrong / running too long"

It auto-starts at 30s when a new diver is set. Click the face to pause/resume, click ↻ to reset, or press T. If divers consistently need more time (warm-up between rounds, equipment), the operator can pause manually.

### "Can I stream the scoreboard into OBS / our live broadcast?"

Yes — the scoreboard ships with a built-in chroma-key overlay designed for OBS Studio, Streamlabs, vMix, Restream, Ecamm Live, or any tool that supports a Browser Source. No plugin or extra install.

From the Control Room, open the header `⋯` menu → **📺 Broadcast…** and pick **🎬 Stream to OBS / live-streaming app…**. The panel shows the overlay URL for the current event with a one-click **Copy** button and a 5-step Browser Source recipe (add Browser Source → paste URL @ 1920×1080 → add Chroma Key filter → position → go live). See [Scoreboard → Stream Overlay](/guide/scoreboard#stream-overlay-for-obs--live-streaming-apps) for the full walkthrough including chroma-colour overrides for venues with green-spill lighting.

## Judge Analysis

### "What is the Judge Analysis page?"

**Judge Analysis** (`/judge-analysis`) is a public transparency tool — no account needed. It has two tabs:

- **By Event** — pick any Completed event to see a per-judge ranking matrix: where each diver/pair/team would have placed if every scoring judge had judged like that judge alone. Synchro events are segmented into Exec A / Exec B / Sync. Results can be exported to CSV or PDF.
- **By Judge** — search the public judge directory and open any judge's `/judge-profile` analytics page.

![The Judge Analysis page on its By Event tab, showing the per-judge ranking matrix](/guide-screenshots/judge-analysis.png)

Signed-in users see the page inside the full CRM shell (it is also in the left sidebar under **Judge Analysis**). Logged-out users see a minimal top chrome — the event data and judge profiles are the same either way.

### "Can I link someone directly to a specific event's analysis?"

Yes. The URL updates to `/judge-analysis?event=<id>` when you pick an event — copy and share that URL and it will pre-select the same event for anyone who opens it.

## Club change

### "How do I request a club change?"

Open your **Dive Sheets** page (`/competitor`). The **My club** card at the top shows your current club. Click **Request club change**, pick the new club, add an optional note, and submit. (**Change Club** on **My Profile** does the same.) Your federation admin reviews and approves or rejects the request in **User Manager → Requests**. If your country has no federation on DivingHQ yet, the club you're joining decides: its admins approve it on **My club**.

### "I'm transferring to a club in a different federation — why does it say 'Pending' for so long?"

Cross-federation transfers require three approvals: your current org's admin, the target org's admin, and finally **your own confirmation** (a **Confirm transfer** button appears on the My club card once both admins have signed off). Nothing moves until all three are recorded — that is by design to prevent accidental or unauthorised transfers.

## Session scheduler

### "My schedule has a red conflict"

Red conflicts mean two things cannot happen at the same time. The most common cases are:

- Two events on the same board at the same time
- The same judge assigned to overlapping events
- The same referee assigned to overlapping events
- A synchro event with an invalid panel split

Click the warning, then either move the event, change the board, edit the panel, or add a break between sessions. See [Session Scheduler → Conflict detection](/guide/session-scheduler#conflict-detection).

### "The public meet page is showing old times"

You probably have unpublished schedule changes. Open **Meet Manager → Schedule**, review the draft timeline, and click **Publish**. The public meet page, program export, dashboards, and iCal export read from the published schedule.

Calendar apps may still cache old iCal entries. Treat the public meet page as the source of truth for last-minute changes.

### "An event is running late — should I use Hold or Schedule?"

Use **Hold** inside the Control Room when the current event is paused temporarily: video review, equipment check, referee discussion.

Use **Schedule** when the delay changes the rest of the day: later warmups, another board, lunch, ceremonies, or judge assignments. Update the timeline and publish the change.

### "Why is warmup 45 minutes?"

That is the default starting point for planning. Change it in the scheduler if your venue, federation bulletin, or session type needs a different warmup length.

### "The schedule won't estimate an event finish"

The scheduler needs enough information to estimate duration: rounds, roster size, and event type. If you are still building the event, set a manual duration and refine it once the roster is known.

## Synchro events

### "Why does my synchro event need 7, 9, or 11 judges?"

Synchro panels split into three sub-groups: Exec A (Diver A's execution), Exec B (Diver B's execution), and Sync (synchronisation). DivingHQ supports 7, 9, and 11 judge synchro panels:

| Panel size | Exec A | Exec B | Sync |
|---|---|---|---|
| 7 | 2 judges | 2 judges | 3 judges |
| 9 | 2 judges | 2 judges | 5 judges |
| 11 | 3 judges | 3 judges | 5 judges |

A 5-judge synchro panel doesn't have enough slots for the role split. Use 7, 9, or 11 so judges see the correct role hints and the Control Room can validate the panel before going Live.

### "Synchro pair from two countries — only one country chip showing"

The scoreboard shows a second chip only when the partner represents something different from the lead. If both divers represent the same country (or state, or club, depending on the meet's **Divers represent** setting), only one chip renders, since the second would be a duplicate. If they really come from different places, check each diver's club and country on their profile: what a diver represents is taken from their account at the moment they're entered in the event.

## Records

### "An old record didn't update — my new score was higher"

Records are checked once, the moment the last judge's score for a dive lands (from a judge's phone or through manual entry). Nothing re-checks them at finalise. If a book on [`/records`](/records) didn't move:

- Was the dive points total actually higher? An equal score doesn't take a record; the first to reach it keeps it.
- Is it the same dive, position and board height? A 105B from 3 m and a 105C from 3 m are separate records.
- Are you looking at the right book? Books are split into Women's and Men's, and the toggle sits above the table.
- Was it an individual event? Synchro and team dives never set records, and neither do rehearsal events or scores typed into an event that was still Upcoming.
- Was it a Mixed event? Then the dive goes in the book the diver's profile gender says, and a profile with no gender sets nothing.
- Did every judge on the panel score it? A dive only counts once the whole panel is in.

A score correction afterwards doesn't re-check records either way. If a book really is wrong, the system admin can [rebuild it from the scores](/guide/admin-tasks#rebuilding-the-record-books).

### "The record book says Unofficial"

The country (or state) hasn't been claimed on DivingHQ by its governing body yet, so nobody has vouched for its books. The marks are real results from real meets and they become official as soon as a claim is approved; the note links to the claim flow.

## Authentication

### "I forgot my password"

Click **Reset it** on the sign-in page and enter the email address on your account. You'll get a single-use link valid for 30 minutes. Use it from any device.

### "The reset link doesn't work / says 'expired'"

The link is single-use AND time-limited. Causes of failure:

- 30 minutes have passed → request a new link
- Someone else (or you, on another device) already used the link → request a new one
- Your password was changed via another path between request and click → request a new one (the bcrypt fingerprint guard kicks in)

### "I need to log out everywhere"

Change your password from your profile (**Change Password**). Every existing session for your user becomes invalid (token version is bumped server-side); every session is forced to re-login.

The system admin can also force a logout for any user from User Manager — useful if a phone is lost.

### "How do I turn on two-factor authentication?"

Open your profile and click **🔐 Two-Factor Auth**. Scan the QR code with an authenticator app (1Password, Authy, Google Authenticator and the like), type in the 6-digit code it shows, and save the recovery codes somewhere safe. From then on sign-in asks for a code after your password. If you lose your phone, a recovery code gets you in once; each works a single time.

## Performance

### "The scoreboard feels sluggish"

The scoreboard is PWA-installable — install it for faster reloads, service-worker caching, and offline resilience. On iOS / Android Chrome, look for "Add to Home Screen" / "Install".

If install isn't available and the live broadcast is consistently slow, check:

- Your network — websockets need stable bandwidth, not just throughput
- The number of events open simultaneously — each subscribes to its own room, ten tabs is heavy
- Browser memory — Safari especially throttles backgrounded tabs aggressively

### "My dive list submission keeps timing out"

Per-round DD validation runs server-side. If the validation hits a slow path (e.g. recomputing every dive's points across 10 rounds), it can hit the 30s default timeout. Solutions:

- Submit fewer rounds at a time (the form doesn't enforce all-or-nothing)
- For very long lists (12+ rounds), the meet manager has a CSV import that's much faster

### "PDF export taking forever"

The bigger PDFs (meet program with 80 events, results PDF for a 200-diver meet) can take 5 – 10 seconds. The download starts only when the server has finished generating; if your browser shows nothing happening, give it a minute. If it's truly stuck, check `/api/health` to see if the server is up.

## Glossary

### DD (Degree of Difficulty)

A multiplier specific to each dive at each board height. Higher DD = harder dive. From the dive directory — DivingHQ ships with all ~830 World Aquatics dives.

### Trim rule

For panels of 5+, the highest and lowest scores are dropped before summing. For 9+, the top 2 and bottom 2 are dropped. For 11, top 3 and bottom 3. This is the World Aquatics rule — it limits a single rogue judge's influence on a dive's points.

### Synchro sub-panels

The 7, 9, or 11 judge panel splits into three groups: Exec A (judges scoring Diver A's execution), Exec B (judges scoring Diver B's execution), and Sync (judges scoring how well the pair stayed together). See [Setting Up a Meet](/guide/setting-up-a-meet).

### Session scheduler

The meet-level plan for boards, warmups, event starts, breaks, ceremonies, officials, and delays. It is separate from event status: the schedule says when something should happen; the Control Room flips an event from Upcoming to Live when it actually starts.

### Per-round DD limit

A cap on the maximum DD a diver can pick for round N. Common in junior events to prevent unsafe-for-age dives. Set per event in the Create Event form.

### Personal Best (PB)

Your highest dive points on a specific `(dive_code, position, board_height)` combination, from individual events. Kept automatically as scores land and shown on your profile; the public record books at `/records` hold club, state, national and continental records instead.

### Catch-up math

The cyan-tinted block on the live scoreboard that tells the audience what the active diver needs from the panel to overtake the leaders. Rounded up to the next 0.5 because judges only score in halves. See [Scoreboard](/guide/scoreboard).

### World Aquatics category

The colour-coded score buckets the audience sees on per-judge tiles:

| Score | Category |
|---|---|
| 10.0 | Excellent |
| 8.5 – 9.5 | Very good |
| 7.0 – 8.0 | Good |
| 5.0 – 6.5 | Satisfactory |
| 2.5 – 4.5 | Deficient |
| 0.5 – 2.0 | Unsatisfactory |
| 0.0 | Failed |

The boundaries match the official WA judging guidelines so the colour treatment matches what an experienced spectator expects.

### Token version

A small integer on each user's record. The current value is signed into every JWT. When the user changes their password or an admin grants/revokes a role, the version increments — every existing token becomes invalid the next request, forcing re-login. The "log them out everywhere" hammer.

### Audit log

A row inserted on every score change (insert / update / delete) and every role change (grant / revoke). Captures the actor, IP, user agent, old + new value, and a reason field. 30-day retention by default. See [Admin Tasks](/guide/admin-tasks).

### Event status

`Upcoming` (lists open), `Live` (judges scoring), `Completed` (recap published). The meet manager flips status; the rest of the app reacts.

### Sign-off (referee)

A pre-meet step where the licensed referee authorises the panel. Required before the event can flip to Live. Either a password or an approved push notification on the referee's phone — both write the same audit row.
