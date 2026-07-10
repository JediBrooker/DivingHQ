# Judging

The judge view (`/judge`) is the single-purpose, phone-friendly screen that scoring panel members use during a meet. The whole UI exists to do one thing: get a half-point score from the judge into the server as fast and as reliably as possible.

![The judge terminal on a phone, showing the active diver and the score entry pad](/guide-screenshots/judge.png)

## Before the meet

You'll need an account with the `judge` role in your federation. The org admin or meet manager creates it from User Manager → see [Admin Tasks](/guide/admin-tasks). They'll send you a username + temporary password.

When the meet manager assigns the panel for an event, you become officially eligible to score that event. You'll see it listed when you sign in.

## Logging in

1. Open DivingHQ on your phone (works on iOS + Android, mobile browsers, or installed as a PWA).
2. Sign in with your username + password.
3. The dashboard shows a **Judge** tile listing every event you're assigned to. Tap one to enter the judge view.

> If you see *"No events assigned"* but you know you're supposed to be on a panel, check with the meet manager — the assignment might still be pending, or you might be in the wrong org.

## The judge view

The view is split into two zones:

- **Top zone — diver context.** The current diver's name + country chip + (for synchro) partner. The dive code, position letter, DD, and human description ("Forward 2½ Somersaults Pike"). This updates the moment the operator picks a new active diver.
- **Bottom zone — score dial.** A 0.0 → 10.0 dial in 0.5 increments. Tap a value, confirm, submit.

The top of the screen also shows a header with:

- **Your judge number** (1 – 11) — confirms you're sitting in the right panel slot.
- **Your synchro role** if applicable — Exec A, Exec B, or Sync — so you know which slot you're filling.
- **Connection pill** — green when the socket is connected, amber when reconnecting, red when offline.
- **Hold banner** — full-width amber strip when the operator has held the meet. Submit button is disabled until they resume.

## Submitting a score

1. Wait for the diver to finish the dive.
2. Tap your score on the dial. The dial highlights your selection.
3. The submit button activates. Tap it.
4. The score broadcasts over the socket; the operator's Control Room shows your tile turn cyan; the audience-facing scoreboard updates the live judge strip; the dial resets.

The whole flow should take **under three seconds**. If you see the connection pill go amber after submit, hold tight — the score is queued locally and replays when the connection comes back. If it stays amber for more than a few seconds, flag the operator.

### Half-point precision

The dial only accepts half-point increments (0.0, 0.5, 1.0, …, 10.0). DivingHQ enforces this server-side too, so a typo in a custom client wouldn't get through.

### Re-submitting a corrected score

If you tapped wrong and want to re-submit before the round advances, just tap a new score and submit again. The server treats your last submission for that diver-round as authoritative — older entries from the same judge get overwritten.

After the round advances (the operator clicks Next Diver, or auto-advance fires), corrections need to go through the meet manager via the **Score Correction** modal in the Control Room. Tell them which judge-diver-round to fix and what the correct score is.

## Synchro events

Synchro panels split into three sub-groups:

| Panel | Exec A | Exec B | Sync |
|---|---|---|---|
| 7-judge | Judges 1 – 2 (Diver A's execution) | Judges 3 – 4 (Diver B's execution) | Judges 5 – 7 |
| 9-judge | Judges 1 – 2 (Diver A's execution) | Judges 3 – 4 (Diver B's execution) | Judges 5 – 9 |
| 11-judge | Judges 1 – 3 | Judges 4 – 6 | Judges 7 – 11 |

Your judge number determines your sub-panel; the header above the dial spells out *"Exec A — Diver A"* / *"Exec B — Diver B"* / *"Synchronisation"* so you don't have to remember.

You score **only your assigned aspect** of the dive — Exec A judges score how well Diver A executes their half, Sync judges score how well the pair stay together. The server combines the three sub-panels per the WA synchronised rule.

## Hold / Resume

If the operator holds the meet (video review, judge consultation), the amber hold banner appears across the top with the reason text. The submit button is disabled. The shot clock pauses too. Wait for the operator to resume — the banner clears automatically.

## Connection drops

If wifi flakes mid-meet, the connection pill goes amber and a small "reconnecting…" indicator appears. The app doesn't lose your score input — the dial keeps your selection and resends when the socket reconnects.

If the pill stays red for more than a few seconds, flag the operator. The Control Room sees your reconnect-pending state and won't auto-advance until your sub-panel is full.

## Privacy

You only see:

- The current diver and the dive they're about to do
- Your own score on the dial
- A confirmation that your score landed

You **do not** see:

- Other judges' scores in real time
- Standings during the meet
- Anyone's dive list before the event goes Live (same as spectators)

