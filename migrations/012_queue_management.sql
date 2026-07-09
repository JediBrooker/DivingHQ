-- =============================================================
-- MIGRATION 012: QUEUE MANAGEMENT
--
-- Two columns on competitor_dive_lists for Control Room workflow:
--
--   display_order: nullable int. When set, it overrides the
--     default queue order (round_number, full_name) so the
--     operator can re-sort divers within a round on the fly.
--     Roster query falls back to NULL ORDER BY full_name when
--     it's not set, so older events keep working unchanged.
--
--   withdrawn_at: nullable timestamptz. When set, the diver has
--     scratched / DNS / DNF for that specific dive list row. The
--     roster endpoint excludes withdrawn rows from the active
--     queue, but standings can still attribute prior dives to them.
--
-- Idempotent.
-- =============================================================

BEGIN;

ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS display_order integer;

ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS withdrawn_at  timestamptz;

CREATE INDEX IF NOT EXISTS idx_dive_lists_event_round_order
    ON public.competitor_dive_lists (event_id, round_number, display_order)
    WHERE withdrawn_at IS NULL;

-- Bump schema version. Defensive create here so this still works
-- against a DB that doesn't have 008 applied yet.
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 12, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
