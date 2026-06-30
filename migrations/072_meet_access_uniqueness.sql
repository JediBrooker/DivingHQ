-- =============================================================
-- MIGRATION 072 — MEET-ACCESS LIVE-PAYMENT GUARD
--
-- Spectator ticket / livestream / programme are meet-level access purchases
-- (one per buyer per meet per kind for this cut — quantity/multi-ticket is a
-- later feature). Mirror the other one-live-payment guards so a buyer can't
-- stack duplicate live payments for the same access on the same meet.
-- =============================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_meet_access
  ON public.payments (meet_id, payer_user_id, subject_type)
  WHERE subject_type IN ('spectator_ticket', 'livestream', 'programme')
    AND meet_id IS NOT NULL AND payer_user_id IS NOT NULL
    AND status IN ('pending', 'paid');

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 72, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
