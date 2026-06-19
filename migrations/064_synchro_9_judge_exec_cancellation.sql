-- =============================================================
-- MIGRATION 064 — 9-JUDGE SYNCHRO EXECUTION CANCELLATION
--
-- World Aquatics Competition Regulations (Feb 2026), Part Four,
-- Article 9.1.5.4: in a 9-judge synchronised panel the Secretaries
-- cancel "the highest and the lowest Judges' awards given for
-- execution BETWEEN BOTH Athletes" (i.e. one high + one low across
-- the combined pool of four execution marks → keep the middle two),
-- and cancel the highest + lowest of the five synchronisation marks
-- (keep three). The award is then (sum of the five counted marks)
-- × (3/5) × DD — matching the 11-judge panel's five-mark scale.
--
-- The previous definition (migrations 050 / init.sql) summed ALL
-- FOUR execution marks for the 9-judge panel, counting seven marks
-- instead of five and over-scoring every 9-judge synchro dive by a
-- factor of 7/5. This redefinition fixes the 9-judge branch; the
-- 7-judge and 11-judge branches are unchanged.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.calc_synchro_dive_points(
    judge_numbers integer[],
    scores        numeric[],
    num_judges    integer,
    dd            numeric
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    n           integer;
    jn          integer;
    exec_a      numeric[];
    exec_b      numeric[];
    sync_grp    numeric[];
    exec_all    numeric[];
    sorted      numeric[];
    group_sum   numeric;
    counted_sum numeric := 0;
BEGIN
    IF scores IS NULL OR array_length(scores, 1) IS NULL THEN
        RETURN 0;
    END IF;

    exec_a := ARRAY[]::numeric[];
    exec_b := ARRAY[]::numeric[];
    sync_grp := ARRAY[]::numeric[];

    FOR n IN 1 .. array_length(scores, 1) LOOP
        jn := COALESCE(judge_numbers[n], n);
        IF num_judges = 7 THEN
            IF jn BETWEEN 1 AND 2 THEN exec_a := exec_a || scores[n];
            ELSIF jn BETWEEN 3 AND 4 THEN exec_b := exec_b || scores[n];
            ELSIF jn BETWEEN 5 AND 7 THEN sync_grp := sync_grp || scores[n]; END IF;
        ELSIF num_judges = 9 THEN
            IF jn BETWEEN 1 AND 2 THEN exec_a := exec_a || scores[n];
            ELSIF jn BETWEEN 3 AND 4 THEN exec_b := exec_b || scores[n];
            ELSIF jn BETWEEN 5 AND 9 THEN sync_grp := sync_grp || scores[n]; END IF;
        ELSIF num_judges = 11 THEN
            IF jn BETWEEN 1 AND 3 THEN exec_a := exec_a || scores[n];
            ELSIF jn BETWEEN 4 AND 6 THEN exec_b := exec_b || scores[n];
            ELSIF jn BETWEEN 7 AND 11 THEN sync_grp := sync_grp || scores[n]; END IF;
        ELSE
            sync_grp := sync_grp || scores[n];
        END IF;
    END LOOP;

    -- EXECUTION marks.
    IF num_judges = 9 THEN
        -- WA Art 9.1.5.4: cancel the single highest + lowest execution
        -- award across BOTH Athletes' four marks → keep the middle two.
        exec_all := exec_a || exec_b;
        SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(exec_all) AS s;
        IF array_length(sorted, 1) = 4 THEN
            counted_sum := counted_sum + sorted[2] + sorted[3];
        ELSE
            -- Defensive: an unexpected execution count (partial panel) —
            -- sum whatever execution marks are present rather than drop.
            SELECT COALESCE(SUM(s), 0) INTO group_sum FROM unnest(exec_all) AS s;
            counted_sum := counted_sum + group_sum;
        END IF;
    ELSE
        -- 11-judge: cancel high + low PER Athlete (3 → keep middle 1).
        -- 7-judge / fallback: keep every execution mark.
        IF array_length(exec_a, 1) IS NOT NULL THEN
            IF num_judges = 11 AND array_length(exec_a, 1) = 3 THEN
                SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(exec_a) AS s;
                counted_sum := counted_sum + sorted[2];
            ELSE
                SELECT COALESCE(SUM(s), 0) INTO group_sum FROM unnest(exec_a) AS s;
                counted_sum := counted_sum + group_sum;
            END IF;
        END IF;

        IF array_length(exec_b, 1) IS NOT NULL THEN
            IF num_judges = 11 AND array_length(exec_b, 1) = 3 THEN
                SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(exec_b) AS s;
                counted_sum := counted_sum + sorted[2];
            ELSE
                SELECT COALESCE(SUM(s), 0) INTO group_sum FROM unnest(exec_b) AS s;
                counted_sum := counted_sum + group_sum;
            END IF;
        END IF;
    END IF;

    -- SYNCHRONISATION marks: 9 & 11-judge panels drop hi+lo of the
    -- five (keep middle 3); 7-judge keeps all three.
    IF array_length(sync_grp, 1) IS NOT NULL THEN
        IF num_judges IN (9, 11) AND array_length(sync_grp, 1) = 5 THEN
            SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(sync_grp) AS s;
            counted_sum := counted_sum + sorted[2] + sorted[3] + sorted[4];
        ELSE
            SELECT COALESCE(SUM(s), 0) INTO group_sum FROM unnest(sync_grp) AS s;
            counted_sum := counted_sum + group_sum;
        END IF;
    END IF;

    RETURN counted_sum * COALESCE(dd, 1.0) * 0.6;
END
$$;

INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 64, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
