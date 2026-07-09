-- =============================================================
-- MIGRATION 015: DIVER DASHBOARD WIDGETS
--
-- Stores each diver's chosen analytics widgets as a jsonb array of
-- widget IDs. Defaults to the two widgets that were already on the
-- profile (score_trend, personal_bests) so existing accounts don't
-- see an empty dashboard after the upgrade.
--
-- Went with jsonb (rather than a child table) since the list is
-- small, atomic, never queried by individual element, and adding
-- new widget IDs later doesn't require a migration.
--
-- Idempotent.
-- =============================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS dashboard_widgets jsonb
    DEFAULT '["score_trend","personal_bests","recent_form","placings"]'::jsonb;

-- Bump schema version here too, same defensive create so it
-- still works against a DB without 008 applied.
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 15, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
