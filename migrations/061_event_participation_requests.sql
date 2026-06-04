-- =============================================================
-- MIGRATION 061 — event participation invite workflow
--
-- `event_participating_orgs` remains the accepted-membership table:
-- a row there means the visiting federation can enter divers and
-- all existing cross-federation visibility/auth checks keep working.
--
-- This table adds the operational workflow around that membership.
-- Hosts create pending requests; visiting org admins accept or
-- decline. Accepting inserts into event_participating_orgs inside
-- the API transaction.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_participation_requests (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id       uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    org_id         uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    status         varchar(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
    requested_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    responded_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    requested_at   timestamptz NOT NULL DEFAULT now(),
    responded_at   timestamptz,
    note           text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_participation_requests_event_org
    ON public.event_participation_requests (event_id, org_id);

CREATE INDEX IF NOT EXISTS idx_event_participation_requests_org_status
    ON public.event_participation_requests (org_id, status, requested_at DESC);

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 61, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
