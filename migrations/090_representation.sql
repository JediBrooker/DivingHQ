-- 090_representation.sql
--
-- Phase 4 of docs/club-first-onboarding.md: what a diver represents on
-- scoreboards and results, per meet.
--
--   meets.represent_as
--       'country' (default, and exactly what every existing screen already
--       shows: the diver's country code), 'region' (their state /
--       province, for national championships) or 'club' (their club's
--       short code, for club and inter-club meets).
--
--   competitor_dive_lists.rep_club_id / rep_region_id / rep_country
--       Who the diver was when they were entered, so a club or state move
--       next season doesn't rewrite this season's results. Filled by the
--       trigger below on every insert, which covers all eleven code paths
--       that create entries (submit, synchro mirrors, CSV import, late add,
--       advance, H2H / SF / F seeding, synchro replacement, team lists)
--       without each one having to remember.
--
--   event_rep_code(event_id, user_id, home_country)
--       The code to print next to a diver in an event: from the entry
--       snapshot where there is one, falling back to the diver's current
--       club / region for rows entered before this migration, and to
--       home_country when there's nothing better (no club short code, no
--       region, an event outside any meet). The scoreboard, recap, PDFs,
--       Control Room and venue boards emit it in the country_code slot, so
--       every existing chip and the medal table follow the meet's setting.

BEGIN;

ALTER TABLE public.meets
  ADD COLUMN IF NOT EXISTS represent_as varchar(8) NOT NULL DEFAULT 'country';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meets_represent_as_check') THEN
    ALTER TABLE public.meets
      ADD CONSTRAINT meets_represent_as_check CHECK (represent_as IN ('country', 'region', 'club'));
  END IF;
END $$;

ALTER TABLE public.competitor_dive_lists
  ADD COLUMN IF NOT EXISTS rep_club_id   uuid REFERENCES public.clubs(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rep_region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rep_country   char(3);

CREATE OR REPLACE FUNCTION public.cdl_snapshot_rep() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only when the inserting code didn't set anything itself.
  IF NEW.competitor_id IS NOT NULL
     AND NEW.rep_club_id IS NULL AND NEW.rep_region_id IS NULL AND NEW.rep_country IS NULL THEN
    SELECT u.club_id, c.region_id, o.country_code
      INTO NEW.rep_club_id, NEW.rep_region_id, NEW.rep_country
      FROM public.users u
      LEFT JOIN public.clubs c ON c.id = u.club_id
      LEFT JOIN public.organisations o ON o.id = u.org_id
     WHERE u.id = NEW.competitor_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cdl_snapshot_rep ON public.competitor_dive_lists;
CREATE TRIGGER cdl_snapshot_rep
  BEFORE INSERT ON public.competitor_dive_lists
  FOR EACH ROW EXECUTE FUNCTION public.cdl_snapshot_rep();

CREATE OR REPLACE FUNCTION public.event_rep_code(p_event uuid, p_user uuid, p_home text)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    CASE m.represent_as
      WHEN 'region' THEN (
        SELECT rg.short_code FROM public.regions rg
         WHERE rg.id = COALESCE(
           snap.rep_region_id,
           (SELECT c.region_id FROM public.users u JOIN public.clubs c ON c.id = u.club_id WHERE u.id = p_user)))
      WHEN 'club' THEN (
        SELECT c.short_code FROM public.clubs c
         WHERE c.id = COALESCE(snap.rep_club_id, (SELECT u.club_id FROM public.users u WHERE u.id = p_user)))
      ELSE snap.rep_country
    END,
    p_home)
  FROM public.events e
  LEFT JOIN public.meets m ON m.id = e.meet_id
  LEFT JOIN LATERAL (
    SELECT cdl.rep_club_id, cdl.rep_region_id, cdl.rep_country
      FROM public.competitor_dive_lists cdl
     WHERE cdl.event_id = e.id AND cdl.competitor_id = p_user
       AND (cdl.rep_club_id IS NOT NULL OR cdl.rep_region_id IS NOT NULL OR cdl.rep_country IS NOT NULL)
     LIMIT 1
  ) snap ON true
  WHERE e.id = p_event
$$;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 90, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
