# P1 deploy + canary checklist

**Status:** ready to run, 2026-05-22.

Step-by-step for landing the P1 outbox infrastructure on production
and smoke-testing it before general availability. References
[offline-inventory.md](./offline-inventory.md) (the contract) and
[offline-p1-design.md](./offline-p1-design.md) (the implementation
design + rollout plan).

Assumes you've already merged everything to `origin/main`. Don't
cherry-pick across phases.

## What's about to land

New code (already on main, awaiting deploy):

- Schema: `migrations/054_outbox_and_audit_clock.sql`
- Server: `lib/idempotency.js`, `lib/idempotency-sweeper.js`,
  `routes/conflicts.js`, idempotency wiring in
  `routes/socket.js submit_score`
- Client: `src/lib/outbox.js`, `src/composables/useOutbox.js`,
  `src/components/OfflineBanner.vue`,
  `src/components/SyncStatusBadge.vue`, JudgeView migration
- Tests: `test/idempotency.test.js`, `test/outbox.test.js`,
  `test/idempotency.integration.test.js`
- Docs: this file + the two it references

All behind `VITE_OFFLINE_OUTBOX_ENABLED=0` in production. The first
deploy applies the migration + ships the code but doesn't change
user-visible behaviour at all. Flipping the flag is a separate,
reversible step.

## Phase A — land the infrastructure (zero user impact)

### A1. Confirm CI is green

```
gh run list --branch main --limit 1
```

If the latest run on main is failing, fix that first. The CI build
job now bakes `VITE_OFFLINE_OUTBOX_ENABLED=1` into its bundle to
exercise the outbox path, so a failure there is meaningful.

### A2. Deploy

```
ssh box
cd /root/DiveRecorder
./deploy.sh
```

What to expect:
- `git pull` advances HEAD to the latest main
- `npm ci` installs (no new deps)
- `npm run build` rebuilds the SPA — with
  `VITE_OFFLINE_OUTBOX_ENABLED=0` (default), so the production
  bundle still uses the legacy single-slot pendingScore path
- `npm run migrate -- --dry` previews migration 054
- `npm run migrate` applies it
- `npm run test:safe` runs (skips i18n stuck-tolerance via
  `SKIP_I18N_STUCK_CHECK=1` set by deploy.sh)
- `pm2 restart dive-recorder --update-env`
- Health check
- Section 8 background translator fires for any new English-stuck
  keys (the P2 i18n additions — about 20 strings)

### A3. Verify the schema landed

```
ssh box
psql divinghq -c "SELECT version FROM schema_meta WHERE id = 1"
psql divinghq -c "\\d idempotency_keys"
psql divinghq -c "SELECT unnest(enum_range(NULL::event_status))::text"
```

Expected:
- `version` = 54
- `idempotency_keys` table exists with the columns from migration 054
- `event_status` enum includes `pending_signoff`

### A4. Verify nothing user-visible changed

Load `/judge` as any judge. The behaviour is identical to before
this deploy: connection banner appears when offline, scores submit
on reconnect via the legacy single-slot path. No "N pending"
label, no offline banner with a pulse dot — those only show when
the flag is on.

## Phase B — canary federation (one federation, real meets)

### B1. Pick a canary

Ideal: a federation with a technical contact who's running 2-3
meets in the next 1-2 weeks and is OK telling you what they saw.
Not ideal: the highest-stakes federation in the system.

Write down: federation name, contact, planned meet dates.

### B2. Flip the flag for the canary's deployment

There isn't a per-federation flag in P1 (that's on the roadmap).
For a single-tenant box this means flipping the global flag and
accepting that every federation hitting that instance gets the
outbox path. For a multi-tenant cloud this means flipping the
flag on the cloud's `.env` and accepting the same.

On the box:

```
ssh box
cd /root/DiveRecorder
vi .env
# Add or change:
#   VITE_OFFLINE_OUTBOX_ENABLED=1
./deploy.sh
```

The rebuild bakes the flag into the SPA bundle every user
downloads on next visit. PM2 restart with `--update-env` (already
in deploy.sh, see commit 20f5fb9) picks up any server-side env
changes — not strictly needed for the outbox flag (it's
client-side) but matches the no-glitches deploy story.

### B3. Smoke test (manual)

Before the canary's first real meet:

1. Open `/judge` on a phone you control. Sign in as a test judge.
2. Open browser devtools → Application → IndexedDB. You should
   see `divinghq-outbox` exist (empty store is fine).
3. Submit a score with the network up. Verify:
   - Score lands on the public scoreboard within ~1s
   - The outbox table briefly shows a `synced` entry, then it
     drops below the 72h retention
