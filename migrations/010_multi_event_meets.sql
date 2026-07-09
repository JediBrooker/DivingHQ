-- =============================================================
-- MIGRATION 010 - MULTI-EVENT MEETS
--
-- Real diving competitions are bundles of events. "2026
-- Australian Open" might run 8 events over 2 days (1m M/F,
-- 3m M/F, 10m M/F, synchro pair, team).
--
-- Adds a `meets` table that owns multiple events, plus a
-- nullable `events.meet_id` so an existing standalone event
-- continues to work unchanged. Existing events stay with
-- meet_id = NULL; managers can group them retroactively.
--
-- Idempotent, uses IF NOT EXISTS / DO blocks throughout.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.meets (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    venue       varchar(255),                 -- "Sydney Olympic Aquatic Centre"
    start_date  date,
    end_date    date,
    description text,
    sponsor_name      varchar(255),           -- optional headline sponsor
    sponsor_logo_url  text,
    sponsor_link_url  text,
    created_at  timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT meets_dates_check CHECK (
        start_date IS NULL OR end_date IS NULL OR end_date >= start_date
    )
);

CREATE INDEX IF NOT EXISTS idx_meets_org   ON public.meets (org_id);
CREATE INDEX IF NOT EXISTS idx_meets_dates ON public.meets (start_date DESC NULLS LAST);

-- Add the nullable backref on events. ON DELETE SET NULL so a
-- meet deletion preserves the underlying events (and their
-- standings, audit log, etc.), they just become standalone
-- again. Mirrors the team_id pattern from migration 007.
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS meet_id uuid REFERENCES public.meets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_meet ON public.events (meet_id);

-- Bump schema version. Defensive create, just in case this runs
-- against a DB without 008 applied (same pattern as 009).
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 10, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
