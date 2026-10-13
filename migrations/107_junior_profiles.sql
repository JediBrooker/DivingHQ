-- 107_junior_profiles.sql
--
-- Junior profiles: divers under 13 that adults look after.
--
-- Accounts are 13+ since 84862769 (lib/direct-use-age.js), and signup was
-- the only way a users row got made, so a new 9-year-old had no way onto
-- DivingHQ at all. A junior profile is an ordinary users row with no
-- password and no email, so nobody can sign in to it, plus one row here
-- saying who added it, that a parent agreed, and where it stands.
--
--   pending      added by someone who doesn't confirm that club's divers
--                (a parent, a coach, a club admin under a federation).
--                No diver role yet, so it can't be entered in anything.
--   active       confirmed. Has the diver role and competes like anyone.
--   handed_over  the diver turned 13 and took it over (stage 2): they set
--                a username, password and email through a one-time link.
--
-- Who confirms is whoever confirms that club's diver requests
-- (lib/role-requests.js nearestReviewers): the federation's admins under
-- a federation, otherwise the club's admins, its region, then DivingHQ.
-- lib/juniors.js has the rules.
--
-- A parent who adds their child gets a guardians row (migration 083) at
-- the same time, approved when the junior is. That link is also what
-- sends the child's meet notifications to the parent (lib/push.js).
--
-- The handover token is stored hashed (sha256 hex), same as the email
-- change token on users.

BEGIN;

CREATE TABLE IF NOT EXISTS public.junior_profiles (
    user_id             uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    org_id              uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    status              varchar(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'active', 'handed_over')),
    created_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_as          varchar(20) NOT NULL
                          CHECK (created_as IN ('parent', 'coach', 'club', 'org')),
    -- Who ticked "a parent or guardian agreed" (the parent themselves when
    -- created_as = 'parent'), and when.
    consent_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,
    consent_at          timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    reviewed_by         uuid REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at         timestamptz,
    handover_email      varchar(255),
    handover_token_hash varchar(64),
    handover_sent_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    handover_sent_at    timestamptz,
    handover_expires_at timestamptz,
    handed_over_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_junior_profiles_org_pending
    ON public.junior_profiles (org_id) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_junior_profiles_handover_token
    ON public.junior_profiles (handover_token_hash) WHERE handover_token_hash IS NOT NULL;

INSERT INTO public.schema_meta (id, version, applied_at) VALUES (1, 107, now())
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
