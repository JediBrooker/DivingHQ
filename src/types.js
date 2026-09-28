// Shared API response shapes as JSDoc typedefs. Vue files (and any
// modern editor or AI agent) pick these up via:
//
//   /** @type {import('@/types').DiverProfile} */
//
// or by writing JSDoc on a variable. There's no runtime export, this
// file exists purely so editors and code-completion can answer
// "what's on this object?" without grepping through server.js.
//
// Keep this in sync with the actual response builders in server.js.
// AGENTS.md lists this file in the "When you change X, also check Y"
// table, please honour that.

// ---- core ---------------------------------------------------------

/**
 * @typedef {Object} JwtPayload
 * The decoded JWT, attached to req.user by verifyToken on the server,
 * and exposed via auth.user (a computed) on the client.
 *
 * @property {string}   id              UUID, do not call this user_id.
 * @property {string}   username
 * @property {string}   full_name
 * @property {string}   org_id          Primary org of the user.
 * @property {string[]} org_roles       e.g. ['org_admin', 'meet_manager', 'judge', 'coach', 'diver', 'spectator']
 * @property {boolean}  is_system_admin
 * @property {?string}  [locale]        users.locale (migration 052), null until set. The
 *   SPA's auth store saves the on-screen language here and adopts it on
 *   sign-in (adoptAccountLocale); server-side mail goes out in it.
 * @property {number}   iat             issued-at, set by jsonwebtoken
 * @property {number}   exp             expiry, set by jsonwebtoken
 * @property {boolean}  [has_dependents] Body-only (login + /api/auth/me), never in the JWT.
 * @property {{id: string, name: string, region_id: ?string, org_claim_state: 'claimed'|'unclaimed'}[]} [club_admin_of]
 *   Body-only (login + /api/auth/me): clubs this user admins, and whether
 *   their org has a federation (claimed) or the clubs run it (unclaimed).
 *   UI hint only, the server re-reads club_admins on every club-scoped route.
 * @property {{id: string, name: string, short_code: string, org_claim_state: 'claimed'|'unclaimed'}[]} [region_admin_of]
 *   Body-only, same deal for region_admins (migration 088).
 * @property {boolean} [has_claim]
 *   Body-only: this user filed a claim (lib/claims.js, any status but
 *   withdrawn). Puts Claims in a claimant's nav.
 * @property {?{id: string, name: string, org_name: string}} [pending_club]
 *   Body-only: a club this user started that's still waiting for its
 *   federation to approve it (migration 096, lib/club-approvals.js).
 *   null once it's approved or rejected.
 */

/**
 * @typedef {Object} MyOpenClaim
 * One row of `my_claims` on GET /api/dashboard: a claim this user filed
 * that's still being decided.
 *
 * @property {string} id
 * @property {'org'|'region'} target_kind
 * @property {string} target_name   the country's name for a national claim, else the region's
 * @property {'open'|'escalated'} status
 * @property {'clubs'|'regions'|'parent'|'sysadmin'} approver  who decides it
 * @property {boolean} activated    false until the claimant verified their email
 * @property {?string} closes_at    ISO timestamp, when voting ends
 */

/**
 * @typedef {Object} PublicConfig
 * GET /api/public-config, public. Deployment settings the signed-out
 * pages need (routes/public-config.js).
 *
 * @property {string} support_email  SUPPORT_EMAIL, default support@divinghq.app
 */

/**
 * @typedef {Object} CountryOrg
 * One row of GET /api/orgs/by-country/:code, the org a registrant from
 * that country would join.
 *
 * @property {string} id
 * @property {string} name
 * @property {string} country_code
 * @property {'claimed'|'unclaimed'} claim_state  unclaimed = started by clubs, no federation yet
 * @property {boolean} auto_approve_clubs  claimed orgs only: a new club joins straight
 *   away instead of waiting for the federation to approve it (migration 096)
 */

/**
 * @typedef {Object} RegisterResult
 * POST /api/auth/register, 201.
 *
 * @property {string} message
 * @property {?('pending'|'active')} club_status  the club they joined or started;
 *   'pending' = a new club waiting for the federation (null when no club)
 * @property {?string} org_name  the org they joined, for "waiting for {org}"
 */

