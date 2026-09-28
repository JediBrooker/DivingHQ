-- 100_users_email_lower_idx.sql
--
-- users had no index on email at all, and routes/auth.js looks people
-- up by it case-insensitively in three places:
--
--   resend-verification   WHERE (username = $1 OR lower(email) = lower($1))
--   email change request  WHERE lower(email) = $1 AND id <> $2
--   email change confirm  WHERE lower(email) = lower($1) AND id <> $2
--
-- Every one of those was a full scan of users. Resend-verification sits
-- behind nothing but the auth rate limiter, so anyone can make the box do
-- that scan, and an address nobody has (the usual case for a probe) reads
-- the whole table before giving up.
--
-- Measured on the test DB with 50k extra users, inside a rolled-back
-- transaction, three runs each:
--   resend-verification, unknown address   13-25 ms seq scan
--       -> 0.03-0.1 ms (BitmapOr of users_username_key and this index)
--   email change dup checks                 10-15 ms seq scan
--       -> 0.01-0.02 ms index scan
--
-- forgot-password matches email = $1 exactly, so it can't use a lower()
-- index. Making that lookup case-insensitive would change who gets a
-- reset mail, which is a separate call.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_users_email_lower
    ON public.users (lower(email));

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 100, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
