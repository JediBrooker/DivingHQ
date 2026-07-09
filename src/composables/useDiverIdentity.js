// useDiverIdentity: normalises the many ways a "diver row"
// surfaces across the API (roster row, history row, standings
// row, scoreboard upcoming row, completed-dive recap row…) into
// a single shape the SPA renders consistently. Every place that
// shows "person + affiliation" (Control Room history cards,
// Up Next tiles, Dive Order roster, the Scoreboard's Completed
// Dives + Standings + Up Next) reads the SAME derived fields
// so a layout tweak only has to land in one component.
//
// Returned shape:
//   {
//     leadName,       // primary diver name (always present)
//     partnerName,    // synchro partner's name, or null
//     badge,          // lead's affiliation chip text:
//                     //   country_code → team_code → club_code
//                     // first non-null wins. null when none set.
//     partnerBadge,   // partner's affiliation chip: populated
//                     // ONLY for synchro pairs whose partner has
//                     // a different country / club from the lead
//                     // (e.g. an international synchro pairing).
//                     // null when same as the lead so the
//                     // template doesn't render a duplicate chip.
//     teamName,       // team event entrant's team name. Rendered
//                     // as a purple chip-line by the "split"
//                     // variant; falls into `secondary` for the
//                     // "compact" variant. null when no team set.
//     clubName,       // club affiliation full name. Same field
//                     // both variants surface, but split renders
//                     // it as its own muted line beneath the
//                     // team chip whereas compact uses it only
//                     // when there's no team_name.
//     clubCode,       // short club code (e.g. "NZL-3"). Rendered
//                     // alongside clubName in split variant; not
//                     // included in the compact `secondary`.
//     secondary,      // back-compat one-liner for compact
//                     // callers (Up Next tiles, roster rows):
//                     //   team_name → club_name (never both)
//                     // null for synchro pairs because the
//                     // partner already occupies that slot.
//   }
//
// Pure data extraction, no side effects. Safe to call from a
// computed without binding to component lifetime.

export function diverIdentity(row) {
  if (!row) {
    return {
      leadName: '', partnerName: null,
      badge: null, partnerBadge: null,
      teamName: null, clubName: null, clubCode: null,
      secondary: null,
    }
  }
  // The lead's name surfaces under three different keys depending
  // on the call site:
  //   full_name      : roster + history + standings rows
  //   name           : Control Room's local history-card shape
  //                    (built by addHistoryCard)
  //   diverName      : Control Room's currentActive shape (the
  //                    set_active_diver socket payload)
  // Coalesce so consumers don't have to know which API gave
  // them the row.
  const leadName = row.full_name || row.name || row.diverName || ''
  const partnerName = row.partner_name || null

  // Affiliation chip fallback chain: country wins because most
  // events are international, then team_code (relevant in team
  // events), then club_code (used by club-only meets).
  const badge =
    row.country_code ||
    row.team_code ||
    row.club_code ||
    null

  // Partner's affiliation. The API exposes partner_country today;
  // partner_club_code is exposed where available too (history +
  // roster rows). For team events we don't show a partner chip
  // because both divers share the same team_code already pinned
  // as the lead's chip, would just be a duplicate.
  const partnerAffiliation = partnerName
    ? (row.partner_country || row.partner_club_code || null)
    : null
  // Only surface the partner chip when it actually differs from
  // the lead's (international synchro pair, or two divers from
  // different clubs in a club-only meet). Same chip on both
  // names is redundant, so let the single chip carry both.
  const partnerBadge =
    partnerAffiliation && partnerAffiliation !== badge
      ? partnerAffiliation
      : null

  // Affiliation lines: surfaced separately so the "split"
  // variant can render team_name as a purple chip-line and
  // club_name + club_code as its own muted line beneath. We
  // expose these for synchro pairs too: the partner name still
  // takes its own line above (handled by the template), but
  // the lead's club still gets surfaced. Hiding it for synchro
  // dropped the affiliation entirely from synchro history
  // cards, which made it impossible tell which club a pair
  // represents at a glance.
  const teamName = row.team_name || null
  const clubName = row.club_name || null
  const clubCode = row.club_code || null

  // Compact one-liner for callers that only want a single
  // muted line (Up Next tiles, roster rows, scoreboard
  // standings).
  //
  // For synchro pairs we fall through to the club_name: the
  // partner row already takes the team-or-club slot in
  // the compact layout, so without this extra line a synchro
  // pair would surface zero affiliation info beyond the
  // single country chip top-right. team_name is rare on
  // synchro entries (synchro is its own event_type, not a
  // team variant) so club_name is the practical fallback.
  const secondary = partnerName
    ? (clubName || null)
    : (teamName || clubName || null)

  return {
    leadName, partnerName,
    badge, partnerBadge,
    teamName, clubName, clubCode,
    secondary,
  }
}
