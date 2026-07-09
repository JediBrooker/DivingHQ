-- =============================================================
-- MIGRATION 057: CLUB CHANGE REQUESTS + CROSS-ORG TRANSFERS
--
-- Two flows, one table:
--
--   club_change (within-org)
--     A diver asks to move between clubs inside their OWN org.
--     One org_admin of that org approves -> users.club_id updated.
--     A diver may always CLEAR their club themselves (existing
--     PUT /api/users/:id/club); MOVING into a different club needs
--     sign-off so a club roster can't be polluted by anyone.
--
--   org_transfer (cross-org)
--     A diver moves to a DIFFERENT org (federation). Three-way
--     handshake so nobody is moved unilaterally:
--       * source org_admin approves the release,
--       * target org_admin approves the intake,
--       * the diver confirms the move themselves.
--     When all three are set -> users.org_id + users.club_id are
--     updated atomically.
--
-- A pending request does NOT block the diver competing. Every
-- finalised change writes an audit_log row.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.club_change_requests (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    kind            varchar(20) NOT NULL DEFAULT 'club_change'
                      CHECK (kind IN ('club_change', 'org_transfer')),
    from_org_id     uuid REFERENCES public.organisations(id) ON DELETE SET NULL,
    from_club_id    uuid REFERENCES public.clubs(id)         ON DELETE SET NULL,
    to_org_id       uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    to_club_id      uuid REFERENCES public.clubs(id)         ON DELETE SET NULL,
    status          request_status NOT NULL DEFAULT 'pending',
    source_approved_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
    source_approved_at  timestamptz,
    target_approved_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
    target_approved_at  timestamptz,
    diver_confirmed_at  timestamptz,
    requested_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at     timestamptz,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ccr_user
    ON public.club_change_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_ccr_to_org_status
    ON public.club_change_requests (to_org_id, status);
CREATE INDEX IF NOT EXISTS idx_ccr_from_org_status
    ON public.club_change_requests (from_org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ccr_one_open
    ON public.club_change_requests (user_id)
    WHERE status = 'pending';

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 57, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
