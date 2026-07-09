-- =============================================================
-- MIGRATION 075: PLATFORM MERCHANT-OF-RECORD + PAYOUTS
--
-- The payment model changed: DivingHQ is now the MERCHANT OF RECORD. Every
-- payment is charged on the PLATFORM's own Stripe account (no federation
-- connected account, no application_fee). The platform keeps its 15% and
-- PAYS OUT the net to the relevant federation or club. Federations/clubs no
-- longer onboard with Stripe, they just hand over payout bank details,
-- stored here. Who's owed what is our own ledger now, not Stripe's.
--
-- (The old organisations.stripe_account_id / stripe_charges_enabled /
-- stripe_payouts_enabled columns are unused now but left in place, dropping
-- them is a separate cleanup, heads up for whoever picks that up.)
-- =============================================================

BEGIN;

-- Payout bank details for recipients (free-text for now: account name +
-- IBAN or sort/account). Federation for now, the CLUB columns +
-- payouts.club_id are the recipient scaffold for the upcoming
-- club-payments feature (a club admin will set details + see a balance
-- there), just not wired up yet.
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
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency     varchar(10) NOT NULL,
  status       varchar(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'paid', 'failed')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  -- must be exactly one recipient
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
