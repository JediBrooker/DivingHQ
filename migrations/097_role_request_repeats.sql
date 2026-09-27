-- 097_role_request_repeats.sql
--
-- Role requests can now be made after signup (POST /api/role-requests),
-- which means the same person can ask for the same role more than once
-- over the years: asked to judge, got turned down, asked again next
-- season. The original UNIQUE (user_id, org_id, requested_role, status)
-- from init.sql made the second decision of that kind blow up. Rejecting
-- a repeat request tried to write a second 'rejected' row for the same
-- key and the review 500'd; same for re-approving a role that had been
-- revoked in between.
--
-- What the table actually needs is at most one PENDING request per
-- person, org and role. History of decided ones can repeat freely.
--
-- The constraint name comes from Postgres' default naming, which isn't
-- guaranteed on every box (hand-built databases, a rename somewhere), so
-- find it by its columns rather than by name.

BEGIN;

DO $$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT con.conname
          FROM pg_constraint con
         WHERE con.conrelid = 'public.role_requests'::regclass
           AND con.contype = 'u'
           AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
                  FROM unnest(con.conkey) AS k(attnum)
                  JOIN pg_attribute att
                    ON att.attrelid = con.conrelid AND att.attnum = k.attnum)
               = ARRAY['org_id', 'requested_role', 'status', 'user_id']
    LOOP
        EXECUTE format('ALTER TABLE public.role_requests DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

-- The old constraint already allowed only one pending row per key, so
-- this can't collide with existing data.
CREATE UNIQUE INDEX IF NOT EXISTS role_requests_one_pending
    ON public.role_requests (user_id, org_id, requested_role)
    WHERE status = 'pending';

-- "My requests" on the profile reads by user.
CREATE INDEX IF NOT EXISTS idx_role_requests_user
    ON public.role_requests (user_id, created_at DESC);

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 97, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
