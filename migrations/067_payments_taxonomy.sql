-- =============================================================
-- MIGRATION 067: PAYMENTS TAXONOMY
--
-- Widens the fee system (Migration 066) from {membership, event_entry}
-- to the full fee taxonomy and wires fees to the right entities:
--   • fee_definitions: 15 scopes + entity links (meet_id, club_id,
--     role_type, discipline, tier) + late-fee trigger + donation presets,
--     each scope gated by its own readable CHECK.
--   • payments: polymorphic payer (user | club | official_role), meet/club
--     subjects, liable party (fines), per-subject live-payment uniqueness.
--   • memberships: tier snapshot.
--   • NEW tables: club_admins, club_affiliations, official_accreditations,
--     entry_charges, meet_bundle_items.
--
-- Backward compatible: existing membership/event_entry rows satisfy the
-- new per-scope CHECKs, and payer_type defaults to 'user'. Additive and guarded,
-- nothing here should break existing rows.
-- =============================================================

BEGIN;

-- ============================================================
-- 1A. fee_definitions: widen scope + add entity linkage + tiers
-- ============================================================

ALTER TABLE public.fee_definitions
  DROP CONSTRAINT IF EXISTS fee_definitions_scope_check;

ALTER TABLE public.fee_definitions
  ADD COLUMN IF NOT EXISTS meet_id     uuid REFERENCES public.meets(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS club_id     uuid REFERENCES public.clubs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS role_type   varchar(40),   -- 'judge'|'referee'|'coach'|'meet_manager'
  ADD COLUMN IF NOT EXISTS discipline  varchar(40),   -- '1m'|'3m'|'platform'|'synchro_3m'|'synchro_platform' (NULL = all)
  ADD COLUMN IF NOT EXISTS tier        varchar(40),   -- 'junior'|'senior'|'masters' (NULL = single-tier)
  ADD COLUMN IF NOT EXISTS late_fee_trigger varchar(20)
        CHECK (late_fee_trigger IS NULL
               OR late_fee_trigger IN ('entries_close_at','dive_list_locks_at')),
  ADD COLUMN IF NOT EXISTS suggested_amounts integer[];  -- donations: presets (minor units)

-- Full scope set. event_entry now attaches to event OR meet.
ALTER TABLE public.fee_definitions
  ADD CONSTRAINT fee_definitions_scope_check CHECK (scope IN (
    'membership',            -- athlete registration / annual membership (+tiers via `tier`)
    'event_entry',           -- per-event OR per-meet entry (+discipline)
    'meet_bundle',           -- buy a whole meet's events as one discounted package
    'late_entry',            -- surcharge after a deadline trigger
    'scratch',               -- withdrawal penalty (admin/system-issued debit)
    'no_show',               -- DNS penalty (admin/system-issued debit)
    'club_affiliation',      -- federation charges the CLUB (annual)
    'club_accreditation',    -- federation charges the CLUB (accreditation)
    'official_accreditation',-- per-role official/coach meet pass (uses role_type)
    'spectator_ticket',      -- day/event pass
    'livestream',            -- stream access
    'programme',             -- digital/printed programme
    'fine',                  -- disciplinary fine (admin-issued, named liable party)
    'levy',                  -- per-entry sanctioning levy (multi-org events)
    'donation'               -- fundraising add-on
  ));

-- Per-scope named entity CHECKs. Each fully constrains which entity columns
-- AND which of tier/discipline/role_type are permitted, for readable failures.

-- event_entry: exactly one of event_id|meet_id; discipline optional; no club/role/tier.
ALTER TABLE public.fee_definitions ADD CONSTRAINT fee_def_chk_event_entry CHECK (
  scope <> 'event_entry' OR (
    ((event_id IS NOT NULL) <> (meet_id IS NOT NULL))
    AND club_id IS NULL AND role_type IS NULL AND tier IS NULL
  ));

-- late_entry / scratch / no_show: event-keyed; no meet/club/role/tier/discipline.
ALTER TABLE public.fee_definitions ADD CONSTRAINT fee_def_chk_entry_penalty CHECK (
  scope NOT IN ('late_entry','scratch','no_show') OR (
    event_id IS NOT NULL AND meet_id IS NULL AND club_id IS NULL
    AND role_type IS NULL AND tier IS NULL AND discipline IS NULL
  ));

-- meet_bundle: meet-keyed only.
ALTER TABLE public.fee_definitions ADD CONSTRAINT fee_def_chk_meet_bundle CHECK (
  scope <> 'meet_bundle' OR (
    meet_id IS NOT NULL AND event_id IS NULL AND club_id IS NULL
    AND role_type IS NULL AND tier IS NULL AND discipline IS NULL
  ));

-- membership: org-level only; tier optional; nothing else.
ALTER TABLE public.fee_definitions ADD CONSTRAINT fee_def_chk_membership CHECK (
  scope <> 'membership' OR (
    event_id IS NULL AND meet_id IS NULL AND club_id IS NULL
    AND role_type IS NULL AND discipline IS NULL
  ));

-- club_affiliation / club_accreditation: club_id optional (NULL = template for any
-- club, set = one specific club); no event/meet/role/tier/discipline.
ALTER TABLE public.fee_definitions ADD CONSTRAINT fee_def_chk_club CHECK (
  scope NOT IN ('club_affiliation','club_accreditation') OR (
    event_id IS NULL AND meet_id IS NULL
    AND role_type IS NULL AND tier IS NULL AND discipline IS NULL
  ));

-- official_accreditation: role_type required; meet_id optional (NULL = org-wide
-- annual); no event/club/tier/discipline.
ALTER TABLE public.fee_definitions ADD CONSTRAINT fee_def_chk_official CHECK (
  scope <> 'official_accreditation' OR (
    role_type IS NOT NULL AND event_id IS NULL AND club_id IS NULL
    AND tier IS NULL AND discipline IS NULL
  ));

-- spectator_ticket / livestream / programme: attach to meet_id OR event_id;
-- no club/role/tier/discipline.
ALTER TABLE public.fee_definitions ADD CONSTRAINT fee_def_chk_spectator CHECK (
  scope NOT IN ('spectator_ticket','livestream','programme') OR (
    (meet_id IS NOT NULL OR event_id IS NOT NULL)
    AND club_id IS NULL AND role_type IS NULL AND tier IS NULL AND discipline IS NULL
  ));

-- fine / levy / donation: org-level; no entity/role/tier/discipline.
--   (fine's liable party lives on the payment, not the definition.)
ALTER TABLE public.fee_definitions ADD CONSTRAINT fee_def_chk_misc CHECK (
  scope NOT IN ('fine','levy','donation') OR (
    event_id IS NULL AND meet_id IS NULL AND club_id IS NULL
    AND role_type IS NULL AND tier IS NULL AND discipline IS NULL
  ));

-- Replace the single-active-entry unique index (066) with a scope+entity
-- composite: one active fee per (org, scope, entity, discipline, tier, role).
DROP INDEX IF EXISTS idx_fee_definitions_one_active_entry;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_definitions_one_active
  ON public.fee_definitions (
    org_id, scope,
    COALESCE(event_id,  '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(meet_id,   '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(club_id,   '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(role_type,  '~'),
    COALESCE(discipline, '~'),
    COALESCE(tier,       '~')
  ) WHERE active;

CREATE INDEX IF NOT EXISTS idx_fee_definitions_meet ON public.fee_definitions (meet_id) WHERE meet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fee_definitions_club ON public.fee_definitions (club_id) WHERE club_id IS NOT NULL;

-- ============================================================
-- 1B. fee_prices: reused as-is for windows/audience (no schema change here).
--   resolvePrice() picks up tier/discipline awareness via the
--   fee_definition row, not new audience values. Early-bird/standard/late
--   still just map to starts_at/ends_at.
-- ============================================================

-- ============================================================
-- 1C. payments: polymorphic payer (user | club | official-role)
-- ============================================================
ALTER TABLE public.payments
  ALTER COLUMN payer_user_id DROP NOT NULL;  -- club payments have no individual payer

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payer_type varchar(20) NOT NULL DEFAULT 'user'
        CHECK (payer_type IN ('user','club','official_role')),
  ADD COLUMN IF NOT EXISTS payer_club_id uuid REFERENCES public.clubs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payer_role_type varchar(40),
  ADD COLUMN IF NOT EXISTS meet_id   uuid REFERENCES public.meets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS club_id   uuid REFERENCES public.clubs(id) ON DELETE SET NULL,  -- subject club (affiliation)
  ADD COLUMN IF NOT EXISTS liable_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;  -- fines: who is liable

-- Exactly one payer identity present, matching payer_type.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_payer_check CHECK (
       (payer_type = 'user'          AND payer_user_id IS NOT NULL AND payer_club_id IS NULL)
    OR (payer_type = 'official_role' AND payer_user_id IS NOT NULL AND payer_role_type IS NOT NULL)
    OR (payer_type = 'club'          AND payer_club_id IS NOT NULL AND payer_user_id IS NULL)
  );

-- Widen subject_type to mirror the scope set.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_subject_type_check;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_subject_type_check CHECK (subject_type IN (
    'membership','event_entry','meet_bundle','late_entry','scratch','no_show',
    'club_affiliation','club_accreditation','official_accreditation',
    'spectator_ticket','livestream','programme','fine','levy','donation'
  ));

-- Live-payment uniqueness guards (per subject_type; covers user/club/official payers).
DROP INDEX IF EXISTS idx_payments_one_live_entry;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_event_entry
  ON public.payments (event_id, payer_user_id, fee_definition_id)
  WHERE subject_type = 'event_entry' AND payer_user_id IS NOT NULL
        AND status IN ('pending','paid');

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_meet_entry
  ON public.payments (meet_id, payer_user_id, fee_definition_id)
  WHERE subject_type = 'event_entry' AND meet_id IS NOT NULL AND payer_user_id IS NOT NULL
        AND status IN ('pending','paid');

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_membership
  ON public.payments (payer_user_id, fee_definition_id)
  WHERE subject_type = 'membership' AND payer_user_id IS NOT NULL
        AND status IN ('pending','paid');

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_club
  ON public.payments (payer_club_id, fee_definition_id)
  WHERE subject_type IN ('club_affiliation','club_accreditation')
        AND payer_club_id IS NOT NULL AND status IN ('pending','paid');

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_official
  ON public.payments (payer_user_id, payer_role_type, fee_definition_id)
  WHERE subject_type = 'official_accreditation' AND payer_user_id IS NOT NULL
        AND status IN ('pending','paid');

CREATE INDEX IF NOT EXISTS idx_payments_payer_club ON public.payments (payer_club_id) WHERE payer_club_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_meet ON public.payments (meet_id) WHERE meet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_liable ON public.payments (liable_user_id) WHERE liable_user_id IS NOT NULL;

-- ============================================================
-- 1D. memberships: tier support (junior/senior/masters)
-- ============================================================
ALTER TABLE public.memberships
  ADD COLUMN IF NOT EXISTS tier varchar(40);  -- snapshot of the tier purchased

-- ============================================================
-- 1E. club_admins: club-scoped authorization
--   There was no club-role mechanism before this. Grants named users admin
--   over a club, seperate from org_role. requireClubAdmin is what authorizes
--   the club-payer routes.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.club_admins (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_club_admins_user ON public.club_admins (user_id);
CREATE INDEX IF NOT EXISTS idx_club_admins_club ON public.club_admins (club_id);

-- ============================================================
-- 1F. club_affiliations: paid club-level periods (drives status + pricing)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.club_affiliations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  club_id       uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  fee_definition_id uuid REFERENCES public.fee_definitions(id) ON DELETE SET NULL,
  payment_id    uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  kind          varchar(20) NOT NULL DEFAULT 'affiliation'
                  CHECK (kind IN ('affiliation','accreditation')),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        varchar(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','expired','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_club_affiliations_active
  ON public.club_affiliations (org_id, club_id, kind) WHERE status = 'active';

-- ============================================================
-- 1G. official_accreditations: paid official/coach role passes
-- ============================================================
CREATE TABLE IF NOT EXISTS public.official_accreditations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  meet_id       uuid REFERENCES public.meets(id) ON DELETE CASCADE,  -- NULL = org-wide annual
  role_type     varchar(40) NOT NULL,
  fee_definition_id uuid REFERENCES public.fee_definitions(id) ON DELETE SET NULL,
  payment_id    uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  period_start  date,
  period_end    date,
  status        varchar(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','expired','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_official_accred_active
  ON public.official_accreditations (org_id, user_id, role_type) WHERE status = 'active';

-- ============================================================
-- 1H. entry_charges: scratch / no-show as entry-state debits
--   Heads up, these aren't checkouts: they're admin/system-initiated debits
--   against an existing entry. Records the triggering transition, who and
--   when, and links to the payment created to collect the penalty
--   (settled out-of-band).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.entry_charges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  entrant_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind            varchar(20) NOT NULL CHECK (kind IN ('scratch','no_show')),
  fee_definition_id uuid REFERENCES public.fee_definitions(id) ON DELETE SET NULL,
  amount_cents    integer NOT NULL,
  payment_id      uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  triggered_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,  -- NULL = system
  triggered_at    timestamptz NOT NULL DEFAULT now(),
  status          varchar(20) NOT NULL DEFAULT 'owed'
                    CHECK (status IN ('owed','paid','waived')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entry_charges_entrant
  ON public.entry_charges (entrant_user_id) WHERE status = 'owed';
CREATE INDEX IF NOT EXISTS idx_entry_charges_event ON public.entry_charges (event_id);

-- ============================================================
-- 1I. meet_bundle_items: what a bundle grants
--   A meet_bundle is basically a discounted package over a defined set of
--   the meet's events. The webhook expands a paid bundle into per-event
--   entries.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.meet_bundle_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_definition_id uuid NOT NULL REFERENCES public.fee_definitions(id) ON DELETE CASCADE,
  event_id          uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fee_definition_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_meet_bundle_items_def ON public.meet_bundle_items (fee_definition_id);

-- ---- bump schema version -------------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 67, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
