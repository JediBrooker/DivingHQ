-- =============================================================
-- MIGRATION 069 — WIDEN scope / subject_type COLUMNS
--
-- Migration 067 widened the fee taxonomy and added per-scope CHECKs that
-- list 'official_accreditation' (22 chars) as a valid value — but left
-- fee_definitions.scope and payments.subject_type at varchar(20). So the
-- one scope longer than 20 chars (official_accreditation) is permitted by
-- the CHECK yet rejected at write time with 22001 "value too long".
-- Every other scope (≤ 18 chars) fits, which is why only official
-- accreditation broke. Widen both columns to varchar(40) (matches
-- role_type/discipline/tier). Safe widening; no data change.
-- =============================================================

BEGIN;

ALTER TABLE public.fee_definitions ALTER COLUMN scope TYPE varchar(40);
ALTER TABLE public.payments        ALTER COLUMN subject_type TYPE varchar(40);

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 69, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
