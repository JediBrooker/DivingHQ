-- =============================================================
-- MIGRATION 048: event rehearsal mode
--
-- Adds a first-class dry-run flag to events. Rehearsal events use
-- the same roster, panel, check-in, sign-off, and scoring surfaces
-- as real meets, but product code excludes them from the public
-- archive, analytics, event-start/result emails, and record-setting.
-- =============================================================

BEGIN;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS is_rehearsal boolean NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_events_rehearsal
    ON public.events (org_id, is_rehearsal, status);

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 48, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
