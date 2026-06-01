-- =============================================================
-- MIGRATION 058 — DIVER PROFILE DETAILS + ACCOUNT SUSPEND
--
-- Lets an org admin maintain a diver's competition details and
-- run basic account lifecycle from the User Manager:
--   * date_of_birth — drives age-group eligibility / display.
--   * gender        — free-ish (UI offers Male/Female/Other/…).
--   * nationality   — 3-letter country code (independent of the
--                     federation/org the diver competes for).
--   * suspended_at  — NULL = active. A non-null value blocks login
--                     (checked in /api/auth/login) without deleting
--                     the account; reversible via reactivate.
-- All edits are written to audit_log by the API.
-- =============================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS date_of_birth date,
    ADD COLUMN IF NOT EXISTS gender        varchar(20),
    ADD COLUMN IF NOT EXISTS nationality   char(3),
    ADD COLUMN IF NOT EXISTS suspended_at  timestamptz;

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 58, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