/**
 * @typedef {Object} ClubRow
 * One row of GET /api/clubs (org admin, meet manager, sysadmin). Rows with
 * status 'pending' only go to the org admin and the sysadmin, and only once
 * the founder has verified their email; only those carry the founder_*
 * fields and submitted_at (null on active rows).
 * Decide with POST /api/clubs/:id/approve { name?, short_code?, region_id?,
 * make_founder_admin } or POST /api/clubs/:id/reject { reason?, move_members_to? }.
 *
 * @property {string} id
 * @property {string} name
 * @property {?string} short_code
 * @property {string} created_at
 * @property {?string} region_id
 * @property {'active'|'pending'} status
 * @property {string} org_id
 * @property {string} org_name
 * @property {?string} country_code
 * @property {number} member_count
 * @property {boolean} affiliation_active
 * @property {boolean} accreditation_active
 * @property {?string} submitted_at   when the federation was asked
 * @property {?string} founder_id
 * @property {?string} founder_name
 * @property {?string} founder_username
 * @property {?string} founder_email
 * @property {?boolean} founder_email_verified
 */

/**
 * @typedef {Object} ClubSettings
 * GET / PUT /api/orgs/:id/club-settings (org admin of that org, sysadmin).
 * PUT answers 409 org_unclaimed for a country the clubs started.
 *
 * @property {boolean} auto_approve_clubs  new clubs join without approval
 * @property {'claimed'|'unclaimed'} claim_state
 */

/**
 * @typedef {Object} OrgNeedingCountry
 * One row of GET /api/orgs/needs-country (sysadmin): a live org whose
 * country_code is missing or not in lib/countries.json, so no signup can
 * find it. PUT /api/orgs/:id/country { country_code } fixes one and
 * answers with the whole organisations row.
 *
 * @property {string} id
 * @property {string} name
 * @property {?string} country_code  trimmed; null when there's none
 * @property {'active'|'suspended'} status
 * @property {'claimed'|'unclaimed'} claim_state
 * @property {string} created_at
 */

// Note (migration 090): on diver rows from the scoreboard, recap, Control
// Room, PDF and venue endpoints, `country_code` / `partner_country` hold
// the meet's representation code (country, state short code or club
// short code, per meets.represent_as), not necessarily a country.
// Team standings rows (migration 095) carry the code the team's divers
// share in `country_code` (event_team_rep_code, falling back to the team
// org's country) and the team short code in `club_name`.

/**
 * @typedef {Object} RegionList
 * GET /api/orgs/:id/regions and GET /api/countries/:code/regions.
 *
 * @property {?('state'|'province'|'home_nation'|'region')} label  null = no regions
 * @property {{id?: string, name: string, short_code: string, club_count?: number, claim_state?: 'claimed'|'unclaimed', claimed_name?: ?string, has_live_admin?: boolean}[]} regions
 *   id, club_count, claim_state, claimed_name and has_live_admin only on the
 *   per-org list (the country list is the built-in catalogue). has_live_admin
 *   is false for a claimed region whose admins have all been deleted or
 *   suspended: it can be claimed again, and its clubs can leave it.
 * @property {boolean} [catalogue]  per-org list only: DivingHQ has a built-in list
 *   for the org's country, so POST /api/orgs/:id/regions/seed can work.
 */

/**
 * @typedef {Object} MyRoleRequests
 * GET /api/role-requests/mine, for the "Request a role" dialog on your
 * own profile. POST /api/role-requests answers 201 with one `requests`
 * row, or 400 role_not_requestable / 409 already_held, already_pending,
 * recently_declined.
 *
 * @property {?('claimed'|'unclaimed')} claim_state  your org's
 * @property {string[]} requestable  roles your org lets you ask for (no meet_manager where unclaimed, nothing in the Administration org)
 * @property {string[]} held         roles you already have in your org, spectator included
 * @property {{id: string, requested_role: string, status: 'pending'|'approved'|'rejected', note: ?string, created_at: string, reviewed_at: ?string}[]} requests
 *   your 20 most recent, newest first
 */

/**
 * @typedef {Object} ClubAdmins
 * GET /api/clubs/:id/admins (org admin, or the club's / its region's
 * admins where there's no federation).
 *
 * @property {{id: string, full_name: string, username: string, created_at: string, live: boolean}[]} admins  deleted accounts left out (suspended ones stay, so they can be removed); live is false for a suspended one
 * @property {{id: string, full_name: string, username: string}[]} members
 * @property {?{region_id: string, requested_at: string}} region_request
 *   a claimed region this club has asked to join and is waiting on (PUT
 *   /api/clubs/:id/region answered 202 {requested: true})
 * @property {boolean} keep_one_live  the caller can't remove the last live
 *   admin (DELETE answers 409): true for the club's own and its region's
 *   admins, false for the org admin and the sysadmin
 */

