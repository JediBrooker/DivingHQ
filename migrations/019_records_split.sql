-- =============================================================
-- MIGRATION 019: SPLIT records / records_history INTO PER-SCOPE
-- TABLES (PERSONAL / CLUB / FEDERATION) WITH PROPER FOREIGN KEYS
--
-- The original `records` table used a polymorphic scope_id column
-- that held a user_id, club_id, or org_id depending on the value of
-- `scope`. There was no FK constraint because postgres can't
-- reference three different tables, so deleting a club silently
-- orphaned its records. That's a real referential-integrity
-- problem, probably the most concrete normalization debt in the
-- schema tbh.
--
-- This migration splits the table into three:
--   records_personal   (user_id  references users)
--   records_club       (club_id  references clubs, holder_id references users)
--   records_federation (org_id   references organisations, holder_id references users)
--
-- Plus three matching *_history tables. The old polymorphic tables
-- get backfilled into the new ones, then dropped, and the
-- now-unused `record_scope` enum goes with them.
--
-- Idempotent: re-running on a DB where 019 already applied is a
-- no-op (CREATE TABLE IF NOT EXISTS, DO blocks that gate the
-- backfill on the old table existing, DROP IF EXISTS).
-- =============================================================

BEGIN;

-- ---------- New tables ----------------------------------------

CREATE TABLE IF NOT EXISTS public.records_personal (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, height, dive_code, position)
);

CREATE TABLE IF NOT EXISTS public.records_club (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
    -- Who actually set the record. They may have moved clubs since,
    -- the record still belongs to whichever club held them at the time.
    holder_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (club_id, height, dive_code, position)
);

CREATE TABLE IF NOT EXISTS public.records_federation (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    holder_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, height, dive_code, position)
);

-- ---------- History tables ------------------------------------
-- Append-only. NOT FK'd to users / clubs / orgs / events because
-- those rows may have been deleted between when the record was set
-- and when it was superseded, history has to survive either way.

CREATE TABLE IF NOT EXISTS public.records_personal_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id       uuid NOT NULL,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.records_club_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    club_id       uuid NOT NULL,
    holder_id     uuid,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.records_federation_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id        uuid NOT NULL,
    holder_id     uuid,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Indexes -------------------------------------------

CREATE INDEX IF NOT EXISTS idx_records_personal_user
    ON public.records_personal (user_id);
CREATE INDEX IF NOT EXISTS idx_records_club_club
    ON public.records_club (club_id);
CREATE INDEX IF NOT EXISTS idx_records_club_holder
    ON public.records_club (holder_id);
CREATE INDEX IF NOT EXISTS idx_records_federation_org
    ON public.records_federation (org_id);
CREATE INDEX IF NOT EXISTS idx_records_federation_holder
    ON public.records_federation (holder_id);
CREATE INDEX IF NOT EXISTS idx_records_personal_history_user
    ON public.records_personal_history (user_id);
CREATE INDEX IF NOT EXISTS idx_records_club_history_club
    ON public.records_club_history (club_id);
CREATE INDEX IF NOT EXISTS idx_records_federation_history_org
    ON public.records_federation_history (org_id);

-- ---------- Backfill ------------------------------------------
-- Wrapping the backfill in a DO block gated on the old polymorphic
-- tables existing means re-running this migration after the DROP
-- at the bottom is just a clean no-op.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'records') THEN

    -- For 'personal' the old scope_id == holder_id == the user.
    INSERT INTO public.records_personal
        (user_id, height, dive_code, position, score, event_id, set_at)
    SELECT scope_id, height, dive_code, position, score, event_id, set_at
    FROM public.records WHERE scope = 'personal'
    ON CONFLICT (user_id, height, dive_code, position) DO NOTHING;

    -- For 'club' / 'federation' scope_id is the club / org, and
    -- holder_id just stays as the user.
    INSERT INTO public.records_club
        (club_id, holder_id, height, dive_code, position, score, event_id, set_at)
    SELECT scope_id, holder_id, height, dive_code, position, score, event_id, set_at
    FROM public.records WHERE scope = 'club'
    ON CONFLICT (club_id, height, dive_code, position) DO NOTHING;

    INSERT INTO public.records_federation
        (org_id, holder_id, height, dive_code, position, score, event_id, set_at)
    SELECT scope_id, holder_id, height, dive_code, position, score, event_id, set_at
    FROM public.records WHERE scope = 'federation'
    ON CONFLICT (org_id, height, dive_code, position) DO NOTHING;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'records_history') THEN

    INSERT INTO public.records_personal_history
        (user_id, height, dive_code, position, score, event_id, set_at, superseded_at)
    SELECT scope_id, height, dive_code, position, score, event_id, set_at, superseded_at
    FROM public.records_history WHERE scope = 'personal';

    INSERT INTO public.records_club_history
        (club_id, holder_id, height, dive_code, position, score, event_id, set_at, superseded_at)
    SELECT scope_id, holder_id, height, dive_code, position, score, event_id, set_at, superseded_at
    FROM public.records_history WHERE scope = 'club';

    INSERT INTO public.records_federation_history
        (org_id, holder_id, height, dive_code, position, score, event_id, set_at, superseded_at)
    SELECT scope_id, holder_id, height, dive_code, position, score, event_id, set_at, superseded_at
    FROM public.records_history WHERE scope = 'federation';
  END IF;
END$$;

-- ---------- Drop the old polymorphic tables -------------------

DROP TABLE IF EXISTS public.records_history;
DROP TABLE IF EXISTS public.records;

-- record_scope enum was only ever used by records / records_history.
-- Safe to drop now those tables are gone.
DROP TYPE IF EXISTS public.record_scope;

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 19, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
