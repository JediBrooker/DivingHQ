// Group a meet's events into progression ROWS for the aligned grid.
//
// A row is one discipline (e.g. "Men's 3m Springboard"); its
// progression stages — preliminary → semifinal → final, in
// progression order — become the ordinal columns. A straight final
// is a single-stage row occupying the first column.
//
// Two source shapes feed this:
//   * scoreboard — live `events` rows. Stages are linked
//     STRUCTURALLY via parent_event_id and labelled by
//     event_format, so grouping is reliable.
//   * archive — DiveRecorder `dr_events` rows. There's no
//     structural link, only a `phase` string best-effort parsed
//     from the event name, so we group by the discipline name
//     (with the phase suffix stripped) and order by phase. Fuzzier
//     by nature — a stray un-grouped stage is possible.
//
// Both return { rows, maxCols } where each row is:
//   { key, discipline, tags:[{text,cyan?}],
//     stages:[{ id, label, status:'live'|'final'|null, count }] }
// ordered first→last column, and maxCols is the widest row's stage
// count (so the grid lines up across rows).

// Progression order — lower rank = earlier stage = leftmost column.
const FORMAT_RANK = {
  preliminary: 0, super_final_h2h: 0,
  semifinal: 1,   super_final_semi: 1,
  final: 2,       super_final_final: 2,
}
const FORMAT_LABEL = {
  preliminary: 'Prelim', semifinal: 'Semi', final: 'Final',
  super_final_h2h: 'H2H', super_final_semi: 'SF Semi', super_final_final: 'SF Final',
}

// DiveRecorder phase strings → rank + short label. Unknown phases
// sort to the end and keep their raw label.
const PHASE_RANK = {
  preliminary: 0, prelim: 0, prelims: 0,
  quarterfinal: 0.5, 'quarter-final': 0.5, quarter: 0.5,
  semifinal: 1, 'semi-final': 1, semi: 1, semifinals: 1,
  final: 2, finals: 2, 'grand final': 2,
}
function phaseKey(phase) { return String(phase || '').trim().toLowerCase() }
function phaseRank(phase) {
  const r = PHASE_RANK[phaseKey(phase)]
  return r == null ? 3 : r
}
function phaseLabel(phase) {
  const p = String(phase || '').trim()
  if (!p) return 'Result'
  const k = p.toLowerCase()
  if (k.startsWith('prelim')) return 'Prelim'
  if (k.startsWith('quarter')) return 'Quarter'
  if (k.startsWith('semi')) return 'Semi'
  if (k === 'final' || k === 'finals') return 'Final'
  return p
}

// "Men's 3m Springboard — Final" → "Men's 3m Springboard". Straight
// finals carry no suffix and pass through unchanged.
function baseScoreboardName(name) {
  if (!name) return ''
  const stripped = name.replace(
    /\s*[—–-]\s*(preliminary|semi-?final|final|prelim|semi|quarter-?final|h2h|head-to-head)\s*$/i,
    '',
  ).trim()
  return stripped || name.trim()
}
// "Girls Group B 3m, Final" → "Girls Group B 3m".
function baseArchiveName(name, phase) {
  if (!name) return ''
  let base = name
  if (phase) {
    const esc = String(phase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    base = base.replace(new RegExp(',\\s*' + esc + '\\s*$', 'i'), '')
  }
  base = base.replace(/,\s*(preliminary|semi-?final|final|prelim|semi|quarter-?final)\s*$/i, '')
  return base.trim() || name.trim()
}

function scoreboardTags(e) {
  const tags = []
  if (e.gender) tags.push({ text: e.gender })
  if (e.height) tags.push({ text: e.height })
  if (e.total_rounds != null) tags.push({ text: `${e.total_rounds} rds` })
  if (e.number_of_judges != null) tags.push({ text: `${e.number_of_judges}j` })
  if (e.event_type === 'synchro_pair') tags.push({ text: 'Synchro', cyan: true })
  else if (e.event_type === 'team') tags.push({ text: 'Team', cyan: true })
  return tags
}
function archiveTags(e) {
  const tags = []
  if (e.gender) tags.push({ text: e.gender })
  if (e.height) tags.push({ text: e.height })
  return tags
}

function withMaxCols(rows) {
  const maxCols = rows.reduce((m, r) => Math.max(m, r.stages.length), 1)
  return { rows, maxCols }
}

// ---- Scoreboard (live events table) ----
export function groupScoreboardEvents(events) {
  const list = Array.isArray(events) ? events : []
  const byId = new Map(list.map(e => [String(e.id), e]))
  // Resolve each event to its chain-root id by walking parent links.
  // A straight final (no in-list parent) is its own root. The guard
  // caps pathological cycles.
  const rootId = (e) => {
    let cur = e, guard = 0
    while (cur && cur.parent_event_id && byId.has(String(cur.parent_event_id)) && guard++ < 16) {
      cur = byId.get(String(cur.parent_event_id))
    }
    return String(cur.id)
  }
  const groups = new Map()
  for (const e of list) {
    const key = rootId(e)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  const rows = []
  for (const [key, evs] of groups) {
    evs.sort((a, b) =>
      (FORMAT_RANK[a.event_format] ?? 2) - (FORMAT_RANK[b.event_format] ?? 2)
      || new Date(a.created_at || 0) - new Date(b.created_at || 0),
    )
    const lead = evs[0]
    rows.push({
      key,
      discipline: baseScoreboardName(lead.name),
      tags: scoreboardTags(lead),
      stages: evs.map(e => ({
        id: e.id,
        label: FORMAT_LABEL[e.event_format] || 'Final',
        status: e.status === 'Live' ? 'live' : e.status === 'Upcoming' ? 'upcoming' : 'final',
        count: e.competitor_count || 0,
      })),
    })
  }
  // Live disciplines float to the top, then alphabetical.
  rows.sort((a, b) => {
    const aLive = a.stages.some(s => s.status === 'live')
    const bLive = b.stages.some(s => s.status === 'live')
    if (aLive && !bLive) return -1
    if (bLive && !aLive) return 1
    return a.discipline.localeCompare(b.discipline)
  })
  return withMaxCols(rows)
}

// ---- Archive (DiveRecorder dr_events) ----
export function groupArchiveEvents(events) {
  const list = Array.isArray(events) ? events : []
  const groups = new Map()
  for (const e of list) {
    const base = baseArchiveName(e.name, e.phase)
    const key = base.toLowerCase()
    if (!groups.has(key)) groups.set(key, { discipline: base, evs: [] })
    groups.get(key).evs.push(e)
  }
  const rows = []
  for (const [key, g] of groups) {
    g.evs.sort((a, b) =>
      phaseRank(a.phase) - phaseRank(b.phase)
      || String(a.name || '').localeCompare(String(b.name || '')),
    )
    rows.push({
      key,
      discipline: g.discipline,
      tags: archiveTags(g.evs[0]),
      stages: g.evs.map(e => ({
        id: e.id,
        label: phaseLabel(e.phase),
        status: null,                 // historical — no live/final badge
        count: e.result_count || 0,
      })),
    })
  }
  // Preserve source order (Map insertion = first occurrence per
  // discipline, which follows the sheet's event order).
  return withMaxCols(rows)
}
