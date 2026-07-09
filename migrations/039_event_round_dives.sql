-- 039_event_round_dives.sql
--
-- Operator-prescribed round dives. A meet manager can pin a
-- specific dive to a specific round of an event ("round 3 must
-- be 5132D off the 3 m board"); when the diver opens that event
-- in the submit-list flow, that round is pre-filled and locked,
-- and the server's submit-list endpoint rejects any list whose
-- round-N pick doesn't match the prescription.
--
-- Real-world driver: skills trials, certification fixtures, and
-- novice-level meets where the operator want the whole field
-- to dive the same things in the same order so judges can
-- compare like-for-like.
--
-- Schema:
--
--   one row per (event, round_number)
--   dive_id NULL  → "diver picks freely for this round"
--   dive_id set   → diver MUST submit exactly this dive_id
--   height NULL   → use the dive's directory-height (or any
--                   height, for free slots in non-mixed events)
--   height set    → mixed-board override: even if the slot is
--                   free, restrict the diver's pick to this board
--
-- The total number of rows for an event becomes the source of
-- truth for `total_rounds` once any round_dives exist:
-- POST /api/events sets total_rounds from the array length, and
-- PUT keeps them in sync. Events without round_dives keep the
-- legacy total_rounds-only behaviour.

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_round_dives (
  event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  round_number  integer NOT NULL CHECK (round_number >= 1),
  dive_id       uuid REFERENCES public.dive_directory(id) ON DELETE SET NULL,
  -- Optional board height for the slot. Only meaningful when the
  -- event is_mixed_height AND dive_id IS NULL, since it constrains the
  -- diver's free pick to this board. When dive_id is set the
  -- canonical height is on the dive_directory row.
  height        numeric(3,1),
  PRIMARY KEY (event_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_event_round_dives_event
  ON public.event_round_dives(event_id);

COMMIT;
