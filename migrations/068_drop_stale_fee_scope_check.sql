-- =============================================================
-- MIGRATION 068 — DROP STALE fee_definitions_scope_event_check
--
-- Migration 066 created fee_definitions_scope_event_check, which only
-- permits two rows:
--   (scope='event_entry' AND event_id IS NOT NULL)
--   OR (scope='membership' AND event_id IS NULL)
--
-- Migration 067 widened `scope` to 15 values and added per-scope entity
-- CHECKs (fee_def_chk_event_entry, fee_def_chk_club, …) that enforce the
-- correct entity linkage for every scope — but it never dropped this old
-- constraint. As a result EVERY new scope (club_affiliation, meet_bundle,
-- late_entry, official_accreditation, …) is rejected, and even the
-- intended meet-level event_entry (event_id NULL, meet_id set, added in
-- the same taxonomy work) fails because the stale check still demands
-- event_id IS NOT NULL for event_entry.
--
-- The 067 per-scope checks fully supersede this one, so dropping it loses
-- no safety. Idempotent.
-- =============================================================

BEGIN;

ALTER TABLE public.fee_definitions
  DROP CONSTRAINT IF EXISTS fee_definitions_scope_event_check;

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 68, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
