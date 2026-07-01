-- =============================================================
-- MIGRATION 076 — AUTO-WITHDRAW SETTINGS
--
-- The dedicated Payments section lets a federation opt into automatic
-- withdrawals: when its owed balance reaches a threshold, the platform pays
-- that balance out to the stored bank details without the admin having to
-- click "Withdraw". These two columns hold that preference; the withdrawal
-- itself is recorded in the payouts table (migration 075). The auto-execution
-- job is wired when payments go live — dormant until then, but the admin can
-- save the preference now.
-- =============================================================

BEGIN;

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS auto_withdraw_enabled   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_withdraw_min_cents integer
    CHECK (auto_withdraw_min_cents IS NULL OR auto_withdraw_min_cents >= 0);

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 76, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
