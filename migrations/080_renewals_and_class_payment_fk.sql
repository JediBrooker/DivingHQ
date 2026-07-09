-- =============================================================
-- MIGRATION 080: renewable purchases + class-payment delete fix
--
-- 1. The one-live-payment unique indexes for membership, club
--    affiliation/accreditation, and official accreditation (migration 067)
--    included status='paid' with no time bound, so the SECOND year's
--    purchase of the same fee hit the index forever, which made annual
--    renewals structurally impossible. Paid rows never expire from an
--    index, so "don't buy twice" for renewable purchases moves to the
--    APP instead, which actually knows the granted period: checkout now
--    refuses while an active grant is more than 30 days from expiry, and
--    a renewal extends from the current period_end (routes/payments.js +
--    routes/stripe-webhook.js). The indexes still block concurrent
--    DOUBLE-PENDING checkouts, which is the part the app genuinely can't
--    do race-free.
--
--    Event entries, meet access, bundles, penalties, fines, and class
--    enrolments are NOT renewable, one settled purchase per subject is
--    correct, so their indexes keep including 'paid'.
--
-- 2. payments_chk_class_enrolment (migration 078) required
--    class_enrolment_id NOT NULL, but the FK is ON DELETE SET NULL, so
--    deleting a class (cascading its enrolments) tried to null the
--    column and violated the CHECK. Class deletion 500'd forever once
--    any enrolment payment existed. The linkage here is just lifecycle
--    plumbing though; the club's MONEY integrity rests on
--    recipient_type + club_id, which stay required. Settled payments
--    may now outlive their enrolment row. (routes/classes.js
--    additionally refuses to delete a class with live paid enrolments,
--    and retires in-flight checkouts first.)
-- =============================================================

BEGIN;

DROP INDEX IF EXISTS idx_payments_one_live_membership;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_membership
  ON public.payments (payer_user_id, fee_definition_id)
  WHERE subject_type = 'membership' AND payer_user_id IS NOT NULL
        AND status = 'pending';

DROP INDEX IF EXISTS idx_payments_one_live_club;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_club
  ON public.payments (payer_club_id, fee_definition_id)
  WHERE subject_type IN ('club_affiliation','club_accreditation')
        AND payer_club_id IS NOT NULL AND status = 'pending';

DROP INDEX IF EXISTS idx_payments_one_live_official;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_official
  ON public.payments (payer_user_id, payer_role_type, fee_definition_id)
  WHERE subject_type = 'official_accreditation' AND payer_user_id IS NOT NULL
        AND status = 'pending';

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_chk_class_enrolment;
ALTER TABLE public.payments ADD CONSTRAINT payments_chk_class_enrolment CHECK (
  subject_type <> 'class_enrolment' OR (
    recipient_type = 'club' AND club_id IS NOT NULL
    AND event_id IS NULL AND meet_id IS NULL AND fee_definition_id IS NULL
  )
);

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 80, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
