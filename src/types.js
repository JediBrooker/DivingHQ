// Shared API response shapes as JSDoc typedefs. Vue files (and any
// modern editor or AI agent) pick these up via:
//
//   /** @type {import('@/types').DiverProfile} */
//
// or by writing JSDoc on a variable. There's no runtime export — this
// file exists purely so editors and code-completion can answer
// "what's on this object?" without grepping through server.js.
//
// Keep this in sync with the actual response builders in server.js.
// AGENTS.md lists this file in the "When you change X, also check Y"
// table — please honour that.

// ---- core ---------------------------------------------------------

/**
 * @typedef {Object} JwtPayload
 * The decoded JWT, attached to req.user by verifyToken on the server,
 * and exposed via auth.user (a computed) on the client.
 *
 * @property {string}   id              UUID — DO NOT call this user_id.
 * @property {string}   username
 * @property {string}   full_name
 * @property {string}   org_id          Primary org of the user.
 * @property {string[]} org_roles       e.g. ['org_admin', 'meet_manager', 'judge', 'coach', 'diver', 'spectator']
 * @property {boolean}  is_system_admin
 * @property {number}   iat             issued-at, set by jsonwebtoken
 * @property {number}   exp             expiry, set by jsonwebtoken
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
 * @property {string}      created_at  ISO timestamp
 * @property {number}      attempts
 */

/**
 * @typedef {Object} ScoreTrendRow
 * @property {string}        event_id
 * @property {string}        event_name
 * @property {string}        [height]
 * @property {string}        [gender]
 * @property {string}        status        'pending' | 'live' | 'completed'
 * @property {string}        created_at    ISO
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
 * @property {string}      created_at
 * @property {number}      total
 * @property {number}      rank        Diver's finishing place in this meet.
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
 * @property {number} deficient
 * @property {number} unsatisfactory
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
 * @property {number}      year
 * @property {number}      meets
 * @property {number|null} avg_meet_total
 * @property {number|null} best_meet_total
 * @property {number}      wins
 * @property {number}      podiums
 */

// ---- /api/events/:id/roster --------------------------------------

/**
 * @typedef {Object} RosterRow
 * Row returned by the roster endpoint and used by the Control Room
 * queue. Every row is one (competitor, round, dive) tuple.
 *
 * @property {string}      dive_list_id      cdl.id — target for reorder/withdraw
 * @property {number|null} display_order
 * @property {string|null} withdrawn_at      ISO timestamp or null
 * @property {string}      competitor_id
 * @property {string}      full_name
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
 * @typedef {Object} StandingsRow
 * One row of /api/scoreboard/:eventId standings.
 *
 * @property {string}       full_name
 * @property {string}       [country_code]
 * @property {string}       [club_name]
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
 * @typedef {Object} ScoreboardPayload
 * @property {StandingsRow[]}      standings
 * @property {Object[]}            history
 * @property {ScoreboardUpcomingRow[]} upcoming
 * @property {ScoreboardPanelRow[]} panel
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

// Force this file to be a module so import('@/types') works in
// editors that need an export to consider it an importable module.
export {}
