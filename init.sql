-- =============================================================
-- DivingHQ: INITIAL LOAD
--
-- One-shot bootstrap for a fresh, empty database. Folds in the
-- old schema_v2.sql plus every migration (001..007), the full
-- World Aquatics dive directory, and a single super-admin
-- account so you can sign in right away.
--
-- Usage:
--     createdb divinghq
--     psql -d divinghq -f init.sql
--
-- After this finishes, log in with:
--     username: admin
--     password: admin
--
-- (Change the password from the User Manager as soon as you can, don't leave it on admin/admin.)
-- =============================================================

BEGIN;

-- =============================================================
-- EXTENSIONS
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- =============================================================
-- ENUM TYPES
-- =============================================================

CREATE TYPE org_status AS ENUM (
    'pending',      -- registered, awaiting system_admin approval
    'active',       -- fully operational
    'suspended'     -- disabled by system_admin
);

CREATE TYPE org_role AS ENUM (
    'org_admin',
    'meet_manager',
    'referee',
    'judge',
    'coach',
    'diver',
    'spectator'
);

CREATE TYPE request_status AS ENUM (
    'pending',
    'approved',
    'rejected'
);

CREATE TYPE dive_position AS ENUM (
    'A',  -- straight
    'B',  -- pike
    'C',  -- tuck
    'D'   -- free
);

CREATE TYPE event_gender AS ENUM (
    'Male',
    'Female',
    'Mixed'
);

CREATE TYPE event_status AS ENUM (
    'Upcoming',
    'Live',
    'Completed'
);

CREATE TYPE event_type AS ENUM (
    'individual',
    'synchro_pair',
    'team'
);

CREATE TYPE board_height AS ENUM (
    '0m',
    '1m',
    '3m',
    '5m',
    '7.5m',
    '10m'
);

CREATE TYPE score_audit_action AS ENUM (
    'insert',
    'update',
    'delete'
);

CREATE TYPE role_audit_action AS ENUM (
    'granted',
    'revoked'
);

CREATE TYPE attendance_status AS ENUM (
    'present',
    'late',
    'absent'
);

-- The record_scope enum got retired in migration 019 when records
-- were split into per-scope tables (records_personal /
-- records_club / records_federation) with proper foreign keys.
-- Any consumer that used to read records.scope::text now just
-- looks at wich table the row came from.


-- =============================================================
-- ORGANISATIONS
-- Top-level multi-tenant boundary. Country federations live here.
-- =============================================================

CREATE TABLE public.organisations (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name         varchar(255) NOT NULL,
    country_code char(3),                        -- ISO 3166-1 alpha-3 e.g. 'AUS'
    -- IOC continent code. Set by sysadmin per federation. NULL
    -- means not yet classified, so continental records just skip
    -- this org's divers for now. See migration 037.
    continent    varchar(20)
        CHECK (continent IS NULL OR continent IN
          ('africa','americas','asia','europe','oceania')),
    slug         varchar(100) UNIQUE NOT NULL,
    status       org_status DEFAULT 'pending' NOT NULL,
    created_at   timestamptz DEFAULT now()
);


-- =============================================================
-- CLUBS
-- A smaller organisational unit nested under organisations
-- (country federations). Optional: independent divers can have
-- a NULL club_id.
-- =============================================================

CREATE TABLE public.clubs (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    short_code  varchar(20),
    created_at  timestamptz DEFAULT now() NOT NULL
);


-- =============================================================
-- USERS
-- =============================================================

CREATE TABLE public.users (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    username        varchar(50) UNIQUE NOT NULL,
    password        varchar(255),
    full_name       varchar(100) NOT NULL,
    email           varchar(255),
    org_id          uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
    club_id         uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
    is_system_admin boolean DEFAULT false NOT NULL,
    -- Bumped on every role grant/revoke and every password change.
    -- The current version is signed into each issued JWT (`tv`);
    -- verifyToken rejects any token whose tv doesn't match. This
    -- gives an admin a one-line "log them out everywhere" by
    -- incrementing this column.
    token_version   integer NOT NULL DEFAULT 1,
    -- Email verification gate. New registrations leave this NULL
    -- until the user clicks the verification link emailed at
    -- sign-up. init.sql backfills existing rows below so a fresh
    -- bootstrap doesn't lock anyone out.
    email_verified_at timestamptz,
    -- 2FA (TOTP), added in Migration 022. NULL totp_secret = 2FA off.
    -- totp_enabled_at gets set once the user finishes the setup
    -- flow (verifies a code from their authenticator). The login
    -- gate checks enabled_at, not the secret, so a half-finished
    -- setup doesn't lock the user out.
    totp_secret         varchar(64),
    totp_enabled_at     timestamptz,
    -- Replay guard (Migration 063): absolute 30s time-step of the
    -- most recently accepted TOTP code. Login/step-up flows only
    -- accept codes whose step is strictly greater, so a code can't
    -- be presented twice inside the validity window. NULL means no
    -- code consumed yet; reset alongside totp_secret on disable.
    totp_last_used_step bigint,
    -- Array of bcrypt hashes of one-time recovery codes. Plaintext
    -- shown to the user once at setup; we never store the readable
    -- form. A used code is removed from the array on consume.
    totp_recovery_codes jsonb,
    -- Stable opaque identifier for public profile URLs (Migration
    -- 023). 16 random hex chars at user creation; never changes.
    -- See routes/public-profile.js for how it's used. NOT NULL
    -- after the migration backfill; init.sql generates one per
    -- inserted row via the trigger below.
    public_slug         varchar(32) NOT NULL DEFAULT REPLACE(gen_random_uuid()::text, '-', ''),
    -- Diver-customisable analytics dashboard. Array of widget
    -- IDs (see frontend WIDGET_CATALOG). Defaults to the four
    -- core widgets so a fresh diver has something to look at.
    dashboard_widgets jsonb DEFAULT '["score_trend","personal_bests","recent_form","placings"]'::jsonb,
    -- Judge-customisable analytics dashboard (Migration 042). Array
    -- of widget IDs (see frontend JUDGE_WIDGET_CATALOG). Lives in
    -- its own column so users who hold both 'diver' and 'judge'
    -- roles keep two independent layouts. Default catalogue picks
    -- the four most universally useful widgets so a fresh judge
    -- sees something meaningful on first visit.
    judge_dashboard_widgets jsonb DEFAULT '["bias_summary","deviation_distribution","height_breakdown","recent_meets"]'::jsonb,
    -- Self-service email change (Migration 044). When a signed-in
    -- user requests a new email, the new address is parked in
    -- pending_email and a sha256-hashed verification token in
    -- pending_email_token_hash; both clear on confirm. A new request
    -- overwrites all three, invalidating any older in-flight token.
    -- 30-min expiry mirrors the password-reset window.
    pending_email             varchar(254),
    pending_email_token_hash  varchar(64),
    pending_email_expires_at  timestamptz,
    -- Per-user UI/server locale (Migration 052). NULL means "infer
    -- from Accept-Language on each request". When set, server-side
    -- i18n (error messages, email templates, PDF column headers)
    -- and the SPA pick this locale across devices.
    locale          varchar(8),
    -- Self-service account deletion (Migration 053). NULL = active
    -- user; non-NULL = the user has deleted their account. The
    -- row is intentionally retained (not hard-deleted) so the
    -- user's name stays on the dives they actually competed in,
    -- since diving meets are public sporting records. Login and
    -- every PII column get wiped at delete time; what remains is
    -- the minimum needed to anchor historical FK references and to
    -- support reunite-on-return (claim-past-results flow). See
    -- routes/users.js for the delete + claim endpoints and
    -- docs/privacy-policy.md §7 for the user-facing contract.
    deleted_at      timestamptz,
    created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_pending_email_token
  ON public.users(pending_email_token_hash)
  WHERE pending_email_token_hash IS NOT NULL;

-- Claim-candidate lookup (Migration 053). The returning-user
-- flow asks "any deleted users in my org with my full_name?",
-- which without this index would scan every deleted row in the
-- federation. Partial so we pay zero storage on active rows.
CREATE INDEX IF NOT EXISTS idx_users_deleted_claim_lookup
  ON public.users (org_id, lower(full_name))
  WHERE deleted_at IS NOT NULL;


-- =============================================================
-- USER ORG ROLES
-- A user can hold multiple roles within their org.
-- =============================================================

CREATE TABLE public.user_org_roles (
    user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id     uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    role       org_role NOT NULL,
    granted_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    granted_at timestamptz DEFAULT now(),
    PRIMARY KEY (user_id, org_id, role)
);


-- =============================================================
-- ROLE REQUESTS
-- Self-serve flow: user requests a role, org_admin approves.
-- =============================================================

CREATE TABLE public.role_requests (
    id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id         uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    requested_role org_role NOT NULL,
    status         request_status DEFAULT 'pending' NOT NULL,
    note           text,
    reviewed_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at    timestamptz,
    created_at     timestamptz DEFAULT now(),
    UNIQUE (user_id, org_id, requested_role, status)
);


-- =============================================================
-- DIVE DIRECTORY
-- Global reference table, not org-scoped.
-- =============================================================

CREATE TABLE public.dive_directory (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    dive_code       varchar(10) NOT NULL,
    height          numeric(3,1) NOT NULL,
    position        dive_position NOT NULL,
    dd              numeric(3,1) NOT NULL,
    description     text,
    -- Custom-vs-core flag. Core rows are the World Aquatics catalog
    -- shipped with init.sql; nobody should ever edit those. Custom
    -- rows are added by an org for poolside / progression dives etc.
    -- and only the org that created them can edit/delete.
    is_custom       boolean NOT NULL DEFAULT FALSE,
    created_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_org_id  uuid REFERENCES public.organisations(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- DD is part of the unique key so a custom dive can legitimately
    -- exist as multiple variants at the same code/height/position
    -- (e.g. a 0m forward sit-dive scored at DD 0.4 for novices and
    -- DD 0.6 for stricter standard). Exact duplicates still refuse.
    CONSTRAINT dive_directory_code_height_pos_dd_key UNIQUE (dive_code, height, position, dd)
);


-- =============================================================
-- MEETS: bundles of events.
-- A real diving competition is multiple events ("2026 National
-- Open" with 1m / 3m / 10m / synchro …). The meet record holds
-- the venue, dates, sponsor info; events.meet_id is a nullable
-- backref so an event can also stand alone.
-- =============================================================

CREATE TABLE public.meets (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    venue       varchar(255),
    start_date  date,
    end_date    date,
    description text,
    -- Legacy single-sponsor fields (kept for backward-compat with
    -- meets created before the multi-logo table landed in 045).
    -- When meet_sponsor_logos has no rows for a meet, these are
    -- the fallback for the public sponsor strip.
    sponsor_name      varchar(255),
    sponsor_logo_url  text,
    sponsor_link_url  text,
    -- Multi-logo rotation cadence on broadcast / scoreboard. 0
    -- disables rotation (all logos rendered statically). Default
    -- is 8, long enough to read a brand but short enough for several
    -- logos to cycle within one dive. See migration 045.
    sponsor_rotation_seconds integer NOT NULL DEFAULT 8
        CHECK (sponsor_rotation_seconds >= 0 AND sponsor_rotation_seconds <= 60),
    created_at  timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT meets_dates_check CHECK (
        start_date IS NULL OR end_date IS NULL OR end_date >= start_date
    )
);

-- Multi-sponsor logo storage (migration 045). One row per
-- (meet, slot). Image payload stored inline as BYTEA so backups
-- stay simple and LAN-deploys don't need a seperate uploads
-- mount. The legacy meets.sponsor_logo_url field falls through
-- as a single virtual slot when this table has no rows for the
-- meet. See lib/sponsor-logos.js for the read path.
CREATE TABLE public.meet_sponsor_logos (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    meet_id      uuid NOT NULL REFERENCES public.meets(id) ON DELETE CASCADE,
    slot_number  integer NOT NULL,
    mime_type    text NOT NULL,
    byte_size    integer NOT NULL,
    image_bytes  bytea NOT NULL,
    alt_text     text,
    link_url     text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (meet_id, slot_number)
);
CREATE INDEX idx_meet_sponsor_logos_meet
    ON public.meet_sponsor_logos (meet_id, slot_number);


-- =============================================================
-- BOARDS (Migration 049, Session Scheduler phase 1)
-- First-class resource so a championship venue can model multiple
-- physical boards at the same height (warmup vs competition,
-- pool A vs pool B). The board_height enum stays as the source
-- of truth for events.height and the dive picker, this table is
-- additive on top of it. Boards get seeded lazily on first GET to
-- the scheduler endpoint (one per board_height in "Main pool");
-- the migration does not backfill every org.
-- =============================================================
CREATE TABLE public.boards (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id        uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    pool_name     varchar(80) NOT NULL,             -- "Main pool", "Warmup pool"
    height        board_height NOT NULL,
    label         varchar(60),                      -- "Board A", "South-end", optional
    display_order integer NOT NULL DEFAULT 0,
    archived_at   timestamptz,                      -- soft delete; preserves history
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, pool_name, height, label)
);
CREATE INDEX idx_boards_org_active
    ON public.boards (org_id) WHERE archived_at IS NULL;


-- =============================================================
-- EVENTS
-- =============================================================

CREATE TABLE public.events (
    id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id           uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    meet_id          uuid REFERENCES public.meets(id) ON DELETE SET NULL,
    name             varchar(255) NOT NULL,
    gender           event_gender NOT NULL,
    age_group        varchar(40),                  -- 'U14', 'Open', 'Masters 30-34', etc.
    height           board_height,
    number_of_judges integer NOT NULL,
    total_rounds     integer DEFAULT 6 NOT NULL,
    dd_limit_rounds  integer DEFAULT 0,
    dd_limit_value   numeric(3,1),
    -- Structured round-by-round dive-list rules. NULL = use
    -- the legacy (dd_limit_rounds, dd_limit_value) flat
    -- constraint. Populated: an array of sections, each with
    -- {label, rounds, dd_limit (SUM), require_different_groups}.
    -- See migration 038 for the full shape.
    round_rules      jsonb
        CHECK (round_rules IS NULL
               OR jsonb_typeof(round_rules->'sections') = 'array'),
    event_type       event_type DEFAULT 'individual' NOT NULL,
    -- World Aquatics three-stage chain:
    --   'preliminary' (all entrants) →
    --   'semifinal'   (top 18, optional intermediate) →
    --   'final'       (top 12, the default, also covers
    --                  standalone events with no feeder)
    --
    -- Diving World Cup Super Final stages (Migration 043,
    -- see docs/2026.03.05-…-Super-Final…pdf Appendix 3):
    --   'super_final_h2h'    : Head-to-Head, 6 seeded pairs
    --   'super_final_semi'   : 6 H2H winners, two SF groups
    --   'super_final_final'  : 4 finalists, scores reset
    --
    -- Synchro and team events typically skip the semi, chain
    -- length is operator-defined per event.
    event_format     varchar(20) NOT NULL DEFAULT 'final'
                       CHECK (event_format IN (
                         'preliminary','semifinal','final',
                         'super_final_h2h','super_final_semi','super_final_final'
                       )),
    -- Set on a child stage to link back to its parent.
    -- ON DELETE SET NULL so deleting the parent doesn't
    -- cascade the child.
    parent_event_id  uuid REFERENCES public.events(id) ON DELETE SET NULL,
    -- When set, the standings + ranking layers SUM scores from
    -- THIS stage AND the stage referenced here. Default NULL =
    -- points reset per Article 4.1.13 (the standard behaviour).
    -- The Super Final's SF stage sets this to the H2H event id;
    -- F leaves it NULL (reset, per Appendix 3 §3).
    score_carry_from uuid REFERENCES public.events(id) ON DELETE SET NULL,
    advance_count    integer DEFAULT 12,           -- how many top-N advance from prelim → final
    scheduled_at     timestamptz,                  -- when the event starts (schedules, .ics, notifications)
    -- Registration deadline. Independent of `status`: lets a manager
    -- close entries before the event goes Live (e.g. "submissions
    -- shut at noon, event runs at 6pm"). NULL = no explicit deadline,
    -- entries simply close when status flips off 'Upcoming'.
    entries_close_at timestamptz,
    status           event_status DEFAULT 'Upcoming' NOT NULL,
    -- Pre-meet workflow stamps. The Control Room walks the operator
    -- through four sequential states before the event flips to
    -- Live: check divers in, randomise the dive order, get the
    -- referee to sign off, then start the event. Re-randomising
    -- clears sign-off (the order changed → re-approval needed);
    -- a workflow reset clears all four stamps to walk the steps
    -- again from the top.
    check_in_done_at          timestamptz,
    dive_order_randomised_at  timestamptz,
    dive_order_signed_off_at  timestamptz,
    dive_order_signed_off_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
    -- Sign-off policy. When TRUE the simple manager-attests path
    -- is forbidden, only push approval by the named referee or
    -- credential entry by the same person counts. Default FALSE
    -- so light-touch club meets keep working.
    enforce_referee_signoff   boolean NOT NULL DEFAULT FALSE,
    -- Multi-board flag. When TRUE the height column above is
    -- informational and every dive picker widens to the full
    -- directory rather than filtering to one height. Used for
    -- mixed-board exhibitions / progression sessions.
    is_mixed_height           boolean NOT NULL DEFAULT FALSE,
    -- Workflow rehearsal / dry-run mode. Rehearsal events can
    -- move through the same Control Room flow as real events but
    -- are excluded from public archive, analytics, emails, and
    -- record-setting side effects.
    is_rehearsal              boolean NOT NULL DEFAULT FALSE,
    -- Migration 041: post-advance dive-list lock. Stamped by
    -- the advance endpoint (NOW() + lock_minutes, default 30
    -- per WA Article 6.7.3, change-of-dives must be submitted
    -- "no later than 30 min after the end of the previous
    -- stage"). Past this moment the dive-list editor closes,
    -- divers can't change their list and the inherited one rides.
    -- Meet manager can bypass via /roster late-entry.
    dive_list_locks_at        timestamptz,
    -- Migration 049: optional pin to a specific physical board.
    -- NULL = the scheduler matches by `height` against the
    -- meet's pool. Existing events stay valid without picking a
    -- board.
    board_id                  uuid REFERENCES public.boards(id),
    created_at       timestamptz DEFAULT now(),
    CONSTRAINT events_number_of_judges_check
        CHECK (number_of_judges = ANY (ARRAY[3, 5, 7, 9, 11])),
    CONSTRAINT events_total_rounds_check
        CHECK (total_rounds > 0)
);


-- =============================================================
-- EVENT MANAGERS / EVENT JUDGES
-- =============================================================

CREATE TABLE public.event_managers (
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    added_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    added_at timestamptz DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);

CREATE TABLE public.event_judges (
    event_id     uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    judge_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    judge_number integer,
    PRIMARY KEY (event_id, judge_id)
);

-- Operator-prescribed round dives (migration 039). One row per
-- (event, round_number). dive_id NULL means "diver picks for this
-- round"; non-null means "diver MUST submit this dive". The
-- existence of any row for an event makes the row count the
-- source of truth for total_rounds; events without rows fall back
-- to the legacy total_rounds column.
CREATE TABLE public.event_round_dives (
    event_id     uuid    NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    round_number integer NOT NULL CHECK (round_number >= 1),
    dive_id      uuid    REFERENCES public.dive_directory(id) ON DELETE SET NULL,
    -- Optional board-height override for the slot. Only meaningful
    -- when the event is_mixed_height AND dive_id IS NULL, in which
    -- case it constrains the diver's free pick to this board.
    height       numeric(3,1),
    PRIMARY KEY (event_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_event_round_dives_event
  ON public.event_round_dives(event_id);


-- =============================================================
-- TEAMS: for event_type = 'team' events.
-- Defined BEFORE competitor_dive_lists so the team_id FK on that
-- table resolves cleanly. (The old schema_v2.sql had teams below
-- competitor_dive_lists which made the FK forward-ref explode on
-- a fresh install, a gotcha we hit once, fixed here.)
-- =============================================================

CREATE TABLE public.teams (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    short_code  varchar(20),
    created_at  timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE public.team_members (
    team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    added_at   timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE public.event_teams (
    event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    added_at   timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (event_id, team_id)
);


-- =============================================================
-- COMPETITOR DIVE LISTS
-- partner_id: synchro pair partner (synchro events / synchro
--             dives within team events).
-- team_id:    team owning this dive list row in team events.
--             ON DELETE SET NULL preserves history when a team
--             is renamed or pruned.
-- =============================================================

CREATE TABLE public.competitor_dive_lists (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id      uuid REFERENCES public.events(id) ON DELETE CASCADE,
    competitor_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
    partner_id    uuid REFERENCES public.users(id) ON DELETE CASCADE,
    team_id       uuid REFERENCES public.teams(id) ON DELETE SET NULL,
    dive_id       uuid REFERENCES public.dive_directory(id) ON DELETE RESTRICT,
    round_number  integer NOT NULL,
    -- Control Room queue management (migration 012):
    --   display_order overrides the default name-sort within a
    --     round so the operator can re-sequence divers on the fly.
    --   withdrawn_at marks a row as scratched / DNS / DNF; the
    --     roster endpoint excludes them from the active queue.
    display_order integer,
    withdrawn_at  timestamptz,
    -- Migration 047: who withdrew this row and why. NULL on
    -- historic withdrawals from before the audit fields existed.
    withdrawn_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    withdrawn_reason     text,
    -- Migration 040: reserves carry forward from a prelim/semi to
    -- the next stage but don't compete unless the operator
    -- promotes them via the Control Room (e.g. when a primary
    -- withdraws). reserve_position preserves rank ordering so
    -- "Reserve 1" is the next in line to fill a slot.
    is_reserve       boolean NOT NULL DEFAULT FALSE,
    reserve_position integer,
    -- Migration 043: Super Final sub-group identifier. 1 or 2
    -- for super_final_h2h (G1 = pairs 12v1, 9v4, 8v5;
    -- G2 = pairs 11v2, 10v3, 7v6) and super_final_semi
    -- (groups carry forward from H2H). NULL for non-super-
    -- final events. The standings query uses this to compute
    -- intra-group rankings rather than a global field rank.
    group_number     integer
        CHECK (group_number IS NULL OR group_number BETWEEN 1 AND 4),
    -- Migration 041: when the diver explicitly confirmed (or
    -- re-submitted) the list. NULL = inherited from a parent
    -- stage and untouched. Lets the operator audit who actively
    -- responded to the post-advance lock vs. who let the default
    -- ride.
    confirmed_at  timestamptz,
    UNIQUE (event_id, competitor_id, round_number),
    CONSTRAINT competitor_dive_lists_round_number_check
        CHECK (round_number > 0)
);


-- =============================================================
-- SCORES
-- =============================================================

CREATE TABLE public.scores (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id      uuid REFERENCES public.events(id) ON DELETE CASCADE,
    competitor_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
    judge_id      uuid REFERENCES public.users(id) ON DELETE CASCADE,
    dive_id       uuid REFERENCES public.dive_directory(id),
    round_number  integer NOT NULL,
    score         numeric(3,1) NOT NULL,
    status        varchar(20) DEFAULT 'active',
    created_at    timestamptz DEFAULT now(),
    UNIQUE (event_id, competitor_id, round_number, judge_id),
    CONSTRAINT scores_score_check
        CHECK (
            score >= 0.0
            AND score <= 10.0
            AND ((score * 2) % 1) = 0  -- must be a 0.5 increment
        ),
    FOREIGN KEY (event_id, competitor_id, round_number)
        REFERENCES public.competitor_dive_lists(event_id, competitor_id, round_number)
        ON DELETE CASCADE
);


-- =============================================================
-- AUDIT LOGS
-- score_audit_log: append-only history of every score mutation.
-- role_audit_log:  append-only history of every role grant/revoke.
-- =============================================================

CREATE TABLE public.score_audit_log (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    score_id        uuid,                                            -- nullable after delete
    -- All three of these were originally `NOT NULL ON DELETE CASCADE`,
    -- which silently destroyed audit history when an event or user
    -- was deleted. SET NULL keeps the audit trail past parent-row
    -- removal (the row's score values + actor + IP + reason still
    -- support forensics). See migration 035 for the corresponding
    -- ALTER on existing deployments.
    event_id        uuid REFERENCES public.events(id) ON DELETE SET NULL,
    competitor_id   uuid REFERENCES public.users(id)  ON DELETE SET NULL,
    judge_id        uuid REFERENCES public.users(id)  ON DELETE SET NULL,
    round_number    integer NOT NULL,
    action          score_audit_action NOT NULL,
    old_score       numeric(3,1),                                    -- null for insert
    new_score       numeric(3,1),                                    -- null for delete
    actor_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    ip_address      inet,
    user_agent      text,
    reason          text,                                            -- free-text "why" for corrections
    created_at      timestamptz DEFAULT now() NOT NULL
);

-- Migration 043: Diving World Cup Super Final dive-offs.
-- Appendix 3 §6: a single-dive tie-breaker held at end of
-- Head-to-Head or Semi Final. Divers each pick one previously
-- performed dive; higher score wins; doesn't affect official
-- scores. The row records both choices, both totals, and the
-- declared winner so the audit trail explains the advancement.
CREATE TABLE public.tiebreak_dive_offs (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    competitor_a_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    competitor_b_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    dive_a_id       uuid REFERENCES public.dive_directory(id) ON DELETE SET NULL,
    dive_b_id       uuid REFERENCES public.dive_directory(id) ON DELETE SET NULL,
    score_a         numeric(6,2),
    score_b         numeric(6,2),
    winner_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz,
    CONSTRAINT tiebreak_distinct_competitors
      CHECK (competitor_a_id <> competitor_b_id),
    CONSTRAINT tiebreak_winner_is_competitor
      CHECK (
        winner_id IS NULL
        OR winner_id = competitor_a_id
        OR winner_id = competitor_b_id
      )
);

-- Saved event configurations. A meet manager builds an event
-- once ("World Aquatics U16 Women's 3m") then re-applies the template
-- for future seasons. config jsonb holds the form state (name
-- pattern, gender, height, judges, rounds, format, dd_limit_*,
-- age_group, etc.) so adding new event columns later doesn't
-- require a template-table migration.
CREATE TABLE public.event_templates (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    config      jsonb NOT NULL,
    created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name)
);


-- Saved dive lists per diver. Lets a diver carry common 5- or
-- 6-dive combinations between meets without retyping, just pick a
-- template, load it, tweak, submit.
CREATE TABLE public.dive_list_templates (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    height      board_height,
    dives       jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at  timestamptz DEFAULT now() NOT NULL,
    updated_at  timestamptz DEFAULT now() NOT NULL,
    UNIQUE (user_id, name)
);


-- Coach ↔ Diver links, many-to-many. A coach can mentor
-- multiple divers; a diver may have multiple coaches over time.
-- Cascade on either side's deletion; UNIQUE keeps duplicate
-- assignments out and implicitly indexes "is X my coach".
CREATE TABLE public.coach_diver_links (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    coach_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    diver_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    note        text,
    created_at  timestamptz DEFAULT now() NOT NULL,
    UNIQUE (coach_id, diver_id),
    CONSTRAINT coach_diver_distinct CHECK (coach_id <> diver_id)
);

CREATE TABLE public.coach_alert_preferences (
    coach_id      uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    enabled       boolean NOT NULL DEFAULT true,
    dives_ahead   int NOT NULL DEFAULT 2
                  CHECK (dives_ahead >= 1 AND dives_ahead <= 10),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.role_audit_log (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    -- SET NULL rather than CASCADE so the audit trail survives
    -- user / org deletion. See migration 035.
    user_id     uuid REFERENCES public.users(id)         ON DELETE SET NULL,
    org_id      uuid REFERENCES public.organisations(id) ON DELETE SET NULL,
    role        org_role NOT NULL,
    action      role_audit_action NOT NULL,
    actor_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    note        text,
    created_at  timestamptz DEFAULT now() NOT NULL
);

-- audit_log: generic entity-lifecycle audit. The two domain
-- logs above (score_audit_log / role_audit_log) cover their
-- own use cases tightly, this table catches everything else:
-- event create / delete / status flip, org status changes,
-- club + team deletes, late-entry adds, withdraw / reinstate,
-- pre-meet workflow resets, manager-attest sign-offs.
--
-- entity_type + action are short varchars (not enums) so
-- adding new audited surfaces in future commits is a
-- code-only change. metadata jsonb carries action-specific
-- shape: { from, to } for status flips, { round_count } for
-- late entries, etc. entity_id is nullable post-delete;
-- entity_name is denormalised so the row still reads right even
-- after the source row is gone.
--
-- Also created via migration 032 for existing deployments.
-- event_live_state: the "currently on the board" diver plus the
-- meet hold reason (if any), per event. Persisted so a server
-- restart doesn't lose the live meet's state, the in-memory
-- maps in lib/live-state.js are a write-through cache rebuilt
-- from this table on boot. See migration 034.
CREATE TABLE public.event_live_state (
    event_id              uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
    active_diver_payload  jsonb,
    on_hold_reason        text,
    hold_since            timestamptz,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

-- event_participating_orgs: join table that opts other federations
-- into this event's roster. A populated row makes it an
-- "international event", divers from the listed org can
-- self-enter, and their results count toward THEIR home
-- federation's records rather than the host's. The host org is
-- NOT listed here (events.org_id is the source of truth for the
-- host); this table lists OTHER federations only. See migration
-- 036.
CREATE TABLE public.event_participating_orgs (
    event_id    uuid NOT NULL REFERENCES public.events(id)        ON DELETE CASCADE,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    added_at    timestamptz NOT NULL DEFAULT now(),
    added_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    PRIMARY KEY (event_id, org_id)
);
CREATE INDEX idx_event_participating_orgs_org
  ON public.event_participating_orgs (org_id);

CREATE TABLE public.audit_log (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id       uuid REFERENCES public.organisations(id) ON DELETE SET NULL,
    actor_id     uuid REFERENCES public.users(id)         ON DELETE SET NULL,
    entity_type  varchar(40) NOT NULL,
    entity_id    uuid,
    entity_name  varchar(255),
    action       varchar(60) NOT NULL,
    metadata     jsonb,
    note         text,
    ip_address   inet,
    user_agent   text,
    created_at   timestamptz DEFAULT now() NOT NULL
);

-- =============================================================
-- EVENT ATTENDANCE: pre-meet door check-in (migration 016).
-- One row per (event, competitor); no row = "not yet checked in".
-- =============================================================

CREATE TABLE public.event_attendance (
    event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    competitor_id uuid NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
    status        attendance_status NOT NULL,
    set_at        timestamptz NOT NULL DEFAULT now(),
    set_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
    PRIMARY KEY (event_id, competitor_id)
);

-- =============================================================
-- RECORDS: split per scope so we can attach proper FKs
-- (migration 017 introduced a polymorphic scope_id table; 019
-- split it into the three relations below).
--
-- Each scope has a current-best table + a *_history table for
-- previous holders. History tables don't carry FKs because the
-- subjects (users / clubs / orgs / events) might get deleted
-- between when a record was set and when it was superseded, and
-- the historical row still needs to survive.
-- =============================================================

CREATE TABLE public.records_personal (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, height, dive_code, position)
);

CREATE TABLE public.records_club (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
    -- Who set the record. The user may have moved clubs since;
    -- the record still belongs to whoever held them at the time.
    holder_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (club_id, height, dive_code, position)
);

CREATE TABLE public.records_federation (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    holder_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, height, dive_code, position)
);

CREATE TABLE public.records_personal_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id       uuid NOT NULL,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.records_club_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    club_id       uuid NOT NULL,
    holder_id     uuid,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.records_federation_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id        uuid NOT NULL,
    holder_id     uuid,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);

-- Continental records: best per (continent, height, dive_code,
-- position). Mirrors records_federation's shape with `continent`
-- replacing org_id. Only divers whose home federation has a
-- non-null `continent` set ever land here. See migration 037.
CREATE TABLE public.records_continental (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    continent   varchar(20) NOT NULL,
    holder_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (continent, height, dive_code, position)
);

CREATE TABLE public.records_continental_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    continent     varchar(20) NOT NULL,
    holder_id     uuid,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);


-- =============================================================
-- WORLD AQUATICS DIVE POINTS: INDIVIDUAL
-- Trim rules:
--   3j keep all, 5j drop high+low, 7j drop 2+2,
--   9j drop 2+2 × 0.6,  11j drop 3+3 × 0.6
--   dive_points = (sum of counted scores) × DD × scaling
-- =============================================================

CREATE OR REPLACE FUNCTION public.calc_dive_points(
    scores      numeric[],
    num_judges  integer,
    dd          numeric
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    sorted       numeric[];
    n            integer;
    drop_count   integer;
    scaling      numeric;
    counted_sum  numeric;
BEGIN
    IF scores IS NULL OR array_length(scores, 1) IS NULL THEN
        RETURN 0;
    END IF;
    SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(scores) AS s;
    n := array_length(sorted, 1);
    drop_count := CASE
        WHEN num_judges = 5  THEN 1
        WHEN num_judges = 7  THEN 2
        WHEN num_judges = 9  THEN 2
        WHEN num_judges = 11 THEN 3
        ELSE 0
    END;
    scaling := CASE WHEN num_judges IN (9, 11) THEN 0.6 ELSE 1.0 END;
    IF drop_count > 0 AND n > drop_count * 2 THEN
        SELECT SUM(s) INTO counted_sum
        FROM unnest(sorted[(drop_count + 1) : (n - drop_count)]) AS s;
    ELSE
        SELECT SUM(s) INTO counted_sum FROM unnest(sorted) AS s;
    END IF;
    RETURN COALESCE(counted_sum, 0) * COALESCE(dd, 1.0) * scaling;
END
$$;


-- =============================================================
-- WORLD AQUATICS DIVE POINTS: SYNCHRO
-- 7-judge:  four execution judges (j1+j2 exec A, j3+j4 exec B)
--           plus three synchronisation judges (j5..j7); all count.
-- 9-judge:  j1+j2 exec A, j3+j4 exec B, j5..j9 sync (drop hi+lo,
--           keep middle 3), both exec scores keep, no drops.
-- 11-judge: j1..j3 exec A (keep middle 1), j4..j6 exec B (keep
--           middle 1), j7..j11 sync (drop hi+lo, keep middle 3).
-- award = (counted exec A + counted exec B + counted sync) × DD × 0.6
-- =============================================================

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


-- =============================================================
-- DISPATCH WRAPPER: used by every standings / leaderboard /
-- archive / PDF query so they don't have to CASE on event_type
-- inline.
--   synchro_pair             → role-grouped synchro
--   team event w/ has_partner → individual trim × 0.6
--   else                     → standard individual trim × DD
-- =============================================================

CREATE OR REPLACE FUNCTION public.calc_event_dive_points(
    judge_numbers integer[],
    scores        numeric[],
    num_judges    integer,
    dd            numeric,
    e_type        event_type,
    has_partner   boolean DEFAULT false
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF e_type = 'synchro_pair' THEN
        RETURN public.calc_synchro_dive_points(judge_numbers, scores, num_judges, dd);
    ELSIF has_partner THEN
        RETURN public.calc_dive_points(scores, num_judges, dd) * 0.6;
    ELSE
        RETURN public.calc_dive_points(scores, num_judges, dd);
    END IF;
END
$$;


-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX idx_users_org              ON public.users (org_id);
CREATE INDEX idx_users_club             ON public.users (club_id);
CREATE INDEX idx_users_locale           ON public.users (locale) WHERE locale IS NOT NULL;
CREATE INDEX idx_user_org_roles_user    ON public.user_org_roles (user_id);
CREATE INDEX idx_user_org_roles_org     ON public.user_org_roles (org_id);
CREATE INDEX idx_role_requests_org      ON public.role_requests (org_id, status);
CREATE INDEX idx_clubs_org              ON public.clubs (org_id);
CREATE INDEX idx_events_org             ON public.events (org_id);
CREATE INDEX idx_events_status          ON public.events (status);
CREATE INDEX idx_events_rehearsal       ON public.events (org_id, is_rehearsal, status);
CREATE INDEX idx_event_managers_event   ON public.event_managers (event_id);
CREATE INDEX idx_event_managers_user    ON public.event_managers (user_id);
-- Composite covers both the "panel for this event" listings and
-- the per-submission `WHERE event_id = $1 AND judge_id = $2`
-- lookup that runs on every submit_score.
CREATE INDEX idx_event_judges_event_judge ON public.event_judges (event_id, judge_id);
CREATE INDEX idx_dive_lists_event       ON public.competitor_dive_lists (event_id);
CREATE INDEX idx_dive_lists_competitor  ON public.competitor_dive_lists (competitor_id);
CREATE INDEX idx_dive_lists_partner     ON public.competitor_dive_lists (partner_id);
CREATE INDEX idx_dive_lists_team        ON public.competitor_dive_lists (team_id);
CREATE INDEX idx_cdl_withdrawn_by       ON public.competitor_dive_lists (withdrawn_by_user_id)
    WHERE withdrawn_by_user_id IS NOT NULL;
CREATE INDEX idx_teams_org              ON public.teams (org_id);
CREATE INDEX idx_team_members_user      ON public.team_members (user_id);
CREATE INDEX idx_event_teams_team       ON public.event_teams (team_id);
-- The scores UNIQUE constraint on (event_id, competitor_id,
-- round_number, judge_id) creates a btree that is already
-- prefix-usable for event_id-only filters, so a standalone
-- single-column scores(event_id) index would be redundant. The
-- additional composite below covers the standings rebuild path
-- which groups by (event_id, round_number).
CREATE INDEX idx_scores_event_round     ON public.scores (event_id, round_number);
CREATE INDEX idx_scores_competitor      ON public.scores (competitor_id);
-- Migration 062: judge analytics + public judges directory filter
-- scores by judge_id alone; none of the indexes above lead with
-- it, so those rollups sequential-scanned the whole table.
CREATE INDEX idx_scores_judge           ON public.scores (judge_id);
CREATE INDEX idx_score_audit_event_round   ON public.score_audit_log (event_id, round_number);
CREATE INDEX idx_score_audit_event_created ON public.score_audit_log (event_id, created_at DESC);
CREATE INDEX idx_score_audit_competitor    ON public.score_audit_log (competitor_id);
CREATE INDEX idx_score_audit_judge         ON public.score_audit_log (judge_id);
CREATE INDEX idx_score_audit_actor         ON public.score_audit_log (actor_user_id, created_at DESC);
-- Migration 043: dive-off + group_number indexes
CREATE INDEX idx_tiebreak_event             ON public.tiebreak_dive_offs (event_id);
CREATE INDEX idx_cdl_event_group            ON public.competitor_dive_lists (event_id, group_number)
  WHERE group_number IS NOT NULL;
CREATE INDEX idx_role_audit_user           ON public.role_audit_log (user_id, created_at DESC);
CREATE INDEX idx_role_audit_org            ON public.role_audit_log (org_id, created_at DESC);
CREATE INDEX idx_role_audit_actor          ON public.role_audit_log (actor_id);
CREATE INDEX idx_score_audit_created_at    ON public.score_audit_log (created_at);
CREATE INDEX idx_role_audit_created_at     ON public.role_audit_log  (created_at);
CREATE INDEX idx_audit_log_org_created     ON public.audit_log (org_id, created_at DESC);
CREATE INDEX idx_audit_log_entity          ON public.audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_log_actor           ON public.audit_log (actor_id, created_at DESC);
CREATE INDEX idx_coach_diver_coach         ON public.coach_diver_links (coach_id);
CREATE INDEX idx_coach_diver_diver         ON public.coach_diver_links (diver_id);
CREATE INDEX idx_coach_diver_org           ON public.coach_diver_links (org_id);
CREATE INDEX idx_meets_org                 ON public.meets (org_id);
CREATE INDEX idx_meets_dates               ON public.meets (start_date DESC NULLS LAST);
CREATE INDEX idx_events_meet               ON public.events (meet_id);
CREATE INDEX idx_dive_list_templates_user  ON public.dive_list_templates (user_id);
CREATE INDEX idx_event_templates_org       ON public.event_templates (org_id);
CREATE INDEX idx_events_scheduled_at       ON public.events (scheduled_at);
-- Partial: only events that have a deadline set are interesting;
-- NULLs short-circuit the predicate before the index is consulted.
CREATE INDEX idx_events_entries_close_at   ON public.events (entries_close_at)
    WHERE entries_close_at IS NOT NULL;
CREATE UNIQUE INDEX idx_users_public_slug   ON public.users (public_slug);
CREATE INDEX idx_events_parent_event       ON public.events (parent_event_id);
CREATE INDEX idx_dive_lists_event_round_order
    ON public.competitor_dive_lists (event_id, round_number, display_order)
    WHERE withdrawn_at IS NULL;
CREATE INDEX idx_event_attendance_event    ON public.event_attendance (event_id);
CREATE INDEX idx_records_personal_user             ON public.records_personal (user_id);
CREATE INDEX idx_records_club_club                 ON public.records_club (club_id);
CREATE INDEX idx_records_club_holder               ON public.records_club (holder_id);
CREATE INDEX idx_records_federation_org            ON public.records_federation (org_id);
CREATE INDEX idx_records_federation_holder         ON public.records_federation (holder_id);
CREATE INDEX idx_records_continental_lookup        ON public.records_continental (continent, height, dive_code, position);
CREATE INDEX idx_organisations_continent           ON public.organisations (continent);
CREATE INDEX idx_records_personal_history_user     ON public.records_personal_history (user_id);
CREATE INDEX idx_records_club_history_club         ON public.records_club_history (club_id);
CREATE INDEX idx_records_federation_history_org    ON public.records_federation_history (org_id);


-- =============================================================
-- WEB PUSH BACKEND (Migration 029)
-- Reusable across every push-driven feature: referee sign-off,
-- judge calls, "you're up next" nudges, role-request approvals,
-- score corrections, etc. Keyed on a free-form category string
-- so a new caller adds rows without a schema change.
-- =============================================================

CREATE TABLE public.push_subscriptions (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    endpoint     text NOT NULL,
    p256dh_key   text NOT NULL,
    auth_key     text NOT NULL,
    user_agent   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz,
    CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);
CREATE INDEX idx_push_subscriptions_user_active
    ON public.push_subscriptions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE public.notifications (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    category        varchar(40) NOT NULL,
    title           varchar(160) NOT NULL,
    body            text,
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    action_url      text,
    status          varchar(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN
                        ('pending','sent','acknowledged','failed','expired')),
    failure_reason  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    acknowledged_at timestamptz,
    expires_at      timestamptz
);
CREATE INDEX idx_notifications_user_status
    ON public.notifications (user_id, status, created_at DESC);
CREATE INDEX idx_notifications_pending_expiry
    ON public.notifications (status, expires_at)
    WHERE status IN ('pending','sent');


-- =============================================================
-- REFEREE SIGN-OFF REQUESTS (Migration 030, Cut 2)
-- Round-trip log for the meet manager → referee push request.
-- Lets the SPA show "Waiting for Sarah Chen…", lets a refresh
-- resume the right state, and gives the credential-fallback path
-- a place to short-circuit to approved while leaving the prior
-- push request as 'expired'.
-- =============================================================

CREATE TABLE public.referee_signoff_requests (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id          uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    requested_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    target_referee_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    notification_id   uuid REFERENCES public.notifications(id) ON DELETE SET NULL,
    status            varchar(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','declined','expired')),
    decision_method   varchar(16)
                        CHECK (decision_method IN ('push','credential','code')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    responded_at      timestamptz,
    expires_at        timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
    -- Cut 3 handoff: a 6-digit code the manager generates on
    -- their screen and the referee types into a sign-off-codes
    -- page on their own already-signed-in device. NULL on
    -- requests created via the push or credential path.
    handoff_code      varchar(8)
);
CREATE INDEX idx_signoff_requests_event_pending
    ON public.referee_signoff_requests (event_id) WHERE status = 'pending';
CREATE INDEX idx_signoff_requests_referee_pending
    ON public.referee_signoff_requests (target_referee_id) WHERE status = 'pending';
-- Only one PENDING code at a time per referee, stops two
-- parallel "generate code" clicks from racing each other.
CREATE UNIQUE INDEX idx_signoff_pending_code
    ON public.referee_signoff_requests (target_referee_id, handoff_code)
    WHERE status = 'pending' AND handoff_code IS NOT NULL;


-- =============================================================
-- SESSION SCHEDULER (Migration 049, Phase 1)
--
-- A session is one day-on-one-pool timeline owned by a meet; a
-- session is composed of schedule_blocks (warmups, event starts,
-- breaks, ceremonies, customs). Phase 1 is read-only, blocks
-- are auto-seeded server-side from events.scheduled_at on first
-- GET (45-min warmup window before each event, event_duration
-- estimated from total_rounds × competitors × 90s, fallback
-- 90 min). See routes/sessions.js and docs/session-scheduler.md.
--
-- The schedule_block_shifts and dismissed_conflicts ledgers
-- below land now even though no Phase-1 code writes to them yet,
-- they just avoid a second schema bump for phase 2 (conflicts)
-- and phase 4 (live re-flow).
-- =============================================================

CREATE TABLE public.sessions (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    meet_id         uuid NOT NULL REFERENCES public.meets(id) ON DELETE CASCADE,
    name            varchar(120) NOT NULL,         -- "Saturday morning, 3m"
    session_date    date NOT NULL,                 -- the day this session covers
    pool            varchar(80),                   -- "Main pool", free text for v1
    -- Optional referee for the whole session. Per-block
    -- assignments can override but most sessions inherit one.
    referee_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_meet_date
    ON public.sessions (meet_id, session_date);

CREATE TYPE schedule_block_type AS ENUM (
    'warmup',       -- pool open for athletes, no scoring
    'event_start',  -- a competition event runs here
    'break',        -- pool closed, scoreboard idle
    'ceremony',     -- medals / opening / closing
    'custom'        -- free-form for whatever the operator needs
);

CREATE TABLE public.schedule_blocks (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id      uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    block_type      schedule_block_type NOT NULL,
    label           varchar(160),                  -- "Warmup: Men's 3m"
    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,
    CONSTRAINT block_window_valid CHECK (ends_at > starts_at),
    -- Array because a warmup can claim multiple boards at once.
    -- Empty = doesn't claim a board (ceremony, announcements).
    -- Postgres can't FK an array, heads up: the API is what
    -- actually validates membership here, not the schema.
    board_ids       uuid[] NOT NULL DEFAULT '{}',
    -- For event_start blocks: the event running in the slot.
    -- NULL for non-event blocks. SET NULL on delete so removing
    -- an event leaves an orphaned-but-visible schedule row the
    -- operator can clean up.
    event_id        uuid REFERENCES public.events(id) ON DELETE SET NULL,
    -- Phase-4 live re-flow. starts_at / ends_at stay as the
    -- planned window; actual_* track what really happened.
    actual_start_at timestamptz,
    actual_end_at   timestamptz,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_schedule_blocks_session
    ON public.schedule_blocks (session_id, starts_at);
CREATE INDEX idx_schedule_blocks_event
    ON public.schedule_blocks (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_events_board
    ON public.events (board_id) WHERE board_id IS NOT NULL;

-- Audit-only, never read by the running app. Lets us debrief
-- "why did Sunday afternoon collapse" after a meet.
CREATE TABLE public.schedule_block_shifts (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    block_id      uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
    shifted_at    timestamptz NOT NULL DEFAULT now(),
    shifted_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    old_starts_at timestamptz NOT NULL,
    new_starts_at timestamptz NOT NULL,
    reason        text                              -- "Event 3 ran 20m long"
);

-- Per-conflict dismissals (phase 2). Sorted (a,b) so the pair
-- has one canonical row. resource_fingerprint is a hash of the
-- resource members at dismissal time so the conflict resurfaces
-- when membership shifts.
CREATE TABLE public.dismissed_conflicts (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    meet_id      uuid NOT NULL REFERENCES public.meets(id) ON DELETE CASCADE,
    block_a_id   uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
    block_b_id   uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
    CONSTRAINT block_pair_sorted CHECK (block_a_id < block_b_id),
    resource_kind text NOT NULL
        CHECK (resource_kind IN ('judge','board','diver','referee')),
    resource_fingerprint text NOT NULL,
    dismissed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    dismissed_at timestamptz NOT NULL DEFAULT now(),
    reason       text,
    UNIQUE (block_a_id, block_b_id, resource_kind)
);


-- =============================================================
-- PENDING PARTNER PAIRINGS (migration 051), synchro consent.
-- A synchro submit creates a pending row when no reciprocal
-- invite exists. The partner can then accept (auto-finalises
-- both competitor_dive_lists rows) or decline. See the
-- migration file for the full flow.
-- =============================================================

CREATE TABLE public.pending_partner_pairings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    requester_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    partner_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    dives         jsonb NOT NULL DEFAULT '[]'::jsonb,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    responded_at  timestamptz,
    UNIQUE (event_id, requester_id, partner_id),
    CHECK (requester_id <> partner_id)
);

CREATE INDEX idx_pending_pairings_partner
    ON public.pending_partner_pairings (partner_id, status)
    WHERE status = 'pending';


-- =============================================================
-- SCHEMA VERSION STAMP
-- Single-row table the server reads on boot to log which schema
-- version is deployed. init.sql is pinned to bootstrap baseline
-- version 53, so after loading it into a fresh database, run
-- migrations/054* through the latest numbered migration in order
-- to reach HEAD. Don't bump this stamp unless the later migrations
-- have also been ported into this file.
-- =============================================================

CREATE TABLE public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);

INSERT INTO public.schema_meta (id, version) VALUES (1, 53);


-- =============================================================
-- AUDIT-LOG RETENTION
-- Audit tables are append-only, so they'll grow forever otherwise.
-- This function deletes entries older than the given window
-- (default 30 days). Wire it into a cron, rely on the server's
-- boot-time cleanup, or just run it ad-hoc from psql.
-- =============================================================

CREATE OR REPLACE FUNCTION public.purge_audit_logs(
    retention_days integer DEFAULT 30
) RETURNS TABLE (table_name text, deleted_rows bigint) LANGUAGE plpgsql AS $$
DECLARE
    cutoff timestamptz;
    n_score bigint;
    n_role  bigint;
    n_audit bigint;
BEGIN
    cutoff := now() - make_interval(days => retention_days);

    DELETE FROM public.score_audit_log WHERE created_at < cutoff;
    GET DIAGNOSTICS n_score = ROW_COUNT;

    DELETE FROM public.role_audit_log  WHERE created_at < cutoff;
    GET DIAGNOSTICS n_role = ROW_COUNT;

    DELETE FROM public.audit_log       WHERE created_at < cutoff;
    GET DIAGNOSTICS n_audit = ROW_COUNT;

    RETURN QUERY
        SELECT 'score_audit_log'::text, n_score
        UNION ALL
        SELECT 'role_audit_log'::text,  n_role
        UNION ALL
        SELECT 'audit_log'::text,       n_audit;
END
$$;


-- =============================================================
-- DIVE DIRECTORY DATA
-- World Aquatics / World Aquatics DD tables (valid from 2017,
-- double-checked against the 2024 publication).
-- Heights:    1m, 3m (springboard) | 5m, 7.5m, 10m (platform)
-- Positions:  A = Straight, B = Pike, C = Tuck, D = Free
-- Only rows with a valid DD get inserted here (dashes mean impossible).
-- =============================================================


-- -----------------------------------------------------------------------------
-- FORWARD GROUP (1xx)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 1.0, 'A', 1.4, 'Forward Dive'),
('101', 1.0, 'B', 1.3, 'Forward Dive'),
('101', 1.0, 'C', 1.2, 'Forward Dive'),
('102', 1.0, 'A', 1.6, 'Forward 1 Somersault'),
('102', 1.0, 'B', 1.5, 'Forward 1 Somersault'),
('102', 1.0, 'C', 1.4, 'Forward 1 Somersault'),
('103', 1.0, 'A', 2.0, 'Forward 1½ Somersaults'),
('103', 1.0, 'B', 1.7, 'Forward 1½ Somersaults'),
('103', 1.0, 'C', 1.6, 'Forward 1½ Somersaults'),
('104', 1.0, 'A', 2.6, 'Forward 2 Somersaults'),
('104', 1.0, 'B', 2.3, 'Forward 2 Somersaults'),
('104', 1.0, 'C', 2.2, 'Forward 2 Somersaults'),
('105', 1.0, 'B', 2.6, 'Forward 2½ Somersaults'),
('105', 1.0, 'C', 2.4, 'Forward 2½ Somersaults'),
('106', 1.0, 'B', 3.2, 'Forward 3 Somersaults'),
('106', 1.0, 'C', 2.9, 'Forward 3 Somersaults'),
('107', 1.0, 'B', 3.3, 'Forward 3½ Somersaults'),
('107', 1.0, 'C', 3.0, 'Forward 3½ Somersaults'),
('108', 1.0, 'C', 4.0, 'Forward 4 Somersaults'),
('109', 1.0, 'C', 4.3, 'Forward 4½ Somersaults'),
('112', 1.0, 'B', 1.7, 'Forward Flying Somersault'),
('112', 1.0, 'C', 1.6, 'Forward Flying Somersault'),
('113', 1.0, 'B', 1.9, 'Forward Flying 1½ Somersaults'),
('113', 1.0, 'C', 1.8, 'Forward Flying 1½ Somersaults');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 3.0, 'A', 1.6, 'Forward Dive'),
('101', 3.0, 'B', 1.5, 'Forward Dive'),
('101', 3.0, 'C', 1.4, 'Forward Dive'),
('102', 3.0, 'A', 1.7, 'Forward 1 Somersault'),
('102', 3.0, 'B', 1.6, 'Forward 1 Somersault'),
('102', 3.0, 'C', 1.5, 'Forward 1 Somersault'),
('103', 3.0, 'A', 1.9, 'Forward 1½ Somersaults'),
('103', 3.0, 'B', 1.6, 'Forward 1½ Somersaults'),
('103', 3.0, 'C', 1.5, 'Forward 1½ Somersaults'),
('104', 3.0, 'A', 2.4, 'Forward 2 Somersaults'),
('104', 3.0, 'B', 2.1, 'Forward 2 Somersaults'),
('104', 3.0, 'C', 2.0, 'Forward 2 Somersaults'),
('105', 3.0, 'A', 2.8, 'Forward 2½ Somersaults'),
('105', 3.0, 'B', 2.4, 'Forward 2½ Somersaults'),
('105', 3.0, 'C', 2.2, 'Forward 2½ Somersaults'),
('106', 3.0, 'B', 2.8, 'Forward 3 Somersaults'),
('106', 3.0, 'C', 2.5, 'Forward 3 Somersaults'),
('107', 3.0, 'B', 3.1, 'Forward 3½ Somersaults'),
('107', 3.0, 'C', 2.8, 'Forward 3½ Somersaults'),
('108', 3.0, 'B', 3.8, 'Forward 4 Somersaults'),
('108', 3.0, 'C', 3.4, 'Forward 4 Somersaults'),
('109', 3.0, 'B', 4.2, 'Forward 4½ Somersaults'),
('109', 3.0, 'C', 3.8, 'Forward 4½ Somersaults'),
('112', 3.0, 'B', 1.8, 'Forward Flying Somersault'),
('112', 3.0, 'C', 1.7, 'Forward Flying Somersault'),
('113', 3.0, 'B', 1.8, 'Forward Flying 1½ Somersaults'),
('113', 3.0, 'C', 1.7, 'Forward Flying 1½ Somersaults'),
('115', 3.0, 'B', 2.7, 'Forward Flying 2½ Somersaults'),
('115', 3.0, 'C', 2.5, 'Forward Flying 2½ Somersaults');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 5.0, 'A', 1.4, 'Forward Dive'),
('101', 5.0, 'B', 1.3, 'Forward Dive'),
('101', 5.0, 'C', 1.2, 'Forward Dive'),
('102', 5.0, 'A', 1.6, 'Forward 1 Somersault'),
('102', 5.0, 'B', 1.5, 'Forward 1 Somersault'),
('102', 5.0, 'C', 1.4, 'Forward 1 Somersault'),
('103', 5.0, 'A', 2.0, 'Forward 1½ Somersaults'),
('103', 5.0, 'B', 1.7, 'Forward 1½ Somersaults'),
('103', 5.0, 'C', 1.6, 'Forward 1½ Somersaults'),
('104', 5.0, 'A', 2.6, 'Forward 2 Somersaults'),
('104', 5.0, 'B', 2.3, 'Forward 2 Somersaults'),
('104', 5.0, 'C', 2.2, 'Forward 2 Somersaults'),
('105', 5.0, 'B', 2.6, 'Forward 2½ Somersaults'),
('105', 5.0, 'C', 2.4, 'Forward 2½ Somersaults'),
('106', 5.0, 'B', 3.2, 'Forward 3 Somersaults'),
('106', 5.0, 'C', 2.9, 'Forward 3 Somersaults'),
('107', 5.0, 'B', 3.0, 'Forward 3½ Somersaults'),
('112', 5.0, 'B', 1.7, 'Forward Flying Somersault'),
('112', 5.0, 'C', 1.6, 'Forward Flying Somersault'),
('113', 5.0, 'B', 1.9, 'Forward Flying 1½ Somersaults'),
('113', 5.0, 'C', 1.8, 'Forward Flying 1½ Somersaults'),
('114', 5.0, 'B', 2.5, 'Forward Flying 2 Somersaults'),
('114', 5.0, 'C', 2.4, 'Forward Flying 2 Somersaults');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 7.5, 'A', 1.6, 'Forward Dive'),
('101', 7.5, 'B', 1.5, 'Forward Dive'),
('101', 7.5, 'C', 1.4, 'Forward Dive'),
('102', 7.5, 'A', 1.7, 'Forward 1 Somersault'),
('102', 7.5, 'B', 1.6, 'Forward 1 Somersault'),
('102', 7.5, 'C', 1.5, 'Forward 1 Somersault'),
('103', 7.5, 'A', 1.9, 'Forward 1½ Somersaults'),
('103', 7.5, 'B', 1.6, 'Forward 1½ Somersaults'),
('103', 7.5, 'C', 1.5, 'Forward 1½ Somersaults'),
('104', 7.5, 'A', 2.4, 'Forward 2 Somersaults'),
('104', 7.5, 'B', 2.1, 'Forward 2 Somersaults'),
('104', 7.5, 'C', 2.0, 'Forward 2 Somersaults'),
('105', 7.5, 'B', 2.4, 'Forward 2½ Somersaults'),
('105', 7.5, 'C', 2.2, 'Forward 2½ Somersaults'),
('106', 7.5, 'B', 2.8, 'Forward 3 Somersaults'),
('106', 7.5, 'C', 2.5, 'Forward 3 Somersaults'),
('107', 7.5, 'B', 3.1, 'Forward 3½ Somersaults'),
('107', 7.5, 'C', 2.8, 'Forward 3½ Somersaults'),
('112', 7.5, 'B', 1.8, 'Forward Flying Somersault'),
('112', 7.5, 'C', 1.7, 'Forward Flying Somersault'),
('113', 7.5, 'B', 1.8, 'Forward Flying 1½ Somersaults'),
('113', 7.5, 'C', 1.7, 'Forward Flying 1½ Somersaults'),
('114', 7.5, 'B', 2.3, 'Forward Flying 2 Somersaults'),
('114', 7.5, 'C', 2.2, 'Forward Flying 2 Somersaults'),
('115', 7.5, 'B', 2.5, 'Forward Flying 2½ Somersaults');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 10.0, 'A', 1.6, 'Forward Dive'),
('101', 10.0, 'B', 1.5, 'Forward Dive'),
('101', 10.0, 'C', 1.4, 'Forward Dive'),
('102', 10.0, 'A', 1.8, 'Forward 1 Somersault'),
('102', 10.0, 'B', 1.7, 'Forward 1 Somersault'),
('102', 10.0, 'C', 1.6, 'Forward 1 Somersault'),
('103', 10.0, 'A', 1.9, 'Forward 1½ Somersaults'),
('103', 10.0, 'B', 1.6, 'Forward 1½ Somersaults'),
('103', 10.0, 'C', 1.5, 'Forward 1½ Somersaults'),
('104', 10.0, 'A', 2.5, 'Forward 2 Somersaults'),
('104', 10.0, 'B', 2.2, 'Forward 2 Somersaults'),
('104', 10.0, 'C', 2.1, 'Forward 2 Somersaults'),
('105', 10.0, 'A', 2.7, 'Forward 2½ Somersaults'),
('105', 10.0, 'B', 2.3, 'Forward 2½ Somersaults'),
('105', 10.0, 'C', 2.1, 'Forward 2½ Somersaults'),
('106', 10.0, 'B', 3.0, 'Forward 3 Somersaults'),
('106', 10.0, 'C', 2.7, 'Forward 3 Somersaults'),
('107', 10.0, 'B', 3.0, 'Forward 3½ Somersaults'),
('107', 10.0, 'C', 2.7, 'Forward 3½ Somersaults'),
('108', 10.0, 'B', 4.1, 'Forward 4 Somersaults'),
('108', 10.0, 'C', 3.7, 'Forward 4 Somersaults'),
('109', 10.0, 'B', 4.1, 'Forward 4½ Somersaults'),
('109', 10.0, 'C', 3.7, 'Forward 4½ Somersaults'),
('1011',10.0, 'B', 4.7, 'Forward 5½ Somersaults'),
('112', 10.0, 'B', 1.9, 'Forward Flying Somersault'),
('112', 10.0, 'C', 1.8, 'Forward Flying Somersault'),
('113', 10.0, 'B', 1.8, 'Forward Flying 1½ Somersaults'),
('113', 10.0, 'C', 1.7, 'Forward Flying 1½ Somersaults'),
('114', 10.0, 'B', 2.4, 'Forward Flying 2 Somersaults'),
('114', 10.0, 'C', 2.3, 'Forward Flying 2 Somersaults'),
('115', 10.0, 'B', 2.6, 'Forward Flying 2½ Somersaults'),
('115', 10.0, 'C', 2.4, 'Forward Flying 2½ Somersaults');

-- -----------------------------------------------------------------------------
-- BACK GROUP (2xx)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 1.0, 'A', 1.7, 'Back Dive'),
('201', 1.0, 'B', 1.6, 'Back Dive'),
('201', 1.0, 'C', 1.5, 'Back Dive'),
('202', 1.0, 'A', 1.7, 'Back 1 Somersault'),
('202', 1.0, 'B', 1.6, 'Back 1 Somersault'),
('202', 1.0, 'C', 1.5, 'Back 1 Somersault'),
('203', 1.0, 'A', 2.5, 'Back 1½ Somersaults'),
('203', 1.0, 'B', 2.3, 'Back 1½ Somersaults'),
('203', 1.0, 'C', 2.0, 'Back 1½ Somersaults'),
('204', 1.0, 'B', 2.5, 'Back 2 Somersaults'),
('204', 1.0, 'C', 2.2, 'Back 2 Somersaults'),
('205', 1.0, 'B', 3.2, 'Back 2½ Somersaults'),
('205', 1.0, 'C', 3.0, 'Back 2½ Somersaults'),
('206', 1.0, 'B', 3.2, 'Back 3 Somersaults'),
('206', 1.0, 'C', 2.9, 'Back 3 Somersaults'),
('212', 1.0, 'B', 1.7, 'Back Flying Somersault'),
('212', 1.0, 'C', 1.6, 'Back Flying Somersault');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 3.0, 'A', 1.9, 'Back Dive'),
('201', 3.0, 'B', 1.8, 'Back Dive'),
('201', 3.0, 'C', 1.7, 'Back Dive'),
('202', 3.0, 'A', 1.8, 'Back 1 Somersault'),
('202', 3.0, 'B', 1.7, 'Back 1 Somersault'),
('202', 3.0, 'C', 1.6, 'Back 1 Somersault'),
('203', 3.0, 'A', 2.4, 'Back 1½ Somersaults'),
('203', 3.0, 'B', 2.2, 'Back 1½ Somersaults'),
('203', 3.0, 'C', 1.9, 'Back 1½ Somersaults'),
('204', 3.0, 'A', 2.5, 'Back 2 Somersaults'),
('204', 3.0, 'B', 2.3, 'Back 2 Somersaults'),
('204', 3.0, 'C', 2.0, 'Back 2 Somersaults'),
('205', 3.0, 'B', 3.0, 'Back 2½ Somersaults'),
('205', 3.0, 'C', 2.8, 'Back 2½ Somersaults'),
('206', 3.0, 'B', 2.8, 'Back 3 Somersaults'),
('206', 3.0, 'C', 2.5, 'Back 3 Somersaults'),
('207', 3.0, 'B', 3.9, 'Back 3½ Somersaults'),
('207', 3.0, 'C', 3.6, 'Back 3½ Somersaults'),
('208', 3.0, 'B', 3.7, 'Back 4 Somersaults'),
('208', 3.0, 'C', 3.4, 'Back 4 Somersaults'),
('209', 3.0, 'B', 4.8, 'Back 4½ Somersaults'),
('209', 3.0, 'C', 4.5, 'Back 4½ Somersaults'),
('212', 3.0, 'B', 1.8, 'Back Flying Somersault'),
('212', 3.0, 'C', 1.7, 'Back Flying Somersault'),
('213', 3.0, 'B', 2.4, 'Back Flying 1½ Somersaults'),
('213', 3.0, 'C', 2.1, 'Back Flying 1½ Somersaults'),
('215', 3.0, 'B', 3.3, 'Back Flying 2½ Somersaults'),
('215', 3.0, 'C', 3.1, 'Back Flying 2½ Somersaults');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 5.0, 'A', 1.7, 'Back Dive'),
('201', 5.0, 'B', 1.6, 'Back Dive'),
('201', 5.0, 'C', 1.5, 'Back Dive'),
('202', 5.0, 'A', 1.7, 'Back 1 Somersault'),
('202', 5.0, 'B', 1.6, 'Back 1 Somersault'),
('202', 5.0, 'C', 1.5, 'Back 1 Somersault'),
('203', 5.0, 'A', 2.5, 'Back 1½ Somersaults'),
('203', 5.0, 'B', 2.3, 'Back 1½ Somersaults'),
('203', 5.0, 'C', 2.0, 'Back 1½ Somersaults'),
('204', 5.0, 'B', 2.5, 'Back 2 Somersaults'),
('204', 5.0, 'C', 2.2, 'Back 2 Somersaults'),
('205', 5.0, 'A', 3.2, 'Back 2½ Somersaults'),
('205', 5.0, 'B', 3.0, 'Back 2½ Somersaults'),
('206', 5.0, 'B', 3.2, 'Back 3 Somersaults'),
('206', 5.0, 'C', 2.9, 'Back 3 Somersaults'),
('207', 5.0, 'B', 3.6, 'Back 3½ Somersaults'),
('207', 5.0, 'C', 3.3, 'Back 3½ Somersaults'),
('208', 5.0, 'B', 4.4, 'Back 4 Somersaults'),
('208', 5.0, 'C', 4.1, 'Back 4 Somersaults'),
('212', 5.0, 'B', 1.7, 'Back Flying Somersault'),
('212', 5.0, 'C', 1.6, 'Back Flying Somersault'),
('213', 5.0, 'B', 2.5, 'Back Flying 1½ Somersaults'),
('213', 5.0, 'C', 2.2, 'Back Flying 1½ Somersaults');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 7.5, 'A', 1.9, 'Back Dive'),
('201', 7.5, 'B', 1.8, 'Back Dive'),
('201', 7.5, 'C', 1.7, 'Back Dive'),
('202', 7.5, 'A', 1.8, 'Back 1 Somersault'),
('202', 7.5, 'B', 1.7, 'Back 1 Somersault'),
('202', 7.5, 'C', 1.6, 'Back 1 Somersault'),
('203', 7.5, 'A', 2.4, 'Back 1½ Somersaults'),
('203', 7.5, 'B', 2.2, 'Back 1½ Somersaults'),
('203', 7.5, 'C', 1.9, 'Back 1½ Somersaults'),
('204', 7.5, 'A', 2.5, 'Back 2 Somersaults'),
('204', 7.5, 'B', 2.3, 'Back 2 Somersaults'),
('204', 7.5, 'C', 2.0, 'Back 2 Somersaults'),
('205', 7.5, 'A', 3.0, 'Back 2½ Somersaults'),
('205', 7.5, 'B', 2.8, 'Back 2½ Somersaults'),
('206', 7.5, 'B', 2.8, 'Back 3 Somersaults'),
('206', 7.5, 'C', 2.5, 'Back 3 Somersaults'),
('207', 7.5, 'B', 3.5, 'Back 3½ Somersaults'),
('208', 7.5, 'B', 4.2, 'Back 4 Somersaults'),
('208', 7.5, 'C', 3.9, 'Back 4 Somersaults'),
('212', 7.5, 'B', 1.8, 'Back Flying Somersault'),
('212', 7.5, 'C', 1.7, 'Back Flying Somersault'),
('213', 7.5, 'B', 2.4, 'Back Flying 1½ Somersaults'),
('213', 7.5, 'C', 2.1, 'Back Flying 1½ Somersaults');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 10.0, 'A', 1.9, 'Back Dive'),
('201', 10.0, 'B', 1.8, 'Back Dive'),
('201', 10.0, 'C', 1.7, 'Back Dive'),
('202', 10.0, 'A', 1.9, 'Back 1 Somersault'),
('202', 10.0, 'B', 1.8, 'Back 1 Somersault'),
('202', 10.0, 'C', 1.7, 'Back 1 Somersault'),
('203', 10.0, 'A', 2.4, 'Back 1½ Somersaults'),
('203', 10.0, 'B', 2.2, 'Back 1½ Somersaults'),
('203', 10.0, 'C', 1.9, 'Back 1½ Somersaults'),
('204', 10.0, 'A', 2.6, 'Back 2 Somersaults'),
('204', 10.0, 'B', 2.4, 'Back 2 Somersaults'),
('204', 10.0, 'C', 2.1, 'Back 2 Somersaults'),
('205', 10.0, 'A', 3.3, 'Back 2½ Somersaults'),
('205', 10.0, 'B', 2.9, 'Back 2½ Somersaults'),
('205', 10.0, 'C', 2.7, 'Back 2½ Somersaults'),
('206', 10.0, 'B', 3.0, 'Back 3 Somersaults'),
('206', 10.0, 'C', 2.7, 'Back 3 Somersaults'),
('207', 10.0, 'B', 3.6, 'Back 3½ Somersaults'),
('207', 10.0, 'C', 3.3, 'Back 3½ Somersaults'),
('208', 10.0, 'B', 4.1, 'Back 4 Somersaults'),
('208', 10.0, 'C', 3.8, 'Back 4 Somersaults'),
('209', 10.0, 'B', 4.5, 'Back 4½ Somersaults'),
('209', 10.0, 'C', 4.2, 'Back 4½ Somersaults'),
('212', 10.0, 'B', 1.9, 'Back Flying Somersault'),
('212', 10.0, 'C', 1.8, 'Back Flying Somersault'),
('213', 10.0, 'B', 2.4, 'Back Flying 1½ Somersaults'),
('213', 10.0, 'C', 2.1, 'Back Flying 1½ Somersaults'),
('215', 10.0, 'B', 3.2, 'Back Flying 2½ Somersaults'),
('215', 10.0, 'C', 3.0, 'Back Flying 2½ Somersaults');

-- -----------------------------------------------------------------------------
-- REVERSE GROUP (3xx)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 1.0, 'A', 1.8, 'Reverse Dive'),
('301', 1.0, 'B', 1.7, 'Reverse Dive'),
('301', 1.0, 'C', 1.6, 'Reverse Dive'),
('302', 1.0, 'A', 1.8, 'Reverse 1 Somersault'),
('302', 1.0, 'B', 1.7, 'Reverse 1 Somersault'),
('302', 1.0, 'C', 1.6, 'Reverse 1 Somersault'),
('303', 1.0, 'A', 2.7, 'Reverse 1½ Somersaults'),
('303', 1.0, 'B', 2.4, 'Reverse 1½ Somersaults'),
('303', 1.0, 'C', 2.1, 'Reverse 1½ Somersaults'),
('304', 1.0, 'A', 2.9, 'Reverse 2 Somersaults'),
('304', 1.0, 'B', 2.6, 'Reverse 2 Somersaults'),
('304', 1.0, 'C', 2.3, 'Reverse 2 Somersaults'),
('305', 1.0, 'B', 3.2, 'Reverse 2½ Somersaults'),
('305', 1.0, 'C', 3.0, 'Reverse 2½ Somersaults'),
('306', 1.0, 'B', 3.3, 'Reverse 3 Somersaults'),
('306', 1.0, 'C', 3.0, 'Reverse 3 Somersaults'),
('312', 1.0, 'B', 1.8, 'Reverse Flying Somersault'),
('312', 1.0, 'C', 1.7, 'Reverse Flying Somersault'),
('313', 1.0, 'B', 2.6, 'Reverse Flying 1½ Somersaults'),
('313', 1.0, 'C', 2.3, 'Reverse Flying 1½ Somersaults');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 3.0, 'A', 2.0, 'Reverse Dive'),
('301', 3.0, 'B', 1.9, 'Reverse Dive'),
('301', 3.0, 'C', 1.8, 'Reverse Dive'),
('302', 3.0, 'A', 1.9, 'Reverse 1 Somersault'),
('302', 3.0, 'B', 1.8, 'Reverse 1 Somersault'),
('302', 3.0, 'C', 1.7, 'Reverse 1 Somersault'),
('303', 3.0, 'A', 2.6, 'Reverse 1½ Somersaults'),
('303', 3.0, 'B', 2.3, 'Reverse 1½ Somersaults'),
('303', 3.0, 'C', 2.0, 'Reverse 1½ Somersaults'),
('304', 3.0, 'A', 2.7, 'Reverse 2 Somersaults'),
('304', 3.0, 'B', 2.4, 'Reverse 2 Somersaults'),
('304', 3.0, 'C', 2.1, 'Reverse 2 Somersaults'),
('305', 3.0, 'B', 3.0, 'Reverse 2½ Somersaults'),
('305', 3.0, 'C', 2.8, 'Reverse 2½ Somersaults'),
('306', 3.0, 'B', 2.9, 'Reverse 3 Somersaults'),
('306', 3.0, 'C', 2.6, 'Reverse 3 Somersaults'),
('307', 3.0, 'B', 3.8, 'Reverse 3½ Somersaults'),
('307', 3.0, 'C', 3.5, 'Reverse 3½ Somersaults'),
('308', 3.0, 'B', 3.7, 'Reverse 4 Somersaults'),
('308', 3.0, 'C', 3.4, 'Reverse 4 Somersaults'),
('309', 3.0, 'B', 4.7, 'Reverse 4½ Somersaults'),
('309', 3.0, 'C', 4.4, 'Reverse 4½ Somersaults'),
('312', 3.0, 'B', 1.9, 'Reverse Flying Somersault'),
('312', 3.0, 'C', 1.8, 'Reverse Flying Somersault'),
('313', 3.0, 'B', 2.5, 'Reverse Flying 1½ Somersaults'),
('313', 3.0, 'C', 2.2, 'Reverse Flying 1½ Somersaults');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 5.0, 'A', 1.8, 'Reverse Dive'),
('301', 5.0, 'B', 1.7, 'Reverse Dive'),
('301', 5.0, 'C', 1.6, 'Reverse Dive'),
('302', 5.0, 'A', 1.8, 'Reverse 1 Somersault'),
('302', 5.0, 'B', 1.7, 'Reverse 1 Somersault'),
('302', 5.0, 'C', 1.6, 'Reverse 1 Somersault'),
('303', 5.0, 'A', 2.7, 'Reverse 1½ Somersaults'),
('303', 5.0, 'B', 2.4, 'Reverse 1½ Somersaults'),
('303', 5.0, 'C', 2.1, 'Reverse 1½ Somersaults'),
('304', 5.0, 'A', 2.9, 'Reverse 2 Somersaults'),
('304', 5.0, 'B', 2.6, 'Reverse 2 Somersaults'),
('304', 5.0, 'C', 2.3, 'Reverse 2 Somersaults'),
('305', 5.0, 'B', 3.3, 'Reverse 2½ Somersaults'),
('305', 5.0, 'C', 3.1, 'Reverse 2½ Somersaults'),
('306', 5.0, 'B', 3.4, 'Reverse 3 Somersaults'),
('306', 5.0, 'C', 3.1, 'Reverse 3 Somersaults'),
('312', 5.0, 'B', 1.8, 'Reverse Flying Somersault'),
('312', 5.0, 'C', 1.7, 'Reverse Flying Somersault'),
('313', 5.0, 'B', 2.6, 'Reverse Flying 1½ Somersaults'),
('313', 5.0, 'C', 2.3, 'Reverse Flying 1½ Somersaults');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 7.5, 'A', 2.0, 'Reverse Dive'),
('301', 7.5, 'B', 1.9, 'Reverse Dive'),
('301', 7.5, 'C', 1.8, 'Reverse Dive'),
('302', 7.5, 'A', 1.9, 'Reverse 1 Somersault'),
('302', 7.5, 'B', 1.8, 'Reverse 1 Somersault'),
('302', 7.5, 'C', 1.7, 'Reverse 1 Somersault'),
('303', 7.5, 'A', 2.6, 'Reverse 1½ Somersaults'),
('303', 7.5, 'B', 2.3, 'Reverse 1½ Somersaults'),
('303', 7.5, 'C', 2.0, 'Reverse 1½ Somersaults'),
('304', 7.5, 'A', 2.7, 'Reverse 2 Somersaults'),
('304', 7.5, 'B', 2.4, 'Reverse 2 Somersaults'),
('304', 7.5, 'C', 2.1, 'Reverse 2 Somersaults'),
('305', 7.5, 'B', 3.1, 'Reverse 2½ Somersaults'),
('305', 7.5, 'C', 2.9, 'Reverse 2½ Somersaults'),
('306', 7.5, 'B', 3.0, 'Reverse 3 Somersaults'),
('306', 7.5, 'C', 2.7, 'Reverse 3 Somersaults'),
('308', 7.5, 'B', 4.5, 'Reverse 4 Somersaults'),
('308', 7.5, 'C', 4.2, 'Reverse 4 Somersaults'),
('312', 7.5, 'B', 1.9, 'Reverse Flying Somersault'),
('312', 7.5, 'C', 1.8, 'Reverse Flying Somersault'),
('313', 7.5, 'B', 2.5, 'Reverse Flying 1½ Somersaults'),
('313', 7.5, 'C', 2.2, 'Reverse Flying 1½ Somersaults');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 10.0, 'A', 2.0, 'Reverse Dive'),
('301', 10.0, 'B', 1.9, 'Reverse Dive'),
('301', 10.0, 'C', 1.8, 'Reverse Dive'),
('302', 10.0, 'A', 2.0, 'Reverse 1 Somersault'),
('302', 10.0, 'B', 1.9, 'Reverse 1 Somersault'),
('302', 10.0, 'C', 1.8, 'Reverse 1 Somersault'),
('303', 10.0, 'A', 2.6, 'Reverse 1½ Somersaults'),
('303', 10.0, 'B', 2.3, 'Reverse 1½ Somersaults'),
('303', 10.0, 'C', 2.0, 'Reverse 1½ Somersaults'),
('304', 10.0, 'A', 2.8, 'Reverse 2 Somersaults'),
('304', 10.0, 'B', 2.5, 'Reverse 2 Somersaults'),
('304', 10.0, 'C', 2.2, 'Reverse 2 Somersaults'),
('305', 10.0, 'A', 3.4, 'Reverse 2½ Somersaults'),
('305', 10.0, 'B', 3.0, 'Reverse 2½ Somersaults'),
('305', 10.0, 'C', 2.8, 'Reverse 2½ Somersaults'),
('306', 10.0, 'B', 3.2, 'Reverse 3 Somersaults'),
('306', 10.0, 'C', 2.9, 'Reverse 3 Somersaults'),
('307', 10.0, 'B', 3.7, 'Reverse 3½ Somersaults'),
('307', 10.0, 'C', 3.4, 'Reverse 3½ Somersaults'),
('308', 10.0, 'B', 4.4, 'Reverse 4 Somersaults'),
('308', 10.0, 'C', 4.1, 'Reverse 4 Somersaults'),
('309', 10.0, 'B', 4.8, 'Reverse 4½ Somersaults'),
('309', 10.0, 'C', 4.5, 'Reverse 4½ Somersaults'),
('312', 10.0, 'B', 2.0, 'Reverse Flying Somersault'),
('312', 10.0, 'C', 1.9, 'Reverse Flying Somersault'),
('313', 10.0, 'B', 2.5, 'Reverse Flying 1½ Somersaults'),
('313', 10.0, 'C', 2.2, 'Reverse Flying 1½ Somersaults');

