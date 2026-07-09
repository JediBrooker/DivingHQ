-- =============================================================
-- MIGRATION 033: score_audit_log actor index
--
-- The federation-wide /api/audit/scores endpoint (added with
-- the audit log view in 43128b5) supports filtering by actor,
-- basically "show me every score amendment user X has made".
-- The existing score_audit_log indexes cover (event_id, …),
-- competitor_id, judge_id, and created_at, but not actor.
--
-- Without this index, an actor-filtered query falls back to a
-- sequential scan plus the existing event-id index. Fine for a
-- few thousand rows but it slows down once a federation racks up
-- a year of audit history. The role_audit_log and audit_log
-- tables already have analogous (actor_id, created_at DESC)
-- indexes, so this just brings score_audit_log into line.
-- =============================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_score_audit_actor
    ON public.score_audit_log (actor_user_id, created_at DESC);

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 33, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
