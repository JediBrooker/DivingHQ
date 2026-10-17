-- 108_profile_gender_case.sql
--
-- users.gender is free text (migration 058). The forms write lowercase
-- ('female', 'male', 'other', 'prefer_not_to_say'), but the admin drawer
-- and older imports left some rows capitalised or abbreviated, and from
-- now on entry eligibility (lib/entry-eligibility.js) and record_gender
-- (migration 094) both read the value. Fold the known spellings onto the
-- lowercase ones so what an admin sees in the drawer is what the checks
-- read. Anything else is left alone: the check treats it as 'other'.
--
-- Signup now asks for date of birth and gender and members set their own
-- under Competition details (PUT /api/users/me/details); no new columns.

BEGIN;

UPDATE public.users
   SET gender = CASE lower(btrim(gender))
                  WHEN 'male'   THEN 'male'
                  WHEN 'm'      THEN 'male'
                  WHEN 'female' THEN 'female'
                  WHEN 'f'      THEN 'female'
                  WHEN 'other'  THEN 'other'
                  WHEN 'prefer not to say' THEN 'prefer_not_to_say'
                  WHEN 'prefer_not_to_say' THEN 'prefer_not_to_say'
                END
 WHERE gender IS NOT NULL
   AND lower(btrim(gender)) IN ('male', 'm', 'female', 'f', 'other', 'prefer not to say', 'prefer_not_to_say')
   AND gender IS DISTINCT FROM CASE lower(btrim(gender))
                  WHEN 'male'   THEN 'male'
                  WHEN 'm'      THEN 'male'
                  WHEN 'female' THEN 'female'
                  WHEN 'f'      THEN 'female'
                  WHEN 'other'  THEN 'other'
                  WHEN 'prefer not to say' THEN 'prefer_not_to_say'
                  WHEN 'prefer_not_to_say' THEN 'prefer_not_to_say'
                END;

INSERT INTO public.schema_meta (id, version, applied_at) VALUES (1, 108, now())
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
