# P1 design — universal outbox + idempotency

**Status:** draft, 2026-05-21. Review before code lands.

P1 builds the infrastructure that every later phase (P2-P5) reuses. Scope:
client-side outbox in IndexedDB, server-side idempotency middleware, the
schema changes that close out the inventory's resolved decisions, and one
migrated action (`submit_score`) as the proof.

Not in P1: optimistic UI patterns (P2), aggressive read caching (P3),
Control Room offline mode (P4), manual fallback (P5).

References: [docs/offline-inventory.md](./offline-inventory.md) (the
contract), commits 9695d81 + a92092e + 233d2af.

## Goals

1. Every meet-time write action can be queued in an IndexedDB-backed outbox
   on any client.
2. Server accepts an `idempotency_key` on every write and returns the
   cached response for duplicate keys within 72 hours.
3. `submit_score` works behind the outbox end-to-end — judge can score
   while offline, queue drains on reconnect, scoreboard reflects the new
   scores within ~1s of reconnect.
4. Feature-flagged. Production stays on the existing path until the flag
   is flipped per-federation as a canary.
5. Audit log records both `actor_local_time` and `server_committed_at` for
   every queued action.

## Non-goals

- UI work beyond what's needed to test the path (the JudgeView's
  "Reconnecting" banner stays as-is; rich "N pending" indicators are P2).
- Optimistic UI updates that require server confirmation to commit. Today
  the judge view already shows the score as submitted optimistically; we
  keep that.
- Migrating any action besides `submit_score`. Other socket events and the
  Control Room write surface come in P4.
- Conflict-resolution UX in Control Room (P4 has the tray; P1 only fires
  the `conflict_pending` socket event).

---

## 1. Client outbox — `src/lib/outbox.js`

### IndexedDB schema

