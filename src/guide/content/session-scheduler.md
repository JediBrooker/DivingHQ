# Session Scheduler

The Session Scheduler turns a meet's events into a **choreographed day plan** — warmups, event starts, breaks, ceremonies, and the inevitable delays — all on one vertical timeline. Operators get conflict warnings before the day, schedule slips re-flow downstream blocks in real time, and coaches / spectators get a public schedule (with iCal subscription) that updates as the day moves.

Before the scheduler, the only thing the app modelled above an event was its `scheduled_at` start time. The printed program was the source of truth and it was stale by lunch. The scheduler is the layer that turns those start times into something the meet actually runs on.

## Quick path

1. Create the meet and events in [Setting Up a Meet](/guide/setting-up-a-meet).
2. Open **Meet Manager** and click **Schedule** on the meet row.
3. Turn **Edit mode** on.
4. Review the auto-seeded warmups and event blocks.
5. Drag events onto the correct board columns.
6. Add breaks, ceremonies, equipment checks, or custom blocks.
7. Fix or dismiss conflict warnings.
8. Publish the schedule so spectators, coaches, divers, judges, and the program export all see the same plan.

You should finish with every event on a board lane, no unresolved red conflicts, and a public timeline that matches the printed or announced run sheet.

## When to use it

- A multi-event championship day with two or three boards running concurrently
- Any meet where the same judge could plausibly be on two panels at once
- Any meet where coaches and divers need a "what's happening at 14:30 on Saturday?" answer that survives a 20-minute weather delay
- A multi-day federation event where Sunday's shape mirrors Saturday's (duplicate the session, edit the deltas)

A one-event club meet doesn't need this — just set `scheduled_at` on the event and skip the scheduler entirely.

## Getting there

From Meet Manager, every meet row has a **Schedule** link in its actions. The scheduler opens at `/meet/<id>/schedule`. The page is read-only by default — to make changes, flip **Edit mode** on in the header (top-right, next to the **Subscribe (.ics)** link).

## The day timeline

The timeline lays out the day vertically with **30-minute gridlines** and **one column per board** (1 m, 3 m, 5 m, 7.5 m, 10 m platform — plus extra columns if your venue has multiple boards of the same height). Each **block** sits on the grid, anchored to its time window and its board column.

![Session scheduler day timeline, with one column per board, half-hour gridlines, and warmup and event blocks placed on the grid](/guide-screenshots/session-scheduler-timeline.png)

Read it like a train timetable that runs downward: time on the left, one lane per board, and a block wherever something is claiming that board.

Five block types:

| Type | What it means | Claims a board? |
|---|---|---|
| **Warmup** | Pool is open for athletes; no scoring | Yes |
| **Event start** | A competition event runs in this window | Yes |
| **Break** | Pool is closed; scoreboard idle | Optional |
| **Ceremony** | Medals / opening / closing | No |
| **Custom** | Free-form — announcements, equipment swaps, hospitality | Optional |

### Auto-seeded from events

The very first time you open the schedule for a meet, the scheduler seeds it for you. For every event with a `scheduled_at`:

- An **event_start** block is inserted at `[scheduled_at, scheduled_at + estimated duration]` on the matching board column
- A **warmup** block of 45 minutes is inserted immediately before it

The duration estimate is `total_rounds × number_of_competitors × 90 seconds`, falling back to 90 minutes for events with no roster yet. None of this is locked in — every auto-seeded block is editable from the moment it lands. Use it as a starting point and adjust.

### Boards are first-class

