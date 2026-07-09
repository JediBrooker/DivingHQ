-- =============================================================
-- MIGRATION 024: ADD '0m' (POOLSIDE) TO board_height ENUM
--
-- Coaches use poolside / pool-deck entries (sit-dives, kneel-dives,
-- standing falls) as a teaching progression before introducing the
-- 1m board. Until now there was no way to record those sessions in
-- DivingHQ since the events.height column is a board_height enum
-- that only knows 1m / 3m / 5m / 7.5m / 10m.
--
-- Adding '0m' before '1m' so the spectator UI's natural sort order
-- still reads low-to-high.
--
-- ALTER TYPE ... ADD VALUE is supported inside a transaction from
-- Postgres 12 onward, which is the project's minimum (init.sql uses
-- gen_random_uuid()::text without pgcrypto). IF NOT EXISTS makes a
-- re-run a no-op.
--
-- No backfill needed, this only widens the legal set. Existing
-- rows on 1m..10m stay valid.
-- =============================================================

BEGIN;

ALTER TYPE board_height ADD VALUE IF NOT EXISTS '0m' BEFORE '1m';

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 24, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
