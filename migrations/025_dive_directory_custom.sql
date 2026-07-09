-- =============================================================
-- MIGRATION 025: CUSTOM ENTRIES IN dive_directory
--
-- The dive_directory table shipped with init.sql is a catalog of
-- the ~830 World Aquatics-recognised dives. Coaches need to record
-- progression/teaching dives that aren't in that catalog, things
-- like poolside sit-dives, kneel-dives, novice forwards on a 0m
-- board, club-specific drills with their own DDs.
--
-- This migration widens dive_directory with three columns so the
-- new "Dive Directory" page in the SPA lets users add their own
-- rows without leaking authority over the core catalog:
--
--   is_custom       - false for catalog rows, true for org-created
--   created_by      - user who added the custom row (nullable so
--                     a user delete doesn't cascade)
--   created_org_id  - org that owns the custom row, only members
--                     of that org can edit/delete it
--
-- Existing rows get backfilled with is_custom = false (handled by
-- the column default plus the existing data), so any code that
-- assumes "all dive_directory rows are core" still reads the same
-- data.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards every change so
-- re-running this on a v25 DB is a no-op.
-- =============================================================

BEGIN;

ALTER TABLE public.dive_directory
    ADD COLUMN IF NOT EXISTS is_custom      boolean NOT NULL DEFAULT FALSE;

ALTER TABLE public.dive_directory
    ADD COLUMN IF NOT EXISTS created_by     uuid;

ALTER TABLE public.dive_directory
    ADD COLUMN IF NOT EXISTS created_org_id uuid;

ALTER TABLE public.dive_directory
    ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now();

-- FKs added separately so a re-run that finds the column already
-- there doesn't blow up trying to recreate the constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dive_directory_created_by_fkey'
  ) THEN
    ALTER TABLE public.dive_directory
      ADD CONSTRAINT dive_directory_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dive_directory_created_org_id_fkey'
  ) THEN
    ALTER TABLE public.dive_directory
      ADD CONSTRAINT dive_directory_created_org_id_fkey
      FOREIGN KEY (created_org_id) REFERENCES public.organisations(id) ON DELETE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_dive_directory_custom_org
    ON public.dive_directory (created_org_id) WHERE is_custom;

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 25, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
