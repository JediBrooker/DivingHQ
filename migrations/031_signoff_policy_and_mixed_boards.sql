-- =============================================================
-- MIGRATION 031: REFEREE SIGN-OFF POLICY + MIXED-BOARD EVENTS +
--                 CUT 3 CODE-HANDOFF
--
-- Three orthogonal bits land together because they all just touch
-- column-additions and a covering index, so it keeps the
-- migration count bounded.
--
-- 1. events.enforce_referee_signoff
--    When TRUE, the meet manager can't soft-attest the dive order,
--    only push approval or credential entry by the actual referee
--    count. The simple /sign-off endpoint (manager-attests path)
--    refuses with 403 in this mode. Default FALSE so existing
--    meets keep their lighter-touch flow.
--
-- 2. events.is_mixed_height
--    Lets a single event span multiple boards (e.g. an "Open
--    Aerial" warm-up event with 1m + 3m + 10m dives). When TRUE,
--    events.height becomes informational only (or NULL) and
--    every dive picker widens to the full directory rather than
--    filtering to one height.
--
-- 3. referee_signoff_requests.handoff_code
--    Cut 3 of the sign-off plan: a 6-digit code the manager
--    generates on their screen and the referee types into a
--    "/sign-off-codes" page on their own device. Doesn't need
--    push permission, doesn't need the referee on the managers
--    laptop, doesn't need email setup either.
--
-- Idempotent: every ADD COLUMN guards on IF NOT EXISTS, the
-- partial index check is gated on pg_class. Re-run on v31 is a
-- no-op.
-- =============================================================

BEGIN;

-- ---- Sign-off enforcement flag --------------------------------
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS enforce_referee_signoff boolean NOT NULL DEFAULT FALSE;

-- ---- Mixed-board flag ----------------------------------------
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS is_mixed_height boolean NOT NULL DEFAULT FALSE;

-- ---- Handoff code on sign-off requests -----------------------
ALTER TABLE public.referee_signoff_requests
    ADD COLUMN IF NOT EXISTS handoff_code varchar(8);

-- Partial unique index: only one PENDING code allowed at a time
-- per referee. Stops two parallel "generate code" clicks for the
-- same referee from racing each other, first one wins, the
-- second 409s. Worth noting, stale codes (expired / consumed)
-- drop out of the index since handoff_code stays on the row but
-- status flips.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'idx_signoff_pending_code'
  ) THEN
    CREATE UNIQUE INDEX idx_signoff_pending_code
      ON public.referee_signoff_requests (target_referee_id, handoff_code)
      WHERE status = 'pending' AND handoff_code IS NOT NULL;
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
VALUES (1, 31, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
