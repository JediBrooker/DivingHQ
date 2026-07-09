-- =============================================================
-- MIGRATION 056 - competitor_dive_lists.created_at
--
-- The late-arrival review feature (migration 054 + the
-- /api/late-arrivals route) selects and ORDERs BY
-- `competitor_dive_lists.created_at`, the server-side moment the
-- dive-list row was inserted, to drive the meet manager's
-- pending-review tray. But the column was never added: 054 added
-- the late-arrival metadata (actor_local_time, late_arrival_flag,
-- late_arrival_decision, …) and assumed a created_at already
-- existed. It didn't, so the tray query 500s with
-- `column cdl.created_at does not exist` the moment the operator
-- surface loads (caught by test/e2e/visual-regression.spec.js).
--
-- A server-stamped creation time is the right ordering key here,
-- more trustworthy than the client-supplied actor_local_time the
-- tray also shows. Cheap column; NOT NULL with DEFAULT now() so
-- every INSERT (none of which set it explicitly) and every
-- existing row are covered without touching call sites. Existing
-- rows backfill to the migration time, which is harmless: the tray
-- only surfaces still-pending late arrivals going forward.
-- =============================================================

BEGIN;

ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 56, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
