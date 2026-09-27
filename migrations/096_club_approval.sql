-- 096_club_approval.sql
--
-- Federation approval of new clubs (docs/club-first-onboarding.md §6.1,
-- the part phase 1 left for later, §14; as built in §20).
--
-- Until now a club founded at signup under a real federation was live the
-- moment it was created: in every picker, able to host meets, with nobody
-- told. Now it waits for the federation's org admin, unless the federation
-- has said clubs may join automatically.
--
--   clubs.status          'pending' or 'active'. Everything that exists
--                         today is active, and anything that inserts a club
--                         without saying otherwise gets 'active', so the
--                         default fails open to today's behaviour and never
--                         to extra privilege. Only signup under a claimed
--                         federation writes 'pending'. Room in the CHECK
--                         for 'suspended' later if we ever want it.
--   clubs.submitted_at    when the federation was asked, i.e. when the
--                         founder verified their email. Makes the "a club
--                         is waiting" notice go out once.
--   clubs.approved_at     when it was approved. NULL for clubs that never
--                         waited (everything before this, and auto-joins).
--   organisations.auto_approve_clubs
--                         "clubs join automatically". Off everywhere,
--                         existing federations included, so they start
--                         getting a queue. Only means anything once the
--                         org is claimed; an unclaimed country has nobody
--                         to approve anything and its clubs always join.
--
-- event_rep_code() also stops printing a pending club's short code on the
-- scoreboard. The founder picked that code and nobody has vetted it yet,
-- so until the club is approved its divers show their home country
-- instead. The entry snapshot still records the club, so the code turns up
-- by itself once it's approved.

BEGIN;

ALTER TABLE public.clubs
    ADD COLUMN IF NOT EXISTS status       varchar(10) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
    ADD COLUMN IF NOT EXISTS approved_at  timestamptz;

-- No ADD CONSTRAINT IF NOT EXISTS in Postgres, hence the guard.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'clubs_status_check'
           AND conrelid = 'public.clubs'::regclass
    ) THEN
        ALTER TABLE public.clubs
            ADD CONSTRAINT clubs_status_check CHECK (status IN ('pending', 'active'));
    END IF;
END $$;

-- The federation's queue, and the dashboard count.
CREATE INDEX IF NOT EXISTS idx_clubs_pending
    ON public.clubs (org_id)
    WHERE status = 'pending';

ALTER TABLE public.organisations
    ADD COLUMN IF NOT EXISTS auto_approve_clubs boolean NOT NULL DEFAULT false;

-- Same as 095 apart from the club branch, which now skips a club that
-- hasn't been approved yet.
CREATE OR REPLACE FUNCTION public.event_rep_code(p_event uuid, p_user uuid, p_home text)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    CASE m.represent_as
      WHEN 'region' THEN (SELECT rg.short_code FROM public.regions rg WHERE rg.id = r.region_id)
      WHEN 'club'   THEN (SELECT c.short_code FROM public.clubs c
                           WHERE c.id = r.club_id AND c.status = 'active')
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
VALUES (1, 96, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
