# Socket.IO event registry

Every event the server listens for or emits, with the auth gate, the
expected payload shape, and the broadcast scope. If you add a new
event, add it here in the same commit — agents reviewing the wire
should be able to see the whole surface in one file.

The handshake auth is **soft**: spectators connect with no token and
that's intentional, but every privileged event must call
`socketRequireRole(socket, [...])` before mutating anything. See
`lib/middleware.js` for the helper and `AGENTS.md` for the rule.

---

## Server → client (`io.emit` or `socket.emit`)

| Event | Payload | Sent when |
|---|---|---|
| `state_update`            | `{ event_id, diverName, country_code, club_name, club_code, diveCode, description, round_number, status, … }` | A diver becomes active in the Control Room, or a new client connects (rebroadcast on demand). |
| `score_received`          | The full score-submit payload + `judge_id`, `judge_number` | A judge submits a score. Broadcast to everyone watching the meet. |
| `score_rejected`          | `{ reason: 'not_authenticated' \| 'insufficient_role' \| 'not_on_panel' \| 'bad_payload' \| 'bad_round' \| 'bad_score' \| 'rate_limited', message?: string }` | A submit_score from this socket failed validation. Sent only to the offending socket. |
| `score_corrected`         | The new score row from `PUT /api/scores/:id` | A referee corrects a score via HTTP (the socket bus rebroadcasts so other operators see it live). |
| `final_score_announced`   | Whatever the announcer sent: `{ event_id, standings }` from the Control Room | Announcer presses "Announce" in the Control Room. The scoreboard refetches its standings on receipt. |
| `referee_action_failed`   | `{ event_id, competitor_id, round_number, … }` | Referee marks a dive failed. |
| `referee_action_cap`      | `{ event_id, competitor_id, round_number, cap_value, … }` | Referee caps the panel's scores at `cap_value` (default 2.0). |
| `referee_action_redive`   | `{ event_id, competitor_id, round_number, … }` | Referee orders a re-dive. |
| `record_broken`           | `{ event_id, round_number, scope: 'personal' \| 'club' \| 'region' \| 'federation' \| 'continental', scope_id, scope_name, scope_code, official, gender: 'Male' \| 'Female', height, dive_code, position, score, prev_score \| null, holder_id, holder_name, prev_holder_name \| null }` | A completed individual dive set one or more records (`lib/records.js` `checkAndApplyRecords`), or a dive that was already scored went up and now holds a book (`recomputeRecordKeys`, after a score correction, a resolved conflict, a manual-entry fix, a judge scoring again after a redive). A dive whose total went down is never announced; its books are replayed quietly and the scoreboard cache dropped. One emit per book, to room `event:<event_id>`, server-only. `scope_code` is the short label (club or region short code, country code, or the continent key); `prev_score` is null for a first mark; `official` is false for an unclaimed region or country. The scoreboard cache is dropped just before the emit. `ScoreboardView` turns club / region / federation / continental marks with a `prev_score` into the record chip (standard scoreboard and recap only, never broadcast or overlay), and drops any mark it already had in the same book (`scope`, `scope_id`, `gender`, `height`, `dive_code`, `position`), since that dive doesn't hold it any more; the same marks ride on `GET /api/scoreboard/:id` and `GET /api/archive/:id/results` as `records` for anyone who loads the page later. |
| `meet_held`               | `{ event_id, reason \| null, since: <ms epoch> }` | Operator holds the meet, or a new client joins while a hold is active. |
| `meet_resumed`            | `{ event_id }` | Operator resumes the meet. |
| `venue.scoreboard_state`  | Canonical venue payload from `lib/venue-state.js` | Emitted to `venue:<event_id>` subscribers after subscribe, active-diver changes, score changes, score announce, hold, and resume. Used by hardware bridges. |
| `unauthorized`            | `{ reason: 'not_authenticated' \| 'insufficient_role' }` | A privileged event was attempted by an anonymous or under-roled socket. |
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
| `set_active_diver`        | meet_manager / referee / org_admin / sysadmin | Roster row + `diverName`, `diveCode`, `eventName`, `status` (built by `activeDiverPayload` in `src/lib/activeDiver.js`) | Persists to in-memory `activeDivers[event_id]` so late-joiners see it. Readers run `normaliseActiveDiver` so a replayed payload without the display fields still renders. |
| `get_active_diver`        | none (any socket)             | `{ event_id }` | Read-only — returns the current state to the asking socket only. |
| `submit_score`            | judge / referee / sysadmin    | `{ event_id, competitor_id, round_number, score, dive_id?, judge_number? }` | Server-trusted `judge_id = socket.userId`. Rate-limited (60/min/judge). Validates 0–10 in 0.5 steps, confirms event_judges membership. |
| `announce_score`          | meet_manager / referee / org_admin / sysadmin | `{ event_id, standings }` (the Control Room sends the focused pool's standings) | Re-broadcast as `final_score_announced`. `event_id` is required: the manage-event gate reads it, and a payload without it is refused as `missing_event_id`. |
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
   side state, gate it with `socketRequireRole(socket, [...])` at
   the top of the handler. Read-only listeners can stay anonymous.
2. **Validate the payload** before doing anything. The
   `submit_score` handler is the template — it rejects with a
   typed `score_rejected` event so the client can react instead of
   guessing why nothing happened.
3. **Add a row here**, updating both tables if the event has both
   directions.
4. **Update the integration test** at `test/integration.test.js`
   to assert the gate works for the unauthenticated case.
