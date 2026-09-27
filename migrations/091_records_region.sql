-- 091_records_region.sql
--
-- Phase 4 of docs/club-first-onboarding.md §10: state / provincial
-- records, next to club, federation and continental (migrations 019,
-- 037). Same shape as records_club. The region is the one the diver was
-- entered from (competitor_dive_lists.rep_region_id, migration 090), so a
-- record stays with the state it was set for even if the diver moves.

BEGIN;

CREATE TABLE IF NOT EXISTS public.records_region (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    region_id   uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
    holder_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (region_id, height, dive_code, position)
);

CREATE TABLE IF NOT EXISTS public.records_region_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    region_id     uuid NOT NULL,
    holder_id     uuid,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 91, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
