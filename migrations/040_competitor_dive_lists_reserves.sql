-- 040_competitor_dive_lists_reserves.sql
--
-- "Reserves" support for the prelim → semi → final progression.
-- When the meet manager hits "Advance to next stage" on a
-- completed prelim, the modal lets them pick:
--
--   * how many top divers progress as PRIMARIES (compete);
--   * how many trailing divers carry forward as RESERVES
--     (don't compete unless promoted, the operator can swap one
--     in if a primary withdraws between stages).
--
-- Both kinds get rows in the child event's competitor_dive_lists,
-- but reserves are flagged so the Control Room roster + diver-
-- portal eligibility queries hide them by default. Promoting a
-- reserve flips the flag and assigns them an open display_order.
--
-- reserve_position preserves the rank ordering so Control Room
-- can show "Reserve 1, Reserve 2…" and promote in order.

BEGIN;

ALTER TABLE public.competitor_dive_lists
  ADD COLUMN IF NOT EXISTS is_reserve boolean NOT NULL DEFAULT FALSE;

ALTER TABLE public.competitor_dive_lists
  ADD COLUMN IF NOT EXISTS reserve_position integer;

-- Reserve_position is only meaningful when is_reserve=true. Didn't
-- bother with a CHECK constraint here, the advance endpoint already
-- enforces the invariant on insert.

CREATE INDEX IF NOT EXISTS idx_competitor_dive_lists_event_reserve
  ON public.competitor_dive_lists(event_id, is_reserve);

COMMIT;