This is deliberate — the panel's job is to score independently. Real-time peer visibility would create anchoring bias.

After the round, the audience-facing scoreboard shows every judge's score (with the dropped high/low marked). You can open it in another tab if you want to compare your scoring against the panel post-event.

## Common pitfalls

- **Wrong panel slot.** If your displayed judge number doesn't match the panel slot you're seated in, tell the meet manager before the event goes Live. They reorder via Assign Judges.
- **Stale dive code.** If the dive code on screen doesn't match what the diver just did, **don't submit**. Flag the operator — the active-diver state on your phone is wrong.
- **Two devices logged in.** Only one device per judge per event. If you log in on a second phone, the first one will be kicked. Stick to one device.
- **Phone goes to sleep.** iOS Safari aggressively suspends background tabs. Keep the screen on (or use the PWA install — it's more lenient) to avoid reconnect churn.

## After the meet

The judge view closes itself when the event flips to Completed. You can sign back in any time and review past meets you scored from your dashboard's Judge tile — historical events stay listed there with read-only access to the per-judge audit history.

## Judge Analysis — how am I tracking?

Every judge has a **public** analytics page at `/judge-profile/:id` that shows how their scoring tracks against the panel-kept mean (post-trim, per **PART FOUR Article 13**). It's the same kept set the dive-points formula uses, so your deviation from it is the same signal a WA judges' assessor would compute by hand.

The page is **public on purpose** — every score the rollups aggregate is already visible on the live scoreboard and the archived meet pages. Pre-aggregating per-judge just makes patterns visible (per-country bias, per-club drift) instead of leaving them buried in the per-dive HTML. The transparency cuts both ways: the judge gets a self-evaluation tool, and the federation has an evidence trail before invoking **Article 8.4.9** (Referee may remove a judge whose judgement is regarded as unsatisfactory).

### Getting there

- **Your own page**: tap *Analysis* on the Judge tile of your dashboard. Goes to `/judge-profile/<your-id>` and lights up the Customise button so you can pick which widgets to show.
- **Anyone else's**: from the public scoreboard, **click any score chip**. The chip's tooltip shows the judge's identity (`J3 — Maria Schmidt · GER · Munich Diving Club`) and clicking opens their analysis page.
- **Judge Analysis hub** (`/judge-analysis`): a public, sidebar-linked page with two tabs:
  - **By Event** — pick any Completed event and see the per-judge ranking matrix (same as the scoreboard recap card) for that event. Deep-linkable via `?event=<id>`.
  - **By Judge** — browse the full judge directory with name, federation, and country filters; click **Open analysis →** on any row to reach that judge's `/judge-profile` page.
- **Browse all judges directly**: `/judges` is a dedicated public directory with a search box, federation filter, country code filter, and a *Min scores* filter to hide judges without enough sample for the bias number to be meaningful.

The hub on its By Event tab, showing the ranking matrix for one completed event:

![The Judge Analysis hub, By Event tab, showing the per-judge ranking matrix for a completed event](/guide-screenshots/judge-analysis.png)

### Default widgets

Judge Analysis ships with the same drag-to-reorder + customise pattern as the diver dashboard:

- **Bias Summary** — headline mean signed deviation, MAD, stddev, sample size.
- **Deviation Distribution** — histogram of how often you score above or below the panel kept-mean, bucketed at 0.5-point bands.
- **Agreement Rate** — % of your calls within ±0.5 (one increment per Article 7.9.4) and ±1.0.
- **Drop Rate** — how often your score gets trimmed off the panel, with the high-vs-low split. A balanced split is expected; a 50/5% high-vs-low skew is the hi-bias signal Article 8.4.9 cares about.
- **By Board Height** / **By Dive Group** / **By DD Difficulty** / **By Round** — deviation broken out per axis.
- **By Diver Country** / **By Diver Club** / **By Individual Diver** — top-N by absolute deviation. Surface a per-country bias signal before the FINAL panel is seated (Article 7.4 already restricts FINAL panels to non-same-nationality judges; this gives the same data ahead of time).
- **Recent Meets** — last 10 events officiated with mean deviation, dive count, drop rate per meet.
- **Trend Over Time** — weekly mean signed deviation. Are you drifting or holding steady?
- **Panel Comparison** — your average score vs the panel-kept mean across all comparable dives.

Synchro panels are excluded from the deviation rollups (the trim is role-grouped — Exec A / Exec B / Sync — not a single mid-panel slice). Synchro dive counts are surfaced separately so you can see your synchro workload without it muddying the individual-event bias signal.

### Date-range filter

The header has From / To date inputs that scope every widget. Pick a season, a single competition window, or leave it empty for "all-time".
