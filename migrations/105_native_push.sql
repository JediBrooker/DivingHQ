BEGIN;
CREATE TABLE IF NOT EXISTS public.native_push_installations (
  id uuid PRIMARY KEY,
  revoke_hash text NOT NULL,
  revision bigint NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.native_push_devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  environment text NOT NULL CHECK (environment IN ('development', 'production')),
  token text NOT NULL,
  revoke_hash text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  token_version integer NOT NULL,
  session_expires_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_accepted_at timestamptz,
  last_error text,
  last_test_at timestamptz,
  UNIQUE(platform, environment, token)
);
CREATE INDEX IF NOT EXISTS native_push_devices_user_active ON public.native_push_devices(user_id) WHERE revoked_at IS NULL AND enabled;
INSERT INTO public.schema_meta(id, version, applied_at) VALUES (1, 105, now())
ON CONFLICT(id) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;
COMMIT;
