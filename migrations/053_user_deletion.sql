-- =============================================================
-- MIGRATION 053 - USER SELF-DELETION + CLAIM-PAST-RESULTS
--
-- Privacy-policy §7 deliverable. Two coupled features:
--
--   1. Account self-deletion. The user POSTs to
--      /api/users/me/delete with their password; we strip every
--      PII column (login, contact, settings) and stamp
--      deleted_at = now(). The row stays though: full_name,
--      org_id, club_id are retained so the user's name remains
--      on the dives they competed in (sporting record).
--
--   2. Reunite-on-return. A returning user with the same name in
--      the same org can claim those historical entries. The
--      candidate-lookup path is `WHERE org_id = $1 AND
--      deleted_at IS NOT NULL AND lower(full_name) = lower($2)`.
--      We index that exact predicate so the typeahead-class
--      latency target holds even on a federation with millions
--      of historical rows.
--
-- Why we don't just hard-delete the row:
--   * Hard delete cascades through scores / competitor_dive_lists
--     and wipes the user's name from every event they ever dived
--     in, which is the wrong outcome for a public sporting record.
--   * Setting an FK to NULL (ON DELETE SET NULL) would leave
--     ranking tables with anonymous rows whose name nobody can
--     ever resurrect. The claim flow needs the original users.id
--     to point at to swap references over.
--
-- Schema notes:
--   * username is rewritten by the delete endpoint to
--     "deleted-<id_short>" so the existing UNIQUE(username)
--     constraint doesn't block a new sign-up choosing the same
--     handle. password / email are NULLed so duplicate-email
--     checks on registration arent blocked either.
--   * No partial unique index on email is needed: existing email
--     uniqueness in init.sql is enforced on lower(email) WHERE
--     email IS NOT NULL, since a deleted row has email = NULL and
--     doesn't participate.
-- =============================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Claim-candidate lookup: find non-reclaimed deleted users in a
-- specific org with a specific full_name (case-insensitive).
-- Partial index so we pay zero storage for active users.
CREATE INDEX IF NOT EXISTS idx_users_deleted_claim_lookup
    ON public.users (org_id, lower(full_name))
    WHERE deleted_at IS NOT NULL;

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 53, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
