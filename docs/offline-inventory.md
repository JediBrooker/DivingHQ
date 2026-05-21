# Offline-resilience — write-action inventory

**Status:** Phase 0 complete, 2026-05-21. P1 design lives in
[offline-p1-design.md](./offline-p1-design.md). Updates to this doc must
land in the same commit as any behaviour change to the underlying action.

This is the contract for the offline-resilience work. Every write surface
the codebase exposes is enumerated here with its sync strategy, conflict
policy, and migration phase.

## Definitions

**Sync strategy**
- **Optimistic** — client may issue the action while offline. Outbox queues
  it, optimistic UI shows it as ⏳ pending, server confirms on drain. The
  judge's `submit_score` outbox today is the prototype.
- **Server-canonical** — must be online. UI greys out when offline. Examples:
  anything that needs a fresh DB read to authoritatively resolve (sign-off
  code verification, finalising an event, cryptographic key issuance).
- **Read-only** — not a write at all. Listed only when reads gate writes
  (e.g., `get_active_diver` precedes most operator actions).

**Conflict resolution policy**
- **Identity-merge** — if two outbox entries land with identical payload for
  the same `(actor, target, action_type)` tuple, server silently merges and
  audit-logs "verified by both sources." If payloads differ, escalates to
  operator-decides.
- **Operator-decides** — server detects conflict, refuses second write,
  emits `conflict_pending` socket event. Control Room surfaces a review
  tray (batched, NOT modal — see CONFLICT-UX-001 below). Operator picks a
  winner; loser is audit-logged with the reason.
- **Last-write-wins** — server-side `updated_at` ordering; loser is
  silently overwritten but audit-logged. Used only when both writers are
  authoritative-equal (single operator with two tabs, two referees on the
  same event, etc.) and the action is non-safety-critical.
- **N/A** — action targets a user-scoped resource (own profile, own
  dashboard widgets, etc.); conflicts are by definition same-user, treated
  as last-write-wins implicitly.

**Migration phase** maps to the plan in [docs/offline-plan.md] (forthcoming):
- **P1** — universal outbox infrastructure (week 1-3)
- **P2** — optimistic UI patterns (week 3-5)
- **P3** — comprehensive read caching (week 4-6)
- **P4** — Control Room offline mode (week 6-10)
- **P5** — manual fallback mode (week 10-12)
- **—** — no migration required (action is online-only by design, e.g. login)

## Resolved policy decisions

These closed out as part of the design review on 2026-05-21:

- **DEC-01 — Stage advancement is online-only.** `POST /api/events/:id/advance`
  (Prelim → SF → F) stays server-canonical. UI greys out the Advance Event
  button during a blackout. Operator's choice: wait for network, or run an
  unofficial intermission.

- **DEC-02 — Sign-off codes during a blackout: `pending_signoff` state.**
  New value in the `event_status` enum (between `Live` and `Completed`).
  During an outage the operator can mark an event as ready to sign off;
  spectators see "results pending official sign-off"; the cryptographic
  sign-off completes the moment network returns and the referee enters the
  code. Schema change in migration 054 (see P1 design doc).

- **DEC-03 — Audit clock records both timestamps.** New columns
  `actor_local_time` (client-claimed) and `server_committed_at` on
  `audit_log` and `score_audit_log`. Existing rows backfill
  `server_committed_at` from `created_at`. The `scores` table also gets
  `actor_local_time` so a per-row replay clock survives audit purges.

- **DEC-04 — Late-arriving submissions: `requireDeadlineWithReview` gate.**
  Generic server-side gate function applies to every action with a hard
  temporal cutoff (entry deadlines, change-of-dives windows, synchro
  substitution). When `actor_local_time < deadline AND
  server_committed_at ≥ deadline`: ACCEPT the action, set
  `late_arrival_flag = true`, surface in the Control Room's pending-review
  tray (P4). Referee adjudicates: approve (keeps edit) or deny (rolls
  back). Both outcomes audit-logged. A backdated `actor_local_time` claim
  is caught by the same review path because any late-arrival triggers
  human review regardless of claimed time.

- **DEC-05 — Mid-meet roster collision: operator-decides.** Two operators
  both offline-add the same diver to the same event → unique-constraint
  collision on `(event_id, competitor_id, round_number)` → server emits
  `conflict_pending`, surfaces in the review tray, operator picks a
  winner, loser audit-logged.

### Open UX decisions (P4 work)

These aren't blocking P1 but need answers before P4 lands:

