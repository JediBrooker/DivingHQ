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
| `final_score_announced`   | Whatever the announcer sent | Announcer presses "Announce" in the Control Room. |
| `referee_action_failed`   | `{ event_id, competitor_id, round_number, … }` | Referee marks a dive failed. |
| `referee_action_cap`      | `{ event_id, competitor_id, round_number, cap_value, … }` | Referee caps the panel's scores at `cap_value` (default 2.0). |
| `referee_action_redive`   | `{ event_id, competitor_id, round_number, … }` | Referee orders a re-dive. |
| `meet_held`               | `{ event_id, reason \| null, since: <ms epoch> }` | Operator holds the meet, or a new client joins while a hold is active. |
| `meet_resumed`            | `{ event_id }` | Operator resumes the meet. |
| `venue.scoreboard_state`  | Canonical venue payload from `lib/venue-state.js` | Emitted to `venue:<event_id>` subscribers after subscribe, active-diver changes, score changes, score announce, hold, and resume. Used by hardware bridges. |
| `unauthorized`            | `{ reason: 'not_authenticated' \| 'insufficient_role' }` | A privileged event was attempted by an anonymous or under-roled socket. |
| `schedule:conflict_dismissed` | `{ meet_id, action: 'dismiss' \| 'undismiss' }` | A scheduler conflict was dismissed or un-dismissed via the editor-only API. Drawer clients refetch `/api/meets/:id/conflicts` on receipt. The broadcast is intentionally minimal and does not include personnel labels. |
| `schedule:block_updated`      | `{ meet_id, session_id, block_id?, created?, session_updated? }` | A Phase 3 manual edit landed (`PUT /api/blocks/:id`, `POST /api/sessions/:sessionId/blocks`, or `PUT /api/sessions/:id`). Other timeline tabs refetch `/sessions` and update inline. The broadcast is intentionally minimal; conflict details stay behind `/api/meets/:id/conflicts`. |
| `schedule:block_deleted`      | `{ meet_id, session_id, block_id }` | A schedule block was deleted via `DELETE /api/blocks/:id`. Other tabs refetch the schedule. |
| `schedule:session_duplicated` | `{ meet_id, source_session_id, session_id }` | A session was cloned forward via `POST /api/sessions/:id/duplicate`. Other tabs refetch `/sessions`. |
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
| `set_active_diver`        | meet_manager / referee / org_admin / sysadmin | Roster row + status | Persists to in-memory `activeDivers[event_id]` so late-joiners see it. |
| `get_active_diver`        | none (any socket)             | `{ event_id }` | Read-only — returns the current state to the asking socket only. |
| `submit_score`            | judge / referee / sysadmin    | `{ event_id, competitor_id, round_number, score, dive_id?, judge_number? }` | Server-trusted `judge_id = socket.userId`. Rate-limited (60/min/judge). Validates 0–10 in 0.5 steps, confirms event_judges membership. |
| `announce_score`          | meet_manager / referee / org_admin / sysadmin | Free-form announce payload | Re-broadcast as `final_score_announced`. |
| `referee_failed_dive`     | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number }` | Logged to `score_audit_log`. |
| `referee_cap_scores`      | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number, cap_value }` | Logged. |
| `referee_redive`          | referee / meet_manager / org_admin / sysadmin | `{ event_id, competitor_id, round_number }` | Logged. |
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
