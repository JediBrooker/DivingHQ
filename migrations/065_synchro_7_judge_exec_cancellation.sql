-- =============================================================
-- MIGRATION 065 - 7-JUDGE SYNCHRO: CONSISTENT NORMALISATION
--
-- The 7-judge synchronised panel (four execution judges split 2+2,
-- plus three synchronisation judges) is a DivingHQ extension for
-- smaller meets. World Aquatics only sanctions 9- and 11-judge
-- synchro panels. Migrations 050/064 scored it by summing ALL seven
-- marks × 0.6, which put it on a different scale from every other
-- synchro panel: the 0.6 (= 3/5) factor is calibrated for FIVE
-- counted marks (5 × 0.6 = an individual-event 3-judge equivalent),
-- so seven counted marks over-scored a 7-judge synchro dive by 7/5.
--
-- This redefinition makes the 7-judge panel a clean sibling of the
-- 9-judge panel: both share the 2+2 execution layout, so both apply
-- the WA Art 9.1.5.4 execution rule, cancelling the single highest and
-- lowest execution award BETWEEN BOTH Athletes (pool of four → keep
-- the middle two). The 7-judge panel keeps all three synchronisation
-- marks since a three-judge group has nothing to drop; the 9-judge
-- panel drops the high + low of its five. Both therefore count five
-- marks and land on the same × 0.6 scale as the 11-judge panel and
-- the individual events. Only the 7-judge branch changes here.
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
    IF num_judges IN (7, 9) THEN
        -- WA Art 9.1.5.4: cancel the single highest + lowest execution
        -- award across BOTH Athletes' four marks → keep the middle two.
        -- The 7- and 9-judge panels share this 2+2 execution layout.
        exec_all := exec_a || exec_b;
        SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(exec_all) AS s;
        IF array_length(sorted, 1) = 4 THEN
            counted_sum := counted_sum + sorted[2] + sorted[3];
        ELSE
            -- Defensive, just in case: an unexpected execution count
            -- (partial panel), so sum whatever marks are present rather than drop.
            SELECT COALESCE(SUM(s), 0) INTO group_sum FROM unnest(exec_all) AS s;
            counted_sum := counted_sum + group_sum;
        END IF;
    ELSE
        -- 11-judge: cancel high + low PER Athlete (3 → keep middle 1).
        -- Fallback panels: keep every execution mark.
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
    -- five (keep middle 3); the 7-judge panel keeps all three.
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
VALUES (1, 65, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
