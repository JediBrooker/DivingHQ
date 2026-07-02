-- =============================================================
-- MIGRATION 077 — CLUB TRAINING CLASSES (club-private)
--
-- A "class" is a recurring club-run training group a diver enrols in. It is
-- CLUB-PRIVATE: managed by the club's own admins (club_admins rows) — NOT by
-- the federation org_admin — visible to the club's coaches (roster) and to the
-- enrolled diver (their own enrolment only). Distinct from `teams` (which are
-- org-scoped competition rosters).
--
-- Pricing is flexible: each class has zero or more price OPTIONS (e.g.
-- "Monthly £40", "Per term £120"); a diver picks one at enrolment. The club
-- may apply a manual per-enrolment discount. Actual enrolment PAYMENT +
-- club payouts land in a later migration; this one is the roster + pricing
-- model and works while payments are dormant.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.classes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,
  description text,
  level       varchar(60),          -- free-text ("Beginner", "Squad", "Masters", any type)
  schedule    varchar(200),         -- free-text ("Mon & Wed 6-7pm")
  capacity    integer CHECK (capacity IS NULL OR capacity > 0),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_classes_club ON public.classes (club_id);

CREATE TABLE IF NOT EXISTS public.class_price_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id     uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  label        varchar(80) NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency     char(3) NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_class_price_options_class ON public.class_price_options (class_id);

CREATE TABLE IF NOT EXISTS public.class_enrolments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id        uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  diver_user_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  club_id         uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  -- pending  = self-enrolled, awaiting payment/approval (payments dormant)
  -- active   = on the roster
  -- inactive = paused (kept on roster history)
  -- cancelled= removed (frees the one-live slot for a re-enrolment)
  status          varchar(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('pending','active','inactive','cancelled')),
  -- The chosen price option + a snapshot of its amount (preserved even if the
  -- option is later edited/removed) and an optional manual discount.
  price_option_id uuid REFERENCES public.class_price_options(id) ON DELETE SET NULL,
  amount_cents    integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  discount_cents  integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  currency        char(3),
  payment_id      uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  note            text,
  enrolled_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_class_enrolments_class ON public.class_enrolments (class_id);
CREATE INDEX IF NOT EXISTS idx_class_enrolments_diver ON public.class_enrolments (diver_user_id);
-- At most one non-cancelled enrolment per (class, diver).
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_enrolments_one_live
  ON public.class_enrolments (class_id, diver_user_id)
  WHERE status <> 'cancelled';

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 77, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
