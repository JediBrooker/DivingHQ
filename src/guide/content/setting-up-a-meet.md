# Setting Up a Meet

A "meet" in DivingHQ is a bundle of one or more **events**. The terminology mirrors World Aquatics:

- **Meet** — the calendar fixture (e.g. *"2026 New Zealand Nationals — 10–12 March"*). Has a name, dates, venue, optional sponsor logo, and zero or more events.
- **Event** — a single board-height + gender + format combination (e.g. *"Women 3 m Springboard"*). Has its own roster, panel, rounds, and scoring.

You can run a one-event "meet" by simply not creating a meet record and leaving the event as standalone — the scoreboard and archive both work either way. But for a multi-event championship, bundling them gives you a single landing page and a single printable program.

![Meet Manager](/guide-screenshots/meet-manager.png)

## Setup checklist

Use this page when you are preparing the meet before the competition day.

1. Create the meet bundle.
2. Add event records for each board, gender, age group, and stage.
3. Add rosters or open self-entry.
4. Assign judges and referees.
5. Plan the day in [Session Scheduler](/guide/session-scheduler).
6. Open [Running a Meet](/guide/running-a-meet) when you are ready to drive the live event.

You are ready for meet day when every event has a roster, a complete dive-list status, a seated panel, a referee, a scheduled warmup/start time, and no red schedule conflicts.

## Creating a meet (the bundle)

Go to `/manager` (or click **Meets & events** in the sidebar). The left rail lists your meets. Click **+ New meet** on the rail to open the New Meet modal.

Required:

- **Name** — `2026 NZL National Championships`
- **Start date / End date** — used by the public landing page and notification emails

Optional:

- **Venue / location** — free text
- **Description** — public meet blurb shown on the landing page
- **Sponsor branding** — see below

A meet can stay empty — you'll attach events to it next. The meet's public landing page is at `/meet/<id>`.

## Sponsor branding

A meet supports **multiple sponsor logos** (title sponsor + presenting sponsors + venue / apparel partners) with optional rotation during the live broadcast.

Select a meet on the left rail, then click the **Edit** button in the right-pane detail header. The Edit Meet modal carries:

- **Sponsor name** — plain-text "Powered by" used when no logo has been uploaded
- **Sponsor link** — where the plain-text "Powered by" anchor goes (per-logo links override this)
- **Sponsor logos** — upload as many as you like (PNG / JPEG / WebP / SVG, ≤1 MB each). Each row gets:
   - drag-handle to reorder (the order is what shows in the rotation)
   - alt-text + per-logo link URL
   - trash button to remove
- **Rotation cadence** — slider 0-60 seconds. `0` disables rotation (a single logo shows always); `>0` cycles through the uploaded logos at that interval during the broadcast.

Uploaded images are auto-resized by the server (long edge ≤600 px) so a 4K source logo lands at ~80 KB. SVGs are passed through untouched. Image bytes are stored inline in the database — backups capture them automatically; LAN deployments don't need a separate `uploads/` mount.

The same sponsor manager is reachable from the Control Room's `⋯ → 🎨 Sponsor branding…` menu so the operator can swap a logo mid-meet without leaving the Control Room (e.g. a late-arriving "this session brought to you by Speedo" deal).

Where the logos render:

- **Public meet landing page** (`/meet/<id>`) — inline "Powered by" strip, all logos rendered side-by-side
- **Live scoreboard / kiosk broadcast** (`/scoreboard/<id>` and `/scoreboard/<id>/broadcast`) — small tile in the bottom-right corner, rotating at the cadence you set
- **OBS stream overlay** (`?overlay=1`) — composite-friendly version of the rotating tile, sized to chroma-key cleanly alongside the active-diver block
- Recap layouts are intentionally **not** branded — sponsorship on a results page reads as gauche

Pre-migration meets that carried a single external `sponsor_logo_url` keep rendering via a legacy fallback path; upload a new logo from the Edit Meet modal to replace it.

## Creating events

In the right pane, click **+ New event** (or **+ Add event** when a specific meet is selected on the rail) to open the New Event modal. The form has the following fields:

![New Event modal](/guide-screenshots/new-event-modal.png)

### Required

