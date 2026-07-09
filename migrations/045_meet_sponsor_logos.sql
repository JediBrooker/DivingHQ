-- 045_meet_sponsor_logos.sql
--
-- Multi-sponsor logo support with rotation.
--
-- Background: the meets table has carried `sponsor_name`,
-- `sponsor_logo_url`, `sponsor_link_url` since the original schema,
-- supporting a SINGLE sponsor referenced by an external URL. The
-- operator could paste a CDN URL and the public meet landing page
-- would render a "Powered by" strip with a logo. Two limitations:
--
--   1. Single sponsor, real meets often carry 2-5 sponsors
--      (title sponsor + presenting sponsors + venue partner +
--      apparel partner). The streaming production team wants
--      to cycle through them during a broadcast.
--   2. External URLs only, LAN deployments (a federation
--      running the app on a single laptop without internet)
--      can't reach an external CDN, so the logos don't load.
--
-- This migration adds:
--
--   • meet_sponsor_logos table, one row per (meet, slot). Image
--     bytes stored inline as BYTEA so backups stay simple (one
--     pg_dump captures everything) and the LAN-deploy story
--     doesn't need a separate `uploads/` mount. Soft cap of
--     ~1MB per logo enforced at the application layer.
--   • meets.sponsor_rotation_seconds, how often the broadcast
--     view should rotate to the next logo. 0 = no rotation
--     (show all in a strip). Default 8, long enough that a
--     spectator can clock the brand, short enough that 4 logos
--     all show within a single dive.
--
-- The legacy `meets.sponsor_logo_url` / `sponsor_link_url` /
-- `sponsor_name` columns are KEPT. When the new table has no
-- rows for a meet, the existing fields fall back to render as a
-- single virtual logo, pre-migration meets keep working
-- without backfill. When the new table has rows, the new ones
-- win (the legacy fields stay as a defensive fallback only).
--
-- Permissions: backend writes are gated on the org_admin /
-- meet_manager role (same as the rest of /api/meets). Heads up,
-- reads are public since the logos are meant to be seen on the
-- public scoreboard and broadcast surfaces.

CREATE TABLE IF NOT EXISTS meet_sponsor_logos (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  meet_id      uuid NOT NULL REFERENCES meets(id) ON DELETE CASCADE,
  -- Slot 1 = top sponsor / title sponsor. Higher numbers are
  -- secondary slots. The UI lets the operator drag to reorder;
  -- the server just persists the order they pick.
  slot_number  integer NOT NULL,
  -- Image payload + metadata. MIME is one of: image/png,
  -- image/jpeg, image/webp, image/svg+xml. byte_size is the raw
  -- length of image_bytes (BYTEA in Postgres is variable-length;
  -- pulling length(bytea) on every read is cheap but cached on
  -- write so the list endpoint doesn't have to compute it).
  mime_type    text NOT NULL,
  byte_size    integer NOT NULL,
  image_bytes  bytea NOT NULL,
  -- Optional human-readable copy. alt_text falls through to the
  -- <img alt=…> for screen readers + appears in the manage UI.
  -- link_url makes the logo clickable on public surfaces (e.g.
  -- click the sponsor → open the sponsor's site in a new tab).
  alt_text     text,
  link_url     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Slot numbers must be unique within a meet so the renderer
  -- has a deterministic order. The UI auto-assigns the next
  -- available slot on upload + reorders via a single PUT.
  UNIQUE (meet_id, slot_number)
);

CREATE INDEX IF NOT EXISTS idx_meet_sponsor_logos_meet
  ON meet_sponsor_logos (meet_id, slot_number);

ALTER TABLE meets
  ADD COLUMN IF NOT EXISTS sponsor_rotation_seconds integer NOT NULL DEFAULT 8
    CHECK (sponsor_rotation_seconds >= 0 AND sponsor_rotation_seconds <= 60);

UPDATE schema_meta SET version = 45 WHERE id = 1;
