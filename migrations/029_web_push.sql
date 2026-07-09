-- =============================================================
-- MIGRATION 029: REUSABLE WEB PUSH BACKEND
--
-- Two tables wire the push engine for everything the app might
-- want to push (referee sign-off, judge calls, "you're up next"
-- nudges, role-request approvals, etc.). Designed to outlive any
-- single feature, since categories are just a free-form text key
-- so a new caller can add rows without needing a schema change.
--
--   push_subscriptions: one row per (user, browser/device).
--                        Stores the Web Push endpoint + the
--                        encryption keys the push service hands
--                        the SPA at subscription time.
--   notifications: server-side record of every dispatch.
--                   Driver for retries, audit, ack tracking,
--                        and the SPA's "what did I miss" inbox.
--
-- Status enum values:
--   'pending':      row inserted, not yet sent
--   'sent':         push delivered to the push service (no
--                   guarantee the user actually saw it, that's
--                   what 'acknowledged' is for)
--   'acknowledged': user interacted (tapped notification, hit
--                   Approve/Deny, or the SPA inbox marked it
--                   read)
--   'failed':       push service rejected (invalid endpoint,
--                   quota, etc.). failure_reason carries the
--                   HTTP status / error string.
--   'expired':      past expires_at without ever sending or
--                   being acknowledged
--
-- Indexes are deliberate: (user_id, status) for the SPA inbox
-- query, (status, expires_at) for the periodic expirer, and
-- (endpoint) UNIQUE so the same browser doesn't get a duplicate
-- subscription when re-registering on the same device.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- Endpoint URL the push service handed the SPA at subscribe.
    -- Unique so re-subscribing from the same browser just updates
    -- the existing row instead of creating a duplicate.
    endpoint    text NOT NULL,
    -- ECDH public key + auth secret the push service needs to
    -- encrypt payloads. Both are URL-safe base64 strings.
    p256dh_key  text NOT NULL,
    auth_key    text NOT NULL,
    -- User-agent at subscribe time, for a future "manage your
    -- devices" UI. Not used by the engine itself yet.
    user_agent  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    -- Soft-delete: when the push service returns 404/410 the row
    -- is marked revoked rather than dropped. Keeps audit pointers
    -- stable for any notifications that referenced this sub.
    revoked_at  timestamptz,
    CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_active
    ON public.push_subscriptions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.notifications (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- Free-form key. Examples used at launch:
    --   referee_signoff, judge_call, dive_on_deck,
    --   dive_list_review, role_request, meet_starting
    -- Constrained at the application layer rather than the DB so
    -- new categories don't need a migration.
    category        varchar(40) NOT NULL,
    title           varchar(160) NOT NULL,
    body            text,
    -- Feature-specific payload. e.g. for referee_signoff:
    --   { request_id, event_id, event_name, requested_by_name }
    -- The SPA's category-aware banner reads this verbatim.
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- SPA route the system notification opens on tap. The service
    -- worker focuses an existing tab if found, otherwise opens.
    action_url      text,
    -- Web Push 'actions' (Approve/Deny buttons etc) live in the
    -- data jsonb so different categories can vary their button
    -- set without a schema change.
    status          varchar(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN
                        ('pending','sent','acknowledged','failed','expired')),
    failure_reason  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    acknowledged_at timestamptz,
    -- After this point the engine refuses to dispatch. NULL = no
    -- expiry (e.g. "your dive list was approved"). For ephemeral
    -- categories like referee_signoff we set this 5 minutes out.
    expires_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_status
    ON public.notifications (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_pending_expiry
    ON public.notifications (status, expires_at)
    WHERE status IN ('pending','sent');

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 29, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
