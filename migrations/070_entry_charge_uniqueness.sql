-- =============================================================
-- MIGRATION 070: ENTRY-CHARGE UNIQUENESS GUARDS
--
-- Scratch / no-show penalties (entry_charges, migration 067) ship with the
-- routes in this change. Two partial unique indexes enforce the invariants
-- the code relies on:
--
--   1. At most one OWED charge per (event, entrant, kind), so re-issuing a
--      scratch/no-show penalty is idempotent instead of stacking debits.
--      Waived/paid rows don't count, so a waived charge can be re-issued.
--
--   2. At most one LIVE (pending|paid) penalty PAYMENT per (event, entrant,
--      fee_definition): the scratch/no_show analogue of the event_entry /
--      membership / club / official live-payment guards (067 added those
--      but not one for the entry-penalty subject types, so duplicate live
--      penalty payments were possible).
-- =============================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_charges_one_owed
  ON public.entry_charges (event_id, entrant_user_id, kind)
  WHERE status = 'owed';

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_entry_penalty
  ON public.payments (event_id, payer_user_id, fee_definition_id)
  WHERE subject_type IN ('scratch', 'no_show')
    AND payer_user_id IS NOT NULL
    AND status IN ('pending', 'paid');

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 70, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
