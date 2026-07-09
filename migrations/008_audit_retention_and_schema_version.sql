-- =============================================================
-- MIGRATION 008: audit-log retention + schema version stamp
--
-- Two independent additions kept together because they're both
-- one-table operational hygiene fixes that the server reads on
-- boot.
--
--   1. schema_meta table: a single-row stamp recording the
--      database schema version. The server logs it on start so
--      an operator can confirm at a glance which version a
--      deployed DB is on. init.sql will set version 1; future
--      migrations bump it.
--
--   2. Audit retention: score_audit_log and role_audit_log
--      currently grow without bound. Add a function that
--      purges entries older than 30 days, plus a created_at
--      index on each table so the purge query stays cheap.
--      Call by hand:
--          SELECT public.purge_audit_logs();
--      ...or wire it into a cron / scheduled task. The server can
--      call it on boot too, cheap enough for a routine cleanup.
--
-- Run:
--   psql -d your_db_name -f migrations/008_audit_retention_and_schema_version.sql
--
-- Idempotent.
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- SCHEMA VERSION STAMP
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);

-- Bump to version 8 (matches this migration). Future migrations
-- should bump this to their own number so the row always reflects
-- whatever schema was most recently applied.
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 8, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;


-- -------------------------------------------------------------
-- AUDIT-LOG RETENTION: 30 DAYS
-- -------------------------------------------------------------

-- Indexes on created_at so the time-based delete is index-only
-- rather than a full table scan once these tables grow large.
-- The score audit table already has (event_id, created_at DESC),
-- so we're just adding a flat created_at index for the cleanup path.
CREATE INDEX IF NOT EXISTS idx_score_audit_created_at
    ON public.score_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_role_audit_created_at
    ON public.role_audit_log  (created_at);

-- one-call purge function, returns the row counts deleted from
-- each table so the caller (server boot, cron, ad-hoc psql) can
-- log them
CREATE OR REPLACE FUNCTION public.purge_audit_logs(
    retention_days integer DEFAULT 30
) RETURNS TABLE (table_name text, deleted_rows bigint) LANGUAGE plpgsql AS $$
DECLARE
    cutoff timestamptz;
    n_score bigint;
    n_role  bigint;
BEGIN
    cutoff := now() - make_interval(days => retention_days);

    DELETE FROM public.score_audit_log WHERE created_at < cutoff;
    GET DIAGNOSTICS n_score = ROW_COUNT;

    DELETE FROM public.role_audit_log  WHERE created_at < cutoff;
    GET DIAGNOSTICS n_role = ROW_COUNT;

    RETURN QUERY
        SELECT 'score_audit_log'::text, n_score
        UNION ALL
        SELECT 'role_audit_log'::text,  n_role;
END
$$;

COMMENT ON FUNCTION public.purge_audit_logs(integer) IS
'Deletes audit-log rows older than the given retention window (default 30 days). Returns per-table row counts. Safe to run repeatedly.';

COMMIT;
