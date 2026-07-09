-- =============================================================
-- MIGRATION 032 - GENERAL AUDIT LOG
--
-- Adds a new `audit_log` table for entity-lifecycle events that
-- the existing per-domain logs (`score_audit_log`,
-- `role_audit_log`) don't capture: event create / delete /
-- status change, org status flips, club + team deletes, late-
-- entry adds, withdraw + reinstate, pre-meet workflow resets,
-- manager-attest sign-offs.
--
-- The two existing logs stay where they are since they're optimised
-- for their respective query patterns (per-event score audit,
-- per-user role history). This new table sits alongside them
-- as generic catch-all for everything else, with a `metadata`
-- jsonb so action-specific details (old / new status, withdrawn
-- diver name, …) ride along without schema bloat.
--
-- Schema design notes:
--
-- * `org_id` is nullable so sysadmin actions on org records
--   themselves still log (the org being created has no parent
--   org).
-- * `actor_id` is ON DELETE SET NULL so user purge doesn't
--   destroy the historical actor link.
-- * heads up: `entity_id` is nullable because an entity can be deleted
--   AFTER the audit row is written; the row preserves
--   `entity_name` denormalised so the audit view reads
--   correctly even after the source row is gone.
-- * `entity_type` + `action` are short varchars (rather than
--   enums) so adding new audited surfaces in future commits is
--   a code-only change, no migration churn.
-- * `metadata` is jsonb. Common shapes:
--     { from: 'Live', to: 'Completed' }     (status changes)
--     { competitor_id, round_count }        (late entries)
--     { round_count, withdrawn_at }         (withdraw/reinstate)
-- * Three indexes cover the read patterns the new
--   /api/audit/activity endpoint hits:
--     - per-org chronological feed
--     - per-entity drill-down
--     - per-actor "what has X been doing"
--
-- Audit retention: the existing `purge_audit_logs(retention_days)`
-- function (migration 008) is extended to truncate this table
-- on the same 30-day window, see the function update below.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.audit_log (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id       uuid REFERENCES public.organisations(id) ON DELETE SET NULL,
    actor_id     uuid REFERENCES public.users(id)         ON DELETE SET NULL,
    entity_type  varchar(40) NOT NULL,
    entity_id    uuid,                          -- nullable post-delete
    entity_name  varchar(255),                  -- denormalised
    action       varchar(60) NOT NULL,
    metadata     jsonb,
    note         text,
    ip_address   inet,
    user_agent   text,
    created_at   timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_org_created
    ON public.audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity
    ON public.audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON public.audit_log (actor_id, created_at DESC);

-- Extend the existing audit-purge function (migration 008
-- created `purge_audit_logs(retention_days)`) to also truncate
-- the new table. The signature stays
-- `RETURNS TABLE (table_name text, deleted_rows bigint)` so
-- existing call sites keep working, we just gain a third
-- output row for `audit_log`. CREATE OR REPLACE works because
-- the column types are unchanged.
CREATE OR REPLACE FUNCTION public.purge_audit_logs(
    retention_days integer DEFAULT 30
) RETURNS TABLE (table_name text, deleted_rows bigint) LANGUAGE plpgsql AS $$
DECLARE
    cutoff timestamptz;
    n_score bigint;
    n_role  bigint;
    n_audit bigint;
BEGIN
    cutoff := now() - make_interval(days => retention_days);

    DELETE FROM public.score_audit_log WHERE created_at < cutoff;
    GET DIAGNOSTICS n_score = ROW_COUNT;

    DELETE FROM public.role_audit_log  WHERE created_at < cutoff;
    GET DIAGNOSTICS n_role = ROW_COUNT;

    DELETE FROM public.audit_log       WHERE created_at < cutoff;
    GET DIAGNOSTICS n_audit = ROW_COUNT;

    RETURN QUERY
        SELECT 'score_audit_log'::text, n_score
        UNION ALL
        SELECT 'role_audit_log'::text,  n_role
        UNION ALL
        SELECT 'audit_log'::text,       n_audit;
END
$$;

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 32, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
