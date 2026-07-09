-- 041_dive_list_lock.sql
--
-- Post-advance dive-list lock, per World Aquatics Article 6.7.3
-- (change-of-dives submission window): a change-of-dives form
-- must be submitted "no later than thirty (30) minutes after
-- the end of the previous stage of the event". Past that
-- window, the inherited list locks and the diver must perform
-- the dives indicated in their original Statement of Dives.
-- Article 4.1.12 governs the advancement itself (next-ranked
-- diver fills the slot when a qualifier withdraws).
--
-- New columns:
--
--   events.dive_list_locks_at  - when the dive-list editor
--     closes for THIS event. Set automatically by
--     POST /api/events/:id/advance to NOW() + lock_minutes
--     (default 30, configurable per advance, 0 = no auto-lock).
--     Because the advance endpoint runs after the parent stage
--     is Completed, NOW() ≈ "end of the previous stage" per
--     Article 6.7.3.
--
--   competitor_dive_lists.confirmed_at - when the diver
--     explicitly confirmed (or re-submitted) their list for
--     this event. NULL means inherited from the parent stage
--     and untouched. Distinguishes "diver actively confirmed"
--     from "diver took the default" so the operator can audit
--     who responded vs. who just let the default ride.

BEGIN;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS dive_list_locks_at timestamptz;

ALTER TABLE public.competitor_dive_lists
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_events_dive_list_locks_at
  ON public.events(dive_list_locks_at);

COMMIT;
