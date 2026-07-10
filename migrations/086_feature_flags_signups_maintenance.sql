-- 086_feature_flags_signups_maintenance.sql
--
-- Two more runtime switches in the feature_flags table (see migration 085
-- and lib/features.js).
--
--   signups      Public registration. Retires the old SIGNUPS_ENABLED env
--                var: the gate in routes/auth.js now reads this flag instead,
--                so opening registration is a click in /admin/features rather
--                than an ssh + edit + restart. Seeded ON, because the call to
--                open registration has been made.
--
--   maintenance  Read-only lockdown. Seeded OFF. When on, non-admin writes
--                are refused and a banner shows; reads and admin sign-in stay
--                live. This is the switch you flip before a risky deploy or a
--                database migration and flip back after.
--
-- ON CONFLICT DO NOTHING so re-running never clobbers a value an operator has
-- since changed (e.g. someone closing registration again from the admin UI
-- must not have it silently reopened by a redeploy).

BEGIN;

INSERT INTO public.feature_flags (key, enabled)
VALUES ('signups',     true),
       ('maintenance', false)
ON CONFLICT (key) DO NOTHING;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 86, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
