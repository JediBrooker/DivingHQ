-- =============================================================
-- MIGRATION 051: pending partner pairings
--
-- Synchro events need both divers to consent to the pairing.
-- Right now the submit-list endpoint just accepts a partner_id
-- with no ask, so a diver can end up on the start list paired
-- with someone who never agreed to it.
--
-- This migration adds a pending_partner_pairings table. The
-- submit flow becomes:
--
--   1. Diver A submits synchro list with partner_id = B.
--   2. If a pending row already exists where the OTHER party
--      named A as their partner, both confirm and the
--      competitor_dive_lists rows land with partner_id set.
--   3. Otherwise, a pending row is created and B is notified
--      (in-app + push). B can accept (which finalises both
--      sides) or decline (which clears the pending row).
--
-- Rows are scoped to (event_id, requester_id, partner_id). The
-- UNIQUE constraint stops duplicate pending invites; the check
-- constraint stops self-pairing.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.pending_partner_pairings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    requester_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    partner_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    -- The requester's chosen dive list as submitted. Stored on the
    -- pending row (not competitor_dive_lists) so the partner sees
    -- the proposal but the public start list isn't polluted with
    -- an entry the partner never agreed to. On accept we use this
    -- payload to populate competitor_dive_lists for BOTH divers in
    -- one transaction.
    -- Shape: [{ dive_id: uuid, round_number: int }, ...]
    dives         jsonb NOT NULL DEFAULT '[]'::jsonb,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    responded_at  timestamptz,
    UNIQUE (event_id, requester_id, partner_id),
    CHECK (requester_id <> partner_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_pairings_partner
    ON public.pending_partner_pairings (partner_id, status)
    WHERE status = 'pending';

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 51, now())
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
