-- =============================================================
-- MIGRATION 066, payments core (Stripe Connect, direct charges)
--
-- Adds the marketplace payment layer. Federations (organisations)
-- become Stripe *connected accounts*; DivingHQ is the Connect
-- *platform*. We use DIRECT charges: the federation is the merchant
-- of record and bears refund/dispute liability + Stripe processing
-- fees; DivingHQ collects an *application fee* (default 15%) on every
-- charge. Money is never custodied by DivingHQ, Stripe pays each
-- federation directly. See routes/payments.js for the fund flow.
--
-- Scope (agreed first cut):
--   • Membership / registration fees: recurring. NOT a prerequisite
--     for entry; a membership record only unlocks member pricing.
--   • Competition entry fees: per event.
-- Both support member-vs-non-member pricing and early-bird / standard
-- / late time windows via fee_prices variants.
--
-- Three non-negotiable knobs are modelled now:
--   • who pays the fees:  fee_definitions.fee_payer
--   • refund policy:      fee_definitions.refund_policy
--   • currency:           organisations.default_currency, set per
--                         the federation's country at onboarding.
--
-- Money is stored in MINOR UNITS (integer pence/cents) and is
-- TAX-INCLUSIVE, since the federation is the taxable supplier, so VAT
-- is baked into the sticker price. organisations.tax_rate_bps is kept
-- only to itemise tax on receipts.
--
-- All steps are guarded/idempotent and forward-safe on a live DB.
-- =============================================================

BEGIN;

