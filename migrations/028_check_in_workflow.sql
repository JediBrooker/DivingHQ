-- =============================================================
-- MIGRATION 028: CHECK-IN STEP IN PRE-MEET WORKFLOW
--
-- Migration 027 introduced the 3-state workflow (randomise →
-- referee sign off → start). This adds an explicit "all divers
-- checked in" step at the front so the Control Room button now
-- walks four states before flipping the event Live:
--
--   1. Check In Divers       (red)
--   2. Randomise Dive Order  (orange)
--   3. Referee Sign Off      (yellow)
--   4. Start Event           (green)
--
-- The new column events.check_in_done_at stores the moment the
-- operator confirmed check-in is complete. The existing
-- attendance / event_attendance table still holds the per-diver
-- status (present / late / DNS); this stamp just gates the
-- workflow advance, and the operator can mark divers in any
-- order and click "Confirm Check-in Complete" inside the modal
-- when ready.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards the change. Re-run
-- on v28 is a no-op.
-- =============================================================

BEGIN;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS check_in_done_at timestamptz;

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 28, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
