# Diver Portal & Profile

DivingHQ has three diver-facing surfaces:

- **Dive Sheets** (`/competitor`) — submit a dive list for an upcoming event, save and re-use templates, watch the live scoreboard for events you're in. In the left sidebar the link is labelled **Dive Sheets** (previously "My Events").
- **Meet day view** (`/me/meet/<eventId>`) — focused phone-deck experience while a meet is in progress: your next dive, current rank, what you need to score for gold/silver/bronze. See [Meet day view](#meet-day-view) below.
- **Diver Profile** (`/profile/<id>`) — a public-ish dashboard with your career stats, personal bests, score-trend sparkline, and a customisable analytics panel.

All three work on phone (most divers use phones) or desktop. The signed-in app shell uses a **light theme by default**; switch to dark with the theme toggle in the top bar. Your preference is saved in `localStorage`.

## Meet day view

When an event you're entered in goes Live, the **Diver tab** of your dashboard surfaces a **Meet day · live now** card at the top. Tapping it lands on `/me/meet/<eventId>` — a focused, phone-first surface designed for the exact two minutes you have between drying off and walking up to the platform. No history, no analytics, no ads — just three things:

![Diver meet day view](/guide-screenshots/meet-day.png)

### 1. Your next dive

The first round on your list whose judges haven't all submitted. Shows the dive code (`201B`), full description, board height, and DD. A round pip in the corner tells you which round (`R2/5`).

If you're up next, a pulsing cyan banner says **YOU'RE UP**. If there's still a queue, it counts down ("3 divers until you're up"). Pre-event, it just says "Pre-meet — entries still locking" so you don't miscount.

### 2. Current standing

Your rank in big italic cyan font with an `↑` or `↓` since the last refresh, your total points, and your gap to the leader. If you ARE the leader, the gap block flips to 🥇 — no negative numbers. The rank uses World Aquatics-style tied-rank sharing: two divers on the same total both get the same rank, and the next rank skips by the size of the tie.

### 3. What you need

Three rows — Gold, Silver, Bronze — each with a colour-coded left border:

- **Cyan = reachable.** "Need avg 6.5 from each judge on every remaining dive" tells you the per-judge score required if you score that exactly on every remaining dive. Rounded UP to the next 0.5 because judges only score in halves; a raw 5.2 isn't a possible judge score, but 5.5 is.
- **Green = already achieved.** You're at or above that total — that medal is yours unless someone catches you.
- **Grey = out of reach.** The gap is too big — even straight 10s on every remaining dive wouldn't close it. The page tells you so directly rather than rendering "Need avg 12.7" you can't actually score.

The math is the same one the operator's Control Room and the audience scoreboard both use — so if a coach watching the spectator stream tells you "you need a 7.0," your page agrees.

### Real-time updates

The page subscribes to the event-room socket. Every score that lands and every change of active diver triggers a 250 ms-debounced refetch — your rank, total, and target math update without you having to refresh. If you lose wifi the data freezes; reconnecting catches you up automatically.

### Pulled-out fast facts

- The view 403s for divers who aren't entered in this event. The link in the dashboard CTA only appears when there's a Live event.
- The "what you need" row uses your **next dive's DD as the proxy** for remaining-dives DD. If your next is a high-DD dive (3.4) the row reads more achievable than if it's a 1.6; that tracks with what's actually possible.
- All three blocks use `clamp()` typography: 36-56 px on the dive code, 40-56 px on the rank. Designed for "deck distance" — readable at arm's length without zooming.

## Submitting a dive list

![Diver Portal — submit dive list](/guide-screenshots/competitor.png)

From the dashboard, tap **Diver Portal**. You'll see a list of every event you're eligible for — events in your federation that are `Upcoming` and haven't passed `entries_close_at`.

Pick one. The dive list builder shows:

- **One row per round** — round 1, round 2, …, round N
- **Dive picker per row** — autocomplete on the dive code (101, 105B, 5132D, …) filtered to the event's board height
- **DD column** — auto-populated from the dive directory once you pick a code
- **Description column** — the human label ("Forward 2½ Somersaults Pike")

Type the first few characters of a dive code (e.g. `103`) and the autocomplete shows matching dives at the event's height. Pick one with the keyboard or tap. The DD and description fill in automatically.

### Per-round DD limits

If the event has per-round DD caps (common in junior events: "rounds 1 and 2 capped to DD 2.0"), a chip shows the cap above the row. Picking a dive that exceeds the cap is blocked — the row stays red until you change it.

### Operator-prescribed dives

Some events have specific dives pre-assigned by the meet manager — common in skills trials, certifications, and training fixtures. When you open such an event, the affected rows are **pre-filled and locked**:

- The row shows the dive code, DD, description, plus a small `🔒 prescribed` tag.
- Clicking the row doesn't open the picker — there's nothing to choose.
- The submit-list endpoint re-checks server-side, so even if the client is bypassed, your list can't replace a prescribed dive.

For mixed-board events the operator may also pin the **board** for a round without pinning the dive itself — in that case the placeholder reads *"Tap to select a 3m dive…"* and the picker filters to that height.

### Round-structure rules (multi-section bulletins)

Many youth events follow a section-based bulletin instead of a flat per-round cap — Diving NSW's *"4 dives @ 7.6 + 4 dives unlimited"* is the canonical example. When the operator has configured one of these (see [Setting Up a Meet → Round-structure rules](/guide/setting-up-a-meet#round-structure-rules)), the dive picker grows two extras:

1. A **section summary strip** above the rows. One row per section (`Voluntary`, `Optional`, …) showing:
   - **DD x.x / 7.6** — running total of your declared DD against the section's cap. Goes red when over.
   - **n of m different groups picked** — how many distinct World Aquatics groups (forward / back / reverse / inward / twist / armstand) you've used in that section vs. the section's `min_distinct_groups` requirement.
2. A **violations panel** below the rows that lists every rule still failing in plain English — *"Voluntary: total DD 8.4 exceeds the 7.6 limit"*, *"Voluntary: needs 4 different groups, 3 used so far"*.

The **Finalise & Submit** button stays disabled — and shows "Round rules not met" — until every violation clears. The server re-validates the same rules on submit, so even if the client is bypassed, a list that breaks the rules cannot land in the DB (`400 Dive list violates the event's round rules` with the same `violations[]` array).

### Synchro entries

For synchro events, the form includes a **Synchro Partner** picker at the top. Type the partner's name; the autocomplete filters to fellow divers in your federation. Pick one and the partner_id is bound to every dive list row you submit.

The partner doesn't have to also submit a list — your submission carries both names. They WILL need an account in your federation though; they show up as the partner_id on every diver-round row.

### Submitting

Click **Submit Dive List**. The form validates:

- Every round has a dive
- Every DD respects the per-round cap
- The partner_id (if synchro) is a valid diver in your org

Once submitted, your name appears in the event's roster on the operator's Control Room. You can re-submit any time before the event goes Live (or before `entries_close_at` for fully gated events) — the new list overwrites the previous one.

## Templates

Once you've built a list, click **Save as Template**. Pick a name (e.g. `"3m Optionals — 2026"`). For your next event, the template appears in the **Apply Template** drop-down at the top of the form — apply it, tweak round-by-round if needed, submit.

Templates are scoped per board height — a 3 m template won't appear when you're entering a 10 m event. They're saved per-user, so your teammates don't see your templates.

A coach role can also save and load templates on behalf of their linked divers.

A coach can also edit a linked diver's whole list from the **Coach Dive Lists** editor at `/coach/dive-lists/<event_id>` — every squad member's rounds, dive codes + DD, submission status, and withdraw control in one per-event view. The same round rules and operator-pinned dives are enforced exactly as in the diver's own portal.

![Coach dive lists editor](/guide-screenshots/coach-dive-lists.png)

## Diver Profile

![Diver Profile](/guide-screenshots/diver-profile.png)

The diver profile (`/profile/<id>`) is **publicly viewable** by default — anyone with the URL can see your career stats. URLs use an opaque slug (not a numeric id), so they're not enumerable from outside.

### Headline stats

The top of the profile shows:

- **Meets entered** — total events you've competed in
- **Dives performed** — across every meet
- **Average DD attempted** — arithmetic mean of your dive lists' DD
- **Best single dive** — your highest-ever dive points (judges trimmed × DD)
- **Score-trend sparkline** — SVG line of total scores across meets

### Personal bests

A table keyed by `(dive_code, position, board_height)`. Each row:

- Best dive points you've achieved on that combination
- Number of attempts at that combination
- "First set at" — the meet where you first hit that PB

This is the raw form — the analytics dashboard below has prettier widgets that draw from the same data.

### Self-serve analytics dashboard

Click **Customize** to pick which widgets show up. Catalog:

- **Score Trend** — line chart of meet totals over time
- **Personal Bests** — same data as the table above, formatted as cards
- **Recent Form** — last 5 meets with your rank "/ of N"
- **Medal Counts** — gold / silver / bronze / finalist / 9th+ totals across your career
- **Height Breakdown** — average + best score per board height, with bars
- **Round-by-Round Form** — per-round average score, with an automatic insight ("you finish strong" / "you fade" / "even pacing")
- **Score Quality Mix** — distribution of your dives across World Aquatics categories (excellent / very good / good / satisfactory / deficient / unsatisfactory / failed)
- **DD Risk Profile** — average + max DD attempted, with how you score at the top end
- **Go-To Dives** — most-attempted dives with avg + best
- **Current Streak** — consecutive podiums or wins (auto-hides when you don't have one)
- **Compare-to-Peers** — your stats vs the org average (anonymous aggregate)
- **Event-Type Splits** — individual vs synchro vs team performance
- **Year-over-Year** — this season vs last

Each widget pulls live data — no caching, no manual refresh. Drag widgets to reorder them in the Customize modal; the order persists per-user.

### Date range filter

The top of the dashboard has a **From / To** date filter that applies to **every widget** simultaneously. Useful for "show me my last 3 months" or "season 2024 only".

### Export Dashboard PDF

Cmd-P / Ctrl-P opens a **print-friendly view** of the dashboard with widget tiles laid out on letter-sized pages. Save as PDF — useful for coach reviews, college recruiting, or sponsor reports.

## Compare two divers

`/compare?a=<diver-id-a>&b=<diver-id-b>` shows two divers side-by-side:

- Headline stats per diver, in two columns
- Per-dive PB diff — for every dive code + position both divers have attempted, who has the better PB and by how much
- Score-trend overlays on a single chart

Useful before national selections or for coaches comparing rivals. Both divers' profiles must be public (default) for the compare view to render.

## Public sharing

A diver's profile URL is shareable with anyone — sponsors, college coaches, family. The URL contains an **opaque slug** (not a numeric id), so:

- People can't enumerate `/profile/1`, `/profile/2`, … to harvest profiles
- The slug isn't your username, so it doesn't expose your login

If you want your profile **private** (visible only to you, your coach, and the org admin), there's a privacy toggle in your account settings — coming in a future release.

## Coach access

If a coach is linked to you (via `coach_diver_links`, approved by your org admin), they see:

- Your full profile + analytics dashboard
- Per-judge breakdowns of every score you received (the panel-by-panel detail isn't public)
- Your saved templates — and they can save new ones to your account

The coach link is bidirectional and visible in your account settings. You can request an unlink at any time.

## Changing clubs

The **My club** card appears at the top of your Dive Sheets page (`/competitor`). It shows your current club and lets you request a move.

### Within the same federation

Click **Request club change**, pick the destination club from the dropdown, add an optional note, and click **Submit request**. Your org admin reviews and approves or rejects the request in **User Manager → Requests**. While your request is pending, the card shows a "Pending" badge with the target club; you can cancel it at any time.

### Cross-organisation transfer

If you are transferring to a club in a different federation, the request becomes a **3-way handshake**:

1. Your current org's admin approves the outgoing transfer.
2. The target org's admin approves the incoming transfer.
3. You confirm the transfer on your end — the card shows a **Confirm transfer** button when both admins have approved and your confirmation is still outstanding.

Every step is audit-logged. The transfer is only applied once all three confirmations are recorded.

## Cross-org browse

The **Diver Search** at `/divers` lets anyone (logged in or not) find a diver by name across every federation on the platform. Click a result to land on their public profile. Useful for finding a diver whose federation slug you don't know.
