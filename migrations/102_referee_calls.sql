-- 102_referee_calls.sql
--
-- A referee's Failed dive or points cap is a call on the dive, not on
-- the scores that happen to be in when the button is pressed. WA 8.6.6:
-- a failed dive gets 0 points. WA 8.4.7: once the Referee declares a
-- maximum of 2 points, any higher award "shall be declared to be 2
-- points", and the call comes before the judges show their awards (or
-- as soon as possible with electronic judging), so most of the panel
-- usually scores after it.
--
-- The socket handler only rewrote the score rows already there, and
-- kept the call nowhere, so every judge who scored after it kept their
-- full award. These two columns hold the call per (event, competitor,
-- round), on the dive-list row every score already hangs off (the
-- scores FK), so submit_score can hold a late award to it. A redive
-- clears them.
--
--   referee_call  'failed' | 'cap', NULL when the dive has no call
--   referee_cap   the cap value for 'cap' (2.0 unless the referee chose
--                 another), NULL otherwise
--
-- Additive and nullable, nothing that reads competitor_dive_lists today
-- notices them.

BEGIN;

ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS referee_call varchar(10)
        CHECK (referee_call IN ('failed', 'cap')),
    ADD COLUMN IF NOT EXISTS referee_cap numeric(3,1);

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 102, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
