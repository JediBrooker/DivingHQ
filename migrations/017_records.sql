-- =============================================================
-- MIGRATION 017, records tracking
--
-- Personal / club / federation records broken at meets, surfaced
-- live on the scoreboard with a badge and stored for posterity on
-- each diver's profile.
--
-- Three scopes:
--   personal:   diver's all-time best at a (height, dive_code,
--               position) tuple. Always check on every scored dive.
--   club:       best at the same tuple within a club. Only check
--               when the diver actually has a club_id.
--   federation: best at the same tuple within an organisation
--               (we use organisation as the "federation" unit).
--
-- A "score" here means a single dive's calc_event_dive_points
-- value, NOT a meet total. Meet-total records are a seperate kind
-- and out of scope for this migration.
--
-- The records table holds the CURRENT record for each (scope,
-- scope_id, height, dive_code, position) tuple. When a new dive
-- beats the existing record we UPDATE the row; the old holder gets
-- archived in records_history so we can show "the previous
-- record was X by Y on date Z".
--
-- Idempotent.
-- =============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'record_scope') THEN
    CREATE TYPE public.record_scope AS ENUM ('personal', 'club', 'federation');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.records (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  scope         record_scope NOT NULL,
  scope_id      uuid NOT NULL,            -- user_id / club_id / org_id depending on scope
  height        board_height NOT NULL,
  dive_code     varchar(10) NOT NULL,
  position      dive_position NOT NULL,
  score         numeric(8,2) NOT NULL,    -- calc_event_dive_points value
  holder_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_id      uuid REFERENCES public.events(id) ON DELETE SET NULL,
  set_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, scope_id, height, dive_code, position)
);

CREATE INDEX IF NOT EXISTS idx_records_scope_id
  ON public.records (scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_records_holder
  ON public.records (holder_id);

-- Append-only history. Every time records.score is overtaken we
-- copy the current row into records_history then UPDATE the
-- canonical row. Lets us show "previous PB: 38.4 set 2024-09-12
-- by Sarah Chen" without losing data.
CREATE TABLE IF NOT EXISTS public.records_history (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  scope         record_scope NOT NULL,
  scope_id      uuid NOT NULL,
  height        board_height NOT NULL,
  dive_code     varchar(10) NOT NULL,
  position      dive_position NOT NULL,
  score         numeric(8,2) NOT NULL,
  holder_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  event_id      uuid REFERENCES public.events(id) ON DELETE SET NULL,
  set_at        timestamptz NOT NULL,
  superseded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_records_history_scope_id
  ON public.records_history (scope, scope_id);

-- Bump schema version. Defensive create so this still works
-- against a DB without 008 applied.
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 17, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
