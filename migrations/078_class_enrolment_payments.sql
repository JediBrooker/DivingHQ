-- =============================================================
-- MIGRATION 078 — CLASS ENROLMENT PAYMENTS + CLUB PAYOUTS
--
-- Wires real payment to class enrolment (migration 077) and gives clubs
-- their own payout ledger, distinct from the federation's. Two new concepts:
--
-- 1. payments.recipient_type ('org' | 'club'): who the collected money is
--    OWED to. Every payment before this migration paid the FEDERATION
--    (recipient_type='org', the default) — including club_affiliation/
--    club_accreditation, where payments.club_id is the SUBJECT club being
--    charged, not the recipient (the federation collects those). A class
--    enrolment payment is the first case where the CLUB is the recipient,
--    so recipient_type is explicit rather than inferred from club_id being
--    set — conflating "subject club" with "recipient club" would silently
--    double-count club_affiliation money into a club's own balance.
-- 2. payments.class_enrolment_id links a payment to the specific
--    class_enrolments row it settles (mirrors payments.entry_charge_id /
--    payments.fine_id for their domains).
--
-- Clubs get the same auto-withdraw preference organisations already have
-- (migration 076); the payout ledger itself (payouts.club_id) and the
-- clubs.payout_account_* columns were already scaffolded in migration 075.
-- =============================================================

BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS recipient_type     varchar(10) NOT NULL DEFAULT 'org'
    CHECK (recipient_type IN ('org', 'club')),
  ADD COLUMN IF NOT EXISTS class_enrolment_id uuid REFERENCES public.class_enrolments(id) ON DELETE SET NULL;

-- Only class_enrolment payments may be club-recipient; every other subject
-- type still pays the federation. Keeps the blast radius of the new
-- recipient concept exactly scoped to this one feature.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_chk_recipient_scope CHECK (
    subject_type = 'class_enrolment' OR recipient_type = 'org'
  );

ALTER TABLE public.payments DROP CONSTRAINT payments_subject_type_check;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_subject_type_check CHECK (subject_type IN (
    'membership','event_entry','meet_bundle','late_entry','scratch','no_show',
    'club_affiliation','club_accreditation','official_accreditation',
    'spectator_ticket','livestream','programme','fine','levy','donation',
    'class_enrolment'
  ));

-- A class-enrolment payment is always club-recipient, always linked to the
-- enrolment it settles, and never carries the event/meet/fee-definition
-- fields those don't apply to (class pricing lives in class_price_options,
-- not fee_definitions).
ALTER TABLE public.payments ADD CONSTRAINT payments_chk_class_enrolment CHECK (
  subject_type <> 'class_enrolment' OR (
    recipient_type = 'club' AND club_id IS NOT NULL AND class_enrolment_id IS NOT NULL
    AND event_id IS NULL AND meet_id IS NULL AND fee_definition_id IS NULL
  )
);

-- One live (pending or paid) payment per enrolment at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_class_enrolment
  ON public.payments (class_enrolment_id)
  WHERE subject_type = 'class_enrolment' AND status IN ('pending', 'paid');

CREATE INDEX IF NOT EXISTS idx_payments_recipient_club
  ON public.payments (club_id) WHERE recipient_type = 'club';

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS auto_withdraw_enabled   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_withdraw_min_cents integer
    CHECK (auto_withdraw_min_cents IS NULL OR auto_withdraw_min_cents >= 0);

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 78, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
