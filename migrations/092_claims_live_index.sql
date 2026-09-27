-- 092_claims_live_index.sql
--
-- Claims hardening (lib/claims.js).
--
-- 089's claims_one_live index counted every open claim against its target,
-- verified or not. register-org opens the claim before the claimant has
-- proved their inbox, so an address nobody ever checks (a typo, or a
-- throwaway sent on purpose) held a country or region for the week it took
-- the sweep to withdraw it, and could simply be sent again.
--
-- Only claims that went live count now. Unverified ones don't block
-- anything: a newer claim on the same target replaces them (openClaim),
-- and activateForUser withdraws a claim that verifies after another one on
-- its target already went live. This index is still what makes that last
-- check race-safe. Escalated claims were always activated first, so the
-- extra condition doesn't let a second one past.

BEGIN;

DROP INDEX IF EXISTS public.claims_one_live;
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_live
  ON public.claims (target_kind, target_id)
  WHERE status IN ('open', 'escalated') AND activated_at IS NOT NULL;

-- openClaim and the sweep look up the not-yet-verified claims on a target.
CREATE INDEX IF NOT EXISTS idx_claims_target_unverified
  ON public.claims (target_kind, target_id)
  WHERE status = 'open' AND activated_at IS NULL;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 92, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
