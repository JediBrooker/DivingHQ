-- =============================================================
-- MIGRATION 059 — DiveRecorder archive tables (dr_*)
--
-- DivingHQ only knows about meets run on its own platform. The
-- DiveRecorder Meet Explorer (diverecorder.co.uk/meetexplorer)
-- publishes a large public archive of historical UK/AUS diving
-- results — ~1,386 meets, each with dozens of events, each with a
-- ranked diver list and a full per-dive breakdown (dive code,
-- position, DD, individual judge marks, running total).
--
-- We mine that archive (scripts/import-diverecorder.js) and surface
-- it as a read-only "Archive Explorer" inside DivingHQ so divers,
-- coaches and clubs get a richer historical record without
-- re-entering anything by hand.
--
-- This data is deliberately kept in its OWN namespace (dr_*). It
-- must never touch the live operational tables (meets / events /
-- scores / users / clubs) or the org-scoped FK / records /
-- analytics machinery: there are no real accounts, no judges, no
-- org behind these rows, and they must not count toward records.
-- Hence: no foreign keys into operational tables, no org_id, no RLS
-- coupling. The source's own numeric ids (mref / eref / dref) are
-- carried as natural keys so re-running the importer is idempotent
-- (ON CONFLICT ... DO UPDATE) and resumable.
-- =============================================================

BEGIN;

-- One row per source meet (selectmeet.php → mref).
CREATE TABLE IF NOT EXISTS public.dr_meets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_mref  integer NOT NULL UNIQUE,
    name         text NOT NULL,
    meet_date    date,                 -- nullable: list page only has "May 24"
    imported_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- One row per event within a meet (selectevent.php → eref).
CREATE TABLE IF NOT EXISTS public.dr_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dr_meet_id  uuid NOT NULL REFERENCES public.dr_meets(id) ON DELETE CASCADE,
    source_eref integer NOT NULL,
    name        text NOT NULL,         -- e.g. "Girls Group A+ 1m, Final"
    gender      text,                  -- best-effort parsed from name
    height      text,                  -- best-effort parsed from name (1m/3m/Platform)
    phase       text,                  -- best-effort parsed from name (Preliminary/Final/...)
    event_date  date,                  -- full date from the sheet page
    judge_count integer,
    UNIQUE (dr_meet_id, source_eref)
);

-- One row per distinct diver across the archive. Collapsed on
-- (name, club_name, birth_year) so the same person appearing in
-- many meets is a single row, enabling a cross-meet history view.
-- No link to real DivingHQ users (out of scope this round).
CREATE TABLE IF NOT EXISTS public.dr_divers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    club_name  text NOT NULL DEFAULT '',
    birth_year integer,
    UNIQUE (name, club_name, birth_year)
);

-- One row per diver's placing in an event (selectsheet.php → dref).
CREATE TABLE IF NOT EXISTS public.dr_results (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dr_event_id uuid NOT NULL REFERENCES public.dr_events(id) ON DELETE CASCADE,
    dr_diver_id uuid NOT NULL REFERENCES public.dr_divers(id) ON DELETE CASCADE,
    source_dref integer NOT NULL,
    rank        integer,
    total_score numeric(8, 2),
    UNIQUE (dr_event_id, source_dref)
);

-- One row per dive on a diver's sheet (showsheet.php rows).
CREATE TABLE IF NOT EXISTS public.dr_dives (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dr_result_id         uuid NOT NULL REFERENCES public.dr_results(id) ON DELETE CASCADE,
    round_number         integer NOT NULL,
    dive_code            text,
    position             text,           -- A/B/C/D/Free
    degree_of_difficulty numeric(3, 1),
    judge_scores         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- raw marks incl. halves
    dive_points          numeric(8, 2),
    running_total        numeric(8, 2),
    UNIQUE (dr_result_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_dr_events_meet     ON public.dr_events (dr_meet_id);
CREATE INDEX IF NOT EXISTS idx_dr_results_event   ON public.dr_results (dr_event_id);
CREATE INDEX IF NOT EXISTS idx_dr_results_diver   ON public.dr_results (dr_diver_id);
CREATE INDEX IF NOT EXISTS idx_dr_dives_result    ON public.dr_dives (dr_result_id);
CREATE INDEX IF NOT EXISTS idx_dr_divers_name     ON public.dr_divers (lower(name));
CREATE INDEX IF NOT EXISTS idx_dr_meets_date      ON public.dr_meets (meet_date);

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 59, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
