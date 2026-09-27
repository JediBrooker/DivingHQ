-- 087_club_first_signup.sql
--
-- Phase 1 of docs/club-first-onboarding.md: a club can sign up in a
-- country where no federation is on DivingHQ yet.
--
--   organisations.claim_state
--       'claimed'   a real federation runs this org. Every org that
--                   exists today is one, hence the default.
--       'unclaimed' a country account the club-first signup made on its
--                   own. Nobody holds org_admin in it; clubs run their
--                   own meets until a federation claims it (phase 3).
--   organisations.claimed_at
--       When it became claimed. NULL for pre-existing orgs, we don't know.
--   organisations_one_unclaimed_per_country
--       Two clubs signing up from the same new country at the same moment
--       must land in the same account, not race into two.
--
--   clubs.created_by
--       Who founded the club through signup. Informational, the actual
--       authority is the club_admins row the signup writes.
--
--   meets.host_club_id
--       NULL means the org hosts the meet, which is how every existing
--       meet works. Set means a club admin of that club can run it.
--       ON DELETE SET NULL hands the meet back to the org rather than
--       deleting a club's competition history with it.

BEGIN;

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS claim_state varchar(12) NOT NULL DEFAULT 'claimed',
  ADD COLUMN IF NOT EXISTS claimed_at  timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organisations_claim_state_check'
  ) THEN
    ALTER TABLE public.organisations
      ADD CONSTRAINT organisations_claim_state_check
      CHECK (claim_state IN ('unclaimed', 'claimed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS organisations_one_unclaimed_per_country
  ON public.organisations (country_code)
  WHERE claim_state = 'unclaimed';

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.meets
  ADD COLUMN IF NOT EXISTS host_club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_meets_host_club
  ON public.meets (host_club_id) WHERE host_club_id IS NOT NULL;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 87, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