- **CONFLICT-UX-001** — Conflicts are batched in a Control Room "pending
  review" tray, not surfaced as interrupt-style modals. Operator under
  meet-day pressure should not be modal-stormed.
- **STALE-CACHE-001** — How long after "OFFLINE since X" should the
  scoreboard cache age out and refuse to render? Probably 15-30 minutes
  for spectator-facing surfaces; indefinite for operator-facing (they
  can see the cached state is old, they're driving from it deliberately).
- **MANUAL-VS-SYNC-001** — When operator manually enters a score they
  read off the judge's phone screen, and the same score later syncs from
  the phone: if they match → silent merge; if they differ → operator
  override applied + audit log with reason.

---

## 1. Meet-time actions (must work offline)

These are the hot path during a live meet. Phase 1, 4, and 5 work focuses
here. Every action below MUST tolerate an extended outage without losing
work.

### Socket events

| Event | File | Trigger role | Today's flow | Sync strategy | Conflict policy | Phase |
|---|---|---|---|---|---|---|
| `submit_score` | [routes/socket.js#L341](../routes/socket.js) | judge | Transactional INSERT + audit row in one txn. Idempotent on `(judge_id, competitor_id, dive_id, round)`. Already buffers ONE pending in `JudgeView.pendingScore`. | Optimistic | Identity-merge → Operator-decides on mismatch | P1 (first to migrate, prototype) |
| `judge_signal` | [routes/socket.js#L527](../routes/socket.js) | judge | Toggleable flag (red ring on operator's panel). Ephemeral, resets on every `state_update`. | Optimistic | Last-write-wins | P1 |
| `set_active_diver` | [routes/socket.js#L283](../routes/socket.js) | meet_manager, referee, org_admin | Updates in-memory `activeDivers[event_id]`, write-through to `event_live_state`, broadcasts `state_update`. | Optimistic | Last-write-wins (single operator) | P4 |
| `meet_hold` | [routes/socket.js#L660](../routes/socket.js) | meet_manager, referee, org_admin | Sets `meetHolds[event_id]`, write-through to `event_live_state`, broadcasts `meet_held`. | Optimistic | Last-write-wins | P4 |
| `meet_resume` | [routes/socket.js#L689](../routes/socket.js) | meet_manager, referee, org_admin | Clears `meetHolds[event_id]`, write-through, broadcasts. | Optimistic | Last-write-wins | P4 |
| `referee_failed_dive` | [routes/socket.js#L624](../routes/socket.js) | referee, meet_manager, org_admin | Marks current dive as failed (0 across the board), audit row. Audit-critical. | Optimistic | Operator-decides (rare conflict, but safety-critical) | P4 |
| `referee_cap_scores` | [routes/socket.js#L637](../routes/socket.js) | referee, meet_manager, org_admin | Caps panel scores (rule 10.x). Audit row. | Optimistic | Operator-decides | P4 |
| `referee_redive` | [routes/socket.js#L650](../routes/socket.js) | referee, meet_manager, org_admin | Grants redive, discards prior score for that dive. Audit row. | Optimistic | Operator-decides | P4 |
| `announce_score` | [routes/socket.js#L499](../routes/socket.js) | meet_manager, referee, org_admin | UI-only broadcast ("say it on screen"). No DB write. | Optimistic | Last-write-wins | P4 |
| `subscribe_event` | [routes/socket.js#L233](../routes/socket.js) | any | Room join only. | Read-only | N/A | — |
| `subscribe_venue` | [routes/socket.js#L249](../routes/socket.js) | bridge | Room join + initial snapshot. | Read-only | N/A | — |
| `get_active_diver` | [routes/socket.js#L329](../routes/socket.js) | any | Emits cached state to caller. | Read-only | N/A | — |
| `get_meet_hold` | [routes/socket.js#L711](../routes/socket.js) | any | Emits cached hold state to caller. | Read-only | N/A | — |
| `notification:ack` | [routes/socket.js#L210](../routes/socket.js) | self | Marks own notification read. | Optimistic | N/A | P1 (low priority) |

### HTTP writes

| Endpoint | File | Trigger role | What it does | Sync strategy | Conflict policy | Phase |
|---|---|---|---|---|---|---|
| `PUT /api/scores/:id` | [routes/score-correction.js](../routes/score-correction.js) | org_admin, meet_manager, referee | Edit a previously-committed score. Audit row. Most-sensitive write in the app. | Optimistic | Operator-decides (always) | P4 |
| `PUT /api/dive-lists/:id/order` | [routes/control-room.js#L202](../routes/control-room.js) | meet_controller | Per-row display order, called during dive-order assembly. | Optimistic | Last-write-wins | P4 |
| `PUT /api/events/:id/dive-lists/reorder` | [routes/control-room.js#L250](../routes/control-room.js) | meet_controller | Bulk reorder rows. | Optimistic | Last-write-wins | P4 |
| `POST /api/events/:id/dive-lists/randomize` | [routes/control-room.js#L313](../routes/control-room.js) | meet_controller | Randomise dive order. | Optimistic | Last-write-wins | P4 |
| `POST /api/events/:id/dive-order/sign-off` | [routes/control-room.js#L398](../routes/control-room.js) | meet_controller | Locks dive order. | Server-canonical (needs fresh DB read to verify state) | Operator-decides | P4 |
| `POST /api/events/:id/dive-order/reset` | [routes/control-room.js#L479](../routes/control-room.js) | meet_controller | Unlocks dive order. | Optimistic | Last-write-wins | P4 |
| `POST /api/events/:id/dive-order/confirm` | [routes/control-room.js#L522](../routes/control-room.js) | meet_controller | Mid-meet confirm + advance. | Optimistic | Last-write-wins | P4 |
| `POST /api/events/:id/check-in/confirm` | [routes/control-room.js#L446](../routes/control-room.js) | meet_controller | Marks attendance. | Optimistic | Last-write-wins | P4 |
| `POST /api/sign-off/code/verify` | [routes/control-room.js#L1099](../routes/control-room.js) | referee, org_admin | Verifies the 6-digit sign-off code. Cryptographic. | **Server-canonical only** — UI greys out when offline | — | — |
| `POST /api/events/:id/dive-order/sign-off/request` | [routes/control-room.js#L597](../routes/control-room.js) | meet_controller | Pushes a sign-off request to referee's phone. | Server-canonical (push needs internet) | — | — |
| `POST /api/events/:id/dive-order/sign-off/respond` | [routes/control-room.js#L710](../routes/control-room.js) | meet_controller | Referee responds to push. | Server-canonical | — | — |
| `POST /api/events/:id/dive-order/sign-off/credential` | [routes/control-room.js#L807](../routes/control-room.js) | meet_controller | Issues credential. | Server-canonical (bcrypt + crypto) | — | — |
| `POST /api/events/:id/dive-order/sign-off/code` | [routes/control-room.js#L967](../routes/control-room.js) | meet_controller | Issues sign-off code. | Server-canonical | — | — |
| `PUT /api/dive-lists/:id/withdraw` | [routes/control-room.js#L1172](../routes/control-room.js) | meet_controller | Withdraws diver from event mid-meet. | Optimistic | Operator-decides (rare but visible) | P4 |
| `PUT /api/events/:id/attendance/:competitorId` | [routes/control-room.js#L1247](../routes/control-room.js) | meet_controller | Marks per-diver attendance. | Optimistic | Last-write-wins | P4 |
| `POST /api/events/:id/roster` | [routes/control-room.js#L1285](../routes/control-room.js) | meet_editor | Adds a row to a diver's sheet (used during meet for late additions). | Optimistic | Last-write-wins | P4 |
| `POST /api/events/:id/advance` | [routes/events/index.js#L1489](../routes/events/index.js) | meet_manager | Advances from one stage to the next (Prelim → SF → F). | Server-canonical (complex ranking logic + reserves) | — | — |
| `POST /api/events/:id/reserves/:competitorId/promote` | [routes/events/reserves.js#L155](../routes/events/reserves.js) | meet_manager | Promote reserve into the event. | Server-canonical | — | — |
| `PUT /api/events/:id/status` | [routes/events/index.js#L784](../routes/events/index.js) | meet_manager | Upcoming → Live → Completed transitions. | Optimistic | Last-write-wins | P4 |

---

## 2. Pre-meet setup (online required, but should fail gracefully)

These should happen at HQ or before the venue's wifi can drop. We don't
migrate them to the outbox; we just need them to fail clearly if attempted
offline.

| Endpoint | File | What it does | Sync strategy |
|---|---|---|---|
| `POST /api/meets` | [routes/meets.js#L228](../routes/meets.js) | Create meet. | Server-canonical |
| `PUT /api/meets/:id` | [routes/meets.js#L259](../routes/meets.js) | Edit meet metadata. | Server-canonical |
| `DELETE /api/meets/:id` | [routes/meets.js#L312](../routes/meets.js) | Delete meet. | Server-canonical |
| `POST /api/events` | [routes/events/index.js#L269](../routes/events/index.js) | Create event. | Server-canonical |
| `PUT /api/events/:id` | [routes/events/index.js#L506](../routes/events/index.js) | Edit event. | Server-canonical |
| `DELETE /api/events/:id` | [routes/events/index.js#L729](../routes/events/index.js) | Delete event. | Server-canonical |
| `POST /api/events/:id/managers` | [routes/event-staff.js#L48](../routes/event-staff.js) | Assign meet manager to event. | Server-canonical |
| `DELETE /api/events/:id/managers/:userId` | [routes/event-staff.js#L67](../routes/event-staff.js) | Unassign meet manager. | Server-canonical |
| `POST /api/events/:id/judges` | [routes/event-staff.js#L109](../routes/event-staff.js) | Seat judging panel. | Server-canonical |
| `POST /api/events/:id/participating-orgs` | [routes/events/index.js#L1049](../routes/events/index.js) | Add visiting federation. | Server-canonical |
| `DELETE /api/events/:id/participating-orgs/:org_id` | [routes/events/index.js#L1169](../routes/events/index.js) | Remove visiting federation. | Server-canonical |
| `POST /api/events/:id/roster/import` | [routes/control-room.js#L1362](../routes/control-room.js) | CSV roster import. | Server-canonical (bulk + validation heavy) |
| `POST /api/events/:id/seed-h2h` | [routes/events/index.js#L2030](../routes/events/index.js) | Seed H2H stage. | Server-canonical |
| `POST /api/events/:id/seed-semi` | [routes/events/index.js#L2440](../routes/events/index.js) | Seed semifinal. | Server-canonical |
| `POST /api/events/:id/seed-final` | [routes/events/index.js#L2733](../routes/events/index.js) | Seed final. | Server-canonical |
| `POST /api/events/:id/replace-from-synchro` | [routes/events/super-final-bridge.js](../routes/events/super-final-bridge.js) | Super-final bridge for synchro pools. | Server-canonical |
| `POST /api/events/:id/dive-offs` | [routes/events/dive-offs.js#L97](../routes/events/dive-offs.js) | Add dive-off round (tie-break). | Server-canonical |
| `PATCH /api/events/:id/dive-offs/:diveOffId` | [routes/events/dive-offs.js#L319](../routes/events/dive-offs.js) | Edit dive-off config. | Server-canonical |
| `POST /api/competitor/submit-list` | [routes/competitor.js#L37](../routes/competitor.js) | Diver submits dive sheet. | Optimistic (could buffer if late edit during meet) | P4 |
| `POST /api/competitor/confirm-list` | [routes/competitor.js#L203](../routes/competitor.js) | Diver confirms list final. | Server-canonical |
| `POST /api/competitor/pairings/:id/accept` | [routes/competitor.js#L541](../routes/competitor.js) | Synchro partner acceptance. | Server-canonical |
| `POST /api/competitor/pairings/:id/decline` | [routes/competitor.js#L625](../routes/competitor.js) | Synchro partner decline. | Server-canonical |
| `POST /api/coach/dive-lists/:event_id/:diver_id` | [routes/coach.js#L666](../routes/coach.js) | Coach submits dive list on behalf of diver. | Optimistic (likely happens during meet) | P4 |
| `POST /api/coach/dive-lists/:event_id/:diver_id/withdraw` | [routes/coach.js#L769](../routes/coach.js) | Coach withdraws diver. | Optimistic | P4 |
| `POST /api/coach/alert-preferences` | [routes/coach.js#L901](../routes/coach.js) | Push alert prefs. | Server-canonical (involves push subscription) |
| `POST /api/teams/:teamId/dive-lists` | [routes/teams.js#L335](../routes/teams.js) | Team-mode dive list. | Server-canonical |

### Session scheduler

The whole scheduler lives in [routes/sessions.js](../routes/sessions.js). Its
edits are all editor-gated and chunky (drag/drop, reflow). Recommend
**server-canonical** for all of them — schedule edits are pre-meet work and
an offline schedule edit conflicts with itself often (reflow algorithm).

- `POST /api/conflicts/dismiss` — dismiss a conflict warning
- `DELETE /api/conflicts/dismiss/:id` — undismiss
- `PUT /api/sessions/:id` — edit session metadata
- `POST /api/sessions/:id/duplicate` — clone
- `POST /api/sessions/:sessionId/blocks` — add block
- `PUT /api/blocks/:id` — edit block
- `DELETE /api/blocks/:id` — remove block
- `POST /api/blocks/reflow` — algorithmic reflow

All server-canonical, no migration.

---

## 3. Account / federation management (online-only, no migration)

Not meet-critical. These live in admin views, behind explicit "requires
internet" affordances if the user tries to use them offline.

### Auth

- `POST /api/auth/login` — password login
- `POST /api/auth/login/totp` — second factor
- `POST /api/auth/2fa/setup` — enable 2FA
- `POST /api/auth/2fa/confirm` — confirm 2FA setup
- `POST /api/auth/2fa/disable` — disable 2FA
- `POST /api/auth/register` — user signup
- `POST /api/auth/register-org` — federation signup
- `POST /api/auth/verify-email` — email verification
- `POST /api/auth/forgot-password` / `reset-password` / `confirm-email-change`
- `PUT /api/users/me/password` — change own password
- `POST /api/users/me/email/change-request` — change email flow
- `POST /api/users/me/locale` — change UI language preference
- `POST /api/users/me/delete` — account deletion
- `POST /api/users/me/claim-candidates` / `claim` — merge legacy profiles

**All server-canonical, no migration.** Offline login is the "don't go there
yet" boundary we agreed on.

### User / role / federation admin

- `PUT /api/users/:id/roles` — grant/revoke roles
- `POST /api/role-requests/:id/review` — approve/reject role request
- `PUT /api/users/:id/club` — set club affiliation
- `PUT /api/orgs/:id/status` — activate/disable federation (sysadmin)
- `POST /api/orgs/:id/clubs` / `PUT /api/clubs/:id` / `DELETE` — club admin
- `POST /api/orgs/:id/teams` / `PUT /api/teams/:id` / `DELETE` — team admin
- `POST /api/teams/:id/members` / `DELETE` — team membership
- `POST /api/events/:id/teams` / `DELETE` — event-team linkage
- `POST /api/orgs/:id/coach-links` — coach-diver link
- `DELETE /api/coach-links/:id` — unlink coach

**All server-canonical, no migration.**

### Reference data

- `POST /api/dive-directory` / `PUT` / `DELETE` — dive catalog edits
- `POST /api/templates` / `DELETE` — dive-list templates
- `POST /api/meets/:id/sponsor-logos` / `PUT` / `DELETE` / `reorder` — sponsor branding
- `PUT /api/meets/:id/sponsor-rotation` — sponsor rotation config

**Server-canonical.** These are pre-meet curation work.

### User-scoped preferences

- `PUT /api/users/me/dashboard` — diver dashboard widget config
- `PUT /api/users/me/judge-dashboard` — judge dashboard widget config
- `POST /api/push/subscribe` / `DELETE` — web-push subscription
- `POST /api/notifications/:id/acknowledge` — mark notification read

**Optimistic (low priority, P1 if cheap) —** user-scoped, no conflict
possible across users.

---

## Summary by phase

| Phase | Actions | Effort estimate |
|---|---|---|
| **P1** (universal outbox) | `submit_score` (prototype), `judge_signal`, dashboard prefs | 2-3 weeks |
| **P2** (optimistic UI) | Visual patterns applied to JudgeView | 2 weeks |
| **P3** (read caching) | Roster, dive lists, panel, schedule, dive directory pre-fetch | 1-2 weeks |
| **P4** (Control Room offline) | All meet-time HTTP writes + remaining socket events (set_active_diver, holds, referee actions, score corrections, mid-meet roster, withdrawals, attendance, coach-on-behalf list edits) | 3-4 weeks |
| **P5** (manual fallback) | Big-score display on judge phones, operator manual-entry UI in Control Room, MANUAL-VS-SYNC-001 reconciliation | 1-2 weeks |
| **—** (online-only) | Auth, federation admin, scheduler, reference data, advance/seed | No migration |

## Approximate counts

- **Socket events:** 14 total. 11 meet-critical (10 write + 1 ack), 3 read-only.
- **HTTP writes:** ~70 total. ~18 meet-time-critical, ~30 pre-meet setup
  (online-required by design), ~22 account/federation admin (online-only).

P1+P4 migrates ~29 write surfaces total. P5 adds 1 surface (operator manual
entry) and reuses the P4 conflict-resolution pipeline.

## Next step

P1 design is locked in [offline-p1-design.md](./offline-p1-design.md). The
five risks raised in the original Phase 0 draft are resolved above as
DEC-01 through DEC-05. P1 code is the next deliverable.
