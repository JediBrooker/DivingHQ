# FAQ & Troubleshooting

Common questions, error states, and "why is X happening" answers, plus a glossary of terms used elsewhere in the wiki.

## Find the right fix

| If the problem is about… | Start here |
|---|---|
| Login, registration, email, setup wizard | [Setup](#setup) |
| Start Event, Control Room, scoring, judges | [Running a meet](#running-a-meet) |
| Boards, warmups, judge overlaps, delays | [Session scheduler](#session-scheduler) |
| Synchro panels and partners | [Synchro events](#synchro-events) |
| Scoreboard, PDFs, performance | [Performance](#performance) |

## Setup

### "I just registered my federation, but I can't sign in"

New federations land in `pending` status. The system administrator (the person running the DivingHQ server) needs to approve it. If you self-host, the bootstrap `admin` account can approve from User Manager → org filter → status = pending.

### "Where do I get the system admin account?"

`init.sql` creates one on first install: username `admin`, password `admin`. **Change the password immediately** from User Manager. If you've lost it, a sysadmin with database access can reset:

```sql
UPDATE users
SET password = crypt('new-password', gen_salt('bf'))
WHERE username = 'admin';
```

### "I just signed up as an org admin and the dashboard sent me to /setup — what is that?"

The **first-run setup wizard**. New federations land on a dashboard with empty everything and no obvious starting point, so DivingHQ auto-redirects fresh org admins (zero events AND zero clubs) to a four-step wizard: Welcome → Create your first club → Invite your people (with a copy-able registration link) → Build your first event. Each step is skip-able; the top-right `Skip setup →` link bails out entirely. The redirect doesn't fire on subsequent visits — a localStorage stamp remembers you've been there.

If you got redirected to `/setup` and you'd rather not deal with it right now, click `Skip setup →`. You won't be redirected again.

### "Email isn't sending — registration didn't get a welcome message"

Without `SMTP_HOST` set in `.env`, the email helpers silently no-op. Configure SMTP if you want welcomes / password resets / meet notifications:

```
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="DivingHQ <noreply@your-domain>"
```

`APP_BASE_URL` also needs to be set so reset-password links point at the right host.

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

Open your **Dive Sheets** page (`/competitor`). The **My club** card at the top shows your current club. Click **Request club change**, pick the new club, add an optional note, and submit. Your org admin reviews and approves or rejects the request in **User Manager → Requests**.

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

The composable shows a second chip only when the partner's country differs from the lead's. If both divers are flagged the same country in your DB, only one chip renders (intentional — it'd be a duplicate). Check the partner's account — their `country_code` (org-level) should differ.

## Records

### "An old record didn't update — my new score was higher"

`checkAndApplyRecords` runs on every score insert AND on event finalise. Both paths compare against the current record. If neither updated:

- Was the score actually higher than the existing record? Check the records page for the current value.
- Was the dive at the same `(dive_code, position, board_height)`? Records are keyed on all three.
- Did the event's height match the records page? A 3 m record only updates from 3 m dives.

If all three check out and it's still wrong, the system admin can re-run the records check via SQL — contact them.

## Authentication

### "I forgot my password"

Click **Reset it** on the login page. Enter your username + email; you'll get a single-use link valid for 30 minutes. Use it from any device.

### "The reset link doesn't work / says 'expired'"

The link is single-use AND time-limited. Causes of failure:

- 30 minutes have passed → request a new link
- Someone else (or you, on another device) already used the link → request a new one
- Your password was changed via another path between request and click → request a new one (the bcrypt fingerprint guard kicks in)

### "I need to log out everywhere"

Change your password from your account settings. Every existing JWT for your user becomes invalid (token version is bumped server-side); every session is forced to re-login.

The system admin can also force a logout for any user from User Manager — useful if a phone is lost.

### "Two-factor authentication?"

DivingHQ doesn't currently support TOTP/2FA. Org admins can mitigate with strong passwords and the email-verified gate (a new account can't log in until the email is verified). 2FA is planned for a future release.

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

Your highest dive points on a specific `(dive_code, position, board_height)` combination. Auto-set on score insert via `checkAndApplyRecords`.

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