-- -----------------------------------------------------------------------------
-- INWARD GROUP (4xx)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 1.0, 'A', 1.8, 'Inward Dive'),
('401', 1.0, 'B', 1.5, 'Inward Dive'),
('401', 1.0, 'C', 1.4, 'Inward Dive'),
('402', 1.0, 'A', 2.0, 'Inward 1 Somersault'),
('402', 1.0, 'B', 1.7, 'Inward 1 Somersault'),
('402', 1.0, 'C', 1.6, 'Inward 1 Somersault'),
('403', 1.0, 'B', 2.4, 'Inward 1½ Somersaults'),
('403', 1.0, 'C', 2.2, 'Inward 1½ Somersaults'),
('404', 1.0, 'B', 3.0, 'Inward 2 Somersaults'),
('404', 1.0, 'C', 2.8, 'Inward 2 Somersaults'),
('405', 1.0, 'B', 3.4, 'Inward 2½ Somersaults'),
('405', 1.0, 'C', 3.1, 'Inward 2½ Somersaults'),
('407', 1.0, 'B', 3.7, 'Inward 3½ Somersaults'),
('407', 1.0, 'C', 3.4, 'Inward 3½ Somersaults'),
('412', 1.0, 'B', 2.1, 'Inward Flying Somersault'),
('412', 1.0, 'C', 2.0, 'Inward Flying Somersault'),
('413', 1.0, 'B', 2.9, 'Inward Flying 1½ Somersaults'),
('413', 1.0, 'C', 2.7, 'Inward Flying 1½ Somersaults');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 3.0, 'A', 1.7, 'Inward Dive'),
('401', 3.0, 'B', 1.4, 'Inward Dive'),
('401', 3.0, 'C', 1.3, 'Inward Dive'),
('402', 3.0, 'A', 1.8, 'Inward 1 Somersault'),
('402', 3.0, 'B', 1.5, 'Inward 1 Somersault'),
('402', 3.0, 'C', 1.4, 'Inward 1 Somersault'),
('403', 3.0, 'B', 2.1, 'Inward 1½ Somersaults'),
('403', 3.0, 'C', 1.9, 'Inward 1½ Somersaults'),
('404', 3.0, 'B', 2.6, 'Inward 2 Somersaults'),
('404', 3.0, 'C', 2.4, 'Inward 2 Somersaults'),
('405', 3.0, 'B', 3.0, 'Inward 2½ Somersaults'),
('405', 3.0, 'C', 2.7, 'Inward 2½ Somersaults'),
('407', 3.0, 'B', 3.7, 'Inward 3½ Somersaults'),
('407', 3.0, 'C', 3.4, 'Inward 3½ Somersaults'),
('409', 3.0, 'B', 4.6, 'Inward 4½ Somersaults'),
('409', 3.0, 'C', 4.2, 'Inward 4½ Somersaults'),
('412', 3.0, 'B', 1.9, 'Inward Flying Somersault'),
('412', 3.0, 'C', 1.8, 'Inward Flying Somersault'),
('413', 3.0, 'B', 2.6, 'Inward Flying 1½ Somersaults'),
('413', 3.0, 'C', 2.4, 'Inward Flying 1½ Somersaults');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 5.0, 'A', 1.8, 'Inward Dive'),
('401', 5.0, 'B', 1.5, 'Inward Dive'),
('401', 5.0, 'C', 1.4, 'Inward Dive'),
('402', 5.0, 'A', 2.0, 'Inward 1 Somersault'),
('402', 5.0, 'B', 1.7, 'Inward 1 Somersault'),
('402', 5.0, 'C', 1.6, 'Inward 1 Somersault'),
('403', 5.0, 'B', 2.4, 'Inward 1½ Somersaults'),
('403', 5.0, 'C', 2.2, 'Inward 1½ Somersaults'),
('404', 5.0, 'B', 3.0, 'Inward 2 Somersaults'),
('404', 5.0, 'C', 2.8, 'Inward 2 Somersaults'),
('405', 5.0, 'B', 3.4, 'Inward 2½ Somersaults'),
('405', 5.0, 'C', 3.1, 'Inward 2½ Somersaults'),
('406', 5.0, 'B', 4.0, 'Inward 3 Somersaults'),
('406', 5.0, 'C', 3.7, 'Inward 3 Somersaults'),
('412', 5.0, 'B', 2.1, 'Inward Flying Somersault'),
('412', 5.0, 'C', 2.0, 'Inward Flying Somersault'),
('413', 5.0, 'B', 2.9, 'Inward Flying 1½ Somersaults'),
('413', 5.0, 'C', 2.7, 'Inward Flying 1½ Somersaults');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 7.5, 'A', 1.7, 'Inward Dive'),
('401', 7.5, 'B', 1.4, 'Inward Dive'),
('401', 7.5, 'C', 1.3, 'Inward Dive'),
('402', 7.5, 'A', 1.8, 'Inward 1 Somersault'),
('402', 7.5, 'B', 1.5, 'Inward 1 Somersault'),
('402', 7.5, 'C', 1.4, 'Inward 1 Somersault'),
('403', 7.5, 'B', 2.1, 'Inward 1½ Somersaults'),
('403', 7.5, 'C', 1.9, 'Inward 1½ Somersaults'),
('404', 7.5, 'B', 2.6, 'Inward 2 Somersaults'),
('404', 7.5, 'C', 2.4, 'Inward 2 Somersaults'),
('405', 7.5, 'B', 3.0, 'Inward 2½ Somersaults'),
('405', 7.5, 'C', 2.7, 'Inward 2½ Somersaults'),
('406', 7.5, 'B', 3.4, 'Inward 3 Somersaults'),
('406', 7.5, 'C', 3.1, 'Inward 3 Somersaults'),
('407', 7.5, 'B', 3.4, 'Inward 3½ Somersaults'),
('412', 7.5, 'B', 1.9, 'Inward Flying Somersault'),
('412', 7.5, 'C', 1.8, 'Inward Flying Somersault'),
('413', 7.5, 'B', 2.6, 'Inward Flying 1½ Somersaults'),
('413', 7.5, 'C', 2.4, 'Inward Flying 1½ Somersaults');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 10.0, 'A', 1.7, 'Inward Dive'),
('401', 10.0, 'B', 1.4, 'Inward Dive'),
('401', 10.0, 'C', 1.3, 'Inward Dive'),
('402', 10.0, 'A', 1.9, 'Inward 1 Somersault'),
('402', 10.0, 'B', 1.6, 'Inward 1 Somersault'),
('402', 10.0, 'C', 1.5, 'Inward 1 Somersault'),
('403', 10.0, 'B', 2.0, 'Inward 1½ Somersaults'),
('403', 10.0, 'C', 1.8, 'Inward 1½ Somersaults'),
('404', 10.0, 'B', 2.6, 'Inward 2 Somersaults'),
('404', 10.0, 'C', 2.4, 'Inward 2 Somersaults'),
('405', 10.0, 'B', 2.8, 'Inward 2½ Somersaults'),
('405', 10.0, 'C', 2.5, 'Inward 2½ Somersaults'),
('406', 10.0, 'B', 3.5, 'Inward 3 Somersaults'),
('406', 10.0, 'C', 3.2, 'Inward 3 Somersaults'),
('407', 10.0, 'B', 3.5, 'Inward 3½ Somersaults'),
('407', 10.0, 'C', 3.2, 'Inward 3½ Somersaults'),
('408', 10.0, 'B', 4.4, 'Inward 4 Somersaults'),
('408', 10.0, 'C', 4.1, 'Inward 4 Somersaults'),
('409', 10.0, 'B', 4.4, 'Inward 4½ Somersaults'),
('409', 10.0, 'C', 4.1, 'Inward 4½ Somersaults'),
('412', 10.0, 'B', 2.0, 'Inward Flying Somersault'),
('412', 10.0, 'C', 1.9, 'Inward Flying Somersault'),
('413', 10.0, 'B', 2.5, 'Inward Flying 1½ Somersaults'),
('413', 10.0, 'C', 2.3, 'Inward Flying 1½ Somersaults');