The scheduler models boards as actual rows, not just enum values, so it can distinguish "the 3 m board in the main pool" from "the 3 m board in the warmup pool" when your venue has both. On first load for a federation, the scheduler auto-creates a default board per height in pool **Main pool** — no setup wizard needed for the common case. Multi-pool venues will need to add boards manually (the data model is ready; the UI for it lands when there's a real ask).

## Edit mode

Flip **Edit mode** on to make the timeline interactive. When edit mode is off, the page is byte-identical to read-only.

| Action | How |
|---|---|
| **Move a block in time** | Drag vertically. Snaps to 30-minute gridlines (Shift+drag for 5-minute granularity). |
| **Move a block to a different board** | Drag horizontally across columns. |
| **Resize** | Drag the bottom edge to change end time, top edge to change start time. Same snap rules. |
| **Insert a new block** | Click any empty cell. An inline form opens pre-filled with that 30-minute slot and that board column. |
| **Delete a block** | Hover the block → tiny × in the corner. Confirm in the inline tooltip. |
| **Edit a block's label / notes** | Click the block (not drag). |

Every save round-trips through the conflict detector. If your edit introduces a conflict, the affected block flashes red (hard) or amber (soft), and the new conflict appears in the **Conflicts drawer** (collapsible panel on the right of the timeline).

The drawer's state — open / closed, "show dismissed" toggle — persists per-user in `localStorage`, matching the same pattern as the theme toggle (the other per-user `localStorage` control in the signed-in app shell).

## Conflict detection

A **conflict** is two blocks that overlap in time AND share a resource. The scheduler checks four resource kinds:

| Resource | What triggers a conflict |
|---|---|
| **Judge** | Same judge on two `event_start` blocks whose windows overlap |
| **Board** | Same board claimed by two blocks at the same time |
| **Diver** | Same diver entered in two events running concurrently |
| **Referee** | Same referee assigned to two parallel sessions |

### Hard vs soft

- **Hard** (red outline): same resource, same time. The block card glows red; the drawer entry is at the top.
- **Soft** (amber outline): same judge in blocks ≤ 15 minutes apart but not overlapping (no time for them to physically switch panels).

Hard conflicts on board, diver, and referee resources only — those are always real. Soft only applies to judges, where "tight switching" is the realistic scenario.

Below, two 3 m events have been scheduled five minutes apart. They share a board, a judging panel, and a roster, so the detector raises a hard conflict on all three resources at once.

![The scheduler's Conflicts drawer open beside the timeline, listing a hard conflict between two overlapping blocks and naming the shared resources](/guide-screenshots/schedule-conflict-drawer.png)

### Dismissing a conflict

If you've handled a conflict outside the app ("Anna's switching panels at the break, we talked it through"), open the drawer and click **Dismiss** on the row. Optionally add a reason. The conflict disappears from the active list but is preserved in an audit trail — and importantly, **the dismissal resurfaces if the situation changes**:

- If either block's time window moves, the conflict reappears (different windows = different problem)
- If the resource membership changes (a judge is added or removed from a panel, a board swap, a diver is newly entered or withdrawn), the conflict reappears
- If a third block enters the overlap, that's a new conflict

This is the deliberate "safer, noisier" design: every materially new conflict surfaces explicitly, even if it involves the same pair of blocks you OK'd yesterday. **There is no "ignore all conflicts involving Judge X" rule** — that's been considered and explicitly rejected, because the click savings don't justify the risk of a real conflict being silently swallowed.

Dismissals can be undone — flip the drawer's **Show dismissed** toggle on, find the row, click **Un-dismiss**.

### Conflicts from the Judge Panel Modal

When you assign judges to an event from the Control Room's `JudgePanelModal`, the scheduler runs the detector immediately after save. If the new panel introduces a conflict, the modal shows a non-blocking warning with a **View in schedule** link. The save still goes through — warnings only, no veto. You can also see each judge's availability badge (green = available in this block's window; amber = busy with another panel) right in the picker.

## Live re-flow

The hardest part of running a championship day is that the schedule slips. An event runs 20 minutes long; suddenly every downstream warmup time is wrong, every coach is asking when their diver is on, and the printed program is fiction.

Live re-flow handles this. When you mark an event **Complete** in the Control Room, the scheduler:

1. Stamps the actual end time on the event's scheduler block
2. Computes the delta vs the planned end time
3. If `|delta| < 5 minutes`, does nothing (sub-5-minute noise isn't worth a modal)
4. Otherwise pops the **Reschedule downstream** modal

The modal lists every block in the same session that starts at or after this event's planned end — labelled with each block's name, old start time, and proposed new start time (old + delta). All checkboxes default to checked. Untick the ones you want to leave at their original time; click **Confirm reschedule** and the scheduler:

- Atomically shifts the checked blocks forward by the delta
- Appends one row per shift to the shifts ledger (so we can debrief "why did Sunday afternoon collapse" after the meet)
- Emits a `schedule:shifted` socket event so every public-schedule viewer (and every iCal subscriber on their next refresh) sees the new times

**Reflow only ever shifts later, never earlier.** If an event finishes 10 minutes early, the scheduler doesn't push the next warmup up — most divers won't have arrived yet, and an early-shift would create more chaos than it solves. You can pull blocks earlier manually in the timeline if you really want to.

Blocks that have already started (their `actual_start_at` is stamped) are never reflow candidates — they're history. If you confirm a reflow and someone marks a candidate as started while the modal was open, the server returns 409 and the UI refetches. No half-applied shifts.

## Duplicate to next day

A 5-day meet has roughly the same shape each morning — same warmup blocks, same events on the same boards, same break pattern. Edit mode adds a **Duplicate to next day** button on each session's header. Click it, pick the target date (defaults to next day), confirm. The scheduler:

- Creates a new session row with the same name / pool / referee
- Copies every block to the new session, time-shifted by the day delta
- Clears `event_id` on the copied event_start blocks (the new day's events haven't been created yet — you'll re-attach them when you create those events)
- Preserves `board_ids` so the day's shape carries through

Then navigates to the new session so you can tweak. Saves an enormous amount of clicking.

## iCal export

Every meet's schedule is published as an iCalendar feed at `/api/meets/<meet-id>/schedule.ics`. Click the **Subscribe (.ics)** link in the timeline header to get the URL; paste it into:

- **Apple Calendar** — File → New Calendar Subscription
- **Google Calendar** — Other calendars → + → From URL
- **Outlook** — Add calendar → Subscribe from web

Each schedule block becomes a `VEVENT` with its label, board(s), and any notes you wrote. The endpoint is **public** — same visibility as the public schedule page — so coaches, federations, and spectators can subscribe without an account.

Re-flow shifts propagate automatically: subscribed calendars re-fetch on their own cadence (typically every few hours; Apple Calendar respects an explicit refresh interval). No push notification spam.

## Public schedule

Anyone with the meet URL can see the schedule. The public view is simpler than the operator timeline — a chronological list grouped by day, no board columns, mobile-friendly — meant for spectators and divers checking when their event runs. Re-flowed times update over the socket within seconds.

## Meet-day checklist

Before doors open:

- Every event has a board, warmup, start time, and expected duration.
- Every break or ceremony is represented on the timeline.
- Judge, diver, board, and referee conflicts are resolved or deliberately dismissed with a reason.
- The schedule is published.
- The public meet page matches the printed or announced program.

During the day:

- Use **Hold / Resume** inside Control Room for a temporary pause inside one event.
- Use the scheduler when a delay affects later warmups, another board, lunch, ceremonies, or officials.
- Publish re-flow changes so the public schedule and iCal feed reflect the new plan.

After the day:

- Keep the final schedule published so the archive and program exports reflect what actually happened.

## Permissions

| Role | Can read | Can edit / dismiss / reflow |
|---|---|---|
| Spectator (public) | Yes (public schedule + iCal) | No |
| Diver | Yes | No |
| Judge | Yes | No |
| Coach | Yes | No |
| Referee | Yes | Yes |
| Meet manager | Yes | Yes |
| Meet controller | Yes | Yes |
| Org admin | Yes | Yes (within their federation) |
| System administrator | Yes | Yes (across federations) |

Edit access reuses the same `requireMeetEditor` gate as the rest of the Control Room's write actions — no new role to manage.

## What it deliberately doesn't do

Some "but what about…" features that have been thought about and intentionally *not* built:

- **Constraint-solver auto-scheduling.** The day's shape is judgment, not optimisation — computers don't know that the Slovak team's bus is always late. The scheduler flags conflicts; it doesn't resolve them.
- **Multi-venue logic.** Pools are a free-text column on the session. If you're running across two venues with travel time between them, model both as separate sessions and handle the gap manually.
- **Per-judge availability windows** ("Anna can only work mornings"). Solved socially today; modelling it adds calendar UX overhead without a clear payoff.
- **Spectator push notifications for re-flowed times.** Coming in a future phase if there's demand — needs a per-meet opt-in and an unsubscribe flow first. iCal subscription covers the same use case for now.
- **Rule-based conflict suppression.** Per-conflict only, by design. See the [conflict-detection](#dismissing-a-conflict) section above for why.

## See also

- [Setting Up a Meet](/guide/setting-up-a-meet) — create the meet and events that feed the scheduler
- [Running a Meet → Finalising the event](/guide/running-a-meet#finalising-the-event) — where the reflow modal pops
- [Roles & Permissions](/guide/roles-and-permissions) — who can edit
- `docs/session-schedulerr.md` — the engineering design doc this feature was built from
