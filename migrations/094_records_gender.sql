-- 094_records_gender.sql
--
-- Record books split by gender, individual dives only.
--
-- Until now every book (personal, club, region, federation,
-- continental) was keyed on (scope, height, dive_code, position) and
-- nothing else. So a man's 107B quietly archived a woman's club record
-- for the same dive, and synchro dives (credited to the lead diver
-- alone) competed with individual ones. lib/records.js now only looks
-- at individual events and files each mark under the diver's gender;
-- this migration gives the tables the column and key to hold that.
--
--   gender       Male or Female. A Male/Female event decides it. A Mixed
--                individual event falls back to the diver's profile
--                gender, and when that's unknown the dive sets nothing.
--                Nullable because old rows may not resolve (see below).
--   prev_score   The score the record beat, NULL for a first mark. The
--                scoreboard uses it to tell "a new record" from "the
--                first time anyone did this dive here", which is noise.
--
--   record_gender(event gender, profile gender)
--                The rule above as one function, so the live write path,
--                this backfill, the rebuild script and the seed agree.
--                users.gender is free text ('male', 'female', 'other',
--                'prefer_not_to_say' from the User Manager), hence the
--                normalising.
--
--   idx_records_*_event
--                event_id on the five current books, for the scoreboard's
--                record chip (bottom of the file).
--
-- Existing rows: additive backfill only, nothing is deleted. A row gets
-- the gender its event says, else its holder's profile gender. Rows set
-- at synchro or team events are left NULL on purpose: under the new
-- rule they aren't records at all, and a NULL gender keeps them out of
-- the gendered books without throwing anything away. Rows that can't be
-- resolved stay NULL too and simply don't show. scripts/rebuild-records.js
-- (dry run by default) is there for a sysadmin who wants the books
-- recomputed from the scores themselves.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_gender(p_event event_gender, p_profile text)
RETURNS event_gender
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_event IN ('Male', 'Female') THEN p_event
    WHEN lower(btrim(p_profile)) IN ('male', 'm')   THEN 'Male'::event_gender
    WHEN lower(btrim(p_profile)) IN ('female', 'f') THEN 'Female'::event_gender
  END
$$;

ALTER TABLE public.records_personal            ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_club                ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_region              ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_federation          ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_continental         ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_personal_history    ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_club_history        ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_region_history      ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_federation_history  ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);
ALTER TABLE public.records_continental_history ADD COLUMN IF NOT EXISTS gender event_gender, ADD COLUMN IF NOT EXISTS prev_score numeric(8,2);

-- Backfill, one table at a time. Only touches rows still NULL, so a
-- second run is a no-op apart from rows that still can't be resolved.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('records_personal',            'user_id'),
      ('records_club',                'holder_id'),
      ('records_region',              'holder_id'),
      ('records_federation',          'holder_id'),
      ('records_continental',         'holder_id'),
      ('records_personal_history',    'user_id'),
      ('records_club_history',        'holder_id'),
      ('records_region_history',      'holder_id'),
      ('records_federation_history',  'holder_id'),
      ('records_continental_history', 'holder_id')) AS v(tbl, holder)
  LOOP
    EXECUTE format(
      'UPDATE public.%1$I r
          SET gender = public.record_gender(
                (SELECT e.gender FROM public.events e WHERE e.id = r.event_id),
                (SELECT u.gender FROM public.users u WHERE u.id = r.%2$I))
        WHERE r.gender IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.events e
                           WHERE e.id = r.event_id AND e.event_type <> ''individual'')',
      t.tbl, t.holder);
  END LOOP;
END $$;

-- Swap each current table's unique key for one that includes gender.
-- The old keys were auto-named and nobody should have to guess what an
-- older bootstrap called them, so find them by shape: a unique key over
-- the scope column + height + dive_code + position without gender.
DO $$
DECLARE
  t record;
  c record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('records_personal',    'user_id'),
      ('records_club',        'club_id'),
      ('records_region',      'region_id'),
      ('records_federation',  'org_id'),
      ('records_continental', 'continent')) AS v(tbl, col)
  LOOP
    FOR c IN
      SELECT con.conname
        FROM pg_constraint con
       WHERE con.conrelid = format('public.%I', t.tbl)::regclass
         AND con.contype = 'u'
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                FROM pg_attribute a
               WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey))
             = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[t.col, 'height', 'dive_code', 'position']) x)
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t.tbl, c.conname);
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t.tbl || '_gender_key') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (%I, gender, height, dive_code, position)',
        t.tbl, t.tbl || '_gender_key', t.col);
    END IF;

    -- Books are Women's and Men's. A Mixed record would be a bug in the
    -- writer, so say so loudly rather than let it sit in a third book.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t.tbl || '_gender_check') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (gender <> ''Mixed'')',
        t.tbl, t.tbl || '_gender_check');
    END IF;
  END LOOP;
END $$;

-- The scoreboard asks "which records does this event hold?" every time
-- it rebuilds its cache (eventRecordMarks in lib/records.js), and
-- deleting an event nulls event_id right across the books. Neither had
-- an index to lean on, so each was a scan of every record table.
CREATE INDEX IF NOT EXISTS idx_records_personal_event    ON public.records_personal (event_id);
CREATE INDEX IF NOT EXISTS idx_records_club_event        ON public.records_club (event_id);
CREATE INDEX IF NOT EXISTS idx_records_region_event      ON public.records_region (event_id);
CREATE INDEX IF NOT EXISTS idx_records_federation_event  ON public.records_federation (event_id);
CREATE INDEX IF NOT EXISTS idx_records_continental_event ON public.records_continental (event_id);

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 94, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