-- -----------------------------------------------------------------------------
-- FORWARD TWISTING GROUP (511x / 512x / 513x / 515x / 517x)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 1.0, 'A', 1.8, 'Forward Dive ½ Twist'),
('5111', 1.0, 'B', 1.7, 'Forward Dive ½ Twist'),
('5111', 1.0, 'C', 1.6, 'Forward Dive ½ Twist'),
('5112', 1.0, 'A', 2.0, 'Forward Dive 1 Twist'),
('5112', 1.0, 'B', 1.9, 'Forward Dive 1 Twist'),
('5121', 1.0, 'D', 1.7, 'Forward Somersault ½ Twist'),
('5122', 1.0, 'D', 1.9, 'Forward Somersault 1 Twist'),
('5124', 1.0, 'D', 2.3, 'Forward Somersault 2 Twists'),
('5126', 1.0, 'D', 2.8, 'Forward Somersault 3 Twists'),
('5131', 1.0, 'D', 2.0, 'Forward 1½ Somersaults ½ Twist'),
('5132', 1.0, 'D', 2.2, 'Forward 1½ Somersaults 1 Twist'),
('5134', 1.0, 'D', 2.6, 'Forward 1½ Somersaults 2 Twists'),
('5136', 1.0, 'D', 3.1, 'Forward 1½ Somersaults 3 Twists'),
('5138', 1.0, 'D', 3.5, 'Forward 1½ Somersaults 4 Twists'),
('5151', 1.0, 'B', 3.0, 'Forward 2½ Somersaults ½ Twist'),
('5151', 1.0, 'C', 2.8, 'Forward 2½ Somersaults ½ Twist'),
('5152', 1.0, 'B', 3.2, 'Forward 2½ Somersaults 1 Twist'),
('5152', 1.0, 'C', 3.0, 'Forward 2½ Somersaults 1 Twist'),
('5154', 1.0, 'B', 3.6, 'Forward 2½ Somersaults 2 Twists'),
('5154', 1.0, 'C', 3.4, 'Forward 2½ Somersaults 2 Twists');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 3.0, 'A', 2.0, 'Forward Dive ½ Twist'),
('5111', 3.0, 'B', 1.9, 'Forward Dive ½ Twist'),
('5111', 3.0, 'C', 1.8, 'Forward Dive ½ Twist'),
('5112', 3.0, 'A', 2.2, 'Forward Dive 1 Twist'),
('5112', 3.0, 'B', 2.1, 'Forward Dive 1 Twist'),
('5121', 3.0, 'D', 1.8, 'Forward Somersault ½ Twist'),
('5122', 3.0, 'D', 2.0, 'Forward Somersault 1 Twist'),
('5124', 3.0, 'D', 2.4, 'Forward Somersault 2 Twists'),
('5126', 3.0, 'D', 2.9, 'Forward Somersault 3 Twists'),
('5131', 3.0, 'D', 1.9, 'Forward 1½ Somersaults ½ Twist'),
('5132', 3.0, 'D', 2.1, 'Forward 1½ Somersaults 1 Twist'),
('5134', 3.0, 'D', 2.5, 'Forward 1½ Somersaults 2 Twists'),
('5136', 3.0, 'D', 3.0, 'Forward 1½ Somersaults 3 Twists'),
('5138', 3.0, 'D', 3.4, 'Forward 1½ Somersaults 4 Twists'),
('5151', 3.0, 'B', 2.8, 'Forward 2½ Somersaults ½ Twist'),
('5151', 3.0, 'C', 2.6, 'Forward 2½ Somersaults ½ Twist'),
('5152', 3.0, 'B', 3.0, 'Forward 2½ Somersaults 1 Twist'),
('5152', 3.0, 'C', 2.8, 'Forward 2½ Somersaults 1 Twist'),
('5154', 3.0, 'B', 3.4, 'Forward 2½ Somersaults 2 Twists'),
('5154', 3.0, 'C', 3.2, 'Forward 2½ Somersaults 2 Twists'),
('5156', 3.0, 'B', 3.9, 'Forward 2½ Somersaults 3 Twists'),
('5156', 3.0, 'C', 3.7, 'Forward 2½ Somersaults 3 Twists'),
('5172', 3.0, 'B', 3.7, 'Forward 3½ Somersaults 1 Twist'),
('5172', 3.0, 'C', 3.4, 'Forward 3½ Somersaults 1 Twist');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 5.0, 'A', 1.8, 'Forward Dive ½ Twist'),
('5111', 5.0, 'B', 1.7, 'Forward Dive ½ Twist'),
('5111', 5.0, 'C', 1.6, 'Forward Dive ½ Twist'),
('5112', 5.0, 'A', 2.0, 'Forward Dive 1 Twist'),
('5112', 5.0, 'B', 1.9, 'Forward Dive 1 Twist'),
('5121', 5.0, 'D', 1.7, 'Forward Somersault ½ Twist'),
('5122', 5.0, 'D', 1.9, 'Forward Somersault 1 Twist'),
('5124', 5.0, 'D', 2.3, 'Forward Somersault 2 Twists'),
('5131', 5.0, 'D', 2.0, 'Forward 1½ Somersaults ½ Twist'),
('5132', 5.0, 'D', 2.2, 'Forward 1½ Somersaults 1 Twist'),
('5134', 5.0, 'D', 2.6, 'Forward 1½ Somersaults 2 Twists'),
('5136', 5.0, 'D', 3.1, 'Forward 1½ Somersaults 3 Twists'),
('5138', 5.0, 'D', 3.5, 'Forward 1½ Somersaults 4 Twists'),
('5152', 5.0, 'B', 3.2, 'Forward 2½ Somersaults 1 Twist'),
('5152', 5.0, 'C', 3.0, 'Forward 2½ Somersaults 1 Twist'),
('5154', 5.0, 'B', 3.6, 'Forward 2½ Somersaults 2 Twists'),
('5154', 5.0, 'C', 3.4, 'Forward 2½ Somersaults 2 Twists');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 7.5, 'A', 2.0, 'Forward Dive ½ Twist'),
('5111', 7.5, 'B', 1.9, 'Forward Dive ½ Twist'),
('5111', 7.5, 'C', 1.8, 'Forward Dive ½ Twist'),
('5112', 7.5, 'A', 2.2, 'Forward Dive 1 Twist'),
('5112', 7.5, 'B', 2.1, 'Forward Dive 1 Twist'),
('5121', 7.5, 'D', 1.8, 'Forward Somersault ½ Twist'),
('5122', 7.5, 'D', 2.0, 'Forward Somersault 1 Twist'),
('5124', 7.5, 'D', 2.4, 'Forward Somersault 2 Twists'),
('5131', 7.5, 'D', 1.9, 'Forward 1½ Somersaults ½ Twist'),
('5132', 7.5, 'D', 2.1, 'Forward 1½ Somersaults 1 Twist'),
('5134', 7.5, 'D', 2.5, 'Forward 1½ Somersaults 2 Twists'),
('5136', 7.5, 'D', 3.0, 'Forward 1½ Somersaults 3 Twists'),
('5138', 7.5, 'D', 3.4, 'Forward 1½ Somersaults 4 Twists'),
('5152', 7.5, 'B', 3.0, 'Forward 2½ Somersaults 1 Twist'),
('5152', 7.5, 'C', 2.8, 'Forward 2½ Somersaults 1 Twist'),
('5154', 7.5, 'B', 3.4, 'Forward 2½ Somersaults 2 Twists'),
('5154', 7.5, 'C', 3.2, 'Forward 2½ Somersaults 2 Twists'),
('5172', 7.5, 'B', 3.7, 'Forward 3½ Somersaults 1 Twist'),
('5172', 7.5, 'C', 3.4, 'Forward 3½ Somersaults 1 Twist');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 10.0, 'A', 2.0, 'Forward Dive ½ Twist'),
('5111', 10.0, 'B', 1.9, 'Forward Dive ½ Twist'),
('5111', 10.0, 'C', 1.8, 'Forward Dive ½ Twist'),
('5112', 10.0, 'A', 2.2, 'Forward Dive 1 Twist'),
('5112', 10.0, 'B', 2.1, 'Forward Dive 1 Twist'),
('5121', 10.0, 'D', 1.9, 'Forward Somersault ½ Twist'),
('5122', 10.0, 'D', 2.1, 'Forward Somersault 1 Twist'),
('5124', 10.0, 'D', 2.5, 'Forward Somersault 2 Twists'),
('5131', 10.0, 'D', 1.9, 'Forward 1½ Somersaults ½ Twist'),
('5132', 10.0, 'D', 2.1, 'Forward 1½ Somersaults 1 Twist'),
('5134', 10.0, 'D', 2.5, 'Forward 1½ Somersaults 2 Twists'),
('5136', 10.0, 'D', 3.0, 'Forward 1½ Somersaults 3 Twists'),
('5138', 10.0, 'D', 3.4, 'Forward 1½ Somersaults 4 Twists'),
('5152', 10.0, 'B', 2.9, 'Forward 2½ Somersaults 1 Twist'),
('5152', 10.0, 'C', 2.7, 'Forward 2½ Somersaults 1 Twist'),
('5154', 10.0, 'B', 3.3, 'Forward 2½ Somersaults 2 Twists'),
('5154', 10.0, 'C', 3.1, 'Forward 2½ Somersaults 2 Twists'),
('5156', 10.0, 'B', 3.8, 'Forward 2½ Somersaults 3 Twists'),
('5156', 10.0, 'C', 3.6, 'Forward 2½ Somersaults 3 Twists'),
('5172', 10.0, 'B', 3.6, 'Forward 3½ Somersaults 1 Twist'),
('5172', 10.0, 'C', 3.3, 'Forward 3½ Somersaults 1 Twist');

