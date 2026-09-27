-- 088_regions.sql
--
-- Phase 2 of docs/club-first-onboarding.md: an optional state / province
-- / home-nation layer between a country's org and its clubs.
--
--   organisations.region_label
--       What this country calls its regions, as a key the SPA translates:
--       'state', 'province', 'home_nation', 'region'. NULL means the org
--       has no regions and signup skips the step.
--
--   regions
--       One row per state etc. inside an org. short_code is what shows on
--       scoreboards later ('NSW'). They're materialised from the built-in
--       catalogue (lib/regions.json) rather than typed by clubs, so we
--       never end up with 'NSW', 'N.S.W.' and 'New South Wales' as three.
--       claim_state / claimed_name are for phase 3 (a state body claims
--       its region); every region starts unclaimed.
--
--   clubs.region_id
--       Which region a club is in. NULL for countries without regions,
--       and for clubs that signed up before their country had them.
--
--   region_admins
--       Mirrors club_admins (067). A region admin runs meets their region
--       (or any club in it) hosts and reviews its clubs' role requests.
--
--   meets.host_region_id
--       A region-hosted meet (state championships). A meet has at most one
--       host: a club, a region, or neither (the org itself).

BEGIN;

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS region_label varchar(20);

CREATE TABLE IF NOT EXISTS public.regions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  name         varchar(80) NOT NULL,
  short_code   varchar(8)  NOT NULL,
  claim_state  varchar(12) NOT NULL DEFAULT 'unclaimed'
                 CHECK (claim_state IN ('unclaimed', 'claimed')),
  claimed_name varchar(120),
  claimed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, short_code)
);

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clubs_region ON public.clubs (region_id) WHERE region_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.region_admins (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id  uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_region_admins_user ON public.region_admins (user_id);

ALTER TABLE public.meets
  ADD COLUMN IF NOT EXISTS host_region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meets_one_host') THEN
    ALTER TABLE public.meets
      ADD CONSTRAINT meets_one_host CHECK (host_club_id IS NULL OR host_region_id IS NULL);
  END IF;
END $$;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 88, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
