-- =============================================================
-- MIGRATION 060 — country on dr_meets
--
-- The DiveRecorder archive (migration 059) stored a meet's name and
-- date but not where it was held. The Meet Explorer actually groups
-- meets by country via its "Filter by Country" sidebar
-- (selectmeet.php?nat=GBR / ?nat=AUS / …), so the importer can tag
-- each meet with the federation that ran it. Surfacing that lets the
-- Archive Explorer filter by country (and by date), matching the
-- source site's own navigation.
--
-- Two nullable columns — code (the source's nat token, e.g. "GBR")
-- and a human label (e.g. "Great Britain") — so the API can filter
-- on the stable code while the UI shows the friendly name. Nullable
-- because a meet imported before this migration, or via the
-- show-all list, may not have a country yet; a re-run backfills it.
-- =============================================================

BEGIN;

ALTER TABLE public.dr_meets
    ADD COLUMN IF NOT EXISTS country_code text,
    ADD COLUMN IF NOT EXISTS country_name text;

CREATE INDEX IF NOT EXISTS idx_dr_meets_country ON public.dr_meets (country_code);

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 60, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
