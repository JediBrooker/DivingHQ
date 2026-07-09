-- =============================================================
-- MIGRATION 052: PER-USER LOCALE
--
-- The SPA locale lives in localStorage today, so a returning user
-- gets their language back on the same device. Cross-device
-- persistence needs server-side storage, so this migration adds
-- users.locale (nullable; null means "infer from Accept-Language
-- on each request").
--
-- Also feeds server-side i18n: error messages, email templates,
-- and PDF column headers pick strings based on the requester's
-- users.locale (when known) or Accept-Language (when not).
-- =============================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS locale varchar(8);

CREATE INDEX IF NOT EXISTS idx_users_locale
    ON public.users (locale) WHERE locale IS NOT NULL;

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 52, now())
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