/**
 * @typedef {Object} RegionAdmins
 * GET /api/regions/:id/admins (the region's admins, or the org admin).
 *
 * @property {{id: string, full_name: string, username: string, created_at: string, live: boolean}[]} admins  same rules as ClubAdmins.admins
 * @property {{id: string, full_name: string, username: string, club_name: string}[]} candidates  live members of the region's clubs; empty unless can_manage
 * @property {boolean} can_manage  may add and remove admins here (org admin, or a region admin where there's no federation)
 * @property {boolean} keep_one_live  same as ClubAdmins.keep_one_live: false only for the org admin and the sysadmin
 */

/**
 * @typedef {Object} RegionOverview
 * GET /api/regions/:id/overview (the region's admins, or the org admin).
 *
 * @property {{id: string, name: string, short_code: string, claim_state: 'claimed'|'unclaimed', claimed_name: ?string, label: ?string, org_id: string}} region
 * @property {{id: string, name: string, short_code: ?string, member_count: number, admins: {id: string, full_name: string}[]}[]} clubs
 * @property {{id: string, name: string, short_code: ?string, member_count: number, requested_at: string, current_region_name: ?string}[]} join_requests
 *   clubs asking to join; accept with PUT /api/clubs/:id/region, decline with DELETE /api/clubs/:id/region-request
 */

/**
 * @typedef {Object} ClubSetup
 * GET /api/clubs/:id/setup (routes/club-setup.js). For the club's admins,
 * the org's admins and the sysadmin; drives the dashboard's "Get started"
 * panel and the invite link / short code card on My club.
 *
 * @property {string}  id
 * @property {string}  name
 * @property {?string} short_code
 * @property {?string} country_code   ISO alpha-3 for the invite link, null when the org has none
 * @property {'claimed'|'unclaimed'} claim_state
 * @property {boolean} can_edit_code  PUT /api/clubs/:id/short-code would be allowed
 * @property {number}  member_count   everyone in the club, the caller included if they're a member
 * @property {boolean} you_are_member
 * @property {number}  meet_count     meets this club hosts
 */

/**
 * @typedef {Object} DiverSummary
 * The lightweight diver row returned from the cross-org search and
 * browse endpoints. Used for autocomplete + filterable lists.
 *
 * @property {string} id
 * @property {string} full_name
 * @property {string} username
 * @property {string} org_id
 * @property {string} org_name
 * @property {string} [country_code]
 * @property {string} [club_id]
 * @property {string} [club_name]
 * @property {string} [club_code]
 */

// ---- /api/divers/:id/profile -------------------------------------

/**
 * @typedef {Object} DiverProfile
 *
 * @property {Object}            diver
 * @property {string}            diver.id
 * @property {string}            diver.full_name
 * @property {string}            diver.org_id
 * @property {string}            diver.org_name
 * @property {string}            [diver.country_code]
 * @property {string}            [diver.club_id]
 * @property {string}            [diver.club_name]
 * @property {string}            [diver.club_code]
 * @property {DiverProfileStats} stats
 * @property {PersonalBest[]}    personal_bests
 * @property {ScoreTrendRow[]}   score_trend
 * @property {string[]}          [dashboard_widgets]  Present only when the
 *   viewer is the owner / org admin / coach. Stripped for outside viewers.
 */

/**
 * @typedef {Object} DiverProfileStats
 * @property {number}        total_meets
 * @property {number}        total_dives
 * @property {number|null}   avg_dd
 * @property {number|null}   best_single_dive
 */

/**
 * @typedef {Object} PersonalBest
 * @property {string}      dive_code
 * @property {string}      position    e.g. 'A' | 'B' | 'C' | 'D'
 * @property {string}      height      e.g. '0m' | '1m' | '3m' | '5m' | '7.5m' | '10m'
 * @property {number}      dd
 * @property {string}      [description]
 * @property {number}      best_total
 * @property {string}      event_name
 * @property {string}      event_id
 * @property {string}      created_at  ISO timestamp of when the event took place (its scheduled_at, else its meet's start date, else when it was created; db/queries.js EVENT_DATE)
 * @property {number}      attempts
 */

/**
 * @typedef {Object} ScoreTrendRow
 * @property {string}        event_id
 * @property {string}        event_name
 * @property {string}        [height]
 * @property {string}        [gender]
 * @property {string}        status        'pending' | 'live' | 'completed'
 * @property {string}        created_at    ISO, when the event took place (see PersonalBest.created_at)
 * @property {string}        event_type    'individual' | 'synchro_pair' | 'team'
 * @property {number}        total_score
 * @property {number}        final_rank
 * @property {string}        [partner_name]
 * @property {string}        [team_name]
 */

