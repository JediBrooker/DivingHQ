-- 043_super_final_format.sql
--
-- World Aquatics Diving World Cup "Super Final" format:
-- foundation schema only. Subsequent commits wire the
-- seeding endpoints, ranking endpoint, dive-offs UI, and
-- synchro-reserve replacement on top of these columns.
--
-- Source of truth for the format (committed alongside the
-- main Competition Regulations PDF):
--
--   docs/2026.03.05-World-Aquatics-Diving-World-Cup-Additional-
--   Rules-and-Regulations-2026-REVISED-w.out-Stop-Clean.pdf
--
-- Appendix 3 spells out the three-stage Individual format:
--
--   Stage 1 - Head-to-Head: 12 divers in 6 seeded pairs
--             (12v1, 11v2, 10v3, 9v4, 8v5, 7v6) split into
--             two physical groups (G1 = 12v1, 9v4, 8v5;
--             G2 = 11v2, 10v3, 7v6). Each diver dives 3
--             dives. Higher pair total advances → 6 winners.
--
--   Stage 2 - Semi Final: the 6 H2H winners regrouped by
--             which H2H group they came from. SCORES CARRY
--             FORWARD from H2H. Women add 2 dives, Men add
--             3. Top 2 per SF group advance → 4 finalists.
--
--   Stage 3 - Final: 4 divers, full submitted dive list
--             (5 W / 6 M). Scores RESET to zero. Reverse-
--             rank start order from SF.
--
--   Final overall ranking blends three sources:
--     1–4  : Final stage scores
--     5–6  : H2H + SF cumulative
--     7–12 : H2H scores only
--
-- ----------------------------------------------------------
-- New columns + table this migration adds:
--
--   competitor_dive_lists.group_number int -
--     1 or 2 for Super Final stages (H2H sub-groups, SF
--     groups). NULL for non-super-final events. Used by
--     the standings query to rank within a sub-group only.
--
--   events.score_carry_from uuid -
--     When set, the standings/calc layers SUM scores from
--     this stage AND the parent stage referenced here.
--     Default NULL = points reset per Article 4.1.13 (the
--     existing behaviour of every other stage type).
--     Super Final SF rows set this to the H2H event's id;
--     the Super Final F leaves it NULL (reset).
--
--   New event_format values:
--     'super_final_h2h'   - Head-to-Head stage
--     'super_final_semi'  - Semi Final stage
--     'super_final_final' - Final stage
--
--   tiebreak_dive_offs table - single-dive tie-breakers
--     held at end of H2H or SF (Appendix 3 §6). Doesn't
--     affect official scores; just records who advanced.

BEGIN;

-- ---- 1. group_number on competitor_dive_lists --------------
ALTER TABLE public.competitor_dive_lists
  ADD COLUMN IF NOT EXISTS group_number integer;

ALTER TABLE public.competitor_dive_lists
  DROP CONSTRAINT IF EXISTS cdl_group_number_check;
ALTER TABLE public.competitor_dive_lists
  ADD CONSTRAINT cdl_group_number_check
    CHECK (group_number IS NULL OR group_number BETWEEN 1 AND 4);

CREATE INDEX IF NOT EXISTS idx_cdl_event_group
  ON public.competitor_dive_lists(event_id, group_number)
  WHERE group_number IS NOT NULL;

-- ---- 2. score_carry_from on events --------------------------
-- The Super Final SF stage sums H2H + SF scores. This column
-- names the sibling stage whose totals carry forward. NULL =
-- WA default (points reset between stages, Article 4.1.13).
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS score_carry_from uuid
    REFERENCES public.events(id) ON DELETE SET NULL;

-- ---- 3. event_format CHECK constraint expansion -------------
-- Three Super Final stage values join 'preliminary' /
-- 'semifinal' / 'final'. Drop + recreate the CHECK so older
-- DBs and fresh init.sql DBs end up with the same constraint.
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_event_format_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_event_format_check
    CHECK (event_format IN (
      'preliminary',
      'semifinal',
      'final',
      'super_final_h2h',
      'super_final_semi',
      'super_final_final'
    ));

-- ---- 4. tiebreak_dive_offs ----------------------------------
-- Appendix 3 §6: "A dive-off is held in case of a tie after
-- Head-to-Head or Semi Final. Divers choose one previously
-- performed dive. Higher score advances. Dive-off does not
-- affect official scores. No dive-off after the Final results."
--
-- One row per dive-off. The dive each athlete picks is recorded
-- alongside their total score for that single dive (sum of
-- post-trim panel × DD, same as a normal dive). Winner is
-- written when the referee resolves it.
CREATE TABLE IF NOT EXISTS public.tiebreak_dive_offs (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    -- The two competitors tied at the end of the stage.
    competitor_a_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    competitor_b_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- Each diver picks one of their previously-performed dives;
    -- the dive_directory ids are recorded so the audit trail
    -- spells out "Diver A picked 5253B, Diver B picked 405C".
    dive_a_id       uuid REFERENCES public.dive_directory(id) ON DELETE SET NULL,
    dive_b_id       uuid REFERENCES public.dive_directory(id) ON DELETE SET NULL,
    -- Total point score (post-trim × DD) for the chosen dive,
    -- recorded only when the referee resolves the dive-off.
    score_a         numeric(6,2),
    score_b         numeric(6,2),
    winner_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
    -- Free-text "why", usually empty, but the referee can
    -- annotate (e.g. "Diver B refused dive-off; Diver A
    -- advanced by default").
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz,
    -- Sanity: the two competitors must be distinct.
    CONSTRAINT tiebreak_distinct_competitors
      CHECK (competitor_a_id <> competitor_b_id),
    -- Once resolved, winner must be one of the two competitors.
    CONSTRAINT tiebreak_winner_is_competitor
      CHECK (
        winner_id IS NULL
        OR winner_id = competitor_a_id
        OR winner_id = competitor_b_id
      )
);

CREATE INDEX IF NOT EXISTS idx_tiebreak_event
  ON public.tiebreak_dive_offs(event_id);

-- Bump schema_meta.version. Migrations 035-042 silently stopped
-- bumping the singleton, the audit caught that init.sql now
-- declares 43 while a migrated DB still reads 34. The runner
-- relies on this column to compute "what's pending", so a stale
-- value re-applies idempotent migrations on every run (harmless
-- but wasteful, plus an observability gap). 043 picks the
-- responsibility back up; backfilling 035-042's bumps is a
-- separate cleanup, tbh not the fun kind.
INSERT INTO public.schema_meta (id, version)
VALUES (1, 43)
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version
WHERE public.schema_meta.version < EXCLUDED.version;

COMMIT;
