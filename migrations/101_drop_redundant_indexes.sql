-- 099_drop_redundant_indexes.sql
--
-- Drops indexes that another index already covers, plus three nothing
-- reads any more. Every one of them still costs a write on insert and
-- update, and the DiveRecorder ones are big (idx_dr_dives_result alone
-- is ~20MB on 1.4M archive dives).
--
-- Exact duplicates:
--   idx_event_judges_event_judge   = event_judges_pkey (event_id, judge_id)
--   idx_meet_sponsor_logos_meet    = UNIQUE (meet_id, slot_number)
--
-- Leading column of a unique key or primary key, which serves the same
-- single-column lookups:
--   idx_dr_dives_result            UNIQUE (dr_result_id, round_number)
--   idx_dr_results_event           UNIQUE (dr_event_id, source_dref)
--   idx_dr_events_meet             UNIQUE (dr_meet_id, source_eref)
--   idx_dive_lists_event           UNIQUE (event_id, competitor_id, round_number)
--   idx_event_attendance_event     PK (event_id, competitor_id)
--   idx_event_managers_event       PK (event_id, user_id)
--   idx_event_round_dives_event    PK (event_id, round_number)
--   idx_club_admins_club           UNIQUE (club_id, user_id)
--   idx_coach_diver_coach          UNIQUE (coach_id, diver_id)
--   idx_event_templates_org        UNIQUE (org_id, name)
--   idx_dive_list_templates_user   UNIQUE (user_id, name)
--   idx_user_org_roles_user        PK (user_id, org_id, role)
--   idx_events_org                 idx_events_rehearsal (org_id, is_rehearsal, status)
--
-- Unused:
--   idx_records_continental_lookup  keyed without gender, from before 094.
--       Every read now filters on gender too, or on continent / event_id
--       alone, and records_continental_gender_key covers both.
--   idx_dr_divers_name  on lower(name), but the archive diver search is
--       name ILIKE '%q%' and nothing compares lower(name). It was only
--       ever maintained, on every import upsert.
--   idx_score_audit_event_round  nothing filters score_audit_log by
--       round; event reads use idx_score_audit_event_created. Every
--       score writes an audit row, so this was one write per score.
--
-- init.sql keeps creating some of these. It's the pinned v53 baseline,
-- and this migration runs on top of it on a fresh install anyway.
--
-- lock_timeout: DROP INDEX wants an ACCESS EXCLUSIVE lock on the table.
-- If a long analytics read is holding events or competitor_dive_lists
-- during a deploy, fail the migration rather than queue live scoring
-- behind the waiting DROP.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_event_judges_event_judge;
DROP INDEX IF EXISTS public.idx_meet_sponsor_logos_meet;

DROP INDEX IF EXISTS public.idx_dr_dives_result;
DROP INDEX IF EXISTS public.idx_dr_results_event;
DROP INDEX IF EXISTS public.idx_dr_events_meet;
DROP INDEX IF EXISTS public.idx_dive_lists_event;
DROP INDEX IF EXISTS public.idx_event_attendance_event;
DROP INDEX IF EXISTS public.idx_event_managers_event;
DROP INDEX IF EXISTS public.idx_event_round_dives_event;
DROP INDEX IF EXISTS public.idx_club_admins_club;
DROP INDEX IF EXISTS public.idx_coach_diver_coach;
DROP INDEX IF EXISTS public.idx_event_templates_org;
DROP INDEX IF EXISTS public.idx_dive_list_templates_user;
DROP INDEX IF EXISTS public.idx_user_org_roles_user;
DROP INDEX IF EXISTS public.idx_events_org;

DROP INDEX IF EXISTS public.idx_records_continental_lookup;
DROP INDEX IF EXISTS public.idx_dr_divers_name;
DROP INDEX IF EXISTS public.idx_score_audit_event_round;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 99, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