// ---- /api/divers/:id/analytics -----------------------------------

/**
 * @typedef {Object} DiverAnalytics
 *
 * @property {RecentFormRow[]}      recent_form
 * @property {Placings}             placings
 * @property {HeightBreakdownRow[]} height_breakdown
 * @property {RoundStaminaRow[]}    round_stamina
 * @property {QualityMix}           quality_mix
 * @property {DDRisk}               dd_risk
 * @property {FrequentDive[]}       frequent_dives
 * @property {{kind: 'win'|'podium'|null, length: number}} streak
 * @property {ComparePeers}         compare_peers
 * @property {EventTypeSplit[]}     event_type_splits
 * @property {YearOverYearRow[]}    year_over_year
 * @property {{from_date: string|null, to_date: string|null}} filter
 */

/**
 * @typedef {Object} RecentFormRow
 * @property {string}      event_id
 * @property {string}      event_name
 * @property {string}      created_at  when the event took place (see PersonalBest.created_at)
 * @property {number}      total
 * @property {number}      rank        Diver's finishing place in this meet. Equal totals share a place (WA Art 4.1.5).
 * @property {number}      field_size  Total competitors in the meet.
 * @property {RecentFormDive[]} [dives] Per-dive breakdown for the click-to-expand panel.
 */

/**
 * @typedef {Object} RecentFormDive
 * @property {string}            event_id
 * @property {number}            round_number
 * @property {string}            [dive_code]
 * @property {string}            [position]
 * @property {string}            [height]
 * @property {number}            [dd]
 * @property {string}            [description]
 * @property {number}            number_of_judges
 * @property {string}            event_type
 * @property {number}            dive_total
 * @property {Array<{judge_number:number, score:number}>} judges
 */

/**
 * @typedef {Object} Placings
 * @property {number} gold
 * @property {number} silver
 * @property {number} bronze
 * @property {number} finalist     ranks 4..8
 * @property {number} further      9th+
 * @property {number} total_meets
 */

/**
 * @typedef {Object} HeightBreakdownRow
 * @property {string} height
 * @property {number} dive_count
 * @property {number} avg_score
 * @property {number} best_score
 */

/**
 * @typedef {Object} RoundStaminaRow
 * @property {number} round_number
 * @property {number} dive_count
 * @property {number} avg_score
 */

/**
 * @typedef {Object} QualityMix
 * @property {number} failed
 * @property {number} very_deficient
 * @property {number} deficient
 * @property {number} satisfactory
 * @property {number} good
 * @property {number} very_good
 * @property {number} excellent
 * @property {number} total
 */

/**
 * @typedef {Object} DDRisk
 * @property {number|null} avg_dd
 * @property {number|null} max_dd
 * @property {number|null} avg_score
 * @property {number|null} avg_score_at_highest_dd
 * @property {number}      attempts_at_highest_dd
 */

/**
 * @typedef {Object} FrequentDive
 * @property {string} dive_code
 * @property {string} position
 * @property {string} height
 * @property {number} attempts
 * @property {number} avg_score
 * @property {number} best_score
 */

/**
 * @typedef {Object} ComparePeers
 * @property {number|null} my_avg_dd
 * @property {number|null} peer_avg_dd
 * @property {number|null} my_max_dd
 * @property {number|null} peer_max_dd
 * @property {number|null} my_avg_score
 * @property {number|null} peer_avg_score
 * @property {number}      my_dives
 * @property {number}      peer_dives
 */

/**
 * @typedef {Object} EventTypeSplit
 * @property {string}      event_type           'individual' | 'synchro_pair' | 'team'
 * @property {number}      meets
 * @property {number}      dives
 * @property {number|null} avg_dive_score
 * @property {number|null} best_single_dive
 * @property {number|null} avg_meet_total
 * @property {number|null} best_meet_total
 */

/**
 * @typedef {Object} YearOverYearRow
 * @property {number}      year        the year the events took place (db/queries.js EVENT_DATE)
 * @property {number}      meets
 * @property {number|null} avg_meet_total
 * @property {number|null} best_meet_total
 * @property {number}      wins
 * @property {number}      podiums
 */

// ---- /api/event-templates ----------------------------------------

