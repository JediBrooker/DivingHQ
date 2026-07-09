-- =============================================================
-- MIGRATION 018: SCORE-CORRECTION REASON IN AUDIT LOG
--
-- The score-correction endpoint (PUT /api/scores/:id) accepts a
-- free-text `reason` from the referee and broadcasts it over the
-- score_corrected socket event, but the audit log never stored
-- it. Post-meet dispute investigations would see the score change
-- without knowing why it was made. Adding a nullable reason
-- column keeps the data forever and is backward compatible (old
-- rows get a NULL reason, old INSERT statements still work).
--
-- Idempotent.
-- =============================================================

BEGIN;

ALTER TABLE public.score_audit_log
    ADD COLUMN IF NOT EXISTS reason text;

-- Bump schema version. Defensive create, just in case this runs
-- against a DB without 008 applied.
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 18, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
