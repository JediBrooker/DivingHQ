-- =============================================================
-- MIGRATION 083 — GUARDIAN / DEPENDENT RELATIONSHIPS
--
-- Lets a parent or guardian link to a minor's account so they can
-- pay entry fees, memberships, etc. on the minor's behalf.
--
-- 1. guardians table (many-to-many, org-scoped, admin-approved)
-- 2. payments.subject_user_id — the beneficiary when payer ≠ subject
-- 3. Rebuild user-keyed one-live dedup indexes with
--    COALESCE(subject_user_id, payer_user_id) so two parents cannot
--    double-pay for the same child's entry.
-- =============================================================

BEGIN;

-- ---- 1. guardians table ---------------------------------------

CREATE TABLE IF NOT EXISTS public.guardians (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id            uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    guardian_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    dependent_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status            varchar(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','revoked')),
    requested_at      timestamptz NOT NULL DEFAULT now(),
    reviewed_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at       timestamptz,
    CONSTRAINT guardians_no_self CHECK (guardian_user_id <> dependent_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guardians_one_active
    ON public.guardians (org_id, guardian_user_id, dependent_user_id)
    WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS idx_guardians_guardian
    ON public.guardians (guardian_user_id) WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_guardians_dependent
    ON public.guardians (dependent_user_id) WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_guardians_org_pending
    ON public.guardians (org_id) WHERE status = 'pending';

-- ---- 2. payments.subject_user_id ------------------------------

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS subject_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payments_subject_user
    ON public.payments (subject_user_id) WHERE subject_user_id IS NOT NULL;

-- ---- 3. rebuild user-keyed dedup indexes -----------------------
-- COALESCE(subject_user_id, payer_user_id) = the beneficiary.
-- For legacy rows subject_user_id IS NULL so COALESCE falls back to
-- payer_user_id — identical behaviour to the old index.

DROP INDEX IF EXISTS idx_payments_one_live_event_entry;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_event_entry
    ON public.payments (event_id, COALESCE(subject_user_id, payer_user_id), fee_definition_id)
    WHERE subject_type = 'event_entry' AND payer_user_id IS NOT NULL
          AND status IN ('pending', 'paid');

DROP INDEX IF EXISTS idx_payments_one_live_meet_entry;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_meet_entry
    ON public.payments (meet_id, COALESCE(subject_user_id, payer_user_id), fee_definition_id)
    WHERE subject_type = 'event_entry' AND meet_id IS NOT NULL AND payer_user_id IS NOT NULL
          AND status IN ('pending', 'paid');

DROP INDEX IF EXISTS idx_payments_one_live_membership;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_membership
    ON public.payments (COALESCE(subject_user_id, payer_user_id), fee_definition_id)
    WHERE subject_type = 'membership' AND payer_user_id IS NOT NULL
          AND status = 'pending';

DROP INDEX IF EXISTS idx_payments_one_live_meet_bundle;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_meet_bundle
    ON public.payments (meet_id, COALESCE(subject_user_id, payer_user_id))
    WHERE subject_type = 'meet_bundle'
      AND meet_id IS NOT NULL AND payer_user_id IS NOT NULL
      AND status IN ('pending', 'paid');

DROP INDEX IF EXISTS idx_payments_one_live_meet_access;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_meet_access
    ON public.payments (meet_id, COALESCE(subject_user_id, payer_user_id), subject_type)
    WHERE subject_type IN ('spectator_ticket', 'livestream', 'programme')
      AND meet_id IS NOT NULL AND payer_user_id IS NOT NULL
      AND status IN ('pending', 'paid');

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 83, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
