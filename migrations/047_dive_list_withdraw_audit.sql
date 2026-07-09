-- =============================================================
-- MIGRATION 047: DIVE LIST WITHDRAW AUDIT FIELDS
--
-- Phase 4 of the coach feature bundle. competitor_dive_lists already
-- carries withdrawn_at (migration 012); when that's set, the diver
-- was scratched from the event. This migration adds two audit
-- fields so we actually know:
--
--   withdrawn_by_user_id: who triggered the withdrawal (the
--                         operator, the diver themselves, or now
--                         the coach via the new endpoint).
--   withdrawn_reason:     free-text reason logged at withdraw time,
--                         shows up in the audit log and on the
--                         operator's Control Room.
--
-- Both fields are nullable so we don't break the existing withdraw
-- paths in routes/control-room.js + routes/events/*.js; old NULL
-- rows just mean "withdrawn before this audit was added". New
-- writes from the coach endpoint always set both.
--
-- Idempotent. Run:
--   psql -d <db> -f migrations/047_dive_list_withdraw_audit.sql
-- =============================================================

BEGIN;

ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS withdrawn_by_user_id uuid
        REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS withdrawn_reason text;

CREATE INDEX IF NOT EXISTS idx_cdl_withdrawn_by
    ON public.competitor_dive_lists (withdrawn_by_user_id)
    WHERE withdrawn_by_user_id IS NOT NULL;

-- Bump schema version.
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 47, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
