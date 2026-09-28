// The set_active_diver payload, both ends of it.
//
// The Control Room builds it from a roster row; the judge screen and the
// spectator scoreboard read it back off state_update. Both readers render
// diverName / diveCode / eventName, which the roster row doesn't have, so
// the builder adds them. The old all-in-one Control Room did this inline,
// and the Stage-Rail rewrite lost it: judges sat on "Waiting for next
// diver" all meet and the Current Performer block was blank.
//
// normaliseActiveDiver is the reader's half. event_live_state keeps the
// last payload per event and the server replays it after a restart, so a
// payload written by the broken build can still turn up. Filling the
// display fields from the raw row means those render too.
//
// Plain JS, no Vue, so the node:test suite can import it straight.

function diveCodeOf(row) {
  if (!row || !row.dive_code) return null
  return `${row.dive_code}${row.position || ''}`
}

export function activeDiverPayload(row, event) {
  if (!row) return null
  return {
    ...row,
    diverName: row.full_name || null,
    diveCode: diveCodeOf(row),
    eventName: (event && event.name) || null,
    // null rather than '' so the audience views' v-if hides a missing
    // description or position instead of rendering an empty line
    description: row.description || null,
    position: row.position || null,
    competitor_id: row.competitor_id || null,
    partner_id: row.partner_id || null,
    country_code: row.country_code || null,
    club_name: row.club_name || null,
    club_code: row.club_code || null,
    status: 'ready',
  }
}

export function normaliseActiveDiver(data) {
  if (!data || typeof data !== 'object') return data
  const out = { ...data }
  if (!out.diverName && out.full_name) out.diverName = out.full_name
  if (!out.diveCode) out.diveCode = diveCodeOf(out)
  return out
}