New database: `divinghq-outbox` (separate from the existing
`dive-recorder-cache` so cache-clear doesn't nuke pending actions).

Store: `outbox`

```
keyPath:  idempotency_key  // UUID v4, generated client-side at push()
indexes:  by_status         { status }
          by_action_type    { action_type }
          by_created_at     { created_at }
```

Entry shape:

```js
{
  idempotency_key:    'a3f1...',   // UUID v4, primary key
  action_type:        'submit_score',
  payload:            { event_id, competitor_id, dive_id, score, ... },
  actor_local_time:   '2026-05-21T14:32:08.103Z',  // ISO 8601, client clock
  user_fingerprint:   '<hash>',     // so a different user can't drain it
  status:             'pending',    // see state machine below
  attempts:           0,
  last_attempt_at:    null,
  last_error:         null,         // string when status==='failed'
  conflict_info:      null,         // server payload when status==='conflict'
  created_at:         '2026-05-21T14:32:08.103Z',
  synced_at:          null,         // set when status flips to 'synced'
  server_response:    null,         // cached server reply when synced
}
```

### State machine

```
  pending  — push()      →  in queue, waiting for connectivity
     │
     ├─ drain()       →  inflight      (request issued)
     │                       │
     │                       ├─ 200 OK  →  synced
     │                       │
     │                       ├─ 409     →  conflict
     │                       │
     │                       ├─ timeout →  pending  (retry)
     │                       │
     │                       └─ 500/4xx →  failed   (max-attempts reached)
     │
     └─ manual.cancel() →  cancelled (rare; only via debug UI)
```

Terminal states: `synced`, `failed`, `cancelled`, `conflict`. Each TTLs out
after 72 hours (matches server idempotency TTL) and is garbage-collected
on startup.

### Public API

```js
import outbox from '@/lib/outbox'

// Queue an action. Returns the idempotency_key. Synchronous IDB write.
const key = await outbox.push('submit_score', payload, {
  actorLocalTime: new Date(),  // optional, defaults to now
})

// Drain pending actions. Idempotent — safe to call concurrently.
// Returns { drained: N, conflicts: M, failed: K }.
await outbox.drain({ socket })

// Query state.
await outbox.list({ status: 'pending' })   // for UI
await outbox.getStatus(key)                // single-action lookup

// Resolve a conflict (operator chose a winner in P4's tray).
await outbox.resolveConflict(key, 'accept' | 'discard')

// Reactive integration. Returns a Vue ref that updates on every
// state change. Components reactively show counts, statuses, etc.
const pendingCount = outbox.usePendingCount()
const entries = outbox.useEntries({ status: 'pending' })
```

### Concurrency rules

- `drain()` acquires an in-memory lock; concurrent callers no-op.
- Entries are sent in `created_at` order (FIFO). The server idempotency
  layer means re-sends are safe, but FIFO matches operator intent.
- Drain on every `socket.on('connect')` and on `window.online` events.
- If `drain()` is called when offline, it returns `{ drained: 0 }` and
  schedules a retry via the Page Visibility API + a 30s heartbeat
  (whichever comes first).
- Max attempts per entry: **5**, with exponential backoff (1s, 2s, 4s,
  8s, 16s). After 5 attempts the entry flips to `failed` and surfaces in
  the UI for manual retry.

### Where it gets called from

P1 wires it into exactly one site: `JudgeView.vue`'s `submit_score` flow.
Replaces the existing in-memory `pendingScore` ref with `outbox.push()`.
The existing `socket.on('connect')` handler that drains `pendingScore`
becomes `outbox.drain({ socket })`.

---

## 2. Server idempotency middleware

### `idempotency_keys` table (new in migration 054)

```sql
CREATE TABLE public.idempotency_keys (
    idempotency_key  uuid PRIMARY KEY,
    user_id          uuid REFERENCES public.users(id) ON DELETE SET NULL,
    action_type      varchar(80) NOT NULL,
    request_hash     bytea NOT NULL,    -- sha256 of canonicalised payload
    response_status  integer NOT NULL,
    response_body    jsonb,
    created_at       timestamptz DEFAULT now() NOT NULL
);

-- 72-hour TTL sweeper runs hourly (see lib/idempotency-sweeper.js).
CREATE INDEX idempotency_keys_created_idx
  ON public.idempotency_keys (created_at);
CREATE INDEX idempotency_keys_user_idx
  ON public.idempotency_keys (user_id);
```

### Middleware flow

```
  Request arrives with idempotency_key in body or X-Idempotency-Key header.
    │
    ├─ Validate UUID v4. If missing/invalid → 401 with clear error.
    │
    ├─ Lookup in idempotency_keys WHERE idempotency_key = $1.
    │    │
    │    ├─ Found, same user, same request_hash
    │    │     → Return cached { status, body } with header
    │    │        X-Idempotent: replay.
    │    │
    │    ├─ Found, different user → 403 (someone else's key).
    │    │
    │    ├─ Found, same user, different request_hash
    │    │     → 422 "key reused with different payload" —
    │    │        client bug, should never happen.
    │    │
    │    └─ Not found → proceed.
    │
    ├─ Handler executes its normal write path.
    │
    ├─ On success: INSERT INTO idempotency_keys ON CONFLICT DO NOTHING,
    │    capturing (key, user, hash, status, body). Fire-and-forget for
    │    speed; a duplicate insert under race resolves cleanly because
    │    of the next request's lookup.
    │
    └─ On 4xx/5xx: do NOT cache. Failed actions remain idempotent at
         the application layer (i.e., the unique constraint on `scores`),
         not the middleware layer.
```

Applied to every meet-time write endpoint (see Section 5 "phasing" below).
Applied selectively, not globally — auth endpoints don't need idempotency,
and applying broadly would explode the `idempotency_keys` table size.

### TTL sweeper

New file `lib/idempotency-sweeper.js`. Runs on a 1-hour interval inside
the Node process (no separate cron). Deletes rows where
`created_at < now() - interval '72 hours'`. Logs row count deleted.

### The submit_score wrinkle

`scores` already has a unique constraint on
`(event_id, competitor_id, round_number, judge_id)`. That's the natural
idempotency key for `submit_score`. Two cases:

1. **Same payload, re-sent** (outbox retry after a flaky network):
   `ON CONFLICT (event_id, competitor_id, round_number, judge_id)
    DO UPDATE SET score = EXCLUDED.score WHERE scores.score = EXCLUDED.score
    RETURNING *`. Updates 0 rows if values match → second-best path:
   re-select to confirm match. Cleaner: rely on the idempotency_keys
   middleware (returns cached response on duplicate key, so the DB write
   doesn't even fire twice).

2. **Different payload, same tuple** (judge sent 8.0 offline, then
   corrected to 8.5 before sync): The outbox sends them in order. Server
   sees them as two distinct idempotency keys with two distinct
   payloads. The unique constraint triggers ON CONFLICT → server returns
   409 + emits `conflict_pending` event. Client moves the second entry to
   `conflict` state in the outbox. Operator's review tray resolves it in
   P4.

For P1, case 2's tray UI doesn't exist yet, so the second action stays in
`conflict` state in the outbox with a clear message. UI surfaces it as a
banner ("Conflict pending review — reconnect to a meet manager").

---

## 3. Schema migration 054

File: `migrations/054_outbox_and_audit_clock.sql`

```sql
-- 054_outbox_and_audit_clock.sql
-- Server-side support for P1 offline outbox.
--
-- 1. idempotency_keys table (described in docs/offline-p1-design.md §2).
-- 2. actor_local_time + server_committed_at on score_audit_log so the
--    audit row distinguishes "when the operator clicked the button on
--    their laptop" from "when Postgres committed the row."
-- 3. Same two columns on the generic audit_log.
-- 4. actor_local_time on scores so a per-row replay clock survives even
--    if the audit row is purged.
-- 5. event_status enum gains 'pending_signoff' value, between 'Live' and
--    'Completed' semantically. Used during a blackout: operator marks the
--    event ready to sign off; sign-off codes complete the transition to
--    'Completed' when network returns.
-- 6. requireDeadlineWithReview gate metadata: late_arrival_flag column on
--    competitor_dive_lists (so the meet manager's review tray can find
--    rows that landed past the entry deadline).

BEGIN;

-- 1. idempotency_keys
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    idempotency_key  uuid PRIMARY KEY,
    user_id          uuid REFERENCES public.users(id) ON DELETE SET NULL,
    action_type      varchar(80) NOT NULL,
    request_hash     bytea NOT NULL,
    response_status  integer NOT NULL,
    response_body    jsonb,
    created_at       timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx
  ON public.idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS idempotency_keys_user_idx
  ON public.idempotency_keys (user_id);

-- 2 + 3. Audit clock columns. Existing rows get NULL on local time and
-- created_at copied to server_committed_at (so backfill stays consistent
-- without a separate update step).
ALTER TABLE public.score_audit_log
  ADD COLUMN IF NOT EXISTS actor_local_time     timestamptz,
  ADD COLUMN IF NOT EXISTS server_committed_at  timestamptz;
UPDATE public.score_audit_log
  SET server_committed_at = created_at
  WHERE server_committed_at IS NULL;

ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS actor_local_time     timestamptz,
  ADD COLUMN IF NOT EXISTS server_committed_at  timestamptz;
UPDATE public.audit_log
  SET server_committed_at = created_at
  WHERE server_committed_at IS NULL;

-- 4. scores.actor_local_time — captures the judge's tap moment even if
-- the audit row is later purged. Useful for forensic queries.
ALTER TABLE public.scores
  ADD COLUMN IF NOT EXISTS actor_local_time timestamptz;

-- 5. event_status: add pending_signoff between Live and Completed.
-- Postgres ENUM extension is documented at
-- https://www.postgresql.org/docs/current/sql-altertype.html.
ALTER TYPE event_status ADD VALUE IF NOT EXISTS 'pending_signoff' AFTER 'Live';

-- 6. requireDeadlineWithReview metadata. Two columns: when the client
-- claims they submitted (actor_local_time) and a flag indicating that
-- this entry needs referee review because it arrived after the
-- entries_close_at deadline server-side.
ALTER TABLE public.competitor_dive_lists
  ADD COLUMN IF NOT EXISTS actor_local_time   timestamptz,
  ADD COLUMN IF NOT EXISTS late_arrival_flag  boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS late_arrival_decision  varchar(20),
                                            -- 'pending' | 'allowed' | 'denied'
  ADD COLUMN IF NOT EXISTS late_arrival_decided_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS late_arrival_decided_at timestamptz;

CREATE INDEX IF NOT EXISTS competitor_dive_lists_late_arrival_idx
  ON public.competitor_dive_lists (late_arrival_flag)
  WHERE late_arrival_flag = true;

-- Bump schema_version.
UPDATE public.schema_meta SET version = 54 WHERE id = 1;

COMMIT;
```

Reversal: Postgres does not allow removing an ENUM value once added, so
rolling back the `pending_signoff` value requires a more elaborate dance
(create a new type, migrate, drop the old). We don't expect to. Other
changes are reversible by dropping columns / tables.

---

## 4. `conflict_pending` socket event protocol

New event emitted by the server when an idempotent action arrives with a
new payload that conflicts with an existing record.

```
  Server  →  io.to(`event:${event_id}`).emit('conflict_pending', {
              conflict_id:     '<uuid>',
              action_type:     'submit_score',
              actor_id:        '<judge_id>',
              actor_local_time: '2026-05-21T14:32:08.103Z',
              target:          { event_id, competitor_id, round_number,
                                 judge_id, dive_id },
              existing_value:  { score: 8.0, source: 'manual_entry',
                                 entered_at: '2026-05-21T14:35:11Z' },
              proposed_value:  { score: 8.5, source: 'outbox_sync',
                                 actor_local_time: '...' },
              resolution_required_by: 'operator',
              created_at:      '2026-05-21T14:38:00Z',
            })
```

Resolution endpoint (P1 stub; P4 builds the operator-facing tray):

```
  POST /api/conflicts/:conflict_id/resolve
  body: { decision: 'accept_proposed' | 'keep_existing' | 'discard_both' }
  auth: operator role
  effect: writes the chosen value, audit-logs the loser, clears conflict
```

For P1, the endpoint exists but has no UI consumer. The client surfaces
conflicts as banners ("1 conflict pending review"). P4 builds the tray.

---

## 5. Feature flags

Two flags, both default off in production:

```env
# Client-side. When 0, writes go straight to the socket like today
# (no outbox involvement at all). When 1, writes route through
# src/lib/outbox.js. Per-meet override is on the roadmap but P1 ships
# with the global flag only.
VITE_OFFLINE_OUTBOX_ENABLED=0

# Server-side. When 'auto', conflicting writes use last-write-wins
# silently (the development / test default). When 'operator', conflicts
# fire conflict_pending events and require explicit resolution. P1
# defaults to 'auto' so the missing P4 tray doesn't deadlock.
OFFLINE_CONFLICT_RESOLUTION=auto
```

Where the flag is read:

- `src/lib/outbox.js` — if `VITE_OFFLINE_OUTBOX_ENABLED !== '1'`, all
  `push()` calls fall through to direct socket emit. The outbox stays
  cold and never persists anything to IDB.
- `lib/idempotency.js` middleware — always runs (cheap; just a lookup).
- `routes/socket.js submit_score` — always honours idempotency keys when
  present; conflict path gated by `OFFLINE_CONFLICT_RESOLUTION`.

Rollout:

1. Land all P1 code with flag off in production.
2. CI sets both flags to enabled for `divinghq_test` to exercise the
   offline path on every test run.
3. Enable for one canary federation (manual `.env` edit in their
   deployment).
4. After 2-3 successful meets under the flag, default to on.

---

## 6. Test strategy

### Unit (Node `node:test`)

New file `test/outbox.test.js`. Pure JS, no DB. Mocks IDB via
[`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb) (~20KB,
zero runtime deps in production). Verifies:

- `push()` is durable across simulated page reloads.
- `drain()` is FIFO.
- 409 from server moves entry to `conflict` without losing payload.
- 5xx triggers backoff; max-5 attempts → `failed`.
- TTL sweep removes terminal-state entries older than 72h.
- Concurrent `drain()` calls are serialised.

New file `test/idempotency.test.js`. Verifies the middleware lookup logic
in isolation: cache hit returns cached body, different-user lookup
returns 403, different-payload-same-key returns 422.

### Integration (`node:test` against Postgres)

New file `test/idempotency.integration.test.js`. Boots `server.js` and:

- Submits the same `submit_score` payload twice with the same
  idempotency key → second response is identical to first, only ONE row
  in `scores`.
- Submits two different payloads with the same key → 422 on second.
- Submits two different payloads with the same target tuple (different
  keys) → second returns 409 + conflict_pending event observable.
- 73h after a write, the idempotency_keys row is gone (sweeper test
  with mocked clock).

### E2E (Playwright)

New file `test/e2e/offline-judge-scoring.spec.js`. Drives a judge
through:

1. Sign in online.
2. `page.context().setOffline(true)`.
3. Submit 5 scores in sequence.
4. Verify the outbox has 5 pending entries via
   `page.evaluate(() => indexedDB.databases())`.
5. `setOffline(false)`.
6. Wait for `socket.on('connect')` and outbox drain.
7. Verify all 5 scores landed in `scores` table.

### Manual smoke

Documented in `docs/offline-p1-design.md` (this file) bottom. Before
enabling the flag for the canary, a human runs through:

- Two phones, one Control Room laptop.
- Phones go to airplane mode for 10 minutes mid-meet.
- All scores eventually land. No duplicates. No drops.
- Conflict path: phone A submits 8.0 offline; operator manually enters
  8.5; phone A reconnects. Confirm a conflict_pending event fires and
  is surfaced (P1 banner is OK; P4 tray is the polished UX).

---

## 7. Rollout sequence

| Week | Deliverable | Behind flag? |
|---|---|---|
| 1 | `src/lib/outbox.js` + tests, no UI integration yet | n/a |
| 1 | Migration 054 + `lib/idempotency.js` middleware + sweeper | n/a |
| 2 | Wire idempotency middleware into `submit_score` socket handler. No client outbox use yet. | n/a |
| 2 | `conflict_pending` socket event scaffold + resolve endpoint (no UI consumer) | n/a |
| 3 | JudgeView migrated to call `outbox.push()` for `submit_score`. Banner says "N pending" when offline. | YES — default off in prod, on in CI |
| 3 | Canary federation enabled via their `.env`. Smoke-test 2-3 meets. | YES |
| 4+ | If green: default the flag on for everyone. If red: revert, learn, retry. | — |

Total: ~3 weeks of focused work for P1.

---

## 8. Risks specific to P1

1. **`fake-indexeddb` license / size.** MIT, ~20KB, no runtime deps. Adding
   it is uncontroversial but flag it for the next dep-audit.

2. **Per-user fingerprint for outbox keys.** A device that logs in as user
   A, queues 5 actions, then logs out and back in as user B must NOT
   drain those 5 as user B. Solved by stamping each outbox entry with
   `user_fingerprint` (same hash as `src/lib/idbCache.js` uses for cache
   keys) and gating drain on a match.

3. **Clock skew.** `actor_local_time` is whatever the client claims. Could
   be wrong (system clock off, deliberate tampering). The deadline-review
   pattern catches the abuse case: client claims pre-deadline time, but
   server saw the request post-deadline → flagged for review. For
   non-deadline actions, clock skew just affects audit-log presentation,
   not correctness.

4. **Idempotency table bloat.** 72h × the steady-state write rate. At a
   busy meet, maybe ~500 scores/hour × 24h × 3 = ~36k rows pending
   sweep. Bytes per row dominated by `response_body` jsonb (≤2KB).
   Total table size cap: ~70MB. Fine. Sweeper keeps it bounded.

5. **Outbox state lost on browser data clear.** A user who clears site
   data while offline loses queued scores. Migration to a SW-managed
   IDB instance would survive cache clear but adds complexity. P1
   accepts this risk; if it bites a real federation, P1.5 mitigates.

6. **Network partition while a `drain()` is in-flight.** The current
   request might complete server-side but the client never sees the 200.
   Idempotency key on retry returns the cached response — outbox sees
   success and clears the entry. Same key, same payload, no double-write.

---

## 9. Open questions before P1 starts

1. **Outbox entry payload size cap.** A `submit_score` payload is ~200
   bytes. A `submit_dive_list` (P4) could be 5KB. Propose a hard cap of
   100KB per entry, reject larger at `push()` time. Reasonable?

2. **Sweeper timing.** 1-hour interval inside the Node process. If the
   process restarts every deploy, the sweeper resets its timer.
   Acceptable, or do we want it as a node-cron expression?

3. **Conflict resolution endpoint authentication.** P1 stub accepts any
   org_admin or meet_manager. P4 narrows to the specific event's
   manager. OK to start permissive?

Lock these (or counter-propose) and code lands.
