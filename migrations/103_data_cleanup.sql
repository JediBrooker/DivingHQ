-- 103_data_cleanup.sql
--
-- Three one-off cleanups, signed off by the product owner on 2026-09-29.
-- Each one is data the fixed code no longer writes, but that older
-- releases left behind in production.
--
-- It only deletes rows (plus the audit rows and token bumps that go with
-- them). Nothing changes shape, so the previous release keeps serving
-- through the deploy window without noticing, and it isn't listed in
-- scripts/migration-compat.js. Safe to re-run: every step matches only
-- what is still wrong, and its audit rows and token bumps come from the
-- rows it actually removed, so a second run writes nothing at all.
--
-- 1. Synchro mirror rows.
--    Confirming a synchro pair through the portal used to write a second
--    competitor_dive_lists row per round with the two divers swapped
--    (d77942c0 stopped it). Every reader counts a pair as one row with
--    the second diver in partner_id, so those pairs still sit in the
--    Control Room queue and the public up-next list twice a round.
--    A mirror row is the accepter's row naming the requester, in a round
--    where the requester's own row names the accepter. It goes, except:
--      * when it has scores. The scores FK cascades, so deleting it would
--        take the scores with it. A pair that dived on the mirror row
--        stays as it is for an operator to sort out.
--      * when the requester's row for that round was withdrawn and the
--        mirror wasn't. Somebody tidied the duplicate by hand and kept
--        the mirror as the live entry, so leave their choice alone.
--      * when the same two divers also have an accepted pairing the other
--        way round that's newer. Then each side's rows are the other's
--        mirror, and the newest pairing is the one whose requester the
--        old code wrote last, so only that one is followed. Otherwise a
--        single DELETE would see both sides as mirrors and drop the pair
--        entirely.
--
-- 2. Roles left behind by org transfers.
--    Roles are kept per org and the token only reads the ones in
--    users.org_id, so a row in any other org isn't authority, it's a
--    grant waiting to switch back on (a former org admin who moved home
--    came back an admin), and a few queries that join user_org_roles
--    without matching the member's org still count it. Transfers clear
--    them since 7208ad4e; this clears the ones from before. Each row is
--    audited as revoked and its holder's token_version is bumped.
--
-- 3. Referees handed out by club or region admins.
--    Where a country has no federation (claim_state 'unclaimed') referee
--    requests used to be decided by the member's club or region admins.
--    Referee reaches every meet in the org, so those asks go to DivingHQ
--    now (lib/role-requests.js). The grants made before that go: any
--    referee row in an unclaimed org whose granted_by is somebody who
--    isn't a system admin. A NULL granted_by (bootstrap, seed data, a
--    granter since hard-deleted) and a sysadmin's grant both stay. Same
--    audit row and token bump as above, and, like a claim revoke, anyone
--    left with no role at all in their own org gets 'spectator'. They can
--    ask again, and it routes to DivingHQ.
--
-- Deploy it when no meet is Live: step 1 can take an unscored row out
-- from under a diver who's on the board at that moment.

BEGIN;

-- ---- 1. synchro mirror rows -------------------------------------
DO $$
DECLARE
    n int;
BEGIN
    DELETE FROM public.competitor_dive_lists m
     USING public.pending_partner_pairings p
     WHERE p.status        = 'accepted'
       AND m.event_id      = p.event_id
       AND m.competitor_id = p.partner_id
       AND m.partner_id    = p.requester_id
       -- The requester's own row for the round, naming the accepter.
       AND EXISTS (
             SELECT 1 FROM public.competitor_dive_lists r
              WHERE r.event_id      = m.event_id
                AND r.round_number  = m.round_number
                AND r.competitor_id = p.requester_id
                AND r.partner_id    = p.partner_id
                AND (r.withdrawn_at IS NULL OR m.withdrawn_at IS NOT NULL))
       -- No newer accepted pairing of the same two the other way round.
       AND NOT EXISTS (
             SELECT 1 FROM public.pending_partner_pairings q
              WHERE q.event_id     = p.event_id
                AND q.requester_id = p.partner_id
                AND q.partner_id   = p.requester_id
                AND q.status       = 'accepted'
                AND (COALESCE(q.responded_at, q.created_at), q.id)
                  > (COALESCE(p.responded_at, p.created_at), p.id))
       AND NOT EXISTS (
             SELECT 1 FROM public.scores s
              WHERE s.event_id      = m.event_id
                AND s.competitor_id = m.competitor_id
                AND s.round_number  = m.round_number);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '103: removed % synchro mirror row(s)', n;
