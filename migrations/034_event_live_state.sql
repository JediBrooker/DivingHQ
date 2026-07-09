-- =============================================================
-- MIGRATION 034 - EVENT LIVE STATE PERSISTENCE
--
-- Currently `activeDivers` (current performer per event) and
-- `meetHolds` (per-event hold reason + since timestamp) are
-- in-memory maps in lib/live-state.js. Heads up: if the server
-- restarts mid-meet (deploy, crash, OS reboot, pm2 reload) that
-- state just vanishes. Spectator scoreboards go blank, judges see
-- the "waiting for diver" placeholder, and the operator has to
-- re-pick the active diver before scoring resumes.
--
-- This table persists both pieces. The application keeps the
-- in-memory cache for synchronous reads (the hot path is
-- "judge connects → sync send the current state_update"), but
-- writes go through to the DB on every mutation, and server
-- boot rehydrates the cache from the table.
--
-- One row per event. event_id PK + ON DELETE CASCADE so a
-- deleted event drops its live state automatically. The
-- application is also responsible for clearing rows when an
-- event flips to Completed (it already does this for the
-- in-memory maps).
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_live_state (
    event_id              uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
    -- The full set_active_diver payload (round, diver name +
    -- country chip + club, dive code + DD + description, etc).
    -- jsonb so the shape can evolve without migrations.
    active_diver_payload  jsonb,
    -- Hold reason. NULL = not held. Set and cleared independently
    -- of the active diver, since a held meet still has a "currently
    -- on board" diver, just nobody scoring.
    on_hold_reason        text,
    hold_since            timestamptz,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 34, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
