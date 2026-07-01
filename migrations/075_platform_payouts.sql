-- =============================================================
-- MIGRATION 075 — PLATFORM MERCHANT-OF-RECORD + PAYOUTS
--
-- The payment model changed: DivingHQ is now the MERCHANT OF RECORD. Every
-- payment is charged on the PLATFORM's own Stripe account (no federation
-- connected account, no application_fee). The platform keeps its 15% and
-- PAYS OUT the net to the relevant federation or club. Federations/clubs no
-- longer onboard with Stripe — they just give payout bank details, stored
-- here; who is owed what is our own ledger, not Stripe's.
--
-- (The old organisations.stripe_account_id / stripe_charges_enabled /
-- stripe_payouts_enabled columns are now unused but left in place — dropping
-- them is a separate cleanup.)
-- =============================================================

BEGIN;

-- Payout bank details for recipients (free-text for now: account name +
-- IBAN or sort/account). Federation- and club-level.
ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS payout_account_name    text,
  ADD COLUMN IF NOT EXISTS payout_account_details text;

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS payout_account_name    text,
  ADD COLUMN IF NOT EXISTS payout_account_details text;

-- Ledger of payouts the platform makes to a federation OR a club. Balance
-- owed = sum(net of paid payments to that recipient) - sum(payouts).
CREATE TABLE IF NOT EXISTS public.payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid REFERENCES public.organisations(id) ON DELETE CASCADE,
  club_id      uuid REFERENCES public.clubs(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL,
  currency     varchar(10) NOT NULL,
  status       varchar(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'paid', 'failed')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  -- exactly one recipient
  CONSTRAINT payouts_recipient_check CHECK ((org_id IS NOT NULL) <> (club_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_payouts_org  ON public.payouts (org_id)  WHERE org_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payouts_club ON public.payouts (club_id) WHERE club_id IS NOT NULL;

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 75, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
