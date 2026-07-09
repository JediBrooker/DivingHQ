-- =============================================================
-- MIGRATION 063: TOTP replay guard (last-used time-step)
--
-- speakeasy verifies TOTP codes with window: 1 (±30s), so a
-- 6-digit code stays valid for ~90 seconds. Without server-side
-- bookkeeping, a code that was just consumed for a login could be
-- replayed (shoulder-surfed, phished in real time) to mint a
-- second session inside that window. RFC 6238 §5.2 says the
-- verifier MUST NOT accept a second attempt of the same OTP.
--
-- totp_last_used_step records the absolute 30-second time-step
-- (floor(unix_seconds / 30), adjusted by the matched window
-- delta) of the most recently accepted code. The auth flows
-- (routes/auth.js) consume a code with a conditional UPDATE, and
-- only a step strictly greater than the stored one gets accepted,
-- so replays and concurrent presentations of the same code lose
-- the race and get rejected like any bad code.
--
-- NULL means no code consumed yet (or 2FA off / re-enrolled). The
-- 2FA setup/disable flows reset it alongside totp_secret.
-- Recovery codes are already single-use, so they're unaffected.
-- =============================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS totp_last_used_step bigint;

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 63, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