/**
 * @typedef {Object} EventTemplate
 * A saved create-form configuration, org-scoped (GET / POST upsert by
 * name / DELETE /api/event-templates). config is the form state as the
 * Meet Manager saved it: gender, height, number_of_judges, total_rounds,
 * event_type, age_group, event_format, advance_count, dd_limit_*,
 * round_rules, optionally round_dives.
 *
 * @property {string} id
 * @property {string} name
 * @property {Object} config
 * @property {string} created_at
 * @property {string} updated_at
 */

// ---- /api/events/:id/roster --------------------------------------

/**
 * @typedef {Object} RosterRow
 * Row returned by the roster endpoint and used by the Control Room
 * queue. Every row is one (competitor, round, dive) tuple; a synchro
 * pair is one row per round with the second diver in partner_id.
 *
 * The Control Room sends the active row as the set_active_diver
 * payload. What the server keeps and broadcasts as state_update is a
 * public copy of it: dive_list_id, competitor_org_id,
 * competitor_org_name and paid_entry are dropped, and club_name /
 * club_code are null unless the diver's club is approved.
 *
 * @property {string}      dive_list_id      cdl.id, target for reorder/withdraw
 * @property {number|null} display_order
 * @property {string|null} withdrawn_at      ISO timestamp or null
 * @property {boolean}     is_reserve        reserve row (migration 040), not in the start order until promoted
 * @property {number|null} round_order       1-based position in its round; null for withdrawn and reserve rows
 * @property {string}      competitor_id
 * @property {string}      full_name
 * @property {string}      competitor_org_id
 * @property {string}      competitor_org_name
 * @property {string}      [country_code]
 * @property {string}      [club_name]
 * @property {string}      [club_code]
 * @property {string}      [partner_id]
 * @property {string}      [partner_name]
 * @property {string}      [partner_country]
 * @property {string}      [team_id]
 * @property {string}      [team_name]
 * @property {string}      [team_code]
 * @property {string}      public_id         per-event sha256 (event_id + competitor_id)
 *                                           truncated to 12 hex chars. Stable per event,
 *                                           non-reversible, used to match against the
 *                                           public scoreboard standings without exposing
 *                                           internal UUIDs to spectators. Same value
 *                                           appears on the standings rows.
 * @property {string}      [team_public_id]  Same idea but for team_id; only set on team events.
 * @property {string}      event_id
 * @property {number}      round_number
 * @property {string}      dive_id
 * @property {string}      dive_code
 * @property {string}      [description]
 * @property {number}      dd
 * @property {string}      position
 * @property {string}      event_type
 * @property {number}      number_of_judges
 */

/**
 * @typedef {Object} RosterImportRoundPreview
 * @property {number} round_number
 * @property {string} dive_code
 * @property {string} position
 * @property {'insert'|'update'} action
 * @property {string|null} current
 */

/**
 * @typedef {Object} RosterImportRowPreview
 * @property {string} username
 * @property {string|null} full_name
 * @property {string|null} partner_username
 * @property {string|null} partner_name
 * @property {RosterImportRoundPreview[]} rounds
 */

/**
 * @typedef {Object} RosterImportResult
 * Returned by POST /api/events/:id/roster/import for both preview
 * and commit. `preview=true` means no database rows were written.
 *
 * @property {boolean} preview
 * @property {number} added
 * @property {number} skipped
 * @property {number} rounds_written
 * @property {Array<{username:string,error:string}>} errors
 * @property {RosterImportRowPreview[]} rows
 */

// ---- /api/events/:id/audit-recent -------------------------------

/**
 * @typedef {Object} ControlAuditRow
 * Recent event-scoped audit row shown in Control Room next to risky
 * workflows. Score rows come from score_audit_log; activity rows come
 * from audit_log.
 *
 * @property {'score'|'activity'} kind
 * @property {string}      id
 * @property {string}      created_at
 * @property {string}      action
 * @property {string|null} [reason]
 * @property {number|null} [round_number]
 * @property {number|null} [old_score]
 * @property {number|null} [new_score]
 * @property {string|null} [competitor_name]
 * @property {string|null} [judge_name]
 * @property {string|null} [actor_name]
 * @property {string|null} [entity_type]
 * @property {string|null} [entity_name]
 * @property {Object|null} [metadata]
 */

// ---- /api/meets/:id/readiness-report ----------------------------

/**
 * @typedef {Object} MeetReadinessFederation
 * @property {string} org_id
 * @property {string} org_name
 * @property {string|null} [country_code]
 * @property {number} active_diver_count
 * @property {number} missing_dive_rows
 * @property {number} incomplete_diver_count
 */

