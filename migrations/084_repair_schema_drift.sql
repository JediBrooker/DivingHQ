-- =============================================================
-- MIGRATION 084: repair schema drift between the two bootstrap
-- lineages.
--
-- A DivingHQ database can be born one of two ways:
--
--   A. init.sql, which is a snapshot pinned at schema_meta.version
--      = 53, followed by `npm run migrate` applying 054 onwards.
--      That's what CI does and what a fresh install does.
--   B. an older init.sql snapshot, followed by whatever migrations
--      were pending at the time. Every long-lived dev box and the
--      production database got here this way.
--
-- The two lineages have quietly diverged, because the runner only
-- ever tracked one integer (schema_meta.version) and could not tell
-- which files had actually run. Concretely:
--
--   * Migrations 008..053 NEVER run on lineage A, since init.sql
--     already claims version 53. So anything those files create but
--     init.sql forgot to include is missing forever. Three indexes
--     are in that bucket (025, 040, 041).
--   * Conversely, init.sql grew objects that no migration creates
--     (idx_events_board), so lineage B never gets them.
--   * migrations/051 was added to init.sql after the fact (commit
--     c86be38). Any lineage-B database bootstrapped before that
--     commit skipped 051 (51 <= 53) and has no
--     pending_partner_pairings table at all. That's the
--     "[Pending Pairings Error] relation does not exist" you see in
--     the server log.
--   * migration 075's inline `CHECK (amount_cents >= 0)` on payouts
--     is missing wherever the table predates the check being added
--     to the file.
--
-- This migration is the convergence point. It's version 84, so it
-- runs exactly once on every database regardless of lineage, and
-- every statement is written to be a no-op when the object is
-- already there. After it, A and B have identical schemas.
--
-- The underlying cause (a single version integer instead of a
-- per-file ledger) is fixed in scripts/migrate.js, and
-- scripts/check-schema-drift.js now guards the invariant in CI.
-- =============================================================

BEGIN;

