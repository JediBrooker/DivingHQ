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
  `guardControl` in `routes/socket.js`: `socketRequireRole(socket)`
  (signed in, not in maintenance mode), then `socketCanManageEvent`
  (`lib/middleware.js`: a UUID event id, token version current, event in
  the caller's org, one of the control roles or a delegate of the event),
  then a per-(action, user) rate limit. `claim_event_control` runs the same
  two gates without the rate limit.
- `submit_score` and `judge_signal` pass `socketRequireRole(socket)` and
  then do their own checks (judge/referee role or a seat on the event's
  panel, token version).
- `notification:ack` needs no role and asks `socketMaintenanceBlocked`
  directly.

Maintenance mode is the one check, `socketMaintenanceBlocked`, which
`socketRequireRole` and `socketCanManageEvent` both run (details below the
client-to-server heading).

Refusals from those gates arrive as `unauthorized` (see below) and, where
the client passed an ack callback, as `{ ok: false, error }` on the ack.

---

## Server → client (`io.emit` or `socket.emit`)

| Event | Payload | Sent when |
|---|---|---|
| `state_update`            | `{ event_id, diverName, country_code, club_name, club_code, diveCode, description, round_number, status, … }` | A diver becomes active in the Control Room (to room `event:<id>`), or in reply to `get_active_diver`. On connect, a signed-in socket also gets the current diver of each event it judges on (`event_judges`) or drives (a meet_manager / referee / org_admin role in the host org), all of them for a sysadmin; nobody else gets a replay. The judge screen takes the same dive arriving again as a replay, not a new diver: it keeps the keypad as it was and re-reads the dive's scores from `GET /api/events/:id/dive-scores`, so a judge who has scored stays shut after a reconnect or a reload. A diver for an event the judge screen has just shown as finished is ignored, until the Live adopt puts that event back in its URL. |
| `score_received`          | `{ event_id, competitor_id, round_number, score, judge_id, judge_number }`, built from the checked values, never an echo of the client's object; `score` is the value stored, which a referee Failed or cap call on the dive may have brought down | A judge submits a score. Broadcast to everyone watching the meet. When the judge's value lost to an earlier manual entry, only the judge's own socket gets it, with the operator's `score` and `superseded_by: 'manual_entry'`. |
| `score_rejected`          | `{ reason: 'not_authenticated' \| 'insufficient_role' \| 'maintenance' \| 'token_revoked' \| 'not_on_panel' \| 'event_not_live' \| 'bad_payload' \| 'bad_round' \| 'bad_score' \| 'rate_limited' \| 'server_error', message?: string }` | A submit_score from this socket failed validation. Sent only to the offending socket; the submit's ack carries the same `reason` as `error`. `maintenance` means the platform is in maintenance mode (non-sysadmins can't score until it's lifted; the judge's outbox keeps the mark, retries a few times, then holds it as failed for a manual resend). `bad_score` covers anything that isn't a number or a plain numeric string in 0-10 half points, `null` and `""` included. `event_not_live` is final: the judge's outbox closes the entry on it (status `rejected`, no retries, left out of the offline banner) and the judge screen says the event has finished and which score wasn't recorded. A refusal that comes back while the judge is on another screen (the outbox drains on every route) is said the next time the judge screen opens; the entry is marked acknowledged once it has been, so it's said once. |
| `score_corrected`         | `{ event_id, competitor_id, round_number, score_id, old_score, new_score, reason, actor_user_id }`; after a referee call just `{ event_id, competitor_id, round_number, reason: 'referee:failed' \| 'referee:cap(<n>)' }` | A score was changed by hand over HTTP: a correction (`PUT /api/scores/:id`) or a conflict settled with the judge's value (`POST /api/conflicts/:id/resolve`). Only someone the host-org score rule lets in can do either (`scoreAuthority` in `lib/middleware.js`: the host club's, the host region's, or for its own meets the org's admins and meet managers, never another level's). Also sent after a referee Failed or Cap, right behind `referee_action_failed` / `referee_action_cap`. To room `event:<event_id>`, so other operators and the scoreboard re-pull; the scoreboard drops its cached copies of the event's score reads first (`invalidateEventScores`), or a correction inside the cache's 5s (live) or 24h (recap) window re-read the old numbers. |
| `final_score_announced`   | Whatever the announcer sent: `{ event_id, standings }` from the Control Room | Announcer presses "Announce" in the Control Room. The scoreboard refetches its standings on receipt. |
| `referee_action_failed`   | `{ event_id, competitor_id, round_number }`, built from the checked values, never an echo of the caller's object | Referee marks a dive failed (WA 8.6.6: 0 points). The server has already set every stored score for the dive to 0 and holds any award still to come to 0. Screens already showing the dive's awards hold them to the call (`heldAward` in `useScoreTrim.js`): the Control Room pool's tiles (`applyRefereeCall`), the scoreboard's live pills and dive total, the judge screen's panel. `score_corrected` follows for History and Standings. |
| `referee_action_cap`      | `{ event_id, competitor_id, round_number, cap_value }`, built from the checked values; `cap_value` is the maximum actually applied (the Control Room sends 2.0) | Referee declares a maximum award (WA 8.4.7): every stored score above `cap_value` comes down to it, and later awards are held to it. Same screens as `referee_action_failed` bring the awards they show down to `cap_value`. `score_corrected` follows. |
| `referee_action_redive`   | `{ event_id, competitor_id, round_number }`, built from the checked values | Referee orders a re-dive. The judge screen reopens its keypad and clears the panel for that dive, the Control Room resets the pool's tiles and disarms Next (`applyRedive`), and the scoreboard clears its live pills. |
| `record_broken`           | `{ event_id, round_number, scope: 'personal' \| 'club' \| 'region' \| 'federation' \| 'continental', scope_id, scope_name, scope_code, official, gender: 'Male' \| 'Female', height, dive_code, position, score, prev_score \| null, holder_id, holder_name, prev_holder_name \| null }` | A completed individual dive set one or more records (`lib/records.js` `checkAndApplyRecords`), or a dive that was already scored went up and now holds a book (`recomputeRecordKeys`, after a score correction, a resolved conflict, a manual-entry fix, a judge scoring again after a redive). A dive whose total went down is never announced; its books are replayed quietly and the scoreboard cache dropped. A dive worth 0 points (a referee Failed call, WA 8.6.6) never sets or keeps a record: after a Failed call on a record holder the replay hands the book back to the mark it beat, or empties it. One emit per book, to room `event:<event_id>`, server-only. `scope_code` is the short label (club or region short code, country code, or the continent key); `prev_score` is null for a first mark; `official` is false for an unclaimed region or country. The scoreboard cache is dropped just before the emit. `ScoreboardView` turns club / region / federation / continental marks with a `prev_score` into the record chip (standard scoreboard and recap only, never broadcast or overlay), and drops any mark it already had in the same book (`scope`, `scope_id`, `gender`, `height`, `dive_code`, `position`), since that dive doesn't hold it any more; the same marks ride on `GET /api/scoreboard/:id` and `GET /api/archive/:id/results` as `records` for anyone who loads the page later. |
| `meet_held`               | `{ event_id, reason \| null, since: <ms epoch> }` | Operator holds the meet, or a new client joins while a hold is active. |
| `roster_changed`          | `{ event_id, competitor_id, change: 'withdrawn' }` | A coach withdrew a diver from the event (`POST /api/coach/dive-lists/:event_id/:diver_id/withdraw`, allowed while it's Live). Sent to room `event:<event_id>`, server-only, after the scoreboard cache is dropped. Ids only: spectators share the room and the withdrawal reason can be medical. `ControlViewV2` re-reads that pool's roster (`refreshPoolRoster` / `rebaseQueue`: the stage stays on the same diver, even the withdrawn one mid-dive) and warns the operator with the diver's name from the fresh roster. The pool's queue only holds competing rows (`competingQueue`), and advancing steps over withdrawn rows and reserves regardless (`nextQueueIndex`). |
| `meet_resumed`            | `{ event_id }` | Operator resumes the meet. |
| `venue.scoreboard_state`  | Canonical venue payload from `lib/venue-state.js` | Emitted to `venue:<event_id>` subscribers after subscribe, active-diver changes, score changes, score announce, hold, and resume. Used by hardware bridges. |
| `unauthorized`            | `{ reason: 'not_authenticated' \| 'insufficient_role' \| 'maintenance' \| 'missing_event_id' \| 'bad_event_id' \| 'event_not_found' \| 'wrong_org' \| 'token_revoked' \| 'server_error' }` | A privileged event was refused: anonymous or under-roled socket, maintenance mode (non-sysadmins), an `event_id` that's missing or not a UUID, an event outside the socket's org, a revoked session, or a server-side failure while checking. The Control Room events also ack `{ ok: false, error }`. |
| `referee_action_rejected` | `{ reason: 'bad_round' \| 'bad_cap_value' \| 'event_not_live' \| 'server_error', message?: string }` | A `referee_failed_dive` / `referee_cap_scores` / `referee_redive` passed the gate but couldn't be applied: `event_not_live` when the event isn't Live. Sent only to the offending socket; the action's ack carries the same reason as `error`. |
| `conflict_pending`        | `{ conflict_id, action_type: 'submit_score_vs_manual_entry', actor_id, actor_local_time, target: { event_id, competitor_id, round_number, judge_id }, existing_value: { score, source: 'manual_entry' }, proposed_value: { score, source: 'judge_direct' }, resolution_required_by: 'operator', created_at }` | A judge's (usually offline-queued) score arrived for a slot the operator already filled by manual entry, with a different value. The operator's value stands; the Control Room's review tray shows the mismatch. To room `event:<event_id>`. The judge's own socket gets a `score_received` with `superseded_by: 'manual_entry'`. |
| `judge_signal`            | `{ event_id, competitor_id, round_number, judge_id, judge_number, signaled }` | A panel judge toggled "Signal Referee" on the keypad. `judge_id`/`judge_number` come from `event_judges`, never the wire. To room `event:<event_id>`; the Control Room highlights that judge's tile. |
| `event_control_granted`   | `{ event_id }` | This socket's `claim_event_control` got the advisory lease (it was free, stale or already ours). To the claiming socket only. |
| `event_control_conflict`  | `{ event_id, sameUser }` | Another live socket already holds the lease. To the claiming socket; `sameUser` is true when it's the same account in another window. The lease never blocks an action, it only warns. |
| `event_control_contested` | `{ event_id, sameUser }` | Someone else just tried to claim a lease this socket holds. To the holder only. |
| `notification`            | `{ id, category, title, body, data, action_url, expires_at, created_at }` | `lib/push.js` `sendNotification` fanned a notification out. To room `user:<id>` (every socket joins its own user room at connect), in parallel with Web Push. `data.actions` carries any action buttons (the referee sign-off has Approve/Deny). The dashboard refetches its bundle on a `referee_signoff` one so the referee desk and its chip show the request straight away. An `event_live` notice with `data.role: 'judge'` also sends a judge screen that's still waiting for an event to look for its Live panel. |
| `referee_signoff_response` | `{ request_id, decision: 'approved' \| 'declined', by_user_id }` | The referee answered a dive-order sign-off request (the in-app banner, the notification's own Approve/Deny, or the handoff code). Sent through `push.emitEvent` to rooms `event:<event_id>`, `user:<requested_by>` and `user:<referee>` in one emit, so the manager's SignoffModal leaves its waiting state and the referee's open dashboard drops the request. The user room is the one that matters: sign-off happens while the event is Upcoming and the Control Room only joins `event:<id>` once it's Live. The dialog also polls `GET /api/events/:id/dive-order/sign-off/request/:requestId` every 3 s (and on reconnect) while it waits, so a missed message still lands. |
| `schedule:conflict_dismissed` | `{ meet_id, action: 'dismiss' \| 'undismiss' }` | A scheduler conflict was dismissed or un-dismissed via the editor-only API. Drawer clients refetch `/api/meets/:id/conflicts` on receipt. The broadcast is intentionally minimal and does not include personnel labels. |
| `schedule:block_updated`      | `{ meet_id, session_id, block_id?, created?, session_updated? }` | A Phase 3 manual edit landed (`PUT /api/blocks/:id`, `POST /api/sessions/:sessionId/blocks`, or `PUT /api/sessions/:id`). Other timeline tabs refetch `/sessions` and update inline. The broadcast is intentionally minimal; conflict details stay behind `/api/meets/:id/conflicts`. |
| `schedule:block_deleted`      | `{ meet_id, session_id, block_id }` | A schedule block was deleted via `DELETE /api/blocks/:id`. Other tabs refetch the schedule. |
| `schedule:session_duplicated` | `{ meet_id, source_session_id, session_id }` | A session was cloned forward via `POST /api/sessions/:id/duplicate`. Other tabs refetch `/sessions`. |
| `event_status_changed`        | `{ event_id, org_id, from, to }` | `PUT /api/events/:id/status` flipped an event (Upcoming / Live / Completed). Sent to rooms `event:<id>`, `org:<host org>`, `org:<each participating org>` and `sysadmins` (every signed-in socket joins `org:<its org>`, and a sysadmin also `sysadmins`, on connect), the people whose dashboard pulse lists the event. The dashboard refetches its pulse; the spectator scoreboard patches its event row so it flips between the live board and the recap; the diver's meet-day page (`/me/meet/<event>`) re-reads its bundle, so its LIVE pill, next dive and targets follow a finalise (it re-reads on reconnect too, for a flip it missed); the Control Room reconciles its event list and stands up (or drops) live pools. On the judge screen, a screen with no event yet (`/judge`, opened before the start) looks for its Live panel when `to` is `Live` (an event it had shown as finished going back to Live takes that notice down first, so an undone finalise with no diver announced doesn't leave the keypad shut), and the event it's judging going off Live (or straight to Completed) clears the diver, locks the keypad and says the event is over, then waits for the next Live panel the same way. The broadcast can be missed, so the judge screen also asks `GET /api/judge/my-events` on open, reconnect and wake, and a score refused with `event_not_live` lands on the same notice. |
| `role_request_created`        | `{ org_id, requested_role }` | Someone asked for a role: at signup (`POST /api/auth/register`) or later from their profile (`POST /api/role-requests`). The dashboard's pulse strip refetches its pending count. Public broadcast, no names; who may see the request is decided by the REST fetch. |
| `schedule:shifted`            | `{ meet_id, shifted_block_ids: [...], delta_seconds }` | Phase 4 live re-flow committed — `POST /api/blocks/reflow` shifted every listed block forward by `delta_seconds` and appended a `schedule_block_shifts` ledger row per block. Timeline tabs refetch `/api/meets/:id/sessions` so the new windows appear. Public broadcast, with no personnel labels. |

Not emitted, despite what you might read in `lib/idempotency.js`'s usage
comment: `action_result` and `error`. The one socket write that's
idempotent (`submit_score`) replays a cached result as `score_received`.

---

## Client → server (`socket.on` handlers)

The meet-control events below go through `socketCanManageEvent`
(`lib/middleware.js`). The event has to be in the socket's org, and the
socket needs one of the listed roles **or** has to be a delegate for that
event: an `event_managers` row, or admin of the club hosting the event's
meet (`meets.host_club_id`, migration 087). That second path is how a club
in a country with no federation on DivingHQ runs its own meets.

Every async handler runs through a small wrapper in `routes/socket.js`
(`on(name, handler)`): a throw is logged and, when the client passed an
ack callback, answered with `{ ok: false, error: 'server_error' }`. A
rejected socket listener used to be an unhandled rejection, which ends a
Node 20 process. An id has to be a UUID string (`isUuid`, `lib/uuid.js`;
an array holding one isn't), and a malformed `event_id` is refused before
any DB work: `unauthorized` with reason `bad_event_id` on the Control
Room events and `claim_event_control`, `bad_payload` on `submit_score`
(which checks `competitor_id` the same way), and silently everywhere
else.

Maintenance mode (the `maintenance` feature flag) refuses every socket
write from a non-sysadmin. The check is `socketMaintenanceBlocked`
(`lib/middleware.js`): `socketRequireRole(socket)` runs it at the top of
the Control Room events (`guardControl`), `submit_score`, `judge_signal`
and `claim_event_control`, `socketCanManageEvent` runs it again with the
event check, and `notification:ack`, which needs no role, asks it
directly. A refused write gets ack `{ ok: false, error: 'maintenance' }`
(`score_rejected` reason `maintenance` for a score).

| Event | Required role | Payload | Notes |
|---|---|---|---|
| `subscribe_event`         | none (any socket)             | `{ event_id }` | Joins room `event:<event_id>`. How a spectator, judge or Control Room gets that event's broadcasts. The id must be a UUID (anything else is ignored), and one socket sits in at most 50 event rooms: joining a 51st drops the room it touched longest ago (joins through `get_active_diver` / `get_meet_hold` count as touches). |
| `claim_event_control`     | `socketCanManageEvent` (control roles or delegate) | `{ event_id }` | Asks for the advisory per-event lease. Answered with `event_control_granted`, or `event_control_conflict` (and `event_control_contested` to the holder). Silently ignored for anyone who couldn't drive the event; a malformed `event_id` gets `unauthorized` with reason `bad_event_id`. |
| `judge_signal`            | signed in, seat on the event's panel (`event_judges`) | `{ event_id, competitor_id, round_number, signaled }` | Rate-limited per user, token version re-checked. Rebroadcast as `judge_signal` to the event room. A caller not on the panel, or a malformed `event_id` / `competitor_id`, is dropped silently. |
| `set_active_diver`        | meet_manager / referee / org_admin / sysadmin | Roster row + `diverName`, `diveCode`, `eventName`, `status` (built by `activeDiverPayload` in `src/lib/activeDiver.js`) | The server keeps and broadcasts a public copy: `paid_entry`, `competitor_org_id`, `competitor_org_name` and `dive_list_id` are dropped, and `club_name` / `club_code` are nulled unless the diver's club is approved (`clubs.status = 'active'`). That copy goes in `activeDivers[event_id]` (and `event_live_state`) so late-joiners see it. Readers run `normaliseActiveDiver` so a replayed payload without the display fields still renders. |
| `get_active_diver`        | none (any socket)             | `{ event_id }` | Read-only — joins the room (same rules as `subscribe_event`) and returns the current state to the asking socket only. |
| `submit_score`            | judge / referee / sysadmin    | `{ event_id, competitor_id, round_number, score, dive_id?, judge_number? }` | Server-trusted `judge_id = socket.userId`. Rate-limited (60/min/judge). Validates 0–10 in 0.5 steps, confirms event_judges membership. A sync that differs from an operator's manual entry is refused but still acked, `{ ok: true, superseded_by: 'manual_entry', response }` with the operator's value, and cached under its `idempotency_key` so a retry replays it. The idempotency hash covers the submission fields only (`event_id`, `competitor_id`, `round_number`, `dive_id`, `judge_id`, `judge_number`, `score`), and `actor_local_time` is kept only when it's a string. |
| `announce_score`          | meet_manager / referee / org_admin / sysadmin | `{ event_id, standings }` (the Control Room sends the focused pool's standings) | Re-broadcast as `final_score_announced`. `event_id` is required: the manage-event gate reads it, and a payload without it is refused as `missing_event_id`. |
| `referee_failed_dive`     | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number }` | Zeroes the scores already in, and stores the call on the dive-list row (`referee_call = 'failed'`, migration 102) so every award that lands afterwards is stored as 0 too (WA 8.6.6). Live events only, like `submit_score`: otherwise it acks `{ ok: false, error: 'event_not_live' }` and sends `referee_action_rejected`, and the same goes for cap and redive. Logged to `score_audit_log`, one row per score, or a single row with no judge when nobody has scored yet. The dive's record books are replayed (`recomputeRecordKeys`), so a record it set goes back to whoever held it before, or comes off the book if nobody else has done that dive: a 0-point dive never holds a record. The room hears `referee_action_failed` then `score_corrected`. |
| `referee_cap_scores`      | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number, cap_value }` | Caps the scores already in and stores the cap on the dive (`referee_call = 'cap'`, `referee_cap`), so a later award above it is stored as the cap (WA 8.4.7). Logged the same way as a failed dive. Record books replayed, as for a failed dive. The room hears `referee_action_cap` (with the `cap_value` applied) then `score_corrected`. |
| `referee_redive`          | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number }` | Logged. Clears any Failed or cap call on the dive. Marks the round's score rows `status = 'redive'` until each judge scores again, so records don't count the dive until the whole panel is fresh; any record the old total held is replayed away. |
| `meet_hold`               | meet_manager / referee / org_admin / sysadmin | `{ event_id, reason? }` | Updates in-memory `meetHolds[event_id]`. |
| `meet_resume`             | meet_manager / referee / org_admin / sysadmin | `{ event_id }` | Clears the hold. |
| `get_meet_hold`           | none (any socket)             | `{ event_id }` | Read-only — joins the room (same rules as `subscribe_event`) and returns the current hold state to the asking socket. |
| `notification:ack`        | any signed-in socket          | `{ id }` | Marks the caller's own notification `acknowledged` (the UPDATE is scoped to `socket.userId`). Dropped silently in maintenance mode, like its HTTP twin `POST /api/notifications/:id/acknowledge`. |
| `subscribe_venue`         | none (any socket)             | `{ event_id }` | Joins `venue:<event_id>` and immediately emits a fresh `venue.scoreboard_state` snapshot for hardware bridges. |
| `disconnect`              | (built-in)                    | — | Frees the socket's slot in the per-IP connection count and any Control Room lease it held (`clearEventControllersBySocket`). Rooms go with the socket. |

---

## Adding a new event

1. **Define the role** required to emit it. If it mutates server-
   side state, gate it at the top of the handler: event-scoped
   Control Room writes through `guardControl` (`socketRequireRole`,
   then `socketCanManageEvent`, then the rate limit), anything else
   through `socketRequireRole` and an explicit role check like
   `submit_score`'s. Either way it reaches the maintenance-mode check;
   don't roll your own. Register it with the `on(name, handler)`
   wrapper, not `socket.on`, so a throw is answered instead of
   killing the process. Read-only listeners can stay anonymous.
2. **Validate the payload** before doing anything. The
   `submit_score` handler is the template — it rejects with a
   typed `score_rejected` event so the client can react instead of
   guessing why nothing happened.
3. **Add a row here**, updating both tables if the event has both
   directions.
4. **Update the integration test** at `test/integration.test.js`
   to assert the gate works for the unauthenticated case.
