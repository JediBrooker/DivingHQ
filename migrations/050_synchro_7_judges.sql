-- =============================================================
-- MIGRATION 050: 7-JUDGE SYNCHRO PANELS
--
-- Lets synchronised events use the 7-judge layout: four execution
-- judges split 2+2, plus three synchronisation judges. The
-- events.number_of_judges CHECK already allowed 7, so this just
-- updates the scoring function so the grouped synchro path scores
-- those panels directly.
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
VALUES (1, 50, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
