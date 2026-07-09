-- =============================================================
-- MIGRATION 021: TOKEN VERSIONING, EMAIL VERIFICATION, INDEXES
--
-- Closes three findings from the May-2026 audit:
--
-- 1. Stale JWT claims. Demoting a judge or revoking sysadmin didn't
--    actually revoke anything (classic gotcha with JWTs): old tokens
--    stayed privileged for up to JWT_EXPIRY (8h). Adds
--    users.token_version: every JWT carries the issuing version, and
--    the verifier rejects tokens whose tv doesn't match. Bumping the
--    column instantly invalidates every outstanding session for that
--    user.
--
-- 2. Self-service registration with no email confirmation.
--    Adds users.email_verified_at; existing rows are grandfathered
--    in (backfilled to created_at), new registrations leave the
--    column NULL until the user clicks the verification link.
--
-- 3. Missing composite indexes on the hottest read paths
--    (scoreboard rebuild, submit_score panel lookup). Adds
--    indexes on scores(event_id, round_number) and
--    event_judges(event_id, judge_id), drops the redundant
--    single-column idx_scores_event (the unique constraint on
--    (event_id, competitor_id, round_number, judge_id) is
--    already prefix-usable for event_id-only queries).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, DROP INDEX IF EXISTS. Re-runs on a v21 DB are no-ops.
-- =============================================================

BEGIN;

-- ---------- users.token_version --------------------------------
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;

-- ---------- users.email_verified_at ----------------------------
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- Grandfather existing accounts: any user that already had an
-- account before this migration is treated as verified, so the
-- new gate doesn't lock anyone out at deploy time. Only NEW
-- registrations from now on need the email-click round trip.
UPDATE public.users
   SET email_verified_at = COALESCE(created_at, now())
 WHERE email_verified_at IS NULL;

-- ---------- Indexes --------------------------------------------

-- Hot path: scoreboard standings query groups scores by
-- (event_id, round_number). Without this index the planner uses
-- the single-column idx_scores_event then filters per-row.
CREATE INDEX IF NOT EXISTS idx_scores_event_round
    ON public.scores (event_id, round_number);

-- Hot path: submit_score panel lookup. Every score submission
-- runs `WHERE event_id = $1 AND judge_id = $2`. The existing
-- single-column idx_event_judges_event forces a scan of every
-- panel member for every submission.
CREATE INDEX IF NOT EXISTS idx_event_judges_event_judge
    ON public.event_judges (event_id, judge_id);

-- The unique constraint on scores(event_id, competitor_id,
-- round_number, judge_id) creates an index that is prefix-usable
-- for event_id-only filters. The standalone single-column
-- idx_scores_event is therefore redundant.
DROP INDEX IF EXISTS public.idx_scores_event;

-- ---------- Schema version stamp -------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 21, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
