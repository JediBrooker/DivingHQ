-- =============================================================
-- MIGRATION 054, offline-resilience foundations
--
-- Server-side support for P1 of the offline-resilience work
-- (see docs/offline-p1-design.md and docs/offline-inventory.md).
--
-- Six changes, all additive:
--
--   1. idempotency_keys table. Every meet-time write endpoint
--      starts accepting an X-Idempotency-Key header or body
--      field; this table caches the response for 72 hours so a
--      retried request from the client outbox gets back the same
--      result instead of double-applying.
--
--   2. score_audit_log gains actor_local_time +
--      server_committed_at. Right now the audit row's created_at
--      conflates "when the operator clicked" and "when Postgres
--      committed", which is fine when those are <100ms apart but
--      breaks once an outbox replays a 30-minute-old action. The
--      two columns keep both clocks. Backfill: server_committed_at
--      = created_at for existing rows since they're equivalent
--      under the old online-only flow.
--
--   3. audit_log gets the same two columns, same reason.
--
--   4. scores.actor_local_time, so a per-row replay clock
--      survives even if the audit row gets purged. ~16 bytes per
--      row; the table is bounded by event size, not append rate.
--
--   5. event_status gains 'pending_signoff' between 'Live' and
--      'Completed'. During a blackout the operator can mark an
--      event ready to sign off; the cryptographic sign-off path
--      (routes/control-room.js sign-off code endpoints, all
--      server-canonical) completes the transition to 'Completed'
--      once network returns and the referee enters the code.
--      Postgres ENUM ADD VALUE is irreversible, see the migration
--      header comment in 053 for the philosophy on irreversible
--      ENUM changes.
--
--   6. competitor_dive_lists gains late-arrival metadata. The
--      requireDeadlineWithReview gate (DEC-04 in offline-
--      inventory.md) accepts a sync from a coach or diver whose
--      actor_local_time is BEFORE the entry deadline even if the
--      server only saw the request AFTER the deadline; the row
--      then gets flagged for referee review. Schema captures the
--      claim, the flag, and the eventual decision.
--
-- All changes guarded with IF NOT EXISTS / ADD VALUE IF NOT
-- EXISTS so a partial re-run is a no-op.
-- =============================================================

BEGIN;

-- ---- 1. idempotency_keys --------------------------------------
-- Primary key is the client-generated UUID v4. request_hash is a
-- sha256 of the canonicalised payload so a client that reuses a
-- key with a different body gets a clear 422 instead of a silent
-- last-write-wins. response_body is the JSON the handler emitted;
-- on cache hit we return it byte-for-byte plus X-Idempotent: replay.
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    idempotency_key  uuid PRIMARY KEY,
    user_id          uuid REFERENCES public.users(id) ON DELETE SET NULL,
    action_type      varchar(80) NOT NULL,
    request_hash     bytea NOT NULL,
    response_status  integer NOT NULL,
    response_body    jsonb,
    created_at       timestamptz DEFAULT now() NOT NULL
);

-- Sweeper queries `WHERE created_at < now() - interval '72 hours'`.
-- BRIN would be tighter for an append-only insert pattern but, tbh,
-- B-tree is unambiguously correct and matches the rest of the
-- schema's idiom.
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx
    ON public.idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS idempotency_keys_user_idx
    ON public.idempotency_keys (user_id);

-- ---- 2 + 3. Audit clock columns -------------------------------
-- Existing rows get server_committed_at backfilled from created_at
-- (they're equivalent under the old online-only flow). NULL on
-- actor_local_time is fine for legacy rows, it just means
-- "unknown, predates the outbox."
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

-- ---- 4. scores.actor_local_time -------------------------------
ALTER TABLE public.scores
    ADD COLUMN IF NOT EXISTS actor_local_time timestamptz;

-- ---- 5. event_status: pending_signoff -------------------------
-- ALTER TYPE … ADD VALUE must run outside a transaction in some
-- Postgres minor versions, but inside BEGIN/COMMIT is supported
-- since PG 12. This codebase targets 14+. IF NOT EXISTS is
-- supported since PG 9.6, so the guard is safe.
ALTER TYPE event_status ADD VALUE IF NOT EXISTS 'pending_signoff' AFTER 'Live';

-- ---- 6. competitor_dive_lists late-arrival metadata -----------
-- actor_local_time: client's claim of when they submitted.
-- late_arrival_flag: server set to true when the gate detected
--   actor_local_time < entries_close_at AND server_committed_at
--   >= entries_close_at. Surfaces the row in the meet manager's
--   pending-review tray (built in P4).
-- late_arrival_decision: 'pending' | 'allowed' | 'denied' once the
--   referee adjudicates. NULL when late_arrival_flag is false.
-- late_arrival_decided_by / _at: audit who and when.
ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS actor_local_time         timestamptz,
    ADD COLUMN IF NOT EXISTS late_arrival_flag        boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS late_arrival_decision    varchar(20),
    ADD COLUMN IF NOT EXISTS late_arrival_decided_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS late_arrival_decided_at  timestamptz;

-- Partial index: the review tray only cares about flagged rows.
CREATE INDEX IF NOT EXISTS competitor_dive_lists_late_arrival_idx
    ON public.competitor_dive_lists (late_arrival_flag)
    WHERE late_arrival_flag = true;

-- ---- Bump schema_version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 54, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
