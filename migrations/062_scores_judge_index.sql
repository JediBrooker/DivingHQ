-- =============================================================
-- MIGRATION 062: index scores(judge_id)
--
-- GET /api/judges/:id/analytics (and /profile) filters scores by
-- judge_id via the JUDGE_PER_DIVE CTE (db/queries.js), and the
-- public judges directory runs a LATERAL COUNT(*) over scores per
-- judge. None of the existing scores indexes lead with judge_id:
--   * UNIQUE (event_id, competitor_id, round_number, judge_id)
--     (judge_id is the last key here, not prefix-usable)
--   * (event_id, round_number)
--   * (competitor_id)
-- so every analytics rollup sequential-scans the whole scores
-- table. The analytics endpoint fans out ~16 of these rollups per
-- request, which on a busy install turns one public page view
-- into 16 table scans. A plain btree on judge_id turns each into
-- an index scan instead.
--
-- IF NOT EXISTS keeps the file idempotent, same convention as
-- every other migration (see scripts/migrate.js). CONCURRENTLY
-- isn't usable here since the runner executes each file as one
-- multi-statement query inside BEGIN/COMMIT, and CREATE INDEX
-- CONCURRENTLY can't run inside a transaction block.
-- =============================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_scores_judge ON public.scores (judge_id);

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 62, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
