-- =============================================================
-- MIGRATION 082 — STRIPE CONNECT RECIPIENT ACCOUNTS (payout automation)
--
-- Replaces the manual-bank-transfer payout model with automated Stripe
-- Connect transfers. Clubs and federations onboard once as RECIPIENT-only
-- connected accounts (Accounts v2, hosted onboarding); "withdraw" then
-- fires a real transfer instead of the operator making a bank transfer by
-- hand.
--
-- Crucially this DELETES the plaintext bank-detail columns: the account
-- and its verified bank account now live at Stripe (referenced only by an
-- acct_… id), so the app never stores or handles bank details again — the
-- single biggest data liability the pre-deploy audit flagged simply ceases
-- to exist.
--
-- organisations already carry stripe_account_id / stripe_payouts_enabled /
-- stripe_charges_enabled from the earlier (retired) Connect direct-charge
-- era; stripe_account_id + stripe_payouts_enabled are REPURPOSED here as
-- the recipient account + its transfers-capability readiness. Clubs get the
-- same three columns fresh. stripe_charges_enabled is left untouched
-- (legacy, unused since PR #94's merchant-of-record refactor).
-- =============================================================

BEGIN;

-- Recipient account + readiness cache on clubs (orgs already have the
-- id/enabled pair). country is stamped at onboarding — recipients may be
-- in a different country than the platform (cross-border corridors are
-- enabled deliberately per-country later; same-country is the launch path).
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS stripe_account_id        text,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_account_country   varchar(2);

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS stripe_account_country   varchar(2);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_stripe_account
  ON public.clubs (stripe_account_id) WHERE stripe_account_id IS NOT NULL;

-- Remove the plaintext bank-detail liability. Pre-launch, no real data —
-- a clean cutover. (The routes/UI that read these are removed in the same
-- change; nothing in production depends on them yet.)
ALTER TABLE public.organisations
  DROP COLUMN IF EXISTS payout_account_name,
  DROP COLUMN IF EXISTS payout_account_details;

ALTER TABLE public.clubs
  DROP COLUMN IF EXISTS payout_account_name,
  DROP COLUMN IF EXISTS payout_account_details;

-- Link each payout to the Stripe transfer that fulfilled it (idempotency +
-- reconciliation). NULL until the transfer succeeds; a failed payout never
-- gets one.
ALTER TABLE public.payouts
  ADD COLUMN IF NOT EXISTS stripe_transfer_id text;

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 82, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
