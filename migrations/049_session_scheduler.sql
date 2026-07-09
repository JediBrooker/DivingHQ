-- =============================================================
-- MIGRATION 049: SESSION SCHEDULER (Phase 1)
--
-- Lays down the data model for docs/session-scheduler.md: a meet
-- day is no longer a flat list of events, it's a sequence of
-- timed *blocks* (warmups, event starts, breaks, ceremonies,
-- customs) on one or more *boards* grouped into a *session*.
--
-- Phase 1 (this migration) is just the read-only slice: the four
-- tables plus the additive events.board_id column. The ledgers
-- (`schedule_block_shifts`, `dismissed_conflicts`) land now so
-- later phases don't have to chase another schema bump. Heads up,
-- nothing writes to them yet.
--
-- All additions are non-breaking: existing meets without
-- sessions keep working fine. Sessions + blocks get seeded
-- lazily on first GET in routes/sessions.js, not by a backfill
-- here, since touching every org on upgrade would be both
-- unnecessary and risky for federations that haven't opted into
-- the feature.
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- BOARDS: first-class resource. The board_height enum stays in
-- place as the source of truth for events.height and the dive
-- picker; this table is additive. Championship venues run two
-- pools or multiple boards at the same height, wich the enum
-- just can't express.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.boards (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id        uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    pool_name     varchar(80) NOT NULL,             -- "Main pool", "Warmup pool"
    height        board_height NOT NULL,            -- reuses the existing enum
    label         varchar(60),                      -- "Board A", "South-end", optional
    display_order integer NOT NULL DEFAULT 0,
    archived_at   timestamptz,                      -- soft delete; preserves history
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, pool_name, height, label)
);

CREATE INDEX IF NOT EXISTS idx_boards_org_active
    ON public.boards (org_id)
    WHERE archived_at IS NULL;

-- Pin an event to a specific physical board. Optional, since the
-- scheduler falls back to matching by events.height within the
-- meet's pool when this is NULL. Existing events keep working
-- fine without ever picking a board.
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES public.boards(id);

-- -------------------------------------------------------------
-- SESSIONS: one timeline per (meet, day, pool). Multiple pools
-- on the same day means multiple session rows; the UI groups
-- them by session_date.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sessions (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    meet_id         uuid NOT NULL REFERENCES public.meets(id) ON DELETE CASCADE,
    name            varchar(120) NOT NULL,         -- "Saturday morning, 3m"
    session_date    date NOT NULL,                 -- the day this session covers
    pool            varchar(80),                   -- "Main pool", free text for v1
    -- Optional referee for the whole session. Per-block
    -- assignments can override it, but most sessions just
    -- inherit one referee.
    referee_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_meet_date
    ON public.sessions (meet_id, session_date);

-- -------------------------------------------------------------
-- SCHEDULE BLOCKS: the atomic timeline element.
-- -------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_block_type') THEN
        CREATE TYPE schedule_block_type AS ENUM (
            'warmup',       -- pool open for athletes, no scoring
            'event_start',  -- a competition event runs here
            'break',        -- pool closed, scoreboard idle
            'ceremony',     -- medals / opening / closing
            'custom'        -- catch-all for whatever the operator needs
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.schedule_blocks (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id      uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    block_type      schedule_block_type NOT NULL,
    label           varchar(160),                  -- "Warmup: Men's 3m"
    -- Time window. Both required; the timeline is fully discrete
    -- in v1 (no open-ended blocks).
    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,
    CONSTRAINT block_window_valid CHECK (ends_at > starts_at),
    -- The board(s) this block occupies. Array so a warmup can
    -- claim multiple boards at once. Empty = doesn't claim a
    -- board (ceremony, announcements). FK references aren't
    -- enforceable on uuid[] in Postgres; the API layer validates
    -- membership against the boards table.
    board_ids       uuid[] NOT NULL DEFAULT '{}',
    -- For event_start blocks: the event this block runs. NULL
    -- for non-event blocks. ON DELETE SET NULL so deleting an
    -- event doesn't blow away the schedule slot, the operator
    -- just sees an orphaned block and decides what to do with it.
    event_id        uuid REFERENCES public.events(id) ON DELETE SET NULL,
    -- Live re-flow state (phase 4). actual_start_at /
    -- actual_end_at track what really happened; starts_at /
    -- ends_at remain the planned window until an operator
    -- confirms a shift.
    actual_start_at timestamptz,
    actual_end_at   timestamptz,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedule_blocks_session
    ON public.schedule_blocks (session_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_schedule_blocks_event
    ON public.schedule_blocks (event_id) WHERE event_id IS NOT NULL;

-- -------------------------------------------------------------
-- SHIFTS LEDGER (phase 4, land now)
-- Audit-only, never read by the running app. Lets us debrief
-- "why did Sunday afternoon collapse" after a meet.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schedule_block_shifts (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    block_id      uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
    shifted_at    timestamptz NOT NULL DEFAULT now(),
    shifted_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    old_starts_at timestamptz NOT NULL,
    new_starts_at timestamptz NOT NULL,
    reason        text                              -- "Event 3 ran 20m long"
);

-- -------------------------------------------------------------
-- DISMISSED CONFLICTS LEDGER (phase 2, land now)
-- Per-conflict dismissals only, see §5 of the design doc for the
-- rationale. A dismissal gets fingerprinted on the resource
-- members at dismissal time; if the set changes, the conflict
-- resurfaces.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dismissed_conflicts (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    meet_id      uuid NOT NULL REFERENCES public.meets(id) ON DELETE CASCADE,
    -- The two blocks involved. Sorted so (a, b) and (b, a)
    -- collapse to one row; saves a noisy index and de-dupes the
    -- lookup.
    block_a_id   uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
    block_b_id   uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
    CONSTRAINT block_pair_sorted CHECK (block_a_id < block_b_id),
    resource_kind text NOT NULL
        CHECK (resource_kind IN ('judge','board','diver','referee')),
    resource_fingerprint text NOT NULL,
    dismissed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    dismissed_at timestamptz NOT NULL DEFAULT now(),
    reason       text,
    UNIQUE (block_a_id, block_b_id, resource_kind)
);

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 49, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
