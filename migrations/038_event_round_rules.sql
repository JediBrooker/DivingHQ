-- 038_event_round_rules.sql
--
-- Structured round-by-round dive-list rules: the "4 dives @
-- 7.6 + 4 dives unlimited" pattern from real youth meet
-- bulletins (see https://www.divingnsw.org.au/events/295029).
--
-- Up to now the only DD constraint was a flat
-- (dd_limit_rounds, dd_limit_value) pair on events: "first N
-- rounds, each ≤ X DD." That covered the simple case but
-- couldn't express:
--   * SUM-of-DD limits per section (vs. per-dive)
--   * "different groups" requirements within a section
--   * multiple sections with different rules
--   * mixed voluntary/optional structures
--
-- New `round_rules` JSONB column. NULL means legacy behaviour
-- (the dd_limit_rounds/value pair still applies). When it's
-- populated, it looks like this:
--
--   {
--     "sections": [
--       {
--         "label": "Voluntary",
--         "rounds": 4,
--         "dd_limit": 7.6,                  // SUM of DDs in section
--         "require_different_groups": true  // each round from a
--                                            // different group
--                                            // (forward / back /
--                                            // reverse / inward /
--                                            // twist / armstand)
--       },
--       { "label": "Optional", "rounds": 4, "dd_limit": null,
--         "require_different_groups": true }
--     ]
--   }
--
-- The sum of section.rounds across all sections has to equal the
-- event's `total_rounds`, enforced server-side rather than at the
-- DB level (a CHECK constraint can't reference another column
-- plus jsonb without a function).

BEGIN;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS round_rules jsonb;

-- Quick sanity check: if round_rules is set, it must contain a
-- `sections` array. Doesn't enforce content, just shape, the full
-- validation lives in lib/round-rules.js so error messages can be
-- be structured per-rule.
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_round_rules_shape_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_round_rules_shape_check
    CHECK (
      round_rules IS NULL
      OR jsonb_typeof(round_rules->'sections') = 'array'
    );

COMMIT;
