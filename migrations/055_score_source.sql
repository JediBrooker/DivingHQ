-- =============================================================
-- MIGRATION 055: SCORE SOURCE TRACKING (P5)
--
-- Manual fallback mode (docs/offline-p1-design.md §Phase 5):
-- during an extended outage the operator can type each judge's
-- score directly from the Control Room, reading the value off the
-- judge's phone (which displays it as a giant number). When the
-- judge's device later reconnects and syncs its queued
-- submit_score, the server reconciles the two: same value means
-- it's audit-logged as confirmed, mismatch means conflict_pending
-- fires for the operator's review tray.
--
-- The reconciliation needs to know whether a score row arrived
-- via the judge directly or via the operator's manual fallback.
-- That's what `score_source` is for. Three states:
--
--   'judge_direct'           - the judge's own submit_score (today's
--                              path, default for every existing row)
--   'manual_entry'           - operator typed it; the judge's later
--                              digital sync will reconcile
--   'manual_then_reconciled' - operator typed AND the judge's later
--                              sync matched; both clocks are now
--                              recorded on the audit row
--
-- Cheap column (varchar(28), NOT NULL DEFAULT 'judge_direct').
-- Existing rows backfill to 'judge_direct' implicitly, since none
-- of them came from the manual path (it didn't exist yet).
--
-- The audit row separately captures who entered the score (the
-- score_audit_log already carries actor_user_id). With the new
-- column the scores table can answer "where did this value come
-- from?" without a join.
-- =============================================================

BEGIN;

-- Audit-log enum extension. The reconciliation path writes
-- 'reconcile_manual' when a judge's digital sync matches a prior
-- manual entry, and 'rejected_duplicate' when it differs and the
-- operator's value wins per MANUAL-VS-SYNC-001. ADD VALUE is
-- irreversible, see migration 054's pending_signoff header for
-- the same caveat. Should be safe here since the new values are
-- pure additions and no existing query distinguishes them.
ALTER TYPE score_audit_action ADD VALUE IF NOT EXISTS 'reconcile_manual';
ALTER TYPE score_audit_action ADD VALUE IF NOT EXISTS 'rejected_duplicate';

ALTER TABLE public.scores
    ADD COLUMN IF NOT EXISTS score_source varchar(28) NOT NULL DEFAULT 'judge_direct';

-- Belt-and-braces: explicit check so a future schema diff catches
-- a typo before it lands in production. Cheap to evaluate per
-- row (one in/match lookup against a small set).
ALTER TABLE public.scores
    ADD CONSTRAINT scores_source_check
    CHECK (score_source IN ('judge_direct', 'manual_entry', 'manual_then_reconciled'));

-- Partial index for the review tray's "show me manual-entry rows
-- still awaiting reconciliation" query. Tiny when populated (a
-- handful of rows during a fallback episode); zero rows in the
-- normal case = zero storage.
CREATE INDEX IF NOT EXISTS scores_manual_pending_idx
    ON public.scores (event_id, competitor_id, round_number)
    WHERE score_source = 'manual_entry';

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 55, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