4. Toggle airplane mode. Submit 3 scores.
5. Confirm the `OfflineBanner` appears at the top with a pulse
   dot, says "Offline for 30s · 3 actions queued".
6. Toggle airplane mode back on. Within ~2s:
   - Banner disappears
   - All 3 scores reach the scoreboard
   - IndexedDB `outbox` store shows 3 `synced` entries
7. Check the deploy box's audit log: `psql divinghq -c "SELECT
   created_at, actor_local_time, server_committed_at FROM
   score_audit_log ORDER BY created_at DESC LIMIT 5"`. Confirm
   `actor_local_time` is set on the outbox-routed rows and is
   earlier than `server_committed_at` by roughly the offline
   duration.

If any of those steps fail, stop. Capture the failure mode + flip
the flag back before the meet.

### B4. Run real meets

Let 2-3 of the canary's meets run with the flag on. After each:

- Did any judges report unexpected behaviour?
- Look at `/api/audit` for the meet's event — any rows where
  `actor_local_time` is more than ~5 minutes earlier than
  `server_committed_at`? Those are the outbox saves we want to
  see in production.
- `psql divinghq -c "SELECT count(*), action_type FROM
  idempotency_keys GROUP BY action_type"` — should mostly show
  `submit_score` entries, ~one per dive scored.
- Any unexpected 4xx/5xx in the server logs from the new
  middleware? `grep -E '\[idempotency\]' /var/log/pm2/dive-recorder-out.log`.

Good signals: zero negative reports, idempotency_keys table grows
at a sensible rate (~50-200 keys per meet), score_audit_log shows
both clocks populated.

Bad signals: 422 errors in the logs (key-reuse-with-different-
payload — client bug somewhere), missing rows in idempotency_keys
(middleware not wired correctly), audit rows where
`actor_local_time IS NULL` for outbox-mode submissions (client
isn't sending it).

## Phase C — general availability

After 2-3 canary meets sign off:

### C1. Document the change

A short post in the federation-admin Inbox or a changelog entry:
"As of {date}, judge phones queue scores locally and replay them
automatically when the network returns. There's no action required.
If your meet has wifi issues, scores no longer disappear — the
offline indicator in the judge view confirms they're saved."

### C2. Roll out

Already done if the flag is on the global box. For a multi-tenant
cloud, ensure the production `.env` for every federation has
`VITE_OFFLINE_OUTBOX_ENABLED=1`. The first build after that flip
ships the outbox-mode SPA to every user.

### C3. Remove the flag (later)

3-6 months after GA, when no one's seen the legacy path in months:

- Delete the `VITE_OFFLINE_OUTBOX_ENABLED` branches from
  `JudgeView.vue` and `useOutbox.js`
- Delete the legacy `conn-banner` styling
- Delete the `else` branch in `submitScore()` that uses
  `pendingScore.value`
- Update `.env.example` to remove the flag

This is dead-code-removal, not a behavioural change. Land in a
single commit.

## Rollback

Any phase A/B failure that's worse than "slightly worse UX":

```
ssh box
cd /root/DiveRecorder
vi .env
# Set:
#   VITE_OFFLINE_OUTBOX_ENABLED=0
./deploy.sh
```

The rebuild restores legacy behaviour. The migration 054 schema
stays — it's purely additive, no functional impact when the
outbox isn't writing to it. Existing idempotency_keys rows expire
in 72h via the sweeper.

A more severe rollback (migration 054 itself causes problems):

```
ssh box
cd /root/DiveRecorder
git reset --hard <pre-054 sha>
pm2 restart dive-recorder --update-env
```

Note: `pending_signoff` was added to the `event_status` enum and
Postgres doesn't allow removing enum values without a more
elaborate migration. If you actually need to roll that back you're
in a hand-write-a-new-migration scenario; the migration 054
header documents this trade-off.

## Sign-off checklist

- [ ] CI green on main
- [ ] `./deploy.sh` ran clean
- [ ] `schema_meta.version` = 54
- [ ] `idempotency_keys` table exists
- [ ] `event_status` enum includes `pending_signoff`
- [ ] Legacy behaviour confirmed unchanged with flag=0
- [ ] Canary federation picked + flag flipped to 1
- [ ] Manual smoke test passed (airplane mode → reconnect cycle)
- [ ] At least 2 real meets ran clean under the canary
- [ ] Audit log shows both clocks populated
- [ ] No 422s or unexplained errors in `[idempotency]` logs
- [ ] GA rollout announced
