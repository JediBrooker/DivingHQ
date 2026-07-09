-- =============================================================
-- MIGRATION 027: PRE-MEET DIVE-ORDER WORKFLOW
--
-- A diving competition's start order has to be referee-approved
-- before the event goes live. The Control Room now walks the
-- operator through three sequential states via a single 3-state
-- button (red → yellow → green):
--
--   1. Randomise dive order  (red, "Randomise Dive Order")
--   2. Referee sign off      (yellow, "Referee Sign Off")
--   3. Start event           (green, "Start Event")
--
-- Two timestamps plus a user FK on events drive the state machine
-- so the workflow survives a page reload or an operator handoff.
-- Re-randomising clears the sign-off, since the order changed and
-- the referee has to re-approve it.
--
-- Idempotent: every ADD COLUMN guards on IF NOT EXISTS, and the FK
-- is added inside a pg_constraint lookup block. Re-running this on
-- v27 is a no-op.
-- =============================================================

BEGIN;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS dive_order_randomised_at timestamptz;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS dive_order_signed_off_at timestamptz;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS dive_order_signed_off_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_dive_order_signed_off_by_fkey'
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_dive_order_signed_off_by_fkey
      FOREIGN KEY (dive_order_signed_off_by)
      REFERENCES public.users(id) ON DELETE SET NULL;
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
VALUES (1, 27, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
