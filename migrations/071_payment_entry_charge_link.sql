-- =============================================================
-- MIGRATION 071, charge-scoped penalty payment uniqueness
--
-- Migration 070's idx_payments_one_live_entry_penalty was keyed on
-- (event_id, payer_user_id, fee_definition_id). But a 'paid' payment is
-- never freed, and upsertFee keeps ONE active scratch/no_show
-- fee_definition per event, so once an entrant paid one penalty, a
-- re-issued penalty of the same kind (which idx_entry_charges_one_owed
-- explicitly allows, since paid rows don't count) could never be paid: the
-- INSERT collided with the old, still-'paid' payment.
--
-- Fix: scope the live-payment guard to the CHARGE, not the fee. Add
-- payments.entry_charge_id and rebuild the index on it, so a penalty
-- payment only collides with another live payment for the SAME charge
-- (true double-pay idempotency).
-- =============================================================

BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS entry_charge_id uuid REFERENCES public.entry_charges(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS idx_payments_one_live_entry_penalty;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_entry_penalty
  ON public.payments (entry_charge_id)
  WHERE subject_type IN ('scratch', 'no_show')
    AND entry_charge_id IS NOT NULL
    AND status IN ('pending', 'paid');

CREATE INDEX IF NOT EXISTS idx_payments_entry_charge
  ON public.payments (entry_charge_id) WHERE entry_charge_id IS NOT NULL;

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 71, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
