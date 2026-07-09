-- =============================================================
-- MIGRATION 026: unique key on dive_directory now includes DD
--
-- The original UNIQUE (dive_code, height, position) blocked any
-- second row sharing those three fields, regardless of DD. Made
-- sense as an invariant for the World Aquatics catalog (each
-- code/height/position has exactly one official tariff), but it
-- gets in the way of the new custom-dives flow: a poolside drill
-- can legitimately exist as "0m forward sit-dive at DD 0.4" AND
-- "0m forward sit-dive at DD 0.6" depending on the level being
-- coached.
--
-- So we widen the unique key to (dive_code, height, position, dd)
-- so variants are allowed but exact duplicates still aren't.
--
-- Idempotent: drops the old constraint by name (the default
-- Postgres-generated name from the inline UNIQUE clause in
-- init.sql), then adds the new one only if it isn't already
-- there. Re-running this on a v26 DB is a no-op.
-- =============================================================

BEGIN;

ALTER TABLE public.dive_directory
    DROP CONSTRAINT IF EXISTS dive_directory_dive_code_height_position_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dive_directory_code_height_pos_dd_key'
  ) THEN
    ALTER TABLE public.dive_directory
      ADD CONSTRAINT dive_directory_code_height_pos_dd_key
      UNIQUE (dive_code, height, position, dd);
  END IF;
END$$;

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 26, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
