-- =============================================================
-- MIGRATION 046 - COACH ALERT PREFERENCES
--
-- Phase 3 of the coach feature bundle: real-time "your diver
-- is up next" push notifications. When the active diver flips,
-- we look ahead N=`dives_ahead` slots in the dive_order. For
-- every squad member that lands in that window, we fan out to
-- their coach(es) via lib/push.js (sockets + Web Push).
--
-- This table stores per-coach preferences:
--   enabled       - coach can opt out entirely
--   dives_ahead   - how many slots out from the active diver
--                   should trigger the alert (default 2 ≈ 60s of
--                   warning at a 30s shot-clock)
--
-- Default policy is opt-IN. The first time a coach hits the
-- console with a Live event in flight we lazily create their
-- row with enabled=true. They can flip it off from the coach
-- console settings (new endpoint POST /api/coach/alert-preferences).
--
-- Idempotent. Run:
--   psql -d <db> -f migrations/046_coach_alert_preferences.sql
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.coach_alert_preferences (
    coach_id      uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    enabled       boolean NOT NULL DEFAULT true,
    dives_ahead   int NOT NULL DEFAULT 2
                  CHECK (dives_ahead >= 1 AND dives_ahead <= 10),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Bump schema version.
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 46, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
