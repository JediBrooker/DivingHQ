-- 099_notifications_user_created_idx.sql
--
-- The inbox (GET /api/notifications/me -> lib/push.js listForUser) asks
-- for a user's newest non-expired notices:
--
--   WHERE user_id = $1 AND status <> 'expired' ORDER BY created_at DESC LIMIT n
--
-- 029's index is (user_id, status, created_at DESC). A <> on its middle
-- column means it can't hand rows back in created_at order, so every
-- fetch read all of that user's rows and sorted them. The sysadmin gets
-- every org_pending / club_created notice, so theirs is the inbox that
-- keeps growing, and the SPA fetches it on every boot. On the test DB
-- (4.7k rows for the sysadmin) the planner gave up on the index
-- entirely: seq scan + top-N sort, about 1.1 ms and 266 buffers a call.
-- With (user_id, created_at DESC) it's an index scan that stops after n
-- rows: 0.02 ms for the SPA's 20 (16 buffers), 0.04 ms for the inbox
-- page's 100, and it stays flat as the inbox grows.
--
-- Nothing else reads notifications by (user_id, status): acknowledge goes
-- by primary key, the expiry sweep has idx_notifications_pending_expiry,
-- and the region-request dedupe keys on category/data. So the old index
-- goes. The new one still leads with user_id, which is all the users FK
-- cascade needs.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON public.notifications (user_id, created_at DESC);

DROP INDEX IF EXISTS public.idx_notifications_user_status;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 99, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
