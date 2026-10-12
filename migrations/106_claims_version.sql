-- 106_claims_version.sql
--
-- Role changes stop signing people out.
--
-- users.token_version does two jobs today: it's the hard revoke (password
-- change, 2FA change, suspension, a DOB correction) and it's also how a
-- role grant or revoke reached the JWT, since org_roles and org_id ride
-- inside the token. Bumping it for a role change 401'd every device the
-- person had, so a judge whose request got approved was thrown to the
-- login page on their phone and their laptop.
--
-- claims_version takes over the second job. A role change bumps it, and
-- verifyToken (lib/middleware.js) rebuilds a token whose cv is behind from
-- the database on the spot: new roles apply on the very next request, a
-- revoked one is gone on the very next request, and nobody signs in again.
-- token_version is left for the cases that really should end a session.
--
-- Tokens minted before this have no cv. The column starts at 0 and a
-- missing cv reads as 0, so they're current until the next role change.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS claims_version integer NOT NULL DEFAULT 0;

INSERT INTO public.schema_meta(id, version, applied_at) VALUES (1, 106, now())
ON CONFLICT(id) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;
COMMIT;
