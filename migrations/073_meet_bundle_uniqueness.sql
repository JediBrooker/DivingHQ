-- =============================================================
-- MIGRATION 073 — MEET-BUNDLE LIVE-PAYMENT GUARD
--
-- A meet_bundle is a discounted package: one payment that the webhook
-- expands into a paid event_entry for every event in the bundle
-- (meet_bundle_items). Guard against a buyer stacking two bundle purchases
-- for the same meet (which would double-expand). One live bundle payment
-- per (meet, buyer) — the meet_bundle analogue of the other live-payment
-- guards.
-- =============================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_meet_bundle
  ON public.payments (meet_id, payer_user_id)
  WHERE subject_type = 'meet_bundle'
    AND meet_id IS NOT NULL AND payer_user_id IS NOT NULL
    AND status IN ('pending', 'paid');

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 73, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
