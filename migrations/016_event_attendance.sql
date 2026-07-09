-- =============================================================
-- MIGRATION 016: EVENT ATTENDANCE / CHECK-IN
--
-- Pre-meet door check-in. Operators tap each diver as they
-- arrive to mark them Present, Late, or DNS (did not start).
-- One row per (event, competitor); no row means "not yet checked in".
--
-- Why a new table rather than a column on competitor_dive_lists,
-- worth spelling out since it's a fair question:
--   * Status is per-diver-per-event, not per-dive-row. We don't
--     want to duplicate it across the diver's N round entries.
--   * Keeps competitor_dive_lists narrowly about the dive list,
--     not about person-arrival state. withdrawn_at handles
--     during-meet scratches, attendance.status handles pre-meet
--     check-in. A diver can be Present in attendance and still
--     have a withdrawn_at on round 5 because they hurt themselves
--     mid-event, these are genuinely different concerns.
--
-- Idempotent.
-- =============================================================

BEGIN;

-- Enum for attendance status. Frontend renders these as
-- Present / Late / Absent chips, but the wire value stays the enum.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_status') THEN
    CREATE TYPE public.attendance_status AS ENUM ('present', 'late', 'absent');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.event_attendance (
  event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  competitor_id uuid NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
  status        attendance_status NOT NULL,
  set_at        timestamptz NOT NULL DEFAULT now(),
  set_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  PRIMARY KEY (event_id, competitor_id)
);

CREATE INDEX IF NOT EXISTS idx_event_attendance_event
  ON public.event_attendance (event_id);

-- Bump schema version. Defensive create so this still works
-- against a DB that doesn't have 008 applied yet.
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 16, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