-- -----------------------------------------------------------------------------
-- BACK TWISTING GROUP (521x / 522x / 523x / 525x / 527x)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 1.0, 'A', 1.8, 'Back Dive ½ Twist'),
('5211', 1.0, 'B', 1.7, 'Back Dive ½ Twist'),
('5211', 1.0, 'C', 1.6, 'Back Dive ½ Twist'),
('5212', 1.0, 'A', 2.0, 'Back Dive 1 Twist'),
('5221', 1.0, 'D', 1.7, 'Back Somersault ½ Twist'),
('5222', 1.0, 'D', 1.9, 'Back Somersault 1 Twist'),
('5223', 1.0, 'D', 2.3, 'Back Somersault 1½ Twists'),
('5225', 1.0, 'D', 2.7, 'Back Somersault 2½ Twists'),
('5227', 1.0, 'D', 3.2, 'Back Somersault 3½ Twists'),
('5231', 1.0, 'D', 2.1, 'Back 1½ Somersaults ½ Twist'),
('5233', 1.0, 'D', 2.5, 'Back 1½ Somersaults 1½ Twists'),
('5235', 1.0, 'D', 2.9, 'Back 1½ Somersaults 2½ Twists'),
('5251', 1.0, 'B', 2.9, 'Back 2½ Somersaults ½ Twist'),
('5251', 1.0, 'C', 2.7, 'Back 2½ Somersaults ½ Twist');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 3.0, 'A', 2.0, 'Back Dive ½ Twist'),
('5211', 3.0, 'B', 1.9, 'Back Dive ½ Twist'),
('5211', 3.0, 'C', 1.8, 'Back Dive ½ Twist'),
('5212', 3.0, 'A', 2.2, 'Back Dive 1 Twist'),
('5221', 3.0, 'D', 1.8, 'Back Somersault ½ Twist'),
('5222', 3.0, 'D', 2.0, 'Back Somersault 1 Twist'),
('5223', 3.0, 'D', 2.4, 'Back Somersault 1½ Twists'),
('5225', 3.0, 'D', 2.8, 'Back Somersault 2½ Twists'),
('5227', 3.0, 'D', 3.3, 'Back Somersault 3½ Twists'),
('5231', 3.0, 'D', 2.0, 'Back 1½ Somersaults ½ Twist'),
('5233', 3.0, 'D', 2.4, 'Back 1½ Somersaults 1½ Twists'),
('5235', 3.0, 'D', 2.8, 'Back 1½ Somersaults 2½ Twists'),
('5237', 3.0, 'D', 3.3, 'Back 1½ Somersaults 3½ Twists'),
('5239', 3.0, 'D', 3.7, 'Back 1½ Somersaults 4½ Twists'),
('5251', 3.0, 'B', 2.7, 'Back 2½ Somersaults ½ Twist'),
('5251', 3.0, 'C', 2.5, 'Back 2½ Somersaults ½ Twist'),
('5253', 3.0, 'B', 3.4, 'Back 2½ Somersaults 1½ Twists'),
('5253', 3.0, 'C', 3.2, 'Back 2½ Somersaults 1½ Twists'),
('5255', 3.0, 'B', 3.8, 'Back 2½ Somersaults 2½ Twists'),
('5255', 3.0, 'C', 3.6, 'Back 2½ Somersaults 2½ Twists');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 5.0, 'A', 1.8, 'Back Dive ½ Twist'),
('5211', 5.0, 'B', 1.7, 'Back Dive ½ Twist'),
('5211', 5.0, 'C', 1.6, 'Back Dive ½ Twist'),
('5212', 5.0, 'A', 2.0, 'Back Dive 1 Twist'),
('5221', 5.0, 'D', 1.7, 'Back Somersault ½ Twist'),
('5222', 5.0, 'D', 1.9, 'Back Somersault 1 Twist'),
('5223', 5.0, 'D', 2.3, 'Back Somersault 1½ Twists'),
('5225', 5.0, 'D', 2.7, 'Back Somersault 2½ Twists'),
('5231', 5.0, 'D', 2.1, 'Back 1½ Somersaults ½ Twist'),
('5233', 5.0, 'D', 2.5, 'Back 1½ Somersaults 1½ Twists'),
('5235', 5.0, 'D', 2.9, 'Back 1½ Somersaults 2½ Twists'),
('5237', 5.0, 'D', 3.4, 'Back 1½ Somersaults 3½ Twists'),
('5239', 5.0, 'D', 3.8, 'Back 1½ Somersaults 4½ Twists'),
('5251', 5.0, 'B', 2.9, 'Back 2½ Somersaults ½ Twist'),
('5251', 5.0, 'C', 2.7, 'Back 2½ Somersaults ½ Twist'),
('5257', 5.0, 'B', 4.1, 'Back 2½ Somersaults 3½ Twists'),
('5257', 5.0, 'C', 3.9, 'Back 2½ Somersaults 3½ Twists'),
('5271', 5.0, 'B', 3.2, 'Back 3½ Somersaults ½ Twist'),
('5271', 5.0, 'C', 2.9, 'Back 3½ Somersaults ½ Twist'),
('5273', 5.0, 'B', 3.8, 'Back 3½ Somersaults 1½ Twists'),
('5273', 5.0, 'C', 3.5, 'Back 3½ Somersaults 1½ Twists'),
('5275', 5.0, 'B', 4.2, 'Back 3½ Somersaults 2½ Twists'),
('5275', 5.0, 'C', 3.9, 'Back 3½ Somersaults 2½ Twists');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 7.5, 'A', 2.0, 'Back Dive ½ Twist'),
('5211', 7.5, 'B', 1.9, 'Back Dive ½ Twist'),
('5211', 7.5, 'C', 1.8, 'Back Dive ½ Twist'),
('5212', 7.5, 'A', 2.2, 'Back Dive 1 Twist'),
('5221', 7.5, 'D', 1.8, 'Back Somersault ½ Twist'),
('5222', 7.5, 'D', 2.0, 'Back Somersault 1 Twist'),
('5223', 7.5, 'D', 2.4, 'Back Somersault 1½ Twists'),
('5225', 7.5, 'D', 2.8, 'Back Somersault 2½ Twists'),
('5231', 7.5, 'D', 2.0, 'Back 1½ Somersaults ½ Twist'),
('5233', 7.5, 'D', 2.4, 'Back 1½ Somersaults 1½ Twists'),
('5235', 7.5, 'D', 2.8, 'Back 1½ Somersaults 2½ Twists'),
('5237', 7.5, 'D', 3.3, 'Back 1½ Somersaults 3½ Twists'),
('5239', 7.5, 'D', 3.7, 'Back 1½ Somersaults 4½ Twists'),
('5251', 7.5, 'B', 2.7, 'Back 2½ Somersaults ½ Twist'),
('5251', 7.5, 'C', 2.5, 'Back 2½ Somersaults ½ Twist'),
('5253', 7.5, 'B', 3.3, 'Back 2½ Somersaults 1½ Twists'),
('5253', 7.5, 'C', 3.1, 'Back 2½ Somersaults 1½ Twists');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 10.0, 'A', 2.0, 'Back Dive ½ Twist'),
('5211', 10.0, 'B', 1.9, 'Back Dive ½ Twist'),
('5211', 10.0, 'C', 1.8, 'Back Dive ½ Twist'),
('5212', 10.0, 'A', 2.2, 'Back Dive 1 Twist'),
('5221', 10.0, 'D', 1.9, 'Back Somersault ½ Twist'),
('5222', 10.0, 'D', 2.1, 'Back Somersault 1 Twist'),
('5223', 10.0, 'D', 2.5, 'Back Somersault 1½ Twists'),
('5225', 10.0, 'D', 2.9, 'Back Somersault 2½ Twists'),
('5231', 10.0, 'D', 2.0, 'Back 1½ Somersaults ½ Twist'),
('5233', 10.0, 'D', 2.4, 'Back 1½ Somersaults 1½ Twists'),
('5235', 10.0, 'D', 2.8, 'Back 1½ Somersaults 2½ Twists'),
('5237', 10.0, 'D', 3.3, 'Back 1½ Somersaults 3½ Twists'),
('5239', 10.0, 'D', 3.7, 'Back 1½ Somersaults 4½ Twists'),
('5251', 10.0, 'B', 2.6, 'Back 2½ Somersaults ½ Twist'),
('5251', 10.0, 'C', 2.4, 'Back 2½ Somersaults ½ Twist'),
('5253', 10.0, 'B', 3.2, 'Back 2½ Somersaults 1½ Twists'),
('5253', 10.0, 'C', 3.0, 'Back 2½ Somersaults 1½ Twists'),
('5255', 10.0, 'B', 3.6, 'Back 2½ Somersaults 2½ Twists'),
('5255', 10.0, 'C', 3.4, 'Back 2½ Somersaults 2½ Twists'),
('5257', 10.0, 'B', 4.1, 'Back 2½ Somersaults 3½ Twists'),
('5257', 10.0, 'C', 3.9, 'Back 2½ Somersaults 3½ Twists'),
('5271', 10.0, 'B', 3.2, 'Back 3½ Somersaults ½ Twist'),
('5271', 10.0, 'C', 2.9, 'Back 3½ Somersaults ½ Twist'),
('5273', 10.0, 'B', 3.8, 'Back 3½ Somersaults 1½ Twists'),
('5273', 10.0, 'C', 3.5, 'Back 3½ Somersaults 1½ Twists'),
('5275', 10.0, 'B', 4.2, 'Back 3½ Somersaults 2½ Twists'),
('5275', 10.0, 'C', 3.9, 'Back 3½ Somersaults 2½ Twists');

