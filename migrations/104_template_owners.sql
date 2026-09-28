-- 104_template_owners.sql
--
-- Saved event templates for club and region admins.
--
-- The product call (Sep 2026) is that a template belongs to the
-- organisation that made it, and nobody above or below it gets to see
-- it. A club's templates are for that club's admins, a region's for the
-- region's admins, and the federation's (every row until now) stay with
-- its org admins and meet managers. A federation admin doesn't see its
-- clubs' templates and a club doesn't see the federation's.
--
-- So every template gets exactly one owner, in one of three columns:
--
--   org_id     the org (federation or country account), as before
--   club_id    a club, for its club admins
--   region_id  a region, for its region admins
--
-- A club or region row leaves org_id NULL instead of repeating the
-- club's org. That looks odd next to club_admins, which carries org_id
-- as a belt-and-braces check, but it buys two things:
--
--   * UNIQUE (org_id, name) stays exactly as it is and keeps meaning
--     "a name once per org". NULLs never collide, so a club can have a
--     template called the same as its federation's, or its neighbour's,
--     and the new partial indexes below give clubs and regions their own
--     "once per owner".
--   * Anything that asks for WHERE org_id = $1 only ever gets the org's
--     own rows. That includes the release still running while deploy.sh
--     tests the new one: it upserts ON CONFLICT (org_id, name), which
--     would have 500'd on every save until the restart had we swapped
--     that key for partial indexes. This way the old code carries on
--     unchanged and nothing needs to go in scripts/migration-compat.js.
--
-- Additive otherwise: two nullable columns, one looser NOT NULL, a CHECK
-- every existing row already meets (org_id set, the others NULL) and two
-- indexes. init.sql stays at its pinned baseline.

BEGIN;

-- Same reasoning as 101: rather fail the deploy than park live traffic
-- behind a lock on clubs or regions while the FKs go on.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.event_templates
    ADD COLUMN IF NOT EXISTS club_id uuid
        REFERENCES public.clubs(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS region_id uuid
        REFERENCES public.regions(id) ON DELETE CASCADE,
    ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'event_templates_one_owner'
           AND conrelid = 'public.event_templates'::regclass
    ) THEN
        ALTER TABLE public.event_templates
            ADD CONSTRAINT event_templates_one_owner
            CHECK (num_nonnulls(org_id, club_id, region_id) = 1);
    END IF;
END $$;

-- A name once per club and once per region. They also serve the list
-- query (WHERE club_id = $1 ORDER BY name), and routes/event-templates.js
-- names the predicate in its ON CONFLICT so Postgres picks them.
CREATE UNIQUE INDEX IF NOT EXISTS event_templates_club_name_key
    ON public.event_templates (club_id, name) WHERE club_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS event_templates_region_name_key
    ON public.event_templates (region_id, name) WHERE region_id IS NOT NULL;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 104, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
