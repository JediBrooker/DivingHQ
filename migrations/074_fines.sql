-- =============================================================
-- MIGRATION 074 — DISCIPLINARY FINES (+ appeals)
--
-- Migration 067 reserved the 'fine' scope/subject_type + payments
-- .liable_user_id, but a fine needs a stable, trackable record independent
-- of any Stripe checkout (it can be appealed, waived, or paid later). This
-- adds the fines table + the payment link/guard.
--
-- Lifecycle: a referee (or org_admin) issues a fine against a person
-- (liable_user_id) with an amount + reason. The person PAYS it or APPEALS
-- it; an org_admin adjudicates the appeal (upheld => waived, dismissed =>
-- back to owed). Paying is blocked while an appeal is pending.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.fines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  liable_user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  issued_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,   -- the referee
  event_id           uuid REFERENCES public.events(id) ON DELETE SET NULL,  -- optional incident context
  amount_cents       integer NOT NULL,
  currency           varchar(10) NOT NULL,
  reason             text,
  payment_id         uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  status             varchar(20) NOT NULL DEFAULT 'owed'
                       CHECK (status IN ('owed', 'appealed', 'paid', 'waived')),
  appeal_reason      text,
  appeal_status      varchar(20)
                       CHECK (appeal_status IS NULL OR appeal_status IN ('pending', 'upheld', 'dismissed')),
  appeal_reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fines_liable ON public.fines (liable_user_id) WHERE status IN ('owed', 'appealed');
CREATE INDEX IF NOT EXISTS idx_fines_org ON public.fines (org_id);

-- Payment link + one-live-payment guard (charge-scoped, like entry_charges).
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS fine_id uuid REFERENCES public.fines(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_fine
  ON public.payments (fine_id)
  WHERE subject_type = 'fine' AND fine_id IS NOT NULL AND status IN ('pending', 'paid');

CREATE INDEX IF NOT EXISTS idx_payments_fine ON public.payments (fine_id) WHERE fine_id IS NOT NULL;

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 74, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
