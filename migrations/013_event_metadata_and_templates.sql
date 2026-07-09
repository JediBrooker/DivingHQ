-- =============================================================
-- MIGRATION 013: EVENT METADATA + TEMPLATES + PRELIM/FINAL LINK
--
-- Adds columns to events for richer real-world configuration:
--   age_group       : 'U10', 'U14', 'Open', 'Masters 30-34', etc.
--   scheduled_at    : when the event starts (used for schedule
--                     views, .ics export, "starts in 1 hour"
--                     notifications)
--   event_format    : 'final' (default, all current events) or
--                     'preliminary' (feeds a 'final' event via
--                     parent_event_id)
--   parent_event_id : FK to another event. Set on the final,
--                     points at its preliminary. ON DELETE SET
--                     NULL keeps the final around if the prelim
--                     gets removed.
--   advance_count   : how many divers advance from prelim to
--                     final. Defaults to 12 (World Aquatics
--                     standard); manager can override per-event.
--
-- Plus a new event_templates table: a manager saves a config once
-- ("World Aquatics U16 Women's 3m") then re-applies it for future
-- events with one click. Stored as JSON so adding more fields to
-- events later doesn't need a template-table migration.
--
-- Idempotent.
-- =============================================================

BEGIN;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS age_group       varchar(40);
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS scheduled_at    timestamptz;
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS event_format    varchar(20) NOT NULL DEFAULT 'final';
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS parent_event_id uuid REFERENCES public.events(id) ON DELETE SET NULL;
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS advance_count   integer DEFAULT 12;

-- Handy for scheduling views and the "advance top N to final"
-- workflow that walks parent → child links.
CREATE INDEX IF NOT EXISTS idx_events_scheduled_at  ON public.events (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_events_parent_event  ON public.events (parent_event_id);

-- Event templates: per-org saved configurations. config jsonb
-- holds the raw form state (name pattern, gender, height, judges,
-- rounds, format, dd_limit_*, age_group, etc.) so adding new
-- event columns later doesn't require a template migration.
CREATE TABLE IF NOT EXISTS public.event_templates (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    config      jsonb NOT NULL,
    created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_event_templates_org ON public.event_templates (org_id);

-- Bump the schema version. Defensive create in case this runs
-- against a DB without 008 applied.
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 13, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