/**
 * @typedef {Object} MeetReadinessEvent
 * @property {string} event_id
 * @property {string} event_name
 * @property {string} status
 * @property {boolean} ready
 * @property {Array<{key:string,label:string,hint:string,to:string,owner:string}>} blockers
 * @property {Object|null} next_action
 * @property {number} active_diver_count
 * @property {number} incomplete_diver_count
 * @property {number} missing_dive_rows
 * @property {number} judge_count
 * @property {number} required_judges
 * @property {number} late_arrival_pending_count
 * @property {number} synchro_pending_count
 * @property {MeetReadinessFederation[]} federations
 */

/**
 * @typedef {Object} MeetReadinessReport
 * @property {Object} meet
 * @property {Object} summary
 * @property {number} summary.event_count
 * @property {number} summary.ready_count
 * @property {number} summary.blocker_count
 * @property {number} summary.late_arrival_pending_count
 * @property {number} summary.synchro_pending_count
 * @property {number} summary.hard_conflict_count
 * @property {number} summary.soft_conflict_count
 * @property {MeetReadinessEvent[]} events
 * @property {Object[]} conflicts
 */

// ---- /api/events/:id/participation-requests ---------------------

/**
 * @typedef {Object} EventParticipationRequest
 * @property {string} id
 * @property {string} event_id
 * @property {string} org_id
 * @property {'pending'|'accepted'|'declined'|'cancelled'} status
 * @property {string} requested_at
 * @property {string|null} [responded_at]
 * @property {string|null} [note]
 * @property {string} org_name
 * @property {string|null} [country_code]
 * @property {string|null} [org_slug]
 * @property {string|null} [requested_by_name]
 * @property {string|null} [responded_by_name]
 */

/**
 * @typedef {Object} StandingsRow
 * One row of /api/scoreboard/:eventId standings. In a team event each
 * row is a team: full_name is the team name, competitor_id is null.
 *
 * @property {string|null}  [competitor_id]
 * @property {string}       full_name
 * @property {string}       [country_code]     Representation code, see the migration 090 note.
 *                                             Team rows: the code the team's divers share.
 * @property {string}       [club_name]        Team rows: the team short code.
 * @property {string}       [partner_name]
 * @property {string}       [partner_country]
 * @property {number}       total
 * @property {string}       public_id          See RosterRow.public_id.
 * @property {boolean}      is_tied_on_total   True when 2+ rows share this total
 *                                             but were separated by World Aquatics tie-break.
 */

/**
 * @typedef {Object} ScoreboardPanelRow
 * One judge row from /api/scoreboard/:eventId.panel.
 *
 * @property {string}      judge_id
 * @property {number}      judge_number
 * @property {string}      full_name
 * @property {string|null} [country_code]
 * @property {string}      org_name
 * @property {string|null} [club_name]
 * @property {string|null} [club_code]
 */

/**
 * @typedef {Object} ScoreboardUpcomingRow
 * One row from /api/scoreboard/:eventId.upcoming.
 *
 * @property {number}      round_number
 * @property {number}      round_order
 * @property {string}      competitor_id
 * @property {string|null} [partner_id]
 * @property {string}      full_name
 * @property {string|null} [country_code]
 * @property {string|null} [club_name]
 * @property {string|null} [partner_name]
 * @property {string|null} [partner_country]
 * @property {string|null} [team_name]
 * @property {string|null} [dive_code]
 * @property {string|null} [position]
 * @property {string|null} [description]
 * @property {number|string|null} [dd] PostgreSQL numeric fields may arrive as text.
 */

/**
 * @typedef {Object} ArchiveEventMeta
 * The `event` block of GET /api/archive/:eventId/results.
 *
 * @property {string}      name
 * @property {string}      [gender]
 * @property {string}      [height]
 * @property {number}      total_rounds
 * @property {number}      number_of_judges
 * @property {'individual'|'synchro_pair'|'team'} event_type
 * @property {string}      org_name
 * @property {'country'|'region'|'club'} represent_as  The meet's setting; 'country' outside a meet.
 * @property {?('state'|'province'|'home_nation'|'region')} region_label  What the org calls its regions, null = none.
 */

/**
 * @typedef {Object} ArchiveResultsPayload
 * GET /api/archive/:eventId/results, the completed-event recap.
 *
 * @property {ArchiveEventMeta} event
 * @property {StandingsRow[]}   standings  With rank; no public_id / is_tied_on_total here.
 * @property {Object[]}         dives
 * @property {ScoreboardPanelRow[]} panel
 * @property {ScoreboardRecordMark[]} records  Records this event's dives currently hold.
 */

