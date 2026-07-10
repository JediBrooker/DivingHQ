# Running a Meet (Control Room)

The Control Room (`/control`) is the operator's cockpit during a live meet. It's where the meet manager picks the active diver, advances rounds, fires referee actions, holds and resumes the meet for video review, and corrects scores after the fact — and it now drives **two or more events at once from a single window**, so a venue running 3 m and 10 m concurrently (or both stages of a Super Final) no longer needs a separate browser window per pool.

This page covers the full eight-hour day. If you're new, do the [Quick Start](/guide/quick-start) first to set up an event, then come back here.

With one event live, the Control Room is the familiar three-column board:

![The Control Room running a live event, with the dive history on the left, the active diver in the centre, and live standings on the right](/guide-screenshots/control-room.png)

With several events live, each becomes its own pool card side by side and the side columns fold into drawers — see [Running multiple events at once](#running-multiple-events-at-once):

![Control Room — two events at once](/guide-screenshots/control-room-simultaneous.png)

## Meet-day checklist

Before the first warmup:

1. Open [Session Scheduler](/guide/session-scheduler) and confirm the published board plan still matches the venue.
2. Open the Control Room and select the first event.
3. Confirm the roster, panel, referee, and dive-list warnings in the right panel.
4. Check in divers.
5. Randomise or confirm the start order.
6. Ask the referee to sign off.
7. Open **Broadcast…** for projectors, OBS, or venue hardware before the first diver is called.
8. Click **Start Event** only when the deck is ready.

During the day, use **Hold / Resume** for a temporary pause inside the current event. Use the **Schedule** tab when a delay affects later events or another board.

### Emergency card

| Problem | Fastest fix |
|---|---|
| Wrong diver is active | Advance with **Next Diver →** on that event's pool card (the active diver also restores from the server if you reopen the room) |
| Wrong score landed | Click the completed-dive card in **History** → Score Correction |
| Diver needs to redo the dive | **Re-dive** on the pool card |
| Referee calls a failed dive | **Failed** on the pool card |
| Meet must pause | **⏸ Hold** on that event's pool card (pauses only that pool) |
| Event is running late | Update [Session Scheduler](/guide/session-scheduler), then publish the change |
| Wrong person was withdrawn | Use the Undo snackbar, or toggle the row back if the snackbar expired |
| Event was finalised by mistake | Use the Undo snackbar, or org admin sets the event back to Live |

## Layout

A **top bar** runs across the whole Control Room and is the only event switcher: every Live event shows as a one-tap **chip** (the focused one highlighted), with an **All events** dropdown for upcoming/completed events on the left, and the action set — **History · Standings · Recovery · Tools** — on the right. (The event name lives here now; there's no separate page-title picker or `⋯` header menu.)

Below the bar, a Live event is the familiar three-column board, pared back so only the things you need every dive are visible at rest:

- **Left column — History.** Every scored dive in the focused event so far: diver name + country, dive code + position, the dive total, and the **per-judge score chips** — the trimmed marks struck through, so you can see at a glance which scores counted. (Synchro events group the chips into Exec A / Exec B / Sync — see [Synchro events](#synchro-events).) Click any card to open the **Score Correction** modal.
- **Centre — the pool card.** The active diver: a READY / DIVING / JUDGING status pill, `Round X / Y`, the 60-second shot clock, the big diver name + country, dive code + DD + description, the live judge tiles, a **Failed · Cap 2.0 · Re-dive** referee row, and the bottom-pinned **Next Diver → / Finalise** primary with an Auto-next picker (the `▾` aside). A per-card **⏸ Hold** sits in the card header.
- **Right column — Standings.** The live leaderboard for the focused event, with an **Announce** button that flashes it on the spectator scoreboard.

**Setup, Review, and Recovery** swap into the centre in place of the live board depending on the event's state: an Upcoming event shows the pre-meet workflow (below); a Completed event shows the final standings; the **Recovery** toggle opens a hold/resume cross-cut. The **Tools** button opens a drawer for the secondary surfaces (Broadcast, Reserves, Audit, Sponsor branding).

## Running multiple events at once

When more than one event is Live, the Control Room shows them **side by side** rather than one at a time. The **History** and **Standings** side columns collapse into edge **drawers** (tap a drawer to peek the focused pool's history or standings), and each Live event renders as its own **pool card** in the centre — each with its own shot clock, auto-advance, **⏸ Hold**, judge tiles, and referee actions. A background pool keeps receiving scores and can auto-advance itself while you work another, so a single operator can run 3 m and 10 m (or both stages of a Super Final) from one screen.

![Control Room — two events at once](/guide-screenshots/control-room-simultaneous.png)

- **Switch focus** by tapping an event's chip in the top bar (or pick a non-Live event from **All events**). The focused card is outlined; History/Standings and the drawers follow the focused pool.
- **Each pool is independent** — advancing, holding, or finalising one never touches another. Scores route to the right pool by event id, so a panel for a non-focused event still fills that card's tiles without stealing your place.
- **Dropped-change safety.** If the server rate-limits a rapid `set_active_diver`, the change is caught client-side and the pool shows a **Retry** so the judges never end up on a stale diver.
- **Two operators on one event.** The lease is advisory: if a second operator (or a second window) opens the same event, both see a "⚠ Also being controlled by another operator" notice. It never blocks — but two people driving the same pool will clobber each other, so coordinate. One operator per event is the supported model.
- **Drive it from the keyboard.** Every hotkey acts on the *focused* pool, and the number keys switch focus — press **1**…**9** to pick a pool, then **Space** / **→** to advance it, **H** to hold, **L** to announce, and **F** / **R** / **C** for the referee's failed / re-dive / cap calls. Full list on the [Keyboard Shortcuts](/guide/keyboard-shortcuts) page.

## The pre-meet workflow

Before the event flips to Live, the centre shows the **Setup** view — a readiness checklist above a single action button, so a new operator sees both **where they are** and **what's next** at a glance.

![Control Room in its pre-meet Setup view, showing the readiness checklist and the contextual action button beneath it](/guide-screenshots/control-room-premeet-checklist.png)

A status chip at the top reads either **Ready to go live** or `N blockers`, and next to it a **Next:** hint names the step in the way. Each readiness item below ticks `✓` green when satisfied and stays `○` grey when it isn't, with a short hint on the right telling you how to satisfy it:

| Readiness item | Satisfied when |
|---|---|
| Roster has competitors | At least one diver is entered |
| Dive lists complete | Every entered diver has a full list |
| Judge panel seated | The panel is assigned and the right size |
| Check-in confirmed | You've run check-in |
| Start order locked | The order is randomised, or the current order is kept |
| Referee sign-off | A referee has authorised the panel |

The button beneath the checklist always offers the one action that unblocks you next, so its label changes as you work through:

| Button | What it does |
|---|---|
| **✓ Check In Divers** | Opens the check-in modal. Tick everyone present, click Continue. Uncheck anyone who didn't show up — they're hidden from the start list. |
| **🎲 Randomise Dive Order** | Writes a random `display_order` per diver. Click opens a confirm modal listing what'll happen ("you can re-run randomise as many times as you like before sign-off"). |
| **📋 Referee Sign Off** | Opens the sign-off modal. The referee can authorise via push notification, scan a QR code on the manager's screen with their phone (auto-submits when they land), type a 6-digit handoff code into `/sign-off-codes` on their own device, or — fallback — type their credentials directly into the manager's laptop. All paths write the same audit row. |
| **▶ Start Event** | Flips status Upcoming → Live and broadcasts `state_update` to every judge's phone. The spectator scoreboards start showing the event immediately. |

Each click is **idempotent** — re-clicking just re-runs the step. You can re-check in divers (a late arrival) and re-randomise as many times as you want, until the event goes Live.

The checklist is the last-chance review. `▶ Start Event` only becomes the button's label once every item has ticked, so by the time you can click it the roster, the dive lists, the panel, and the referee sign-off have all been verified for you.

## During scoring

### Setting the active diver

The pool card advances through the dive order with its **Next Diver →** primary: the button arms once the current dive's panel completes, and clicking it (or letting Auto-next fire) makes the next diver in the order active. Judges' phones receive the new `state_update` and the audience-facing scoreboard shows the new performer.

When you reopen the Control Room mid-meet, each pool **restores the diver the server already has live** rather than resetting to the top of the order — so a reload (or a second operator opening the room) never yanks the judges back to diver 1.

### The shot clock

A 60-second shot clock (the WA post-warning window) auto-starts when a pool's active diver changes, and **each Live pool runs its own** — a background pool keeps its own clock independent of the one you're focused on. The clock turns amber, then red, and flashes when it hits 0. Per WA rules, the diver must have begun their dive by then — the operator should typically not need to intervene. Holding the pool pauses its clock.

### Active diver status

A small pill sits inline at the end of the diver name row and auto-cycles based on what's happening:

| Status | When it shows |
|---|---|
| READY | Diver is on the board, no scores yet, shot clock still ticking |
| DIVING | Shot clock has expired; the diver must have started |
| JUDGING | At least one judge has submitted a score for this round |

The status broadcasts to the audience-facing scoreboard so the spectator strip ticks through the same phases.

### Auto-advance

The **Next Diver** button in the bottom action row is a split-button: clicking the wide main button advances to the next diver immediately; clicking the trailing **▾** opens an Auto-next picker (Manual / 5s / 10s / 15s / 20s / 25s / 30s). The current selection has a check-mark; click any option to switch.

Manual is the default — operator clicks Next Diver themselves. Pick a delay if you want the meet to flow without input (typically 10 – 15 s for the audience to applaud and the next diver to walk up). The same delay governs the round-end **announce standings** prompt.

### Hold / Resume

Hold is **per pool**: if you need to pause one event (video review, referee discussion, equipment failure), click **⏸ Hold** on that event's pool card. A second click resumes. Once held:

- An amber banner appears on the spectator scoreboard with the reason text.
- That pool's card shows a held bar and its `⏸ Hold` flips to `▶ Resume`.
- Judge submit buttons for that event are disabled.
- That pool's shot clock pauses and its auto-advance is cancelled.

Other Live pools keep running — holding 3 m doesn't pause 10 m. The **Recovery** toggle in the top bar opens a focused hold/resume cross-cut for the event you're on.

### Referee actions (Failed · Cap · Re-dive)

Each pool card carries a referee action row beneath the judge tiles:

| Button | Effect |
|---|---|
| **Failed** | All judges' scores for this round set to 0. The audit log records the actor. |
| **Cap 2.0** | Same as above but capped to 2.0 — used for "balk" or partial-attempt rules. |
| **Re-dive** | Wipes the current round's scores; the diver redives. The original attempt is preserved in the audit log with an "amended" marker. |

Each button acts on **that card's** active diver and broadcasts to the judges' phones so the panel knows the dive was officially failed / capped / redived.

## Correcting a score

Click any completed dive card in the left column. The **Score Correction** modal opens with:

- The list of judges and their original scores
- An editable score field per judge
- A **live preview** of the impact (see below)
- A **Reason** text field (required)

Pick a judge, edit their score, type a reason, click Apply. The change is **audit-logged** with:

- Old value + new value
- Actor (your user)
- Reason text
- IP + user agent
- Timestamp

### Live preview of the correction's impact

As you type the new score, a preview block recomputes on every keystroke so you see what the correction will actually do BEFORE you commit:

```
Judge 3       8.5  →  6.0
Trim sum     27.0  → 24.5
Dive points  × DD 2.4
             64.80 → 58.80    -6.00
```

- **Judge row** shows the per-judge change.
- **Trim sum** uses the same trim rule the live scoring uses (drop top + bottom for 5-judge panels, top 2 + bottom 2 for 9-judge, etc.).
- **Dive points** multiplies the trim sum by DD (× 0.6 for synchro pairs per the WA rule). The coloured delta chip (`-6.00` red, `+1.20` green) reads at a glance.

A small note appears when the edit shifts the trim selection (a different judge gets dropped) — that's the case where the trim sum can move by more than the operator might expect.

The audit row is visible to org admins, referees, and system admins via `/events/<id>/audit` (also accessible from the **Audit Log** button on the event row in Meet Manager).

The diver's totals + standings + records all recompute on the fly. The recap PDFs and archive views update automatically. A success toast (`Score correction saved`) confirms when the change reaches the server.

## Late entries

If a diver shows up after entries have closed, click **+ Add** at the top of the Dive Order panel. The late-entry modal lets you:

1. Pick a diver from your federation's user list (or create a new account on the fly)
2. Enter their dive list for each round (defaults to the most popular dive for that round and panel)

The diver lands in the dive order at the end of the current round. They keep all scoring rights and appear in standings + archive normally.

## Withdrawing or scratching a diver

Open the diver's row actions in the dive order → **Withdraw**. The diver is hidden from the active dive order but their existing scores stay in the audit log + history. An **Undo** snackbar appears at the bottom of the screen for 8 seconds — click it to reinstate immediately. After that, toggling the same row brings them back.

Use **Scratch** for a diver who never started — they're removed from the standings entirely.

## Undoing a misclick

The bottom-of-screen Undo snackbar catches the most common operator-day misclicks so you don't need to call an admin to recover. Currently wired to:

- **Withdraw / reinstate diver** — 8 seconds to flip back
- **Finalise event** — 12 seconds to flip Completed → Live (the longer window reflects the bigger consequence; finalise also publishes the recap, sends "results posted" emails, etc., so 12 s gives you time to spot the wrong button click)

Delete event / club / team aren't undoable — they cascade-delete on the backend. Those still keep their `Are you sure?` dialogs.

## Synchro events

The Control Room shows synchro pairs as a single row with both names: *"1. Lead Name & Partner Name"* with two country chips when the divers are from different countries (international synchro). The judge tiles split into Exec A / Exec B / Sync sub-panels, each labelled with its role.

The history cards in the left column also show the pair as one entry with grouped per-judge scores: Exec A scores, Exec B scores, Sync scores.

## Team events

For team events (`event_type: team`), each team has a **bulk dive list** rather than individual lists. Click the team's row in the dive order → **Edit Team List** to:

- See every team member's per-round dive
- Swap dives between rounds (drag-and-drop)
- Sub a member off and another on for a specific round
- Add or remove a synchro pair within the team's roster

The roster panel shows each team grouped together; advancing through the dive order proceeds in the order the bulk list specifies.

## Round-end behaviour

The focused pool's **Standings** column shows the live leaderboard continuously; its **Announce** button flashes a full-screen leaderboard on the spectator scoreboard whenever you want to call the standings (typically at the end of a round). The announcement is captured in the audit log.

## Finalising the event

Finalising is driven from the pool card's primary button, which is **state-aware**:

- **During pre-meet (Upcoming)** — the centre shows the Setup workflow, not a live board; "finalise" makes no sense before anything has happened.
- **At the natural completion moment** — when the last dive of the last round is scored, that pool card's **Next Diver** button morphs into `✓ Finalise & View Results`. Each pool finalises independently, so finishing 3 m doesn't touch a still-running 10 m.
- **After Completed** — the event drops off the Live board; selecting it from the top bar opens the Review view (final standings + recap).

Clicking Finalise opens a confirm modal listing what'll happen:

- Public scoreboard switches to recap mode (podium + full standings + dive-by-dive)
- Event lands in the public Results Archive
- "Results posted" emails go out to every competitor (if SMTP is configured)
- Reversible by an org admin via Meet Manager → set status back to Live

Click `Finalise & publish` to commit. A success toast confirms the recap is live, and an Undo snackbar (12 second window) at the bottom of the screen catches misclicks.

If the meet uses the [Session Scheduler](/guide/session-scheduler) AND this event ran more than 5 minutes long against its scheduled end, a **Reschedule downstream** modal appears immediately after finalise — it lists every downstream block on the same session, defaults to all checked, and atomically shifts the confirmed blocks forward by the delta. Spectators on the public schedule and iCal subscribers see the new times within seconds. See [Session Scheduler → Live re-flow](/guide/session-scheduler#live-re-flow) for the full behaviour.

Finalising is **reversible** by an org admin (open the event in Meet Manager → set status back to Live), but reversing means the audience-facing recap disappears until you re-finalise.

### Judge Ranking Analysis button

Once the event is Completed, a second pill appears in the Control Room header next to **View Results**: **Judge Ranking Analysis**. Click it to open a modal showing the entity-by-judge matrix described in [Scoreboard → Judge Ranking Analysis](/guide/scoreboard#judge-ranking-analysis-completed-events): each row is a competing entity (diver for individual, lead-and-partner for synchro, team for team events), the first column is the official rank + total, and one column per judge shows the rank that entity would have held if every judge on the panel had scored unanimously like that one judge — with the hypothetical total stacked beneath the rank so the magnitude is visible without hovering. Cells where a judge's hypothetical rank disagrees with the official rank are tinted cyan: pale for a single-position swap, brighter for two or more positions. Available on every Completed event type (individual / synchro_pair / team).

Inside the modal, dedicated **CSV** and **PDF** buttons export the same matrix for federation reporting.

## Diving World Cup Super Final

The Super Final is the season-ending stage of the WA Diving World Cup ([Appendix 3 of the World Cup additional rules](https://world.aquatics.com/diving)). It replaces the regular Final with a three-stage knockout: **Head-to-Head → Semi Final → Final**. Each stage is its own event, linked together via `parent_event_id`.

### Setting up the chain

In Meet Manager, create three events with `event_format` set to:

| Stage | event_format | total_rounds | Notes |
|---|---|---|---|
| Head-to-Head | `super_final_h2h` | 3 | 12 divers in 6 seeded pairs |
| Semi Final | `super_final_semi` | 2 (W) / 3 (M) | 6 H2H winners regroup |
| Final | `super_final_final` | 5 (W) / 6 (M) | 4 finalists, scores reset |

Set the `parent_event_id` of each child to point at the prior stage. The Stop 1 final is the parent of the H2H stage.

### Seeding Head-to-Head

When the H2H event is `Upcoming` and the parent (Stop 1 final) is `Completed`, a **🥊 Seed Head-to-Head** button appears on the H2H event card. Click → modal previews the top-12 ranking with the per-federation cap (default 2 — adjustable; see Appendix 3 §1.4.2.1). Confirm and the server seeds:

- 6 pairs by rank (12 vs 1, 11 vs 2, 10 vs 3, 9 vs 4, 8 vs 5, 7 vs 6).
- Two physical groups: G1 = pairs (12,1), (9,4), (8,5); G2 = pairs (11,2), (10,3), (7,6).
- Each diver gets 3 rounds populated from their parent submission.
- Standard 30-min change-of-dives lock window per Article 6.7.3.

Push notifications go out to all 12 advanced divers.

### Scoring + tie-breaking H2H

Score H2H normally — same Control Room flow as any individual event. The pair winners are computed automatically: each diver's 3-dive total is summed, higher total advances. **If a pair ties on total**, the Control Room **Dive-offs** panel surfaces a "Resolve tie" prompt:

1. Click *New Dive-off* (or use the auto-suggest from the tied-pair list).
2. Pick which dive each tied diver will redo (any of their previously-performed dives this stage).
3. Enter the resulting scores after they dive.
4. Pick the winner (auto-defaults to the higher score).
5. Save → the dive-off result advances the winner. The dive-off itself **doesn't affect official scores** (Appendix 3 §6).

### Seeding SF + F

After the H2H event is `Completed`:

- **Seed Semi Final** button appears on the SF event. The 6 winners regroup (G1 winners → SF G1, G2 winners → SF G2). H2H scores carry forward via `events.score_carry_from`. Reverse-rank start order within group.
- **Seed Final** button appears on the F event after SF completes. Top 2 per SF group → 4 finalists. **Scores reset** (per §3.2). Reverse-rank from SF.

### Re-seeding safety

Every seed endpoint (advance, seed-h2h, seed-semi, seed-final) refuses with a **409 error when the target event already has recorded scores**. This stops a scenario where an operator flipped a Live stage back to Upcoming and re-ran the seeding — the underlying `competitor_dive_lists → scores` foreign key would otherwise CASCADE-delete every scored round. If you genuinely need to start the stage over, clear the scores manually first (admin tooling) so the destruction is explicit, not silent.

### Modified change-of-dives window for the Final

Per Appendix 3 §4.1, the F stage uses a **15-min lock with a 5-min buffer before start** (vs. the regular 30-min Article 6.7.3 default). When the SF completes, the F event's `dive_list_locks_at` is auto-stamped to `NOW() + 10 min`. The diver portal shows an aggressive amber MM:SS countdown banner so a Super Final F finalist doesn't miss the shorter deadline.

### Synchro reserve replacement (pre-H2H only)

Per Appendix 3 §5.1, if a Top-12 individual withdraws after the Team Leaders Meeting, the Control Room can pull a replacement from the same meet's synchronised events. Open the H2H event's **Synchro reserves** panel:

- Lists eligible replacement divers in federation-priority order (highest synchro rank wins).
- Federations that already have 2 individuals in the H2H event are filtered out.
- Click *Replace [withdrawing diver] with [replacement]* and confirm.

The replacement assumes the withdrawing diver's pair slot — all H2H matchups stay intact. The replacement uses their own previously-submitted dive list.

### Final 1–12 ranking

After the F event completes, the public scoreboard shows a merged 1–12 ranking that blends three stage sources per Appendix 3 §7:

- **Positions 1–4** — Final stage scores (full dive list, fresh score)
- **Positions 5–6** — H2H + SF cumulative
- **Positions 7–12** — H2H scores only (3 dives)

Within each tier, ties resolve via the standard WA tie-break (cumulative_total DESC, dives_desc DESC).

## Confirm dialogs and toast feedback

Every destructive or consequential action in the Control Room (and across the rest of the operator surfaces — Meet Manager, Clubs, Teams, User Manager, Dive Directory) opens a styled confirm modal rather than the browser's native `Are you sure?` popup. Each modal lists the actual side effects so the operator knows what they're committing to:

- *Delete event?* — "All dives, scores, and the audit log for this event are deleted; personal bests / club records keyed off this event are recomputed from remaining data."
- *Finalise event?* — "Public scoreboard switches to recap; results emails go out to N competitors; reversible by an org admin."
- *Skip ahead with partial scores?* — "Only N of M judges have submitted; missing judges can still amend via score correction afterwards."

Confirm buttons are colour-coded by severity: cyan for routine actions, amber for warnings (`Move on`, `Reset workflow`), red for destructive ones (`Delete event`, `Delete club`).

After every async action lands, a **toast** at the bottom-centre of the screen confirms what just happened — `Roster imported: 12 divers added, 0 errors` / `Score correction saved` / `Late entry added — Avery Ueno scheduled in Round 1`. Failures show as a red error toast with the server message instead of disappearing silently. Success toasts auto-dismiss after a few seconds; you can also close any toast with the ✕ button.

## Meets survive server restart

Mid-meet state — the active diver pinned at the top of the scoreboard, any meet-hold reason, the on-hold-since timestamp — is now persisted to an `event_live_state` table as a write-through cache. In-memory reads stay fast (no DB hit per scoreboard render), but every set/clear writes through to Postgres in the background.

What this buys the operator:

- **A `pm2 reload` mid-event no longer blanks the scoreboard.** The Vue scoreboard reconnects on socket open and the server replays the persisted active-diver payload — same diver, same dive, same DD, same panel.
- **A crash or container restart doesn't force the operator to re-pick the active diver.** Boot reads `event_live_state` back into the in-memory maps before sockets accept connections.
- **A `meet_hold` survives the restart too.** If you'd paused the meet ("waiting on referee for redive") and the server restarted, the hold banner is still up when scoreboards reconnect.

When an event is finalised (status moves to Completed), the live-state row is cleared automatically — no manual housekeeping.

The only thing not persisted is the per-judge ephemeral entry — judges' typed-but-unsubmitted halfway scores live only in their browsers. Submitted scores have always been DB-backed; that didn't change.

### Graceful shutdown

`SIGTERM` and `SIGINT` (the signals `pm2 reload` and `Ctrl-C` send) are now trapped — the server stops accepting new HTTP, drains active connections, closes the Socket.IO layer, and finally closes the PG pool, with a 25-second deadline before forced exit. In-flight score submissions complete instead of returning 502 to the judge's browser.

## Operator tips

- **Use Broadcast for projectors, streaming, and venue boards.** Open **Tools** (top bar) → **Broadcast…** for the chooser: kiosk this screen, open the spectator view for an event in a chromeless window for the projector, pick several Live events for a side-by-side broadcast grid, stream a chroma-key overlay to OBS (see [Scoreboard → Stream Overlay](/guide/scoreboard#stream-overlay-for-obs--live-streaming-apps)), or wire up a Daktronics venue bridge (see [Venue Integration](/guide/venue-integration#enable-from-the-control-room)). The audience windows always open chromeless so the projector image stays clean.
- **Keep Schedule and Control Room separate.** Schedule is the public plan for boards, warmups, breaks, and delays. Control Room is the live scoring surface. If one event pauses for two minutes, Hold that pool. If the whole afternoon shifts, update and publish the schedule.
- **Watch the connection indicator.** If wifi is patchy and the socket shows as connecting, scoring queues locally but won't reach the server — wait for it to reconnect before relying on what you see.
- **Running several pools? Let the cards work for you.** A non-focused pool keeps scoring and (if you've set Auto-next on it) advances itself, so you can leave 10 m ticking over while you drive 3 m. Switch focus with the chips only when a pool needs a hands-on call (a referee ruling, a correction).
- **Hover any disabled button** for a tooltip explaining the gate — *"Waiting for 2 more judge scores"* on Next Diver. Saves you guessing why the click doesn't work.

## Next steps

- [Judging](/guide/judging) — what judges see while you're driving the meet
- [Scoreboard](/guide/scoreboard) — what the audience sees
- [Setting Up a Meet](/guide/setting-up-a-meet) — configuring events before the day