-- -----------------------------------------------------------------------------
-- REVERSE TWISTING GROUP (531x / 532x / 533x / 535x / 537x)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 1.0, 'A', 1.9, 'Reverse Dive ½ Twist'),
('5311', 1.0, 'B', 1.8, 'Reverse Dive ½ Twist'),
('5311', 1.0, 'C', 1.7, 'Reverse Dive ½ Twist'),
('5312', 1.0, 'A', 2.1, 'Reverse Dive 1 Twist'),
('5321', 1.0, 'D', 1.8, 'Reverse Somersault ½ Twist'),
('5322', 1.0, 'D', 2.0, 'Reverse Somersault 1 Twist'),
('5323', 1.0, 'D', 2.4, 'Reverse Somersault 1½ Twists'),
('5325', 1.0, 'D', 2.8, 'Reverse Somersault 2½ Twists'),
('5331', 1.0, 'D', 2.2, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 1.0, 'D', 2.6, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 1.0, 'D', 3.0, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 1.0, 'D', 3.6, 'Reverse 1½ Somersaults 3½ Twists'),
('5351', 1.0, 'B', 2.9, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 1.0, 'C', 2.7, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 1.0, 'B', 3.5, 'Reverse 2½ Somersaults 1½ Twists'),
('5353', 1.0, 'C', 3.3, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 1.0, 'B', 3.9, 'Reverse 2½ Somersaults 2½ Twists'),
('5355', 1.0, 'C', 3.7, 'Reverse 2½ Somersaults 2½ Twists');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 3.0, 'A', 2.1, 'Reverse Dive ½ Twist'),
('5311', 3.0, 'B', 2.0, 'Reverse Dive ½ Twist'),
('5311', 3.0, 'C', 1.9, 'Reverse Dive ½ Twist'),
('5312', 3.0, 'A', 2.3, 'Reverse Dive 1 Twist'),
('5321', 3.0, 'D', 1.9, 'Reverse Somersault ½ Twist'),
('5322', 3.0, 'D', 2.1, 'Reverse Somersault 1 Twist'),
('5323', 3.0, 'D', 2.5, 'Reverse Somersault 1½ Twists'),
('5325', 3.0, 'D', 2.9, 'Reverse Somersault 2½ Twists'),
('5331', 3.0, 'D', 2.1, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 3.0, 'D', 2.5, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 3.0, 'D', 2.9, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 3.0, 'D', 3.5, 'Reverse 1½ Somersaults 3½ Twists'),
('5339', 3.0, 'D', 3.8, 'Reverse 1½ Somersaults 4½ Twists'),
('5351', 3.0, 'B', 2.7, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 3.0, 'C', 2.5, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 3.0, 'B', 3.3, 'Reverse 2½ Somersaults 1½ Twists'),
('5353', 3.0, 'C', 3.1, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 3.0, 'B', 3.7, 'Reverse 2½ Somersaults 2½ Twists'),
('5355', 3.0, 'C', 3.5, 'Reverse 2½ Somersaults 2½ Twists'),
('5371', 3.0, 'B', 3.4, 'Reverse 3½ Somersaults ½ Twist'),
('5371', 3.0, 'C', 3.1, 'Reverse 3½ Somersaults ½ Twist'),
('5373', 3.0, 'C', 3.7, 'Reverse 3½ Somersaults 1½ Twists'),
('5375', 3.0, 'B', 4.1, 'Reverse 3½ Somersaults 2½ Twists');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 5.0, 'A', 1.9, 'Reverse Dive ½ Twist'),
('5311', 5.0, 'B', 1.8, 'Reverse Dive ½ Twist'),
('5311', 5.0, 'C', 1.7, 'Reverse Dive ½ Twist'),
('5312', 5.0, 'A', 2.1, 'Reverse Dive 1 Twist'),
('5321', 5.0, 'D', 1.8, 'Reverse Somersault ½ Twist'),
('5322', 5.0, 'D', 2.0, 'Reverse Somersault 1 Twist'),
('5323', 5.0, 'D', 2.4, 'Reverse Somersault 1½ Twists'),
('5325', 5.0, 'D', 2.8, 'Reverse Somersault 2½ Twists'),
('5331', 5.0, 'D', 2.2, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 5.0, 'D', 2.6, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 5.0, 'D', 3.0, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 5.0, 'D', 3.5, 'Reverse 1½ Somersaults 3½ Twists'),
('5351', 5.0, 'B', 3.0, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 5.0, 'C', 2.8, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 5.0, 'B', 3.4, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 5.0, 'B', 3.8, 'Reverse 2½ Somersaults 2½ Twists');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 7.5, 'A', 2.1, 'Reverse Dive ½ Twist'),
('5311', 7.5, 'B', 2.0, 'Reverse Dive ½ Twist'),
('5311', 7.5, 'C', 1.9, 'Reverse Dive ½ Twist'),
('5312', 7.5, 'A', 2.3, 'Reverse Dive 1 Twist'),
('5321', 7.5, 'D', 1.9, 'Reverse Somersault ½ Twist'),
('5322', 7.5, 'D', 2.1, 'Reverse Somersault 1 Twist'),
('5323', 7.5, 'D', 2.5, 'Reverse Somersault 1½ Twists'),
('5325', 7.5, 'D', 2.9, 'Reverse Somersault 2½ Twists'),
('5331', 7.5, 'D', 2.1, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 7.5, 'D', 2.5, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 7.5, 'D', 2.9, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 7.5, 'D', 3.4, 'Reverse 1½ Somersaults 3½ Twists'),
('5339', 7.5, 'D', 3.8, 'Reverse 1½ Somersaults 4½ Twists'),
('5351', 7.5, 'B', 2.8, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 7.5, 'C', 2.6, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 7.5, 'B', 3.4, 'Reverse 2½ Somersaults 1½ Twists'),
('5353', 7.5, 'C', 3.2, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 7.5, 'B', 3.8, 'Reverse 2½ Somersaults 2½ Twists'),
('5355', 7.5, 'C', 3.6, 'Reverse 2½ Somersaults 2½ Twists');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 10.0, 'A', 2.1, 'Reverse Dive ½ Twist'),
('5311', 10.0, 'B', 2.0, 'Reverse Dive ½ Twist'),
('5311', 10.0, 'C', 1.9, 'Reverse Dive ½ Twist'),
('5312', 10.0, 'A', 2.3, 'Reverse Dive 1 Twist'),
('5321', 10.0, 'D', 2.0, 'Reverse Somersault ½ Twist'),
('5322', 10.0, 'D', 2.2, 'Reverse Somersault 1 Twist'),
('5323', 10.0, 'D', 2.6, 'Reverse Somersault 1½ Twists'),
('5325', 10.0, 'D', 3.0, 'Reverse Somersault 2½ Twists'),
('5331', 10.0, 'D', 2.1, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 10.0, 'D', 2.5, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 10.0, 'D', 2.9, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 10.0, 'D', 3.4, 'Reverse 1½ Somersaults 3½ Twists'),
('5339', 10.0, 'D', 3.8, 'Reverse 1½ Somersaults 4½ Twists'),
('5351', 10.0, 'B', 2.7, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 10.0, 'C', 2.5, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 10.0, 'B', 3.3, 'Reverse 2½ Somersaults 1½ Twists'),
('5353', 10.0, 'C', 3.1, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 10.0, 'B', 3.7, 'Reverse 2½ Somersaults 2½ Twists'),
('5355', 10.0, 'C', 3.5, 'Reverse 2½ Somersaults 2½ Twists'),
('5371', 10.0, 'B', 3.3, 'Reverse 3½ Somersaults ½ Twist'),
('5371', 10.0, 'C', 3.0, 'Reverse 3½ Somersaults ½ Twist'),
('5373', 10.0, 'B', 3.6, 'Reverse 3½ Somersaults 1½ Twists'),
('5375', 10.0, 'B', 4.0, 'Reverse 3½ Somersaults 2½ Twists');

