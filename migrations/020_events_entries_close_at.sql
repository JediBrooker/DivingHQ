-- =============================================================
-- MIGRATION 020: ADD events.entries_close_at
--
-- Lets a meet manager set a deadline after which divers can no
-- longer submit (or change) their dive list for an event. Distinct
-- from the existing 3-state `status` enum:
--
--     status      = lifecycle (Upcoming → Live → Completed)
--     entries_close_at = registration deadline within Upcoming
--
-- Server-side, an event accepts entries when:
--     status = 'Upcoming'
--   AND (entries_close_at IS NULL OR entries_close_at > now())
--
-- NULL means "no explicit deadline, entries close when the event
-- goes Live" - keeps the pre-migration behaviour for every
-- existing row.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, no backfill needed.
-- =============================================================

BEGIN;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS entries_close_at timestamptz;

-- Index for the diver-portal listing query, which filters on
-- `entries_close_at > now()`. Partial index, only the rows where
-- a deadline is actually set are interesting - NULLs short-circuit
-- the predicate before the index even gets consulted.
CREATE INDEX IF NOT EXISTS idx_events_entries_close_at
    ON public.events (entries_close_at)
    WHERE entries_close_at IS NOT NULL;

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 20, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
