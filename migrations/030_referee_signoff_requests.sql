-- =============================================================
-- MIGRATION 030: REFEREE SIGN-OFF REQUEST TABLE (Cut 2)
--
-- Tracks each "meet manager asked referee X to sign off the dive
-- order" round-trip so:
--   * the SPA can show "Waiting for Sarah Chen…" while the push
--     is in flight,
--   * a refresh on either side resumes from the correct state,
--   * declining + retry is auditable,
--   * a credential-fallback path can short-circuit to approved
--     while leaving the original push request as 'expired'.
--
-- Status enum:
--   'pending'    - request created, push fired, waiting on referee
--   'approved'   - referee tapped Approve (or credential path
--                  succeeded). events.dive_order_signed_off_at
--                  + signed_off_by are set in the same txn.
--   'declined'   - referee tapped Deny, meet manager picks again
--                  or uses the credential path
--   'expired'    - past expires_at, no response came in
--
-- notification_id ties the row back to the push notification the
-- manager fired, so a future "resend" can find the original one.
-- ON DELETE SET NULL because notifications churn pretty often.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.referee_signoff_requests (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id          uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    requested_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    target_referee_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    notification_id   uuid REFERENCES public.notifications(id) ON DELETE SET NULL,
    status            varchar(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','declined','expired')),
    decision_method   varchar(16)
                        CHECK (decision_method IN ('push','credential')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    responded_at      timestamptz,
    expires_at        timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);

CREATE INDEX IF NOT EXISTS idx_signoff_requests_event_pending
    ON public.referee_signoff_requests (event_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_signoff_requests_referee_pending
    ON public.referee_signoff_requests (target_referee_id) WHERE status = 'pending';

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 30, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
