-- 044_email_change_verification.sql
--
-- Self-service email change with proof-of-inbox verification.
--
-- Flow:
--   1. Signed-in user POSTs new_email + current_password to
--      /api/users/me/email/change-request. The server:
--        * verifies the password (defence against hijacked session)
--        * ensures the new address isn't already taken
--        * mints a random 32-byte token, stores sha256(token) on
--          the user row alongside the new email and a 30-min expiry
--        * sends a verification link to the NEW address (proof of
--          inbox control, same posture as registration verification)
--
--   2. User clicks the link → /confirm-email-change?token=… → SPA
--      POSTs the token to /api/auth/confirm-email-change. The server:
--        * looks up the user row by sha256(token)
--        * checks expiry + that pending_email is still set
--        * swaps users.email = pending_email
--        * clears all three pending_* columns (single-use)
--        * bumps token_version (force re-login on every device,
--          same as we do for password change / 2FA toggle)
--
-- Why a DB-backed token instead of the JWT-fingerprint trick used
-- by /forgot-password:
--   * Need to carry the new email between request and confirm.
--     Stashing it in the JWT payload leaks the address into mailer
--     transcripts and any log line that dumps the token.
--   * Need each new change request to invalidate older pending
--     tokens. With JWT-fingerprint, re-issuing doesn't naturally
--     supersede the previous mint, but the column overwrite here does.
--   * sha256-of-token storage (not the plaintext) keeps DB-dump
--     access from being equivalent to clicking every pending link.
--
-- All three columns nullable so users with no change in flight
-- carry no overhead. Index is partial so it only stores rows with
-- a pending change.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pending_email             varchar(254),
  ADD COLUMN IF NOT EXISTS pending_email_token_hash  varchar(64),
  ADD COLUMN IF NOT EXISTS pending_email_expires_at  timestamptz;

-- Partial index, so only rows with an in-flight change actually pay
-- the cost, and the confirm endpoint looks up exclusively by
-- token_hash anyway, so the index covers its one access path.
CREATE INDEX IF NOT EXISTS idx_users_pending_email_token
  ON public.users(pending_email_token_hash)
  WHERE pending_email_token_hash IS NOT NULL;

-- Bump schema_meta.version so the runner records this migration
-- as applied. See 043 for the rationale on why every migration
-- now bumps this column.
INSERT INTO public.schema_meta (id, version)
VALUES (1, 44)
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version
WHERE public.schema_meta.version < EXCLUDED.version;

COMMIT;