-- -----------------------------------------------------------------------------
-- INWARD TWISTING GROUP (541x / 542x / 543x)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 1.0, 'A', 2.0, 'Inward Dive ½ Twist'),
('5411', 1.0, 'B', 1.7, 'Inward Dive ½ Twist'),
('5411', 1.0, 'C', 1.6, 'Inward Dive ½ Twist'),
('5412', 1.0, 'A', 2.2, 'Inward Dive 1 Twist'),
('5412', 1.0, 'B', 1.9, 'Inward Dive 1 Twist'),
('5412', 1.0, 'C', 1.8, 'Inward Dive 1 Twist'),
('5421', 1.0, 'D', 1.9, 'Inward Somersault ½ Twist'),
('5422', 1.0, 'D', 2.1, 'Inward Somersault 1 Twist'),
('5432', 1.0, 'D', 2.7, 'Inward 1½ Somersaults 1 Twist'),
('5434', 1.0, 'D', 3.1, 'Inward 1½ Somersaults 2 Twists');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 3.0, 'A', 1.9, 'Inward Dive ½ Twist'),
('5411', 3.0, 'B', 1.6, 'Inward Dive ½ Twist'),
('5411', 3.0, 'C', 1.5, 'Inward Dive ½ Twist'),
('5412', 3.0, 'A', 2.1, 'Inward Dive 1 Twist'),
('5412', 3.0, 'B', 1.8, 'Inward Dive 1 Twist'),
('5412', 3.0, 'C', 1.7, 'Inward Dive 1 Twist'),
('5421', 3.0, 'D', 1.7, 'Inward Somersault ½ Twist'),
('5422', 3.0, 'D', 1.9, 'Inward Somersault 1 Twist'),
('5432', 3.0, 'D', 2.4, 'Inward 1½ Somersaults 1 Twist'),
('5434', 3.0, 'D', 2.8, 'Inward 1½ Somersaults 2 Twists'),
('5436', 3.0, 'D', 3.5, 'Inward 1½ Somersaults 3 Twists');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 5.0, 'A', 2.0, 'Inward Dive ½ Twist'),
('5411', 5.0, 'B', 1.7, 'Inward Dive ½ Twist'),
('5411', 5.0, 'C', 1.6, 'Inward Dive ½ Twist'),
('5412', 5.0, 'A', 2.2, 'Inward Dive 1 Twist'),
('5412', 5.0, 'B', 1.9, 'Inward Dive 1 Twist'),
('5412', 5.0, 'C', 1.8, 'Inward Dive 1 Twist'),
('5421', 5.0, 'D', 1.9, 'Inward Somersault ½ Twist'),
('5422', 5.0, 'D', 2.1, 'Inward Somersault 1 Twist'),
('5432', 5.0, 'D', 2.7, 'Inward 1½ Somersaults 1 Twist'),
('5434', 5.0, 'D', 3.1, 'Inward 1½ Somersaults 2 Twists');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 7.5, 'A', 1.9, 'Inward Dive ½ Twist'),
('5411', 7.5, 'B', 1.6, 'Inward Dive ½ Twist'),
('5411', 7.5, 'C', 1.5, 'Inward Dive ½ Twist'),
('5412', 7.5, 'A', 2.1, 'Inward Dive 1 Twist'),
('5412', 7.5, 'B', 1.8, 'Inward Dive 1 Twist'),
('5412', 7.5, 'C', 1.7, 'Inward Dive 1 Twist'),
('5421', 7.5, 'D', 1.7, 'Inward Somersault ½ Twist'),
('5422', 7.5, 'D', 1.9, 'Inward Somersault 1 Twist'),
('5432', 7.5, 'D', 2.4, 'Inward 1½ Somersaults 1 Twist'),
('5434', 7.5, 'D', 2.8, 'Inward 1½ Somersaults 2 Twists');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 10.0, 'A', 1.9, 'Inward Dive ½ Twist'),
('5411', 10.0, 'B', 1.6, 'Inward Dive ½ Twist'),
('5411', 10.0, 'C', 1.5, 'Inward Dive ½ Twist'),
('5412', 10.0, 'A', 2.1, 'Inward Dive 1 Twist'),
('5412', 10.0, 'B', 1.8, 'Inward Dive 1 Twist'),
('5412', 10.0, 'C', 1.7, 'Inward Dive 1 Twist'),
('5421', 10.0, 'D', 1.8, 'Inward Somersault ½ Twist'),
('5422', 10.0, 'D', 2.0, 'Inward Somersault 1 Twist'),
('5432', 10.0, 'D', 2.3, 'Inward 1½ Somersaults 1 Twist'),
('5434', 10.0, 'D', 2.7, 'Inward 1½ Somersaults 2 Twists'),
('5436', 10.0, 'D', 3.4, 'Inward 1½ Somersaults 3 Twists');

