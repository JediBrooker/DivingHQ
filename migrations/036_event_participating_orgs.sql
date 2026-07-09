-- 036_event_participating_orgs.sql
--
-- International / multi-federation event support.
--
-- The original data model assumes one event = one federation: every
-- event row has a single `org_id`, and every authz gate checks equality
-- against `req.user.org_id`. That's fine for domestic meets but breaks
-- the moment a federation hosts a multi-country competition (Pacific
-- Junior Champs, World Aquatics Grand Prix stops, bilateral
-- invitationals). Foreign divers had no way to enter without creating a
-- shadow account in the host federation, which split their personal
-- best history and broke their coach links.
--
-- This migration adds an opt-in "participating orgs" join table. The
-- host org still owns the event (keeps full control over meet_manager /
-- referee / score correction / audit log), but divers from any listed
-- participating org can self-enter, and their results count toward
-- THEIR home federation's records rather than the host's. The records
-- logic already keys federation records off `users.org_id`
-- (lib/records.js:119), so no records-side migration is needed, just
-- this join table plus relaxing the entry gates in routes/competitor.js
-- and routes/events.js.
--
-- A populated row in this table is the implicit "is_international
-- event" flag, no separate boolean column needed.
--
-- The host org is NOT inserted into this table for its own event, the
-- existing `events.org_id` is still the source of truth for the host.
-- event_participating_orgs lists OTHER orgs only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_participating_orgs (
    event_id    uuid NOT NULL REFERENCES public.events(id)        ON DELETE CASCADE,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    added_at    timestamptz NOT NULL DEFAULT now(),
    added_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    PRIMARY KEY (event_id, org_id)
);

-- Index for the common reverse lookup: "what events is org X
-- invited to?" Supports the diver-side events list filter
-- (`WHERE e.org_id = $own OR EXISTS … WHERE epo.org_id = $own`)
-- so it doesn't fall back to a sequential scan.
CREATE INDEX IF NOT EXISTS idx_event_participating_orgs_org
  ON public.event_participating_orgs (org_id);

COMMIT;
