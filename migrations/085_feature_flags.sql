-- 085_feature_flags.sql
--
-- Runtime kill switches for whole product areas.
--
-- Payments and classes are both finished and wired up, but we're not
-- launching with them. Rather than ripping the code out (and paying to
-- put it back later) we park them behind a flag a sysadmin can flip
-- from the UI. No restart, no deploy.
--
-- Rows here are the source of truth. lib/features.js caches them in
-- process; the app runs a single PM2 fork (see ecosystem.config.js) so
-- one cache is all there is, and the toggle endpoint refreshes it in
-- the same tick it writes.
--
-- A key that isn't in this table falls back to the default declared in
-- lib/features.js, which is `false` for everything. Deleting a row
-- turns a feature OFF, it doesn't restore some hidden default-on state.
-- That's deliberate: a flag you can't find should never be a flag
-- that's silently live.

BEGIN;

CREATE TABLE IF NOT EXISTS public.feature_flags (
    key         text PRIMARY KEY,
    enabled     boolean     NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Who flipped it last. NULL for the seed rows below, and for a
    -- flag whose toggler has since been deleted.
    updated_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.feature_flags IS
    'Runtime on/off switches for product areas. See lib/features.js for the key registry.';

-- Seeded OFF for launch. ON CONFLICT DO NOTHING so re-running the
-- migration against a database where someone has already turned
-- payments on does not quietly switch it back off again.
INSERT INTO public.feature_flags (key, enabled)
VALUES ('payments', false),
       ('classes',  false)
ON CONFLICT (key) DO NOTHING;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 85, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
