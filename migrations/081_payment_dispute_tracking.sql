-- =============================================================
-- MIGRATION 081: CHARGEBACK / DISPUTE TRACKING
--
-- The webhook now handles charge.dispute.* events (before this, a lost
-- chargeback left the payment 'paid' and the recipient's balance fully
-- credited, so the platform was silently eating the loss). A lost
-- dispute applies refund semantics ADDITIVELY (dispute debits are
-- separate from refunds, so charge.amount_refunded never reflects
-- them). Additive updates need a redelivery guard: stripe_dispute_id
-- records the last dispute already applied so Stripe's at-least-once
-- delivery can't double-debit the recipient's balance.
-- =============================================================

BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS stripe_dispute_id text;

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 81, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
