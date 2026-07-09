-- =============================================================
-- MIGRATION 022: TOTP 2-FACTOR AUTH
--
-- Adds three columns to users:
--   * totp_secret              base32 secret for the TOTP authenticator
--                              (Google Authenticator, 1Password, etc).
--                              NULL until the user opts in.
--   * totp_enabled_at          timestamp the user completed the
--                              setup flow (verified a code from
--                              their authenticator). NULL means setup
--                              was started but not confirmed; login is
--                              still single-factor until this gets set.
--   * totp_recovery_codes      jsonb array of bcrypt hashes of
--                              one-time recovery codes. The user
--                              gets the plaintext at setup time
--                              (and again from a "regenerate" UI).
--                              We store the HASH only, so losing the
--                              DB shouldnt compromise the codes.
--
-- Login flow becomes two-step when totp_enabled_at IS NOT NULL:
--   1. POST /api/auth/login with username+password. If 2FA is
--      enabled, server returns { needs_totp: true, totp_token }
--      where totp_token is a short-lived (5-minute) JWT scoped
--      to second-factor verification only.
--   2. POST /api/auth/login/totp with { totp_token, code }
--      where code is either a 6-digit TOTP or a recovery code.
--      Server validates and returns the real session JWT.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, no backfill needed since
-- every existing row just gets NULLs, which means "2FA off".
-- =============================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS totp_secret           varchar(64),
    ADD COLUMN IF NOT EXISTS totp_enabled_at       timestamptz,
    ADD COLUMN IF NOT EXISTS totp_recovery_codes   jsonb;

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 22, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
