# Scoreboard

The scoreboard is the audience-facing view. It works **anonymously** — no login, no token — so a spectator can open the URL on their phone, drop in halfway through a meet, and immediately see what's happening. It also drives the back-of-house projector via Broadcast mode and overlays an OBS feed via Stream mode.

![The scoreboard's meet browser, listing meets as cards with live and completed status chips](/guide-screenshots/scoreboard.png)

## Two URLs

| Path | What you get |
|---|---|
| `/scoreboard` | Federation index. Live + Upcoming + Completed events listed; click into any. |
| `/scoreboard/<event-id>` | The live broadcast for one event. |

For a multi-event meet, the **meet landing page** at `/meet/<id>` is a better entry point — it lists every event in the meet with its status, and clicks through to the per-event scoreboard.

If the meet manager has published a [Session Scheduler](/guide/session-scheduler), the meet landing page also becomes the public run sheet: warmups, event starts, breaks, ceremonies, and any published delay updates.

## Live broadcast layout

![The live broadcast scoreboard: the active diver in the centre, judge scores below, and live standings alongside](/guide-screenshots/scoreboard-live.png)

A three-column layout while the event is `Live`:

- **Left column — Completed Dives.** Every scored dive in the event so far. Each card shows the diver, country chip, club affiliation (with team chip when in a team event), dive code + DD + description, and the per-judge scores with World Aquatics category colour-coding. Synchro events show role-grouped panels (Exec A / Exec B / Sync). Filter by diver or round at the top.
- **Centre column — Current Performer.** The active diver. Big diver name, country chip, dive code + DD + description, the live judge tile strip (each judge's score appears as it lands), the dive total when the panel completes, the **catch-up projection** (what the diver needs to overtake the leaders), and the Up Next list.
- **Right column — Standings.** Live rankings; tabs to switch between **Final** (running totals) and **By Round** (per-round leader, with up/down movement arrows between rounds).

When no diver is on the board (between divers, pre-meet) the centre flips to an **On Deck** preview showing the next-up performer with the same shape.

## Recap layout (completed events)

Once the meet manager finalises the event, the layout switches to a recap:

- **Podium spotlight** — top three with diver name, club, total score, country chip
- **Full standings** — every diver, their final total, club, podium medals
- **Dive-by-dive breakdown** — grouped by diver, every dive with all judge scores, World Aquatics-category coloured, dropped scores struck through

PDFs (program, start list, score sheet, results) and a CSV export are one click away from the recap header.

## Judge Ranking Analysis (Completed events)

A card sits between the standings and the highlights panel on every Completed event — **individual, synchro pair, and team alike**. It answers the question: **"What would the standings have been if every judge on the panel had scored unanimously like this one judge?"**

For each judge on the panel and each competing entity (diver, pair, or team — depending on event type) the table shows:

- The entity's **actual** rank + panel-trimmed total (the official result)
- The rank that entity would hold in a hypothetical scenario where the whole panel scored exactly like one judge — one such column per judge on the panel, with the hypothetical total shown beneath the rank on a second line so the magnitude is visible without hovering

Cells where a judge's hypothetical rank disagrees with the official rank are **highlighted in blue** — the fill is a touch stronger for bigger rank swaps, so a podium-reshuffling disagreement stands out from a routine one. Hovering a cell shows the underlying hypothetical total and the rank delta; hovering a column header shows that judge's identity (`J3 — Maria Schmidt · GER`).

For synchro events each row is a pair (`Lead & Partner`); for team events each row is a team (named, no individual /profile link). For individual events the row label links straight through to the lead diver's `/profile`.

The card is **collapsed by default**; click the section header to expand it and reveal the full matrix. The same payload that backs the table also feeds the score-chip tooltip enhancement elsewhere on the page (the "Ranked this dive Nth of M in round R" line).

The same matrix is reachable standalone from the Judge Analysis hub, which is easier to link to:

![The Judge Analysis hub showing the per-judge ranking matrix for a completed event](/guide-screenshots/judge-analysis.png)

**CSV / PDF export** buttons at the top of the section produce a federation-reporting-friendly artefact. The CSV carries one row per entity with `actual_rank`, `actual_total`, and `(rank, total)` columns for each judge; the PDF mirrors the on-screen matrix in landscape A4 form. Both endpoints are public — same transparency stance as the rest of the scoreboard.

Loading the section the first time also enhances every score-chip tooltip elsewhere on the recap with the per-round rank that judge gave the diver (see "Click any judge score" below).

## Click any judge score to see the judge's analysis

Every per-judge score chip on the scoreboard — live or recap, individual or synchro, current performer or completed-dives panel — is a clickable link to that judge's public analysis page.

- **Hover** the chip and the tooltip shows the judge's identity: `J3 — Maria Schmidt · GER · Munich Diving Club`. On Completed events the next line tells you where that judge ranked the diver in the round (e.g. `Ranked this dive 2nd of 12 in round 1`). If the chip's score was trimmed off the panel by the World Aquatics rule, that's noted on the next line. The final line tells you "Click to open judge analysis."
- **Click** the chip and you land on `/judge-profile/<judge-id>` — the same public Judge Analysis page covered in [Judging](/guide/judging#judge-analysis--how-am-i-tracking).

The link works for anonymous spectators too — judge profiles are public by design ([Judging](/guide/judging#judge-analysis--how-am-i-tracking) explains the transparency stance). It's the fastest way for a curious viewer to dig into a panel call: tap the chip, see whether the judge has a track record of scoring divers from country X higher than the panel kept-mean, or check their per-board-height bias.

## Judge Analysis page

The standalone **Judge Analysis** page at `/judge-analysis` is a public surface (no login required) with two tabs:

- **By Event** — pick any Completed event from the dropdown and the full per-judge ranking matrix renders (the same component as the recap card described above). Deep-link to a specific event with `?event=<id>`. Signed-out visitors browse completed events from the public archive; signed-in users see their own org's events too.
- **By Judge** — search the public judge directory (name, federation, country). Each result row links to that judge's `/judge-profile/:id` analytics page.

Signed-in users reach **Judge Analysis** via the sidebar. Anonymous spectators see a minimal top bar with a Home link — same pattern as the Scoreboard itself.

## Catch-up projection

The cyan-tinted block in the centre column tells the audience and the diver themselves what they need to overtake the leaders.

- **Chasing** — `Catch-up — N dives left · currently 3rd` with a row per podium target: `1st  Lead Name  avg 7.5`. The "avg" is the **average judge score** the diver needs across the remaining dives to close the gap, **rounded up to the next achievable half-point** (judges only score in halves, so 5.2 isn't a possible target — 5.5 is). When the math is impossible (would need straight 10s and still come up short), the row reads "not possible".
- **Leading** — `Leading by +X.X` with the runner-up's catch-up math: what they'd need to overtake.
- **Pre** — `No completed dives yet. Lead Diver leads at X.X` — shown for the first diver of the meet.

## Per-round leaderboard pop

When the last diver of a round finishes, the operator can fire an **announce standings** prompt. The scoreboard flashes a full-screen overlay with the per-round leader, top 5, and movement arrows from the previous round. About 6 seconds, then back to the normal layout.

## Hold / Resume banner

If the operator holds the meet (video review, equipment failure, judge discussion), an amber banner spans the top with the reason text. The judge tiles dim slightly. The banner clears automatically when the operator resumes.

## Connection-lost banner

The scoreboard subscribes to the live socket; if your wifi or 4G drops, a red banner appears at the top: *"Connection lost — reconnecting…"*. It clears automatically when the socket comes back. The view freezes on the last-known state during a disconnect — you won't see incremental updates, but you also won't see stale data go silently wrong.

## Broadcast mode (venue projector)

For a back-of-house projector, append `?mode=broadcast` to the scoreboard URL or click **Broadcast** in the header. This:

- Hides the page chrome (header, footer, navigation)
- Scales fonts up so a back-row spectator can read everything
- Tints the background a deeper black for high-contrast projection

Same content, optimised for distance viewing.

### Multi-event broadcast (`/broadcast/all`)

When a venue has **one projector but two pools running concurrently**, point the projector at `/broadcast/all` instead of a single event URL. The view auto-grids every currently-Live event:

| Live events | Layout |
|---|---|
| 1 | Full screen |
| 2 | 50/50 horizontal split |
| 3 – 4 | 2 × 2 grid |
| 5 – 6 | 3 × 2 grid |
| 7+ | 4-column scroll |

The list refreshes every 30 s so events that flip Live → Completed drop out and freshly-flipped events drop in automatically — no operator action required to re-arrange the grid.

Each pane is the same `/scoreboard/<id>/broadcast` view we already ship, running in its own iframe with its own socket connection. Score updates flow live and independently per pane.

#### Picking which events to broadcast

`/broadcast/all` defaults to "everything Live right now." When the venue is running 3+ events but only 2 belong on the projector, the Control Room's **📺 Broadcast…** chooser opens an in-modal sub-picker that lists every Live event with a checkbox. Every Live event is ticked by default; untick what you don't want, then click **Open broadcast (N)** to launch the projector window. The chooser builds a URL of the form:

```
/broadcast/all?ids=evt-2,evt-4
```

The view intersects `?ids=` with the polled Live list, so:

- Events outside the picked set never appear (even if Live)
- Selected events that finish drop out naturally on the next 30 s poll
- Newly-Live events do **not** auto-join the grid — the operator made an explicit choice; we respect it

If every event in the picked subset finishes, the grid swaps to an "All selected events have finished" panel with a one-click **Show all Live events** rescue that strips the `?ids=` filter (newly-Live events will then join the grid as they appear).

A small `operator-selected subset` badge sits next to the event count in the floating chrome whenever a subset filter is active, so a back-of-house viewer can tell at a glance whether they're looking at "everything" or a curated pick.

If the operator ticks *every* Live event, the chooser drops the `?ids=` filter entirely so the resulting URL is the canonical `/broadcast/all` (newly-Live events still auto-join). The picker is skipped when there are 0 or 1 Live events — there's nothing to pick between.

The Control Room also has its own kiosk toggle (`/control?broadcast=1`) for the operator's own laptop, if the laptop IS the projector.

## Stream Overlay (for OBS / live-streaming apps)

The scoreboard ships with a built-in **chroma-key overlay** view designed to drop straight into OBS Studio, Streamlabs Desktop, vMix, Restream Studio, Ecamm Live, or any broadcast tool that supports a Browser Source. No plugin to install, no separate server to run — the same page that drives the audience scoreboard renders a chroma-friendly version when you ask for it.

### What the overlay looks like

There are two shapes, chosen by the query flag. Both strip every piece of page chrome — no header, footer, filter bar, or export controls — and both float on a vivid solid-colour background (default `#00ff44`, OBS standard green) for chroma keying.

**`?overlay=1` — the full board.** Everything the audience scoreboard shows, minus the chrome:

- Active diver block (name · country · dive code · DD) with live judge tiles as scores stream in
- Standings, completed dives, the catch-up projection, and the Up Next queue

![The full stream overlay: the three-column board with its page chrome stripped, floating on a solid chroma-key green background](/guide-screenshots/stream-overlay-chroma.png)

Crop the Browser Source in your broadcast tool to whichever columns you want on air — most productions key the centre column only.

**`?overlay=minimal` — the cut-down board.** For productions that want the graphics to sit over live camera footage rather than fill the frame:

- Active diver block and the top 3 of the standings, and nothing else
- Completed dives, the catch-up projection and the Up Next queue are all hidden
- Each tile gets a dark plate and a text shadow, so the white text stays readable whatever `?bg=` colour you key against

![The minimal stream overlay: just the active diver block and the top three standings, on dark plates against chroma-key green](/guide-screenshots/stream-overlay-minimal.png)

The two tiles sit at the top of the frame with the rest keyed out, so position them in your broadcast tool the same way you would any other Browser Source. Unlike the full board, there is nothing to crop away.

### Chroma colour

The chroma colour is configurable via `?bg=<6-digit-hex>` — useful when stage lighting throws green spill onto the broadcast. Common alternatives: `?bg=ff00ff` (magenta), `?bg=0000ff` (blue). It works with either overlay shape.

### URL shape

```
/scoreboard/<event-id>?overlay=1
/scoreboard/<event-id>?overlay=1&bg=ff00ff
/scoreboard/<event-id>?overlay=minimal
/scoreboard/<event-id>?overlay=minimal&bg=ff00ff
```

Same anonymous-friendly endpoint as the public scoreboard, just with the `overlay` query flag flipping the page into chroma-key mode.

### Getting the URL from the Control Room

The Control Room's **📺 Broadcast…** chooser surfaces this flow without you having to remember the URL shape. Open the header `⋯` menu → **📺 Broadcast…** and pick the **🎬 Stream to OBS / live-streaming app…** row. An inline sub-panel appears with:

- The overlay URL for the currently-selected event, in a read-only field with a one-click **Copy** button
- A **5-step Browser Source recipe** (see below)
- A chroma-colour tip with the `&bg=<hex>` override example
- A **Preview overlay ↗** button that opens the live overlay in a new tab so you can sanity-check it before going live

The panel is event-aware: switch to a different event in the Control Room and the URL re-composes automatically.

## Venue hardware bridge

If the venue has Daktronics All Sport Pro / Data Studio / Show Control
RTD ingest, use the Control Room's **📺 Broadcast...** chooser and pick
**Venue hardware — Daktronics bridge...**. That panel gives the operator
and venue technician copyable commands for the selected event, including:

- A safe one-shot test that prints one RTD frame.
- A UDP ERTD command for All Sport Pro / Daktronics RTD data-source feeds.
- A JSON-over-TCP option for Data Studio workflows configured for JSON fields.

The bridge runs on a laptop inside the venue network. DivingHQ continues
to drive the meet normally; the bridge mirrors the same live state to the
venue board. See [Venue Integration](/guide/venue-integration#enable-from-the-control-room).

### OBS Studio: Browser Source setup

The same five steps work in any tool with a Browser Source — the field names match across OBS Studio, Streamlabs Desktop, and Streamlabs OBS; vMix and Ecamm use very similar dialogs.

1. **Open OBS Studio** (or your streaming tool of choice).
2. **Add a Browser Source.** In the **Sources** panel click **+ → Browser**, name it `Scoreboard`, click OK.
3. **Paste the overlay URL** into the **URL** field. Set **Width** to `1920` and **Height** to `1080`. Leave _Refresh browser when scene becomes active_ ticked so the overlay reconnects cleanly if you toggle scenes.
4. **Add a Chroma Key filter.** Right-click the Browser Source → **Filters** → **+ → Chroma Key**. Set **Key Color Type** to **Green** (or **Custom Color** = `#00ff44` if you used the default). The background drops out, leaving just the scoreboard graphics floating on top of your camera feed.
5. **Position and go live.** Drag the source to taste — bottom-third for active-diver lower-thirds, full-frame between dives for the leaderboard. The overlay re-renders in real time as the meet progresses; you don't need to refresh OBS between dives.

### Tips

- **Lock the source layer in OBS** once you've positioned it (right-click → **Lock**) so you can't accidentally drag it during a stream.
- **One source, every event.** Updating the overlay URL when you switch events is a one-line change — copy the new URL from the Control Room's OBS panel, paste it into the same Browser Source's URL field, and you're done. No need to rebuild the filter stack.
- **Use a different chroma colour** if your venue's lighting bleeds green. Magenta (`?bg=ff00ff`) is the most popular alternative — virtually no skin tone, costume, or pool deck pushes it.
- **The overlay is anonymous-friendly** — the URL works without a login, so you can paste it into a streaming PC that isn't signed into DivingHQ. No tokens to manage.

## Public meet landing page

If the event is part of a multi-event meet, the meet's public page at `/meet/<id>` shows:

- **Meet hero** — name, dates, venue, federation logo, optional sponsor branding
- **Live / Upcoming / Completed counts** — at-a-glance status of how the meet is progressing
- **Published schedule** — warmups, event starts, breaks, ceremonies, and delay updates from [Session Scheduler](/guide/session-scheduler)
- **Event grid** — every event in the meet, status pill, click-through to its scoreboard
- **📄 Program export…** — opens a chooser modal for a printable / spreadsheet-friendly meet program (see below)

### Program export

The **📄 Program export…** button at the top of the meet landing page builds a customisable program. The event schedule (name, format, age group, gender, height, rounds, judges, scheduled time, competitor count, status) is always included; tick which optional sections to add, then download as **PDF** or **CSV**:

| Optional section | What it adds |
|---|---|
| **Dive lists** | Every diver in start-order with their per-round dives (code · position · DD · description, with the board height surfaced on mixed-board events). Withdrawn divers and reserves are listed too so the printed program matches the live scoreboard's start list. |
| **Judge panels** | Per-event panel — J-number, name, country. |
| **Estimated event duration** | A per-event ETA + a meet-total summary at the end of the document. Pairs with a cadence picker — **30 s / 45 s / 60 s per dive** — to suit different federation pacing (tight 30 s for a shot-clocked meet, 60 s for a junior meet with deliberate warm-ups). The math is `competitor_count × total_rounds × seconds_per_dive` (synchro pairs counted as one dive); the document notes the figure excludes warm-ups, between-event resets, and ceremonies. |

The **CSV** mirrors the PDF — same data, flat shape. Each row carries a `section` column (`event` / `judge` / `dive`) so a federation analyst can filter to just the rows they want and pivot. Backend endpoints:

```
GET /api/meets/:id/program.pdf?include=dive_lists,judges,timing&seconds_per_dive=45
GET /api/meets/:id/program.csv?include=dive_lists,judges,timing&seconds_per_dive=45
```

Both endpoints are public — same transparency stance as the rest of the meet page. Omit `?include=` for the legacy schedule-only program.

## Completed meets index (`/scoreboard`)

`/scoreboard` with no event id is the **platform index** — a browseable list of every meet *run on DivingHQ itself*, defaulting to Completed. (Not to be confused with the **Results Archive** sidebar item, which is the separate DiveRecorder historical archive documented below.) Filters at the top:

![The results archive with its status filter set to Completed, listing past meets](/guide-screenshots/results-archive.png)

- **Search** — across event name, org name, country
- **Country** — list of every federation that's run a meet
- **Year** — chronological filter
- **Height** — 1 m / 3 m / 5 m / 7.5 m / 10 m
- **Club** — every club that's had a diver in any meet
- **Status** — Completed (default) / Live / Upcoming

Each event card shows the **competitor count** and **club count** so you can see meet size at a glance. PDFs are one click away.

A CSV export of the filtered list is available too — useful for federation reporting.

## Results Archive (DiveRecorder historical results)

The **Results Archive** in the sidebar is a *separate* surface from the `/scoreboard` index above. It lives at `/results-archive` and browses **historical diving results imported from the [DiveRecorder Meet Explorer](https://www.diverecorder.co.uk/)** — meets that were never run on DivingHQ, mined into the `dr_*` tables so the platform has decades of UK/AUS results alongside its own.

It's fully public (no login, no org) and read-only. You can explore three ways:

- **Browse meets** — a paginated, searchable list. Filter by **meet name**, by **country** (each shows its meet count), and by a **date-range slider** (drag either end to narrow the window). Click a meet → its events → an event's ranked results → any diver's full divesheet.
- **Explore by diver** — the always-visible **"Find a diver by name…"** search jumps straight to one athlete's complete result history across every archived meet, regardless of which meet they're filed under.
- **Drill down** — meet → event → result is a clean drill-through; diver names link through to that diver's archived history.

Because the source data is already public and carries no accounts, every endpoint (`/api/dr-archive/*`) is anonymous-readable.

**System-admin only:** an **Import new meets** panel at the top of the page pulls meets not yet stored from DiveRecorder and reports live progress (discovered / imported / skipped). Regular users never see it.

## Spectator-side performance

The scoreboard is **PWA-installable**. On iOS / Android / desktop Chrome, look for "Add to Home Screen" / "Install" — the page becomes a standalone app with a service-worker cache. Effects:

- **Faster reloads.** Cached assets serve instantly while the network update fetches in the background.
- **Resilient on flaky 4G.** A drop doesn't blank the page — the last good state stays painted.
- **No browser chrome.** Full-screen scoreboard on phones.

The scoreboard intentionally never asks for location, contacts, camera, or any other permission — installation is purely about caching and the chromeless launch experience.

## What spectators can NOT see

- Dive lists for events that aren't yet Live (locked to authenticated users — divers don't want their game plan public the day before)
- The score audit log (visible to org admins, referees, system admins via the Audit Log button)
- Pending records still under federation review
- Any data from a meet whose org status is `pending` or `suspended`

Everything else — every score, every standing, every PDF — is openly viewable without an account.
