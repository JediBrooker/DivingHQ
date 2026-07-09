-- =============================================================
-- MIGRATION 011: DIVE LIST TEMPLATES
--
-- Save / load reusable dive lists. A diver builds a 6-dive list
-- for a 3m event, saves it as "3m optionals 2026". Next meet at
-- the same height they load the template, tweak, submit. Cuts
-- typing time on what's an inherently repetitive workflow.
--
-- Templates are per-user (each diver owns their own); name is
-- unique per (user, height) so a diver can have one template
-- per event height. The actual dive picks live in the dives
-- jsonb column, shaped like { round_number: int, dive_code: string,
-- position: 'A'|'B'|'C'|'D' }[]. We keep them as jsonb rather
-- than a child table since the list is small, atomic, and never
-- queried by individual dive.
--
-- Idempotent.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.dive_list_templates (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    height      board_height,
    dives       jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at  timestamptz DEFAULT now() NOT NULL,
    updated_at  timestamptz DEFAULT now() NOT NULL,
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_dive_list_templates_user ON public.dive_list_templates (user_id);

-- Bump schema version. Defensive create so this still works
-- against a DB that hasn't had 008 applied yet.
CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 11, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
