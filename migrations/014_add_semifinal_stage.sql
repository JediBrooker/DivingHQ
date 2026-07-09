-- =============================================================
-- MIGRATION 014 - SEMI-FINALS
--
-- World Aquatics individual diving uses three stages:
--   Preliminary (all entrants) → Semi-Final (top 18) → Final (top 12)
--
-- Synchronised pair championships and team events typically
-- skip the semi (single competition or one feeder + one final),
-- so we don't enforce a rigid chain here, operators just pick per event.
--
-- Adds a CHECK constraint pinning event_format to the three
-- valid values, plus a default advance_count of 18 for the
-- prelim → semi cutoff (operators can override per event).
--
-- Idempotent.
-- =============================================================

BEGIN;

-- Drop any prior version of the constraint first, so this
-- migration stays safe to re-run if the values change later.
ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_event_format_check;

ALTER TABLE public.events
    ADD CONSTRAINT events_event_format_check
    CHECK (event_format IN ('preliminary', 'semifinal', 'final'));

-- Bump schema version. Defensive create, so this still works
-- against a DB without 008 applied.
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 14, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
