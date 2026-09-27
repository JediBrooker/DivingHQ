-- 089_claims.sql
--
-- Phase 3 of docs/club-first-onboarding.md: a national federation claims
-- its country's account, or a state body claims its region, and the
-- people already there decide.
--
--   claims
--       One row per attempt. The approver is fixed when it opens:
--         parent    the org's admins (a region claim under a federation)
--         clubs     the eligible clubs in scope vote
--         regions   the claimed regions vote (national claim)
--         sysadmin  nobody else could fairly decide
--       activated_at: a claim only goes live, and voters only hear about
--       it, once the claimant has verified their email. closes_at is set
--       then. Unverified claims get withdrawn by the sweep.
--       Only one live claim per target: open or escalated.
--
--   claim_voters
--       Who may vote, snapshotted when the claim opens so a club created
--       mid-vote can't tip it. One row per club or region, not per admin.
--
--   claim_votes
--       One vote per voter (club or region), cast by any of its admins.
--
--   platform_settings
--       Numeric knobs the sysadmin edits at /admin/features. Missing rows
--       fall back to the defaults in lib/platform-settings.js.

BEGIN;

CREATE TABLE IF NOT EXISTS public.claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind     varchar(8) NOT NULL CHECK (target_kind IN ('org', 'region')),
  target_id       uuid NOT NULL,
  org_id          uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  claimant_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body_name       varchar(120) NOT NULL,
  website         varchar(255),
  domain_verified boolean NOT NULL DEFAULT false,
  approver        varchar(12) NOT NULL
                    CHECK (approver IN ('parent', 'clubs', 'regions', 'sysadmin')),
  status          varchar(12) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'approved', 'rejected', 'escalated', 'withdrawn', 'revoked')),
  status_reason   text,
  activated_at    timestamptz,
  closes_at       timestamptz,
  decided_at      timestamptz,
  decided_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_live
  ON public.claims (target_kind, target_id) WHERE status IN ('open', 'escalated');
CREATE INDEX IF NOT EXISTS idx_claims_org ON public.claims (org_id);
CREATE INDEX IF NOT EXISTS idx_claims_claimant ON public.claims (claimant_id);

CREATE TABLE IF NOT EXISTS public.claim_voters (
  claim_id   uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  voter_kind varchar(8) NOT NULL CHECK (voter_kind IN ('club', 'region')),
  voter_id   uuid NOT NULL,
  PRIMARY KEY (claim_id, voter_kind, voter_id)
);

CREATE TABLE IF NOT EXISTS public.claim_votes (
  claim_id   uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  voter_kind varchar(8) NOT NULL CHECK (voter_kind IN ('club', 'region')),
  voter_id   uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  vote       varchar(8) NOT NULL CHECK (vote IN ('approve', 'object')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, voter_kind, voter_id)
);

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key        varchar(60) PRIMARY KEY,
  value      numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);

INSERT INTO public.platform_settings (key, value) VALUES
  ('claim_voter_min_age_days', 30),
  ('claim_voter_min_members',  5),
  ('claim_quorum_min',         2),
  ('claim_majority',           0.5),
  ('claim_timeout_days',       14)
ON CONFLICT (key) DO NOTHING;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 89, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
