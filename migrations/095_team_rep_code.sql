-- 095_team_rep_code.sql
--
-- Follow-ups to migration 090 (what a diver represents at a meet).
--
--   A snapshot is the answer, even an incomplete one
--       event_rep_code() used to fill holes in an entry snapshot with the
--       diver's club as it is *today*. Enter from a club that has no
--       region yet, or from a club that later gets deleted, and the old
--       meet would pick up whatever club you're in now, so a move next
--       season relabelled this season. Now today's club only counts when
--       the entry has no snapshot at all (rows from before 090). A
--       snapshot club with no snapshot region still resolves to the region
--       that club sits in, because it's the same club, it just got placed
--       in a region after the entry.
--
--   competitor_dive_lists.partner_rep_club_id / _region_id / _country
--       Roster late-add and CSV import write a synchro pair as one row,
--       with the partner in partner_id and no row of their own, so the 090
--       trigger never looked at them and their chip tracked their current
--       club forever. Same trigger now snapshots the partner too, on
--       insert and again when a row's partner is swapped for somebody
--       else (the ON CONFLICT upserts do that). An account merge moves
--       partner_id to the same person's other account, so it sets
--       divinghq.keep_rep_snapshot for its transaction and keeps what was
--       recorded. Rows written before this migration aren't backfilled:
--       like pre-090 entries, they fall back to the partner's current
--       state, since we never saw who they were.
--
--   event_rep_ids(event_id, user_id)
--       The club / region / country an entry resolves to, in one place,
--       so event_rep_code() and the region-record lookup in lib/records.js
--       can't drift apart. Own entry row first, then a partner snapshot.

BEGIN;

ALTER TABLE public.competitor_dive_lists
  ADD COLUMN IF NOT EXISTS partner_rep_club_id   uuid REFERENCES public.clubs(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS partner_rep_region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS partner_rep_country   char(3);

CREATE OR REPLACE FUNCTION public.cdl_snapshot_rep() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
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
    IF NEW.partner_id IS NOT NULL
       AND NEW.partner_rep_club_id IS NULL AND NEW.partner_rep_region_id IS NULL
       AND NEW.partner_rep_country IS NULL THEN
      SELECT u.club_id, c.region_id, o.country_code
        INTO NEW.partner_rep_club_id, NEW.partner_rep_region_id, NEW.partner_rep_country
        FROM public.users u
        LEFT JOIN public.clubs c ON c.id = u.club_id
        LEFT JOIN public.organisations o ON o.id = u.org_id
       WHERE u.id = NEW.partner_id;
    END IF;
  ELSIF NEW.partner_id IS DISTINCT FROM OLD.partner_id
        AND COALESCE(current_setting('divinghq.keep_rep_snapshot', true), '') <> 'on' THEN
    -- A different partner is a different entry for this slot, so the old
    -- partner's snapshot can't stay.
    NEW.partner_rep_club_id   := NULL;
    NEW.partner_rep_region_id := NULL;
    NEW.partner_rep_country   := NULL;
    IF NEW.partner_id IS NOT NULL THEN
      SELECT u.club_id, c.region_id, o.country_code
        INTO NEW.partner_rep_club_id, NEW.partner_rep_region_id, NEW.partner_rep_country
        FROM public.users u
        LEFT JOIN public.clubs c ON c.id = u.club_id
        LEFT JOIN public.organisations o ON o.id = u.org_id
       WHERE u.id = NEW.partner_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cdl_snapshot_rep ON public.competitor_dive_lists;
CREATE TRIGGER cdl_snapshot_rep
  BEFORE INSERT OR UPDATE OF partner_id ON public.competitor_dive_lists
  FOR EACH ROW EXECUTE FUNCTION public.cdl_snapshot_rep();

-- Always exactly one row. A plain SQL set-returning function, so the
-- planner can inline it into the LATERAL joins that call it.
CREATE OR REPLACE FUNCTION public.event_rep_ids(p_event uuid, p_user uuid)
RETURNS TABLE (club_id uuid, region_id uuid, country char(3))
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN snap.found THEN snap.club_id ELSE u.club_id END,
         CASE WHEN snap.found THEN COALESCE(snap.region_id, sc.region_id) ELSE uc.region_id END,
         snap.country
    FROM (SELECT p_user AS id) me
    LEFT JOIN LATERAL (
      SELECT true AS found, x.club_id, x.region_id, x.country
        FROM (
          SELECT 0 AS pref, cdl.round_number,
                 cdl.rep_club_id AS club_id, cdl.rep_region_id AS region_id, cdl.rep_country AS country
            FROM public.competitor_dive_lists cdl
           WHERE cdl.event_id = p_event AND cdl.competitor_id = p_user
             AND (cdl.rep_club_id IS NOT NULL OR cdl.rep_region_id IS NOT NULL OR cdl.rep_country IS NOT NULL)
          UNION ALL
          SELECT 1, cdl.round_number,
                 cdl.partner_rep_club_id, cdl.partner_rep_region_id, cdl.partner_rep_country
            FROM public.competitor_dive_lists cdl
           WHERE cdl.event_id = p_event AND cdl.partner_id = p_user
             AND (cdl.partner_rep_club_id IS NOT NULL OR cdl.partner_rep_region_id IS NOT NULL
                  OR cdl.partner_rep_country IS NOT NULL)
        ) x
       ORDER BY x.pref, x.round_number
       LIMIT 1
    ) snap ON true
    LEFT JOIN public.clubs sc ON sc.id = snap.club_id
    LEFT JOIN public.users u ON u.id = me.id
    LEFT JOIN public.clubs uc ON uc.id = u.club_id
$$;

CREATE OR REPLACE FUNCTION public.event_rep_code(p_event uuid, p_user uuid, p_home text)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    CASE m.represent_as
      WHEN 'region' THEN (SELECT rg.short_code FROM public.regions rg WHERE rg.id = r.region_id)
      WHEN 'club'   THEN (SELECT c.short_code FROM public.clubs c WHERE c.id = r.club_id)
      ELSE r.country
    END,
    p_home)
  FROM public.events e
  LEFT JOIN public.meets m ON m.id = e.meet_id
  LEFT JOIN LATERAL public.event_rep_ids(e.id, p_user) r ON true
  WHERE e.id = p_event
$$;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 95, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