-- ---- 1. migration 051's table -------------------------------
-- Verbatim from 051_pending_partner_pairings.sql. Synchro pairing
-- consent is broken without it: routes/competitor.js reads this on
-- every synchro dive-list submit.
CREATE TABLE IF NOT EXISTS public.pending_partner_pairings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    requester_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    partner_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    dives         jsonb NOT NULL DEFAULT '[]'::jsonb,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    responded_at  timestamptz,
    UNIQUE (event_id, requester_id, partner_id),
    CHECK (requester_id <> partner_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_pairings_partner
    ON public.pending_partner_pairings (partner_id, status)
    WHERE status = 'pending';

-- ---- 2. indexes only lineage B ever got ---------------------
-- From migrations 025, 040 and 041. Pure read-path indexes, so the
-- symptom on lineage A is a slow query rather than an error, wich is
-- exactly why nobody noticed for 30-odd migrations.
CREATE INDEX IF NOT EXISTS idx_dive_directory_custom_org
    ON public.dive_directory (created_org_id) WHERE is_custom;

CREATE INDEX IF NOT EXISTS idx_competitor_dive_lists_event_reserve
    ON public.competitor_dive_lists (event_id, is_reserve);

CREATE INDEX IF NOT EXISTS idx_events_dive_list_locks_at
    ON public.events (dive_list_locks_at);

-- ---- 3. the index only lineage A ever got -------------------
-- Declared in init.sql, created by no migration.
CREATE INDEX IF NOT EXISTS idx_events_board
    ON public.events (board_id) WHERE board_id IS NOT NULL;

-- ---- 4. payouts amount guard --------------------------------
-- Migration 075 declares `amount_cents integer NOT NULL CHECK
-- (amount_cents >= 0)` inline, so Postgres auto-names the constraint
-- payouts_amount_cents_check. Databases whose payouts table was
-- created before that CHECK went into the file have the column but
-- not the guard, and CREATE TABLE IF NOT EXISTS never revisits it.
-- A payout ledger that accepts negative amounts is worth closing.
--
-- Adding it plain would abort the whole migration if some historical
-- row is already negative, wich would wedge a deploy over a data
-- problem. So: count first. If the table is clean, add and validate.
-- If it isn't, add NOT VALID (new writes are guarded from this moment)
-- and shout about the rows that need a human.
DO $$
DECLARE
  bad_rows bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payouts'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%amount_cents%>= 0%'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO bad_rows FROM public.payouts WHERE amount_cents < 0;

  IF bad_rows > 0 THEN
    RAISE WARNING
      'payouts holds % row(s) with a negative amount_cents. Adding the guard NOT VALID so this migration still lands. Fix the rows, then: ALTER TABLE public.payouts VALIDATE CONSTRAINT payouts_amount_cents_check;',
      bad_rows;
    ALTER TABLE public.payouts
      ADD CONSTRAINT payouts_amount_cents_check CHECK (amount_cents >= 0) NOT VALID;
  ELSE
    ALTER TABLE public.payouts
      ADD CONSTRAINT payouts_amount_cents_check CHECK (amount_cents >= 0);
  END IF;
END $$;

-- ---- 5. referee sign-off by handoff code --------------------
-- Migration 030 created referee_signoff_requests with
-- CHECK (decision_method IN ('push','credential')). The 6-digit
-- handoff-code flow landed later and widened that list to include
-- 'code', but only inside init.sql. routes/control-room.js:1452
-- writes decision_method='code', so on any database that took the
-- migration path the referee's code sign-off blows up on the check
-- constraint. Fresh installs never saw it because init.sql is right.
-- Loop rather than SELECT INTO: a bare INTO quietly keeps the first row
-- when several match, and this table has picked up differently-named
-- copies of the same rule depending on how the database was born.
-- Dropping and re-adding inside the migration's transaction means the
-- column is never unguarded from anyone else's point of view. Existing
-- values are all 'push' or 'credential', so the wider CHECK can't fail
-- validation.
DO $$
DECLARE
  stale record;
  widened boolean := false;
BEGIN
  FOR stale IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.referee_signoff_requests'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%decision_method%'
       AND pg_get_constraintdef(oid) NOT ILIKE '%''code''%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.referee_signoff_requests DROP CONSTRAINT %I',
      stale.conname);
    widened := true;
  END LOOP;

  IF widened AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.referee_signoff_requests'::regclass
       AND conname  = 'referee_signoff_requests_decision_method_check'
  ) THEN
    ALTER TABLE public.referee_signoff_requests
      ADD CONSTRAINT referee_signoff_requests_decision_method_check
        CHECK (decision_method IN ('push', 'credential', 'code'));
  END IF;
END $$;

-- ---- 6. converge the two check-constraint names -------------
-- init.sql spelled these as inline unnamed CHECKs, so pg_dump handed
-- them auto-generated names. Migrations 038 and 043 add the same
-- rules under explicit names, and their guard clauses look the name
-- up, so on lineage A they'd cheerfully add a second, identical
-- constraint. Rename rather than duplicate. init.sql now names them
-- explicitly too, so fresh databases skip this entirely.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.competitor_dive_lists'::regclass
                AND conname  = 'competitor_dive_lists_group_number_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.competitor_dive_lists'::regclass
                        AND conname  = 'cdl_group_number_check')
  THEN
    ALTER TABLE public.competitor_dive_lists
      RENAME CONSTRAINT competitor_dive_lists_group_number_check
                     TO cdl_group_number_check;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.events'::regclass
                AND conname  = 'events_round_rules_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.events'::regclass
                        AND conname  = 'events_round_rules_shape_check')
  THEN
    ALTER TABLE public.events
      RENAME CONSTRAINT events_round_rules_check
                     TO events_round_rules_shape_check;
  END IF;
END $$;

-- ---- bump schema version ------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 84, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
