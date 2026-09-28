# Socket.IO event registry

Every event the server listens for or emits, with the auth gate, the
expected payload shape, and the broadcast scope. If you add a new
event, add it here in the same commit — agents reviewing the wire
should be able to see the whole surface in one file.

The handshake auth is **soft**: spectators connect with no token (the SPA
authenticates off the httpOnly session cookie; a `token` in the handshake
auth also works) and that's intentional, but every privileged event has to
check the caller before mutating anything. How that's done today:

- The Control Room events (`set_active_diver`, `announce_score`, the three
  `referee_*` actions, `meet_hold`, `meet_resume`) go through
  `guardControl` in `routes/socket.js`, which is `socketCanManageEvent`
  (`lib/middleware.js`: signed in, token version current, event in the
  caller's org, one of the control roles or a delegate of the event) plus
  a per-(action, user) rate limit. `claim_event_control` uses
  `socketCanManageEvent` directly.
- `submit_score` and `judge_signal` do their own checks (signed in,
  judge/referee role or a seat on the event's panel, token version).
- `socketRequireRole` exists in `lib/middleware.js` and carries the
  maintenance-mode check, but **no handler calls it**. So maintenance mode
  does not block socket writes at the moment; only the HTTP
  `maintenanceGate` in `server.js` does. If you close that gap, update this
  paragraph and the matching one in `AGENTS.md`.

Refusals from those gates arrive as `unauthorized` (see below) and, where
the client passed an ack callback, as `{ ok: false, error }` on the ack.

---

## Server → client (`io.emit` or `socket.emit`)

| Event | Payload | Sent when |
|---|---|---|
| `state_update`            | `{ event_id, diverName, country_code, club_name, club_code, diveCode, description, round_number, status, … }` | A diver becomes active in the Control Room, or a new client connects (rebroadcast on demand). |
| `score_received`          | The full score-submit payload + `judge_id`, `judge_number` | A judge submits a score. Broadcast to everyone watching the meet. |
| `score_rejected`          | `{ reason: 'not_authenticated' \| 'insufficient_role' \| 'not_on_panel' \| 'bad_payload' \| 'bad_round' \| 'bad_score' \| 'rate_limited', message?: string }` | A submit_score from this socket failed validation. Sent only to the offending socket. |
| `score_corrected`         | The new score row from `PUT /api/scores/:id` | A referee corrects a score via HTTP (the socket bus rebroadcasts so other operators see it live). |
| `final_score_announced`   | Whatever the announcer sent | Announcer presses "Announce" in the Control Room. |
| `referee_action_failed`   | `{ event_id, competitor_id, round_number, … }` | Referee marks a dive failed. |
| `referee_action_cap`      | `{ event_id, competitor_id, round_number, cap_value, … }` | Referee caps the panel's scores at `cap_value` (default 2.0). |
| `referee_action_redive`   | `{ event_id, competitor_id, round_number, … }` | Referee orders a re-dive. |
| `record_broken`           | `{ event_id, round_number, scope: 'personal' \| 'club' \| 'region' \| 'federation' \| 'continental', scope_id, scope_name, scope_code, official, gender: 'Male' \| 'Female', height, dive_code, position, score, prev_score \| null, holder_id, holder_name, prev_holder_name \| null }` | A completed individual dive set one or more records (`lib/records.js` `checkAndApplyRecords`), or a dive that was already scored went up and now holds a book (`recomputeRecordKeys`, after a score correction, a resolved conflict, a manual-entry fix, a judge scoring again after a redive). A dive whose total went down is never announced; its books are replayed quietly and the scoreboard cache dropped. One emit per book, to room `event:<event_id>`, server-only. `scope_code` is the short label (club or region short code, country code, or the continent key); `prev_score` is null for a first mark; `official` is false for an unclaimed region or country. The scoreboard cache is dropped just before the emit. `ScoreboardView` turns club / region / federation / continental marks with a `prev_score` into the record chip (standard scoreboard and recap only, never broadcast or overlay), and drops any mark it already had in the same book (`scope`, `scope_id`, `gender`, `height`, `dive_code`, `position`), since that dive doesn't hold it any more; the same marks ride on `GET /api/scoreboard/:id` and `GET /api/archive/:id/results` as `records` for anyone who loads the page later. |
| `meet_held`               | `{ event_id, reason \| null, since: <ms epoch> }` | Operator holds the meet, or a new client joins while a hold is active. |
| `meet_resumed`            | `{ event_id }` | Operator resumes the meet. |
| `venue.scoreboard_state`  | Canonical venue payload from `lib/venue-state.js` | Emitted to `venue:<event_id>` subscribers after subscribe, active-diver changes, score changes, score announce, hold, and resume. Used by hardware bridges. |
| `unauthorized`            | `{ reason: 'not_authenticated' \| 'missing_event_id' \| 'token_revoked' \| 'event_not_found' \| 'wrong_org' \| 'insufficient_role' \| 'maintenance' }` | A privileged event was refused by `socketCanManageEvent` (or `socketRequireRole`, which only sends `maintenance`/`not_authenticated`/`insufficient_role` and isn't called today). Sent only to the offending socket. On `token_revoked` the socket is also disconnected. |
| `referee_action_rejected` | `{ reason: 'bad_round' \| 'bad_cap_value' \| 'server_error', message?: string }` | A `referee_failed_dive` / `referee_cap_scores` / `referee_redive` passed the gate but couldn't be applied. Sent only to the offending socket. |
| `conflict_pending`        | `{ conflict_id, action_type: 'submit_score_vs_manual_entry', actor_id, actor_local_time, target: { event_id, competitor_id, round_number, judge_id }, existing_value: { score, source: 'manual_entry' }, proposed_value: { score, source: 'judge_direct' }, resolution_required_by: 'operator', created_at }` | A judge's (usually offline-queued) score arrived for a slot the operator already filled by manual entry, with a different value. The operator's value stands; the Control Room's review tray shows the mismatch. To room `event:<event_id>`. The judge's own socket gets a `score_received` with `superseded_by: 'manual_entry'`. |
| `judge_signal`            | `{ event_id, competitor_id, round_number, judge_id, judge_number, signaled }` | A panel judge toggled "Signal Referee" on the keypad. `judge_id`/`judge_number` come from `event_judges`, never the wire. To room `event:<event_id>`; the Control Room highlights that judge's tile. |
| `event_control_granted`   | `{ event_id }` | This socket's `claim_event_control` got the advisory lease (it was free, stale or already ours). To the claiming socket only. |
| `event_control_conflict`  | `{ event_id, sameUser }` | Another live socket already holds the lease. To the claiming socket; `sameUser` is true when it's the same account in another window. The lease never blocks an action, it only warns. |
| `event_control_contested` | `{ event_id, sameUser }` | Someone else just tried to claim a lease this socket holds. To the holder only. |
| `event_status_changed`    | `{ event_id, org_id, from, to }` | An event's status flipped (Upcoming / Live / Completed, via `routes/events/index.js`). Global `io.emit`, no sensitive data; dashboards refetch their pulse counts through their own API gates. |
| `notification`            | `{ id, category, title, body, data, action_url, expires_at, created_at }` | `lib/push.js` `sendNotification` fanned a notification out. To room `user:<id>` (every socket joins its own user room at connect), in parallel with Web Push. `data.actions` carries any action buttons (the referee sign-off has Approve/Deny). |
| `referee_signoff_response` | `{ request_id, decision: 'approved' \| 'declined', by_user_id }` | The referee answered a dive-order sign-off request (the in-app banner, the notification's own Approve/Deny, or the handoff code). Sent through `push.emitEvent` to room `event:<event_id>` so the manager's SignoffModal leaves its waiting state. |

Not emitted, despite what you might read in `lib/idempotency.js`'s usage
comment: `action_result` and `error`. The one socket write that's
idempotent (`submit_score`) replays a cached result as `score_received`.
| `schedule:conflict_dismissed` | `{ meet_id, action: 'dismiss' \| 'undismiss' }` | A scheduler conflict was dismissed or un-dismissed via the editor-only API. Drawer clients refetch `/api/meets/:id/conflicts` on receipt. The broadcast is intentionally minimal and does not include personnel labels. |
| `schedule:block_updated`      | `{ meet_id, session_id, block_id?, created?, session_updated? }` | A Phase 3 manual edit landed (`PUT /api/blocks/:id`, `POST /api/sessions/:sessionId/blocks`, or `PUT /api/sessions/:id`). Other timeline tabs refetch `/sessions` and update inline. The broadcast is intentionally minimal; conflict details stay behind `/api/meets/:id/conflicts`. |
| `schedule:block_deleted`      | `{ meet_id, session_id, block_id }` | A schedule block was deleted via `DELETE /api/blocks/:id`. Other tabs refetch the schedule. |
| `schedule:session_duplicated` | `{ meet_id, source_session_id, session_id }` | A session was cloned forward via `POST /api/sessions/:id/duplicate`. Other tabs refetch `/sessions`. |
| `role_request_created`        | `{ org_id, requested_role }` | Someone asked for a role: at signup (`POST /api/auth/register`) or later from their profile (`POST /api/role-requests`). The dashboard's pulse strip refetches its pending count. Public broadcast, no names; who may see the request is decided by the REST fetch. |
| `schedule:shifted`            | `{ meet_id, shifted_block_ids: [...], delta_seconds }` | Phase 4 live re-flow committed — `POST /api/blocks/reflow` shifted every listed block forward by `delta_seconds` and appended a `schedule_block_shifts` ledger row per block. Timeline tabs refetch `/api/meets/:id/sessions` so the new windows appear. Public broadcast, with no personnel labels. |

---

## Client → server (`socket.on` handlers)

The meet-control events below go through `socketCanManageEvent`
(`lib/middleware.js`). The event has to be in the socket's org, and the
socket needs one of the listed roles **or** has to be a delegate for that
event: an `event_managers` row, or admin of the club hosting the event's
meet (`meets.host_club_id`, migration 087). That second path is how a club
in a country with no federation on DivingHQ runs its own meets.

| Event | Required role | Payload | Notes |
|---|---|---|---|
| `subscribe_event`         | none (any socket)             | `{ event_id }` | Joins room `event:<event_id>`. How a spectator, judge or Control Room gets that event's broadcasts. |
| `claim_event_control`     | `socketCanManageEvent` (control roles or delegate) | `{ event_id }` | Asks for the advisory per-event lease. Answered with `event_control_granted`, or `event_control_conflict` (and `event_control_contested` to the holder). Silently ignored for anyone who couldn't drive the event. |
| `notification:ack`        | signed in                     | `{ id }` | Marks one of the caller's own notifications `acknowledged` (scoped to `user_id`, so someone else's id is a no-op). The HTTP `POST /api/notifications/:id/acknowledge` does the same. |
| `judge_signal`            | signed in, seat on the event's panel (`event_judges`) | `{ event_id, competitor_id, round_number, signaled }` | Rate-limited per user, token version re-checked. Rebroadcast as `judge_signal` to the event room. A caller not on the panel is dropped silently. |
| `set_active_diver`        | meet_manager / referee / org_admin / sysadmin | Roster row + status | Persists to in-memory `activeDivers[event_id]` so late-joiners see it. |
| `get_active_diver`        | none (any socket)             | `{ event_id }` | Read-only — returns the current state to the asking socket only. |
| `submit_score`            | judge / referee / sysadmin    | `{ event_id, competitor_id, round_number, score, dive_id?, judge_number? }` | Server-trusted `judge_id = socket.userId`. Rate-limited (60/min/judge). Validates 0–10 in 0.5 steps, confirms event_judges membership. |
| `announce_score`          | meet_manager / referee / org_admin / sysadmin | Free-form announce payload | Re-broadcast as `final_score_announced`. |
| `referee_failed_dive`     | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number }` | Logged to `score_audit_log`. The dive's record books are replayed (`recomputeRecordKeys`), so a record it set goes back to whoever held it before. |
| `referee_cap_scores`      | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number, cap_value }` | Logged. Record books replayed, as for a failed dive. |
| `referee_redive`          | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number }` | Logged. Marks the round's score rows `status = 'redive'` until each judge scores again, so records don't count the dive until the whole panel is fresh; any record the old total held is replayed away. |
| `meet_hold`               | meet_manager / referee / org_admin / sysadmin | `{ event_id, reason? }` | Updates in-memory `meetHolds[event_id]`. |
| `meet_resume`             | meet_manager / referee / org_admin / sysadmin | `{ event_id }` | Clears the hold. |
| `get_meet_hold`           | none (any socket)             | `{ event_id }` | Read-only — returns the current hold state to the asking socket. |
| `subscribe_venue`         | none (any socket)             | `{ event_id }` | Joins `venue:<event_id>` and immediately emits a fresh `venue.scoreboard_state` snapshot for hardware bridges. |
| `disconnect`              | (built-in)                    | — | Just logs; no state cleanup needed. |

---

## Adding a new event

1. **Define the role** required to emit it. If it mutates server-
   side state, gate it at the top of the handler: event-scoped
   Control Room writes through `guardControl` (which is
   `socketCanManageEvent` plus the rate limit), anything else with
   an explicit signed-in and role check like `submit_score`'s.
   Remember neither path checks maintenance mode today (see the top
   of this file). Read-only listeners can stay anonymous.
2. **Validate the payload** before doing anything. The
   `submit_score` handler is the template — it rejects with a
   typed `score_rejected` event so the client can react instead of
   guessing why nothing happened.
3. **Add a row here**, updating both tables if the event has both
   directions.
4. **Update the integration test** at `test/integration.test.js`
   to assert the gate works for the unauthenticated case.