-- -----------------------------------------------------------------------------
-- ARMSTAND GROUP (6xx / 6xxx), platform only
-- -----------------------------------------------------------------------------

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('600',  5.0, 'A', 1.5, 'Armstand Dive'),
('611',  5.0, 'A', 1.8, 'Armstand Forward ½ Somersault'),
('611',  5.0, 'B', 1.7, 'Armstand Forward ½ Somersault'),
('611',  5.0, 'C', 1.5, 'Armstand Forward ½ Somersault'),
('612',  5.0, 'A', 1.8, 'Armstand Forward 1 Somersault'),
('612',  5.0, 'B', 1.7, 'Armstand Forward 1 Somersault'),
('612',  5.0, 'C', 1.5, 'Armstand Forward 1 Somersault'),
('614',  5.0, 'B', 2.5, 'Armstand Forward 2 Somersaults'),
('614',  5.0, 'C', 2.2, 'Armstand Forward 2 Somersaults'),
('621',  5.0, 'A', 1.7, 'Armstand Back ½ Somersault'),
('621',  5.0, 'B', 1.6, 'Armstand Back ½ Somersault'),
('621',  5.0, 'C', 1.4, 'Armstand Back ½ Somersault'),
('622',  5.0, 'A', 2.1, 'Armstand Back 1 Somersault'),
('622',  5.0, 'B', 2.0, 'Armstand Back 1 Somersault'),
('622',  5.0, 'C', 1.8, 'Armstand Back 1 Somersault'),
('623',  5.0, 'B', 2.3, 'Armstand Back 1½ Somersaults'),
('623',  5.0, 'C', 2.0, 'Armstand Back 1½ Somersaults'),
('624',  5.0, 'A', 3.1, 'Armstand Back 2 Somersaults'),
('624',  5.0, 'B', 2.9, 'Armstand Back 2 Somersaults'),
('624',  5.0, 'C', 2.6, 'Armstand Back 2 Somersaults'),
('626',  5.0, 'B', 3.5, 'Armstand Back 3 Somersaults'),
('631',  5.0, 'A', 1.8, 'Armstand Reverse ½ Somersault'),
('631',  5.0, 'B', 1.7, 'Armstand Reverse ½ Somersault'),
('631',  5.0, 'C', 1.5, 'Armstand Reverse ½ Somersault'),
('632',  5.0, 'B', 2.1, 'Armstand Reverse 1 Somersault'),
('632',  5.0, 'C', 1.9, 'Armstand Reverse 1 Somersault'),
('633',  5.0, 'B', 2.4, 'Armstand Reverse 1½ Somersaults'),
('633',  5.0, 'C', 2.1, 'Armstand Reverse 1½ Somersaults'),
('634',  5.0, 'B', 3.0, 'Armstand Reverse 2 Somersaults'),
('634',  5.0, 'C', 2.7, 'Armstand Reverse 2 Somersaults'),
('6122', 5.0, 'D', 2.4, 'Armstand Forward 1 Somersault 1 Twist'),
('6124', 5.0, 'D', 2.7, 'Armstand Forward 1 Somersault 2 Twists'),
('6142', 5.0, 'D', 3.2, 'Armstand Forward 2 Somersaults 1 Twist'),
('6144', 5.0, 'D', 3.5, 'Armstand Forward 2 Somersaults 2 Twists'),
('6221', 5.0, 'D', 1.6, 'Armstand Back 1 Somersault ½ Twist'),
('6241', 5.0, 'B', 2.8, 'Armstand Back 2 Somersaults ½ Twist'),
('6241', 5.0, 'C', 2.5, 'Armstand Back 2 Somersaults ½ Twist'),
('6243', 5.0, 'D', 3.3, 'Armstand Back 2 Somersaults 1½ Twists'),
('6245', 5.0, 'D', 3.7, 'Armstand Back 2 Somersaults 2½ Twists'),
('6261', 5.0, 'B', 3.6, 'Armstand Back 3 Somersaults ½ Twist'),
('6261', 5.0, 'C', 3.4, 'Armstand Back 3 Somersaults ½ Twist');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('600',  7.5, 'A', 1.6, 'Armstand Dive'),
('611',  7.5, 'A', 2.0, 'Armstand Forward ½ Somersault'),
('611',  7.5, 'B', 1.9, 'Armstand Forward ½ Somersault'),
('611',  7.5, 'C', 1.7, 'Armstand Forward ½ Somersault'),
('612',  7.5, 'A', 1.9, 'Armstand Forward 1 Somersault'),
('612',  7.5, 'B', 1.8, 'Armstand Forward 1 Somersault'),
('612',  7.5, 'C', 1.6, 'Armstand Forward 1 Somersault'),
('614',  7.5, 'B', 2.3, 'Armstand Forward 2 Somersaults'),
('614',  7.5, 'C', 2.0, 'Armstand Forward 2 Somersaults'),
('621',  7.5, 'A', 1.9, 'Armstand Back ½ Somersault'),
('621',  7.5, 'B', 1.8, 'Armstand Back ½ Somersault'),
('621',  7.5, 'C', 1.6, 'Armstand Back ½ Somersault'),
('622',  7.5, 'A', 2.2, 'Armstand Back 1 Somersault'),
('622',  7.5, 'B', 2.1, 'Armstand Back 1 Somersault'),
('622',  7.5, 'C', 1.9, 'Armstand Back 1 Somersault'),
('623',  7.5, 'B', 2.2, 'Armstand Back 1½ Somersaults'),
('623',  7.5, 'C', 1.9, 'Armstand Back 1½ Somersaults'),
('624',  7.5, 'A', 2.9, 'Armstand Back 2 Somersaults'),
('624',  7.5, 'B', 2.7, 'Armstand Back 2 Somersaults'),
('624',  7.5, 'C', 2.4, 'Armstand Back 2 Somersaults'),
('626',  7.5, 'B', 3.3, 'Armstand Back 3 Somersaults'),
('626',  7.5, 'C', 3.1, 'Armstand Back 3 Somersaults'),
('631',  7.5, 'A', 2.0, 'Armstand Reverse ½ Somersault'),
('631',  7.5, 'B', 1.9, 'Armstand Reverse ½ Somersault'),
('631',  7.5, 'C', 1.7, 'Armstand Reverse ½ Somersault'),
('632',  7.5, 'B', 2.2, 'Armstand Reverse 1 Somersault'),
('632',  7.5, 'C', 2.0, 'Armstand Reverse 1 Somersault'),
('633',  7.5, 'B', 2.3, 'Armstand Reverse 1½ Somersaults'),
('633',  7.5, 'C', 2.0, 'Armstand Reverse 1½ Somersaults'),
('634',  7.5, 'B', 2.8, 'Armstand Reverse 2 Somersaults'),
('634',  7.5, 'C', 2.5, 'Armstand Reverse 2 Somersaults'),
('636',  7.5, 'B', 3.2, 'Armstand Reverse 3 Somersaults'),
('6122', 7.5, 'D', 2.5, 'Armstand Forward 1 Somersault 1 Twist'),
('6124', 7.5, 'D', 2.8, 'Armstand Forward 1 Somersault 2 Twists'),
('6142', 7.5, 'D', 3.0, 'Armstand Forward 2 Somersaults 1 Twist'),
('6144', 7.5, 'D', 3.3, 'Armstand Forward 2 Somersaults 2 Twists'),
('6221', 7.5, 'D', 1.7, 'Armstand Back 1 Somersault ½ Twist'),
('6241', 7.5, 'B', 2.6, 'Armstand Back 2 Somersaults ½ Twist'),
('6241', 7.5, 'C', 2.3, 'Armstand Back 2 Somersaults ½ Twist'),
('6243', 7.5, 'D', 3.1, 'Armstand Back 2 Somersaults 1½ Twists'),
('6245', 7.5, 'D', 3.5, 'Armstand Back 2 Somersaults 2½ Twists'),
('6261', 7.5, 'B', 3.2, 'Armstand Back 3 Somersaults ½ Twist'),
('6261', 7.5, 'C', 3.0, 'Armstand Back 3 Somersaults ½ Twist');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('600',  10.0, 'A', 1.6, 'Armstand Dive'),
('611',  10.0, 'A', 2.0, 'Armstand Forward ½ Somersault'),
('611',  10.0, 'B', 1.9, 'Armstand Forward ½ Somersault'),
('611',  10.0, 'C', 1.7, 'Armstand Forward ½ Somersault'),
('612',  10.0, 'A', 2.0, 'Armstand Forward 1 Somersault'),
('612',  10.0, 'B', 1.9, 'Armstand Forward 1 Somersault'),
('612',  10.0, 'C', 1.7, 'Armstand Forward 1 Somersault'),
('614',  10.0, 'B', 2.4, 'Armstand Forward 2 Somersaults'),
('614',  10.0, 'C', 2.1, 'Armstand Forward 2 Somersaults'),
('616',  10.0, 'B', 3.3, 'Armstand Forward 3 Somersaults'),
('616',  10.0, 'C', 3.1, 'Armstand Forward 3 Somersaults'),
('621',  10.0, 'A', 1.9, 'Armstand Back ½ Somersault'),
('621',  10.0, 'B', 1.8, 'Armstand Back ½ Somersault'),
('621',  10.0, 'C', 1.6, 'Armstand Back ½ Somersault'),
('622',  10.0, 'A', 2.3, 'Armstand Back 1 Somersault'),
('622',  10.0, 'B', 2.2, 'Armstand Back 1 Somersault'),
('622',  10.0, 'C', 2.0, 'Armstand Back 1 Somersault'),
('623',  10.0, 'B', 2.2, 'Armstand Back 1½ Somersaults'),
('623',  10.0, 'C', 1.9, 'Armstand Back 1½ Somersaults'),
('624',  10.0, 'A', 3.0, 'Armstand Back 2 Somersaults'),
('624',  10.0, 'B', 2.8, 'Armstand Back 2 Somersaults'),
('624',  10.0, 'C', 2.5, 'Armstand Back 2 Somersaults'),
('626',  10.0, 'B', 3.5, 'Armstand Back 3 Somersaults'),
('626',  10.0, 'C', 3.3, 'Armstand Back 3 Somersaults'),
('628',  10.0, 'B', 4.7, 'Armstand Back 4 Somersaults'),
('628',  10.0, 'C', 4.5, 'Armstand Back 4 Somersaults'),
('631',  10.0, 'A', 2.0, 'Armstand Reverse ½ Somersault'),
('631',  10.0, 'B', 1.9, 'Armstand Reverse ½ Somersault'),
('631',  10.0, 'C', 1.7, 'Armstand Reverse ½ Somersault'),
('632',  10.0, 'B', 2.3, 'Armstand Reverse 1 Somersault'),
('632',  10.0, 'C', 2.1, 'Armstand Reverse 1 Somersault'),
('633',  10.0, 'B', 2.3, 'Armstand Reverse 1½ Somersaults'),
('633',  10.0, 'C', 2.0, 'Armstand Reverse 1½ Somersaults'),
('634',  10.0, 'B', 2.9, 'Armstand Reverse 2 Somersaults'),
('634',  10.0, 'C', 2.6, 'Armstand Reverse 2 Somersaults'),
('636',  10.0, 'B', 3.6, 'Armstand Reverse 3 Somersaults'),
('636',  10.0, 'C', 3.4, 'Armstand Reverse 3 Somersaults'),
('638',  10.0, 'B', 4.8, 'Armstand Reverse 4 Somersaults'),
('638',  10.0, 'C', 4.6, 'Armstand Reverse 4 Somersaults'),
('6122', 10.0, 'D', 2.6, 'Armstand Forward 1 Somersault 1 Twist'),
('6124', 10.0, 'D', 2.9, 'Armstand Forward 1 Somersault 2 Twists'),
('6142', 10.0, 'D', 3.1, 'Armstand Forward 2 Somersaults 1 Twist'),
('6144', 10.0, 'D', 3.4, 'Armstand Forward 2 Somersaults 2 Twists'),
('6162', 10.0, 'B', 3.9, 'Armstand Forward 3 Somersaults 1 Twist'),
('6221', 10.0, 'D', 1.8, 'Armstand Back 1 Somersault ½ Twist'),
('6241', 10.0, 'B', 2.7, 'Armstand Back 2 Somersaults ½ Twist'),
('6241', 10.0, 'C', 2.4, 'Armstand Back 2 Somersaults ½ Twist'),
('6243', 10.0, 'D', 3.2, 'Armstand Back 2 Somersaults 1½ Twists'),
('6245', 10.0, 'D', 3.6, 'Armstand Back 2 Somersaults 2½ Twists'),
('6247', 10.0, 'D', 4.0, 'Armstand Back 2 Somersaults 3½ Twists'),
('6261', 10.0, 'B', 3.4, 'Armstand Back 3 Somersaults ½ Twist'),
('6261', 10.0, 'C', 3.2, 'Armstand Back 3 Somersaults ½ Twist'),
('6263', 10.0, 'B', 4.2, 'Armstand Back 3 Somersaults 1½ Twists'),
('6263', 10.0, 'C', 4.0, 'Armstand Back 3 Somersaults 1½ Twists'),
('6265', 10.0, 'B', 4.6, 'Armstand Back 3 Somersaults 2½ Twists'),
('6265', 10.0, 'C', 4.4, 'Armstand Back 3 Somersaults 2½ Twists');