END $$;

-- ---- 2. roles left behind by org transfers ----------------------
DO $$
DECLARE
    n int;
    people int;
BEGIN
    WITH gone AS (
        DELETE FROM public.user_org_roles r
         USING public.users u
         WHERE u.id = r.user_id
           AND r.org_id <> u.org_id
        RETURNING r.user_id, r.org_id, r.role
    ), logged AS (
        INSERT INTO public.role_audit_log (user_id, org_id, role, action, actor_id, note)
        SELECT user_id, org_id, role, 'revoked', NULL,
               'Data cleanup (migration 103): left behind when they moved to another organisation'
          FROM gone
    ), bumped AS (
        UPDATE public.users u
           SET token_version = u.token_version + 1
         WHERE u.id IN (SELECT user_id FROM gone)
        RETURNING u.id
    )
    SELECT (SELECT count(*) FROM gone), (SELECT count(*) FROM bumped)
      INTO n, people;
    RAISE NOTICE '103: removed % role(s) held outside the member''s own org, from % account(s)', n, people;
END $$;

-- ---- 3. referees from club and region admins --------------------
-- After step 2, so a row that was both only gets audited once.
DO $$
DECLARE
    n int;
    people int;
    spectators int;
BEGIN
    WITH gone AS (
        DELETE FROM public.user_org_roles r
         USING public.organisations o, public.users g
         WHERE o.id = r.org_id
           AND o.claim_state = 'unclaimed'
           AND r.role = 'referee'
           AND g.id = r.granted_by
           AND g.is_system_admin IS NOT TRUE
        RETURNING r.user_id, r.org_id
    ), logged AS (
        INSERT INTO public.role_audit_log (user_id, org_id, role, action, actor_id, note)
        SELECT user_id, org_id, 'referee', 'revoked', NULL,
               'Data cleanup (migration 103): granted by a club or region admin, ask DivingHQ for it again'
          FROM gone
    ), backfill AS (
        -- Every statement in here sees the table as it was before the
        -- DELETE, so "no other role" means no role besides this referee
        -- row (the key allows one referee row per person per org).
        INSERT INTO public.user_org_roles (user_id, org_id, role)
        SELECT g.user_id, g.org_id, 'spectator'
          FROM gone g
          JOIN public.users u ON u.id = g.user_id AND u.org_id = g.org_id AND u.deleted_at IS NULL
         WHERE NOT EXISTS (
                 SELECT 1 FROM public.user_org_roles x
                  WHERE x.user_id = g.user_id AND x.org_id = g.org_id AND x.role <> 'referee')
        ON CONFLICT DO NOTHING
        RETURNING user_id, org_id
    ), backfill_logged AS (
        INSERT INTO public.role_audit_log (user_id, org_id, role, action, actor_id, note)
        SELECT user_id, org_id, 'spectator', 'granted', NULL,
               'Data cleanup (migration 103): their referee role went and they had no other'
          FROM backfill
    ), bumped AS (
        UPDATE public.users u
           SET token_version = u.token_version + 1
         WHERE u.id IN (SELECT user_id FROM gone)
        RETURNING u.id
    )
    SELECT (SELECT count(*) FROM gone), (SELECT count(*) FROM bumped), (SELECT count(*) FROM backfill)
      INTO n, people, spectators;
    RAISE NOTICE '103: removed % referee grant(s) from club or region admins in unclaimed orgs, % account(s), % given spectator', n, people, spectators;
END $$;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 103, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