/**
 * @typedef {Object} ScoreboardRecordMark
 * A record one of this event's dives currently holds. Rides on
 * GET /api/scoreboard/:eventId and GET /api/archive/:eventId/results as
 * `records`, and matches a dive by competitor_id + dive_code + position
 * + score. Personal bests and first marks never appear here.
 * @property {'club'|'region'|'federation'|'continental'} scope
 * @property {string}  scope_id     the book's club / region / org id, or the continent key
 * @property {string}  scope_code   club / region short code, country code, or the continent key
 * @property {string}  height       e.g. '3m'; with scope, scope_id, gender, dive_code and position it names the book
 * @property {boolean} official     false for an unclaimed region or country
 * @property {'Male'|'Female'} gender
 * @property {string}  competitor_id
 * @property {string}  dive_code
 * @property {string}  position
 * @property {number}  score
 * @property {number}  prev_score   the record this one beat
 */

/**
 * @typedef {Object} ScoreboardPayload
 * @property {StandingsRow[]}      standings
 * @property {Object[]}            history
 * @property {ScoreboardUpcomingRow[]} upcoming
 * @property {ScoreboardPanelRow[]} panel
 * @property {ScoreboardRecordMark[]} records
 */

// ---- /api/records ------------------------------------------------

/**
 * @typedef {Object} RecordRow
 * One row of GET /api/records (public). A bare array of these, sorted by
 * board height, dive code, position, then gender.
 *
 * @property {string}  id
 * @property {'personal'|'club'|'region'|'federation'|'continental'} scope
 * @property {string}  scope_id     uuid, or the continent key for 'continental'
 * @property {string}  scope_name   club / region / federation name, the continent, or the diver for 'personal'
 * @property {'Male'|'Female'|null} gender  Which book (migration 094). null = an old row that couldn't be resolved; the /records page hides those.
 * @property {string}  height       board_height, e.g. '3m'
 * @property {string}  dive_code
 * @property {string}  position     A / B / C / D
 * @property {string}  score        numeric, arrives as text
 * @property {string|null} prev_score  what this record beat; null for a first mark
 * @property {string}  set_at
 * @property {string|null} holder_id
 * @property {string|null} holder_name
 * @property {string|null} holder_country_code  the holder's federation country
 * @property {boolean} holder_deleted  the account is gone, so don't link /profile/:id
 * @property {string|null} event_id  null once the event is deleted
 * @property {string|null} event_name
 * @property {boolean} official     false for a region or country nobody has claimed yet
 * @property {string|null} book_org_id  the federation the club / region / national book belongs to; null for personal and continental
 * @property {string|null} dd       from the dive directory, arrives as text
 * @property {string|null} description
 */

/**
 * @typedef {Object} ActiveOrg
 * One row of GET /api/orgs/active (public).
 * @property {string}      id
 * @property {string}      name
 * @property {string|null} country_code
 * @property {string}      slug
 * @property {'africa'|'americas'|'asia'|'europe'|'oceania'|null} continent
 * @property {'claimed'|'unclaimed'} claim_state  unclaimed = a country account the clubs started (migration 087)
 */

// ---- /api/coach/events ------------------------------------------

/**
 * @typedef {Object} CoachEligibility
 * @property {boolean}     host_federation
 * @property {boolean}     invited_federation
 * @property {boolean}     can_submit
 * @property {boolean}     can_withdraw
 * @property {boolean}     read_only
 */

/**
 * @typedef {Object} CoachEventRow
 * @property {string}      event_id
 * @property {string}      event_name
 * @property {string}      height
 * @property {string}      event_type
 * @property {string}      status
 * @property {string|null} [meet_id]
 * @property {string|null} [meet_name]
 * @property {string|null} [entries_close_at]
 * @property {string|null} [dive_list_locks_at]
 * @property {number}      total_rounds
 * @property {number}      squad_entered_count
 * @property {CoachEligibility} coach_eligibility
 */

// ---- /api/coach/dive-lists/:event_id ----------------------------

/**
 * @typedef {Object} CoachDiveListDive
 * @property {number}      round_number
 * @property {string|null} [dive_id]
 * @property {string|null} [dive_code]
 * @property {string|null} [position]
 * @property {number|string|null} [dd] PostgreSQL numeric fields may arrive as text.
 * @property {string|null} [description]
 */