-- ---- organisations: Stripe connected-account + money config --------
ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS stripe_account_id      varchar(64),
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled boolean NOT NULL DEFAULT false,
  -- ISO 4217 settlement currency, set per federation country at
  -- onboarding (NULL until then). Fees inherit it unless overriden.
  ADD COLUMN IF NOT EXISTS default_currency       char(3),
  -- DivingHQ's cut, in basis points (1500 = 15%). Per-federation so a
  -- larger body can negotiate a lower rate without a code change.
  ADD COLUMN IF NOT EXISTS platform_fee_bps       integer NOT NULL DEFAULT 1500,
  -- Federation VAT/GST rate in bps, just for receipt itemisation
  -- (amounts are already tax-inclusive). NULL = not configured.
  ADD COLUMN IF NOT EXISTS tax_rate_bps           integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisations_platform_fee_bps_check') THEN
    ALTER TABLE public.organisations
      ADD CONSTRAINT organisations_platform_fee_bps_check
      CHECK (platform_fee_bps BETWEEN 0 AND 10000);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_organisations_stripe_account
  ON public.organisations (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

-- ---- fee_definitions: a configurable charge a federation owns ------
CREATE TABLE IF NOT EXISTS public.fee_definitions (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id            uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    -- What the fee is for. Extensible; today: membership | event_entry.
    scope             varchar(20) NOT NULL
        CHECK (scope IN ('membership','event_entry')),
    -- Set when scope = 'event_entry'; NULL for membership.
    event_id          uuid REFERENCES public.events(id) ON DELETE CASCADE,
    name              varchar(255) NOT NULL,
    -- ISO 4217. NULL = inherit organisations.default_currency.
    currency          char(3),
    -- Who absorbs Stripe + platform fees:
    --   'absorb':        baked into the price (payer sees one number)
    --   'pass_to_payer': added on top at checkout
    fee_payer         varchar(20) NOT NULL DEFAULT 'absorb'
        CHECK (fee_payer IN ('absorb','pass_to_payer')),
    -- Diver-initiated refund policy. Competition CANCELLATION always
    -- refunds in full regardless (handled in-app, and reverses the
    -- application fee). 'deadline' uses refund_deadline.
    refund_policy     varchar(20) NOT NULL DEFAULT 'full'
        CHECK (refund_policy IN ('full','none','deadline')),
    refund_deadline   timestamptz,
    -- Membership only: the billing period a payment grants.
    membership_period varchar(20)
        CHECK (membership_period IS NULL
               OR membership_period IN ('annual','seasonal')),
    -- Per-fee override of the org platform rate (bps). NULL = inherit.
    platform_fee_bps  integer
        CHECK (platform_fee_bps IS NULL OR platform_fee_bps BETWEEN 0 AND 10000),
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    -- event_entry fees must name an event; membership must not.
    CONSTRAINT fee_definitions_scope_event_check CHECK (
        (scope = 'event_entry' AND event_id IS NOT NULL)
     OR (scope = 'membership'  AND event_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_fee_definitions_org   ON public.fee_definitions (org_id);
CREATE INDEX IF NOT EXISTS idx_fee_definitions_event ON public.fee_definitions (event_id)
  WHERE event_id IS NOT NULL;
-- At most one active entry fee per event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_definitions_one_active_entry
  ON public.fee_definitions (event_id)
  WHERE scope = 'event_entry' AND active;

-- ---- fee_prices: price variants (audience x time window) ----------
-- Lets one fee carry member/non-member prices and early-bird /
-- standard / late windows without column sprawl. At checkout the app
-- selects the matching row for (this payer's membership, now()).
CREATE TABLE IF NOT EXISTS public.fee_prices (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fee_definition_id uuid NOT NULL
        REFERENCES public.fee_definitions(id) ON DELETE CASCADE,
    label             varchar(40) NOT NULL,        -- 'standard','early_bird','late','member'…
    -- Tax-inclusive amount in minor units (pence/cents).
    amount_cents      integer NOT NULL CHECK (amount_cents >= 0),
    -- Eligibility. 'member' applies only to active members of the org.
    audience          varchar(20) NOT NULL DEFAULT 'all'
        CHECK (audience IN ('all','member','non_member')),
    -- Optional active window. NULL bounds = open-ended.
    starts_at         timestamptz,
    ends_at           timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fee_prices_window_check
        CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_fee_prices_def ON public.fee_prices (fee_definition_id);

-- ---- payments: one row per payment attempt (entry or membership) --
CREATE TABLE IF NOT EXISTS public.payments (
    id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id                uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
    fee_definition_id     uuid REFERENCES public.fee_definitions(id) ON DELETE SET NULL,
    payer_user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    subject_type          varchar(20) NOT NULL
        CHECK (subject_type IN ('event_entry','membership')),
    -- Set for event_entry. The dive-list row is confirmed on
    -- successful payment (webhook), so it can be NULL while pending.
    event_id              uuid REFERENCES public.events(id) ON DELETE SET NULL,
    dive_list_id          uuid REFERENCES public.competitor_dive_lists(id) ON DELETE SET NULL,
    -- Stripe linkage (direct charge on the connected account). The
    -- Checkout Session is known at creation; the PaymentIntent/charge
    -- arrive on the 'completed' webhook.
    stripe_checkout_session varchar(64),
    stripe_payment_intent   varchar(64),
    stripe_charge_id        varchar(64),
    -- Snapshot of the money at sale time (minor units, tax-inclusive).
    amount_cents          integer NOT NULL CHECK (amount_cents >= 0),
    platform_fee_cents    integer NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
    currency              char(3) NOT NULL,
    fee_payer             varchar(20) NOT NULL DEFAULT 'absorb'
        CHECK (fee_payer IN ('absorb','pass_to_payer')),
    status                varchar(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','paid','refunded','partially_refunded','failed')),
    refunded_amount_cents integer NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    paid_at               timestamptz,
    refunded_at           timestamptz
);

CREATE INDEX IF NOT EXISTS idx_payments_org   ON public.payments (org_id);
CREATE INDEX IF NOT EXISTS idx_payments_payer ON public.payments (payer_user_id);
CREATE INDEX IF NOT EXISTS idx_payments_event ON public.payments (event_id)
  WHERE event_id IS NOT NULL;
-- Webhook idempotency: a PaymentIntent maps to exactly one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_pi
  ON public.payments (stripe_payment_intent)
  WHERE stripe_payment_intent IS NOT NULL;
-- Block two live entry payments for the same diver+event. A retried
-- payment must mark the prior row 'failed' before re-inserting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_entry
  ON public.payments (event_id, payer_user_id)
  WHERE subject_type = 'event_entry' AND status IN ('pending','paid');

-- ---- memberships: paid-membership record (drives member pricing) --
CREATE TABLE IF NOT EXISTS public.memberships (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id            uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    fee_definition_id uuid REFERENCES public.fee_definitions(id) ON DELETE SET NULL,
    payment_id        uuid REFERENCES public.payments(id) ON DELETE SET NULL,
    period_start      date NOT NULL,
    period_end        date NOT NULL,
    status            varchar(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','expired','cancelled')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memberships_period_check CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON public.memberships (user_id);
-- Fast "is this user currently a member of this org?" for the
-- member-vs-non-member price selector.
CREATE INDEX IF NOT EXISTS idx_memberships_active
  ON public.memberships (org_id, user_id)
  WHERE status = 'active';

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 66, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