-- =============================================================
-- SUPER ADMIN ACCOUNT
--
-- Creates a single platform organisation and the 'admin' user so
-- the freshly built database is immediately usable.
--
--   username: admin
--   password: admin
--
-- Heads up: DEV / BOOTSTRAP ONLY. These are well-known credentials,
-- anyone who can reach the login page owns the platform until
-- they're rotated. Replace the password from the User Manager as
-- the FIRST thing you do after signing in.
--
-- PRODUCTION BEHAVIOUR: server.js refuses to serve when
-- NODE_ENV=production and this account still answers to the
-- default password. The boot check bcrypt.compares 'admin'
-- against the stored hash and exits with a fatal log if it
-- matches. Dev / test installs (NODE_ENV unset) are unaffected,
-- as are the intentional dev fixtures in seed_test_data.sql and
-- docs/seed-credentials.csv.
--
-- The bcrypt hash below was generated with the same cost factor
-- (12) the server uses for live registrations:
--     node -e "console.log(require('bcryptjs').hashSync('admin', 12))"
-- =============================================================

INSERT INTO public.organisations (id, name, country_code, slug, status, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Administration',
    NULL,
    'admin',
    'active',
    now()
);

INSERT INTO public.users
    (id, username, password, full_name, email, org_id, club_id, is_system_admin,
     email_verified_at, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    'admin',
    '$2b$12$ByJxDUrjsvPjFqTjsWp2O.eTL6QoytQLQmHyTNwiNJLOJVZJZ/Oha',  -- bcrypt('admin', 12)
    'System Administrator',
    'admin@divinghq.local',
    '00000000-0000-0000-0000-000000000001',
    NULL,
    true,
    -- email_verified_at is non-null so the bootstrap admin can log in
    -- straight away on a fresh install. Without this, /api/auth/login
    -- refuses with "please verify your email", and there's no inbox
    -- to receive that link from on a brand-new system anyway.
    now(),
    now()
);

-- is_system_admin already gives this user cross-org access regardless
-- of explicit role rows, but we add org_admin + spectator within the
-- platform org too, just in case some code path does a strict role
-- check and needs it to resolve cleanly.
INSERT INTO public.user_org_roles (user_id, org_id, role, granted_at) VALUES
    ('00000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000001',
     'spectator',
     now()),
    ('00000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000001',
     'org_admin',
     now());

INSERT INTO public.role_audit_log
    (user_id, org_id, role, action, actor_id, note, created_at)
VALUES
    ('00000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000001',
     'spectator', 'granted', NULL, 'bootstrap', now()),
    ('00000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000001',
     'org_admin', 'granted', NULL, 'bootstrap', now());


COMMIT;


-- =============================================================
-- DONE
--
-- Sign in at /login with admin / admin, you'll have full system
-- admin access (cross-org User Manager, Clubs, Teams, Archive,
-- and the ability to register additional organisations).
--
-- For test data on top of this clean install, run:
--     psql -d divinghq -f seed_test_data.sql
-- =============================================================