/**
 * @typedef {Object} CoachDiveListDiver
 * @property {string}      diver_id
 * @property {string}      full_name
 * @property {string|null} [country_code]
 * @property {string|null} [club_name]
 * @property {string|null} [club_code]
 * @property {string}      org_id
 * @property {CoachDiveListDive[]} dives
 * @property {string|null} [partner_id]
 * @property {string|null} [partner_name]
 * @property {string|null} [confirmed_at]
 * @property {string|null} [withdrawn_at]
 * @property {boolean}     is_reserve
 * @property {number|null} [reserve_position]
 * @property {CoachEligibility} coach_eligibility
 */

/**
 * @typedef {Object} CoachDiveListsResponse
 * @property {Object}      event
 * @property {string}      event.id
 * @property {string}      event.name
 * @property {string}      event.height
 * @property {string}      event.event_type
 * @property {string}      event.status
 * @property {number}      event.total_rounds
 * @property {Object|null} [event.round_rules]
 * @property {string|null} [event.entries_close_at]
 * @property {string|null} [event.dive_list_locks_at]
 * @property {string|null} [event.meet_id]
 * @property {string|null} [event.meet_name]
 * @property {CoachEligibility} event.coach_eligibility
 * @property {Array<{round_number:number,dive_id:string|null,height:number|null}>} event.prescribed_rounds
 * @property {CoachDiveListDiver[]} divers
 */

// ---- claims (lib/claims.js, migrations 089 + 092) -----------------

/**
 * @typedef {Object} Claim
 * One row of GET /api/claims. Withdrawn claims come back to their
 * claimant, and to anyone who could see them while they were live.
 *
 * @property {string}  id
 * @property {'org'|'region'} target_kind
 * @property {string}  target_name      the country's name for a national claim
 * @property {?string} region_code
 * @property {string}  org_name
 * @property {string}  country_code
 * @property {string}  body_name
 * @property {?string} website
 * @property {boolean} domain_verified
 * @property {string}  claimant_name
 * @property {string}  claimant_since
 * @property {'parent'|'clubs'|'regions'|'sysadmin'} approver
 * @property {'open'|'escalated'|'approved'|'rejected'|'withdrawn'|'revoked'} status
 * @property {?string} status_reason    English, shown as-is
 * @property {boolean} activated        false until the claimant verifies their email
 * @property {?string} closes_at
 * @property {string}  created_at
 * @property {{eligible: number, approvals: number, objections: number}} tally
 * @property {string[]} objections      reasons, sysadmin only (empty otherwise)
 * @property {boolean} mine
 * @property {{voter_id: string, name: string, vote: ?('approve'|'object')}[]} my_votes
 * @property {boolean} can_vote
 * @property {boolean} can_decide       only once activated
 * @property {boolean} can_revoke
 */

/**
 * @typedef {Object} ClaimRevokeResult
 * POST /api/claims/:id/revoke. Everything the revoke took back, so the
 * sysadmin can re-grant anything that should have stayed.
 *
 * @property {true} ok
 * @property {Object} removed
 * @property {{user_id: string, full_name: string, role: 'org_admin'|'meet_manager'|'referee'}[]} removed.org_roles
 *   referee only when granted since the approval by someone other than a sysadmin
 * @property {{user_id: string, full_name: string, club_id: string, club_name: string}[]} removed.club_admins
 * @property {{user_id: string, full_name: string, region_id: string, region_name: string}[]} removed.region_admins
 * @property {{user_id: string, full_name: string, event_id: string, event_name: string}[]} removed.event_managers
 *   event manager seats handed out (or held) under the claim since it was approved
 * @property {{id: string, body_name: string}[]} removed.region_claims
 *   region claims the federation approved, revoked along with it
 * @property {{id: string, name: string}[]} activated_clubs
 *   clubs that were waiting on the federation's approval (migration 096)
 *   and joined when the claim went; empty for a region claim
 */

// ---- guardians (migration 083) --------------------------------------

/**
 * @typedef {Object} GuardianSearchResult
 * GET /api/guardians/search?q=. Live members of the caller's own
 * federation, at least two characters of name, up to 20. Names and club
 * only; the link request checks the age.
 *
 * @property {string}  id
 * @property {string}  full_name
 * @property {?string} club_name
 */

/**
 * @typedef {Object} GuardianLink
 * GET /api/guardians/my-dependents. Approved links only, unless
 * ?include_pending=1, which the Dependents page passes (pending ones sort
 * last). POST /api/guardians/:id/revoke ends either kind.
 *
 * @property {string}  guardian_link_id
 * @property {'approved'|'pending'} status
 * @property {string}  id               the dependent's user id
 * @property {string}  username
 * @property {string}  full_name
 * @property {?string} date_of_birth
 */

// Force this file to be a module so import('@/types') works in
// editors that need an export to consider it an importable module.
export {}