- **Event Name** — *"Women 3 m Springboard — Final"*. Shown in the scoreboard header and the printable program.
- **Event Type** — see *Event types* below.
- **Gender** — Male / Female / Mixed. Used in filters and headings.
- **Age Group / Division** — structured dropdown that shows the WA Group letter alongside its age band, so the operator picks once and the mapping is visible. Composed into a canonical string in `events.age_group`:
  - **Age Group (WA Article 13)**:
    - **Group D — 11 and under** *(extends WA scheme down per common national-federation usage)*
    - **Group C — 12/13** *(WA Article 13.3.1)*
    - **Group B — 14/15** *(WA Article 13.2.1)*
    - **Group A — 16-18** *(WA Article 13.2.2)*
    - **Masters** *(with extra input for the range, e.g. "30-34", "M40+", "70+")*
  - **Open**
  - **Other** *(free text — escape hatch for federation-specific labels like "Para Class S1")*

  Stored format is the canonical short form: *Junior Group A* / *Junior Group B* / *Junior Group C* / *Junior Group D* / *Open* / *Masters 30-34* / etc. Existing events with the older numeric strings (*11 and under*, *14/15* etc.) auto-decompose to the matching WA Group when re-opened in the Edit Event modal.
- **Board / Platform Height** — 1 m, 3 m, 5 m, 7.5 m, 10 m. Filters the dive directory so divers can't pick a 5132D off the 1 m springboard.
- **Judge Panel Size** — 5 / 7 / 9 / 11. Synchro events use **7, 9, or 11** so the judges can be split into Exec A / Exec B / Sync sub-panels. The number of rounds the panel scores does **not** depend on this — every round goes through the same panel.
- **Round dives** — at least one row. Each row is one round; click **+ Add Dive** for each round. Pin a specific dive to a row (operator-prescribed: every diver must submit that dive in that round) or leave it blank (diver picks freely). For mixed-board events, each row also gets a per-slot height selector. See [Operator-prescribed round dives](#operator-prescribed-round-dives) below for the full flow.
- **Round structure** — sits directly under Round dives so the operator's flow reads "pick the rounds, then group them". Same editor described in [Round-structure rules](#round-structure-rules).

### Optional

- **Meet** — drop-down listing your federation's meets. Pick one to bundle this event into a meet. Leave as "Standalone (no meet)" for one-off events.
- **Mixed-board event** — check if a single event mixes platform heights (rare but supported, e.g. a "Skills Trial" with one round each at 1 m / 3 m / 5 m). Each diver-round row gets its own height.
- **Per-round DD limits** — common in junior events. Cap rounds 1 – N to a max DD (e.g. "rounds 1 and 2 capped to DD 2.0"). Diver-side validation refuses lists that exceed the caps.
- **Round structure rules** — for bulletins like Diving NSW's *"4 dives @ 7.6 + 4 dives unlimited"*, see [Round-structure rules](#round-structure-rules) below.
- **Scheduled start time** — feeds the meet schedule view, public program, dashboards, iCal export, and the "Meet went Live" email notifications. Use [Session Scheduler](/guide/session-scheduler) for multi-event days.
- **Entries close at** — registration deadline. Past this point divers can't submit lists themselves; the meet manager has to use the **late-entry** override.

### Event types

| Type | Panel | Notes |
|---|---|---|
| **Individual** | 5 / 7 / 9 / 11 | Standard event. Each diver dives once per round. |
| **Synchro Pair** | 7 / 9 / 11 | Exec A / Exec B / Sync sub-panels (see below). Two divers per entry. |
| **Team** | 5 / 7 / 9 / 11 | World Aquatics Team Event — multiple members per team, mix of individual and synchro dives across rounds. |

#### Synchro panels

Synchro judges split into three sub-panels:

| Panel size | Exec A (Diver A's execution) | Exec B (Diver B's execution) | Sync (synchronisation) |
|---|---|---|---|
| 7 | Judges 1 – 2 | Judges 3 – 4 | Judges 5 – 7 |
| 9 | Judges 1 – 2 | Judges 3 – 4 | Judges 5 – 9 |
| 11 | Judges 1 – 3 | Judges 4 – 6 | Judges 7 – 11 |

Judges see their assigned role (Exec A / Exec B / Sync) on the JudgeView so they know which slot they're filling. The Control Room and scoreboard display the three sub-panel groups visually.

DD multipliers are applied per the WA rule: synchro dive points = `(trimmed sum) × DD × 0.6`, normalised across panel sizes so dives stay comparable.

#### Scheduling the day

Once the event exists, add it to the meet timeline from the **Schedule** tab. The scheduler lets you place each event on a board, keep warmups visible, add breaks or ceremonies, and catch judge/referee conflicts before publishing the public program.

Warmups default to **45 minutes**. Change the value if your venue or meet bulletin uses a different warmup length.

Use the scheduler before the Control Room. The schedule decides when an event is planned to happen; the Control Room decides when that event actually goes Live.

See [Session Scheduler](/guide/session-scheduler) for the full workflow.

#### Team events

A team event is a single event entry where multiple members share a team. Each round, members take turns diving — sometimes individually, sometimes as a synchro pair. Setup:

1. Create the event with `event_type: team`.
2. From the event row, click **Manage Teams** → create one or more teams in the federation (or pick existing ones from `/teams`).
3. Link each team to the event via **Add Team to Event**.
4. Submit each team's bulk dive list — see [Running a Meet → Team events](/guide/running-a-meet#team-events).

## Operator-prescribed round dives

Sometimes the meet manager wants every diver to dive the same thing in the same round — skills trials, certifications, novice fixtures, training meets where the operator just wants comparable scores across the field. Pin a specific dive to a round of the event:

1. In the New Event modal, in the **Round dives** editor, click on an empty row's "Diver picks · click to pin a dive" placeholder.
2. The autocomplete popover opens — type a dive code (e.g. `5132`) or part of the description, and pick from the matches.
3. The row now shows the pinned dive (`5132D · DD 3.0`). Click the ↺ button on the row to unpin it back to "diver picks".
4. Click **+ Add Dive** again for each additional round — one row per round. Leave a row unpinned ("Diver picks") to let divers choose that round freely.

If the dive you need isn't in the directory, click **+ Add a new dive…** in the autocomplete popover. A sub-modal pops with the same fields as `/dive-directory` (code, height, position, DD, description). Submit it — the dive is added to your federation's directory and immediately bound to the row that opened the picker.

For mixed-board events, each row gets an extra **height** selector: leave the dive free but pin the round to a particular board ("round 3 must be a 3m dive, but the diver picks which one").

### How divers see prescribed dives

When a diver opens the event in the [Diver Portal](/guide/diver-portal):

- **Pinned rounds** are pre-filled and locked. The row shows the dive code, DD, description, plus a small `🔒 prescribed` tag. Clicking the row does nothing.
- **Free rounds with a height pin** show the placeholder "Tap to select a 3m dive…" and the picker filters to that height when opened.
- **Free rounds with no pin** behave as today — the diver picks any valid dive at the event's height.

Server-side enforcement is in `/api/competitor/submit-list`: a list whose round-N pick doesn't match the prescription is rejected with `400 Dive list violates the event's prescribed dives` and a `violations[]` array of plain-English strings (`"Round 2 is operator-prescribed; submit the assigned dive only"`).

### Editing after the fact

The Edit Event modal mirrors the same UI. You can re-pin / unpin dives, add or remove rounds, change per-slot heights, and adjust the round-rules sections at the same time. Saving sends an atomic PUT — the prescribed-dives table is replaced (or cleared, if you've removed every row), and the event's `total_rounds` is kept in sync.

## Round-structure rules

Real-world youth bulletins almost always specify the **shape** of a dive list, not just per-round caps. Diving NSW's Event 5 16/18 Boys & Girls 1 m, for example, reads:

> **Event 5 — 16/18 Boys & Girls 1 m**
> 4 dives @ 7.6 + 4 dives unlimited
>
> *(each set of 4 must be from different groups — forward, back, reverse, inward, twist)*

To configure this, use the **Round dives** and **Round structure** editors in the New Event form:

1. Click **+ Add Dive** eight times in the **Round dives** editor to create 8 round rows. The live badge confirms "8 rounds".
2. Click **+ Add section** twice in the **Round structure** editor and fill out:
   - **Section 1**: label `Voluntary`, rounds `4`, DD-sum cap `7.6`, **Min different groups** `4`
   - **Section 2**: label `Optional`, rounds `4`, no DD cap, **Min different groups** `4`

The two section panels appear in the **Round structure** editor and the running `n / 8 rounds` total flips green once the section round-counts add up to the event's total rounds. You can keep adding sections (e.g. a `3 + 2 + 3` split for a more complex format) as long as the section rounds sum to the event's total.

Each section accepts:

- **Label** — free text. Surfaces on the diver's portal and the violations panel ("Voluntary: total DD 8.4 exceeds the 7.6 limit").
- **Rounds** — how many rounds belong to this section. Section 1 starts at round 1; section 2 picks up where section 1 ended.
- **DD-sum cap** *(optional)* — sum of declared DD across the section's rounds must be ≤ this number.
- **Min different groups** *(optional)* — minimum number of distinct World Aquatics groups (forward / back / reverse / inward / twist / armstand) that must appear across the section's dives. Independent of `rounds`, so you can express both "5 dives from 5 different groups" (set rounds=5, min=5 — every dive distinct) and "5 dives drawn from at least 4 groups" (set rounds=5, min=4 — one group may repeat). Leave blank for no group constraint. Capped at 6 (the total number of World Aquatics groups).

### How divers see it

When a diver opens an event with `round_rules` set, the [Diver Portal](/guide/diver-portal) shows a per-section strip above the dive picker:

- Running **DD x.x / 7.6** for each section, in red when over the cap.
- **n of m groups picked** counter so the diver knows how many distinct groups they've used in the section.

The **Finalise & Submit** button stays disabled while there are violations, and a violations panel below the rows lists exactly which rules are still failing. The server re-validates on submit so a malformed list can never land in the DB.

### How it stores

Round rules ride on the `events.round_rules` JSONB column (migration 038). Shape:

```json
{
  "sections": [
    { "label": "Voluntary", "rounds": 4, "dd_limit": 7.6, "min_distinct_groups": 4 },
    { "label": "Optional",  "rounds": 4, "dd_limit": null, "min_distinct_groups": 4 }
  ]
}
```

Section round-counts must sum to the event's `total_rounds` or POST `/api/events` rejects the create up-front (`400 Section round counts sum to N, but the event has total_rounds = M`). `min_distinct_groups` must be an integer 1–6 and cannot exceed the section's `rounds`.

If both `round_rules` *and* the legacy `dd_limit_rounds + dd_limit_value` flat-cap fields are set on the same event, `round_rules` wins — leave the legacy fields blank for new events.

## Suggested templates (World Aquatics-aligned)

Inside the New Event modal, between the saved-template strip and the form, a **Suggested templates** panel surfaces ready-made starting points pulled from `src/lib/standard-templates.js`. The list filters live by your current Gender + Age Group selection, so the panel only shows templates that match.

What ships:

- **Senior / Open Individual** — Men 1m / 3m / 10m and Women 1m / 3m / 10m. Round counts (6 / 5) and "different groups" rule match World Aquatics conditions; no DD limit.
- **Senior / Open Synchro** — Men 3m / 10m (6 dives, 2 voluntary at DD ≤ 4.0 sum + 4 optional) and Women 3m / 10m (5 dives, same voluntary + 3 optional).
- **Junior Group A (16–18)** — Boys / Girls 1m / 3m / 10m. Structurally identical to Senior Open per the WA Junior Championships rule book.
- **Junior Group B (14–15)** — Boys / Girls 1m / 3m. Reflects the canonical Diving NSW *"4 voluntary @ 7.6 + 4 optional"* youth bulletin.
- **Junior Group C (12–13)** — Boys / Girls 1m. 5 dives, 5 different groups (DD caps left blank — add per bulletin).
- **Junior Group D (11 and under)** — Boys / Girls 1m. 4 dives, 4 different groups.

Click a template and the form populates: round_dives count, round_rules sections, judge panel size, height, and event type all set. You're free to tweak any field before clicking Create Event — the click "applies" the template, it doesn't lock it.

> **Note on DD limits.** Junior conditions vary year-to-year and per host federation (Diving Australia, USA Diving, World Aquatics Junior Championships, etc.). The shipped templates intentionally reflect only the *structural* WA rules — round counts and minimum-distinct-groups requirements — and leave most DD caps blank. Layer your federation's current bulletin on top via the round-structure editor; save the customised result with **Save as template** so your org has a per-bulletin starting point next year.

## Event templates

If you run the same event format every weekend (junior 1 m, U14 3 m, etc.), save the configuration as a **template**.

- From the New Event form, fill in all the fields, then click **Save as Template** before clicking Create. You'll be prompted for a template name.
- For future events, pick the template from the **Apply Template** drop-down at the top of the New Event form. Every field except the name pre-fills.

Templates are scoped per-org and keyed by name (overwrite-by-name, not append).

## Multi-stage progression

For championships that run a Preliminary → Semi-Final → Final chain, create the **prelim event first**. After it completes, click **Advance Top N →** on the event row. You'll be prompted for:

- **Stage** — Semi-Final or Final
- **Top N** — typically 18 for semi, 12 for final
- **New event name** — defaults to `<prelim name> — Semi-Final`

The server creates a new event with the same panel and rounds but a roster pulled from the top N of the prelim. The new event's dive lists carry forward from the prelim too — divers can edit them before the new event goes Live (subject to the deadline). The advance is **idempotent** — safe to re-run after a score correction.

The chain length is operator-defined. Synchro and team meets typically skip the semi.

## Mixed-board events

Tick **Mixed-board event** in the New Event form and the per-diver-round rows accept a height column. Each round has its own height per diver. Used in:

- Skills trials (one round at each board)
- Multi-round judging certifications (judges score across heights)
- Custom fixtures that don't fit the single-height pattern

The dive directory filter applies per-row — pick a 1 m height for round 1 and the dive search filters to 1 m dives only.

## CSV roster import

If you have your roster in a spreadsheet, click **Import Roster** on the event row and paste a CSV. Format:

```
username,round_number,dive_code,position
diver_alpha,1,101,B
diver_alpha,2,201,B
diver_alpha,3,301,B
diver_bravo,1,103,C
…
```

The server creates all the dive list rows in one transaction. Per-row errors (unknown username, invalid dive code, DD over the per-round cap) are reported back with line numbers; the rest of the import succeeds.

For mixed-board events, add a `height` column.

## Setting up the panel

From the event row, click **Assign Judges** → pick judges from your federation's user list. Order matters: the first judge you pick becomes Judge 1, the second Judge 2, etc. — this maps to the synchro sub-panel slots above.

The same pattern works for **referees**, but a referee isn't on the panel — they're the supervising official. Add at least one referee to your federation (from User Manager); the **Sign Off** step in the Control Room workflow needs one to authorise the event going Live.

## Pre-meet checklist

Before flipping the event to Live, the Control Room enforces a four-step pre-meet workflow surfaced as both a **stepper** (showing all four steps with completed ones ticked green) and a colour-cycling action button beneath it:

```
(1) Check-in ─── (2) Randomise ─── (3) Sign Off ─── (4) Start
```

1. **Red — Check In Divers** — opens the check-in modal so the operator can mark who actually showed up.
2. **Orange — Randomise Dive Order** — operator can skip if they manually re-ordered; otherwise this writes a random `display_order` per diver. The click opens a confirm modal listing what'll happen ("you can re-run randomise as many times as you like before sign-off").
3. **Yellow — Referee Sign Off** — referee scans a QR on the manager's screen, taps a push notification, types a 6-digit handoff code, or enters credentials directly. All four paths confirm the panel is valid and write the same audit row.
4. **Green — Start Event** — opens the **Pre-Flight Review modal** before actually flipping the event Live. The modal is a last-chance summary of what's about to broadcast: roster size, judge panel composition, referee status, and a warnings list for anything that looks misconfigured (invalid synchro panel, divers with incomplete dive lists, partial panel, missing referee). Two buttons: `Not yet` returns to the workflow; `▶ Go Live` actually flips status Upcoming → Live and broadcasts to all judges' phones.

See [Running a Meet](/guide/running-a-meet) for the operator's perspective.

## Searching the events list

Once your federation has run a season's worth of meets, the right pane can fill up. A **search box** and **status filter chips** in the right-pane header keep things scannable:

- **Search box** — free-text match over event name, age group, venue, and (sysadmin view) org name.
- **Status chips** — `All / Upcoming / Live / Completed`, each showing the per-status count. Click to filter; click `All` to clear.

Filters compose with the existing sysadmin org filter. If the active filters hide everything, the empty state shows a `Clear filters` link so you don't get stuck on an empty list.

## Scheduling the day

For a multi-event championship day where two or three boards run concurrently, the [Session Scheduler](/guide/session-scheduler) lays the events out on a vertical timeline with auto-seeded warmups, conflict warnings (judge double-bookings, board overlap, divers entered in two concurrent events), per-conflict dismissal, live re-flow when an event runs long, duplicate-to-next-day, and a public iCal feed for spectators / coaches. The **Schedule** link on each meet row in Meet Manager opens it. Skippable for single-event club meets — just set `scheduled_at` on each event and the scoreboard handles the rest.

## Common pitfalls

- **Forgetting to set the panel size for synchro.** A 5-judge synchro panel doesn't have an Exec A / Exec B / Sync split. Use 7, 9, or 11 judges so the app can label the sub-panels correctly. The Pre-Flight Review modal flags invalid panels before the event goes Live.
- **Skipping the schedule for a multi-event day.** A single event can run without a schedule, but championships need one source of truth for boards, warmups, breaks, and officials. Build and publish the schedule before meet day.
- **Setting `entries_close_at` in the past.** Divers can't submit. Meet manager has to use the late-entry override for every diver. Just leave it null while testing.
- **Mixing teams across federations in a Team event.** All teams in a team event must belong to the same org. The UI filters this for you, but a direct API call won't.
- **Forgetting the referee.** The yellow Sign Off step blocks Start Event until a referee authorises. Set them up before the meet day. The Pre-Flight Review modal also flags this as a warning before the event flips Live, so you get a second chance.
