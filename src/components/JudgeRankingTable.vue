<script setup>
/* JudgeRankingTable: "what would the standings have been if every
 * judge had scored unanimously like one specific judge?"
 *
 * For a Completed event, renders a matrix:
 *   rows    = competing entities, ordered by their actual rank:
 *               individual events → divers
 *               synchro_pair      → pairs (lead + partner)
 *               team              → teams
 *   columns = Actual (rank + total) + one column per judge
 *   cells   = rank under that judge's hypothetical unanimous panel,
 *             with the hypothetical total on a second line so the
 *             magnitude is visible without hovering
 *
 * Outliers (any judge whose hypothetical rank differs from the
 * actual rank) get highlighted in cyan so a viewer can scan the
 * matrix and spot every disagreement at a glance. The v-tip
 * tooltip carries the same info plus context (delta from actual,
 * judge identity).
 *
 * Payload is fetched eagerly on mount. The parent (ScoreboardView)
 * consumes the same payload via the `loaded` event to feed the
 * chip-tooltip enhancement, so we don't hit the endpoint twice.
 */
import { ref, onMounted, computed, watch } from 'vue'
import { ordinal } from '@/lib/format'

// Two ways this component can get its data:
//
//   1. Parent passes `payload` as a prop (preferred, since the parent
//      has already fetched eagerly so the chip-tooltip data is
//      available on first paint of the page, regardless of
//      whether this section is expanded).
//   2. Parent omits the prop → fall back to fetching internally
//      (Control Room modal still works that way).
const props = defineProps({
  eventId: { type: [String, Number], required: true },
  payload: { type: Object, default: null },
})

const emit = defineEmits(['loaded'])

const loading = ref(false)
const error = ref('')
const localPayload = ref(null)
const payloadView = computed(() => props.payload || localPayload.value)

async function load() {
  // Skip the fetch when the parent already handed us the data.
  if (props.payload) {
    emit('loaded', props.payload)
    return
  }
  if (!props.eventId) return
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/events/${props.eventId}/judge-ranking-analysis`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Failed (${res.status})`)
    }
    localPayload.value = await res.json()
    emit('loaded', localPayload.value)
  } catch (err) {
    error.value = err.message || 'Failed to load judge ranking analysis'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.eventId, load)
watch(() => props.payload, (v) => { if (v) emit('loaded', v) })

const judges = computed(() => payloadView.value?.judges || [])
const divers = computed(() => payloadView.value?.divers || [])
const eventType = computed(() => payloadView.value?.event?.event_type || 'individual')
const numJudges = computed(() => payloadView.value?.event?.number_of_judges || judges.value.length)

// Synchro role assignment per WA Article 13. Mirrors
// src/composables/useScoreCategories.js synchroJudgeGroups so the
// table groups judges identically to how the scoreboard already
// renders synchro chip groups.
function synchroRoleFor(judgeNumber) {
  const n = numJudges.value
  if (eventType.value !== 'synchro_pair') return null
  if (n === 9) {
    if (judgeNumber <= 2) return 'a'
    if (judgeNumber <= 4) return 'b'
    return 'sync'
  }
  if (n === 11) {
    if (judgeNumber <= 3) return 'a'
    if (judgeNumber <= 6) return 'b'
    return 'sync'
  }
  return null
}

// Group judges by synchro role for the segregated sub-tables.
// Each segment renders its OWN matrix so the "what would the
// standings be if every judge had scored like J" comparison only
// pits same-role judges against same-role judges (Exec A judges
// only see Diver A's execution; the cross-role comparison the
// previous version surfaced was meaningless).
const synchroSegments = computed(() => {
  if (eventType.value !== 'synchro_pair') return null
  const groups = { a: [], b: [], sync: [] }
  for (const j of judges.value) {
    const r = synchroRoleFor(j.judge_number)
    if (r && groups[r]) groups[r].push(j)
  }
  return [
    { role: 'a',    label: 'Exec A — Diver A execution', judges: groups.a },
    { role: 'b',    label: 'Exec B — Diver B execution', judges: groups.b },
    { role: 'sync', label: 'Synchronisation',            judges: groups.sync },
  ].filter((g) => g.judges.length > 0)
})

// Raw per-judge per-round WA dive-points (= score × DD × 3/5; the
// server bakes in DD and the 0.6 synchro factor). Keyed
// judge_id:competitor_id:round. This is what the synchro segments
// trim by, so the role sub-totals follow the rulebook exactly.
const perDiveRanks = computed(() => payloadView.value?.per_dive_ranks || {})
const totalRounds = computed(() => Number(payloadView.value?.event?.total_rounds) || 0)
function divePointsOf(judgeId, competitorId, round) {
  const e = perDiveRanks.value[`${judgeId}:${competitorId}:${round}`]
  return e && e.judge_dive_points != null ? Number(e.judge_dive_points) : null
}
// WA per-role cancellation: drop one highest + one lowest, sum the
// rest (heads up: ≤2 values means there's nothing to cancel).
// Trimming the dive-points is equivalent to trimming the raw awards
// since DD is constant within a (pair, round).
function trimmedSum(vals) {
  if (vals.length <= 2) return vals.reduce((a, b) => a + b, 0)
  const sorted = [...vals].sort((a, b) => a - b)
  return sorted.slice(1, -1).reduce((a, b) => a + b, 0)
}
// Awards KEPT in a role after the WA hi/lo cancellation: 3 of the 5
// synchronisation judges; 1 of each execution sub-panel.
function roleKeptCount(role) {
  return role === 'sync' ? 3 : 1
}
// RANK() semantics with ties: sort rows by val() DESC (official
// order as the tie-break), then write the rank back via set().
function rankInto(rows, val, set) {
  const sorted = [...rows].sort((a, b) =>
    val(b) - val(a) || (a.diver.actual_rank - b.diver.actual_rank))
  let prev = null, prevRank = 0
  sorted.forEach((r, idx) => {
    if (prev != null && Math.abs(val(r) - prev) < 1e-9) set(r, prevRank)
    else { set(r, idx + 1); prevRank = idx + 1 }
    prev = val(r)
  })
}
// Per-segment rows, computed straight from the per-dive WA points.
//   • segment_actual_total = the role's WA contribution to the pair
//     total: Σ over rounds of (the role's awards, hi/lo cancelled,
//     summed). Exec A + Exec B + Sync therefore add up to the real
//     pair total.
//   • cells[judge_id] = "if every judge in THIS role scored like J":
//     kept-count × that judge's own dive-points total. Ranked within
//     the segment so each sub-table is self-contained.
function segmentRows(segment) {
  const rounds = totalRounds.value
  const kept = roleKeptCount(segment.role)
  const rows = divers.value.map((d) => {
    let actual = 0
    const cells = {}
    for (let rnd = 1; rnd <= rounds; rnd++) {
      const pts = segment.judges
        .map((j) => divePointsOf(j.judge_id, d.competitor_id, rnd))
        .filter((v) => v != null)
      if (pts.length) actual += trimmedSum(pts)
    }
    for (const j of segment.judges) {
      let sum = 0, any = false
      for (let rnd = 1; rnd <= rounds; rnd++) {
        const p = divePointsOf(j.judge_id, d.competitor_id, rnd)
        if (p != null) { sum += p; any = true }
      }
      cells[j.judge_id] = { total: any ? kept * sum : null, rank: null }
    }
    return { diver: d, segment_actual_total: actual, cells }
  })
  rankInto(rows, (r) => r.segment_actual_total,
    (r, rank) => { r.segment_actual_rank = rank })
  for (const j of segment.judges) {
    rankInto(
      rows.filter((r) => r.cells[j.judge_id].total != null),
      (r) => r.cells[j.judge_id].total,
      (r, rank) => { r.cells[j.judge_id].rank = rank },
    )
  }
  return rows
}
// Tooltip for a synchro segment cell (role-scoped hypothetical).
function segCellTip(diver, judge, cell, segment) {
  const role = segment.label.split(' — ')[0]
  if (!cell || cell.rank == null) return `J${judge.judge_number} — no ${role} score`
  return [
    `J${judge.judge_number}${judge.full_name ? ` — ${judge.full_name}` : ''} · ${role}`,
    `If all ${role} judges scored like this → ranks ${entityLabel(diver)} ${ordinal(cell.rank)}`,
    `${role} total: ${Number(cell.total).toFixed(2)}`,
  ].join('\n')
}

// Outlier = any judge whose hypothetical rank disagrees with the
// actual rank. A 1-rank swap is a real signal in this format, so
// every disagreement gets flagged and the viewer can scan the
// matrix to see exactly where judges disagreed. Cell background
// tone (light cyan for ±1, deep cyan for ≥2) shows the strength of
// the disagreement at a glance.
function isOutlier(pj, actualRank) {
  if (pj?.rank == null) return false
  return pj.rank !== actualRank
}
function outlierStrength(pj, actualRank) {
  if (pj?.rank == null) return ''
  const delta = Math.abs(pj.rank - actualRank)
  if (delta === 0) return ''
  return delta >= 2 ? 'jra-outlier-strong' : 'jra-outlier-mild'
}

// Composite label for a row's competing entity, handles all
// three event types so the table doesnt need branches in the
// template. Individual → diver name. Synchro pair → "Lead &
// Partner". Team → team name (already in full_name from the
// server side).
function entityLabel(d) {
  if (d.partner_name) return `${d.full_name} & ${d.partner_name}`
  return d.full_name
}

// Per-judge cell lookup for the synchro sub-tables. The single-
// matrix branch uses index-aligned per_judge[idx]; the segmented
// branch picks judges by id (since each segment only includes a
// subset of the panel).
function perJudgeOf(diver, judge) {
  if (!diver || !judge) return null
  return diver.per_judge.find((p) => p.judge_id === judge.judge_id) || null
}

// Tooltip composer for a per-judge cell. v-tip renders \n as
// newlines (white-space: pre-line in src/styles/app.css).
function cellTip(diver, judge, pj) {
  if (!pj || pj.rank == null) return `J${judge.judge_number} — no score for this entity`
  const parts = []
  parts.push(`J${judge.judge_number}${judge.full_name ? ` — ${judge.full_name}` : ''}`)
  parts.push(`Would rank ${entityLabel(diver)} ${ordinal(pj.rank)}`)
  parts.push(`Hypothetical total: ${Number(pj.judge_total).toFixed(2)}`)
  if (isOutlier(pj, diver.actual_rank)) {
    const delta = Math.abs(pj.rank - diver.actual_rank)
    parts.push(`(differs from actual by ${delta} position${delta === 1 ? '' : 's'})`)
  }
  return parts.join('\n')
}

// Tooltip for the Actual column, just explains it's the official total.
function actualTip(diver) {
  return `Official rank: ${ordinal(diver.actual_rank)}\n`
    + `Panel-trimmed total: ${Number(diver.actual_total).toFixed(2)}`
}

// URLs for the export buttons. CSV / PDF endpoints share the same
// path prefix with .csv / .pdf suffixes, same convention as the
// existing /api/events/:id/results.csv / .pdf.
const csvHref = computed(() => `/api/events/${props.eventId}/judge-ranking-analysis.csv`)
const pdfHref = computed(() => `/api/events/${props.eventId}/judge-ranking-analysis.pdf`)
</script>

<template>
  <div class="jra-root">
    <div class="jra-header">
      <div class="jra-title-block">
        <div class="jra-title">Judge Ranking Analysis</div>
        <div class="jra-subtitle">
          Each column shows the rank each
          {{ eventType === 'team' ? 'team' :
             eventType === 'synchro_pair' ? 'pair' :
             'diver' }} would hold if every judge had scored
          unanimously like that one judge. Cells where a judge
          disagrees with the actual rank are highlighted in blue.
        </div>
      </div>
      <div class="jra-actions" v-if="payloadView && !error">
        <a class="jra-btn" :href="csvHref" v-tip="'Download CSV'">CSV</a>
        <a class="jra-btn" :href="pdfHref" v-tip="'Download PDF'">PDF</a>
      </div>
    </div>

    <div v-if="loading" class="jra-skeleton" aria-live="polite">
      Loading judge ranking analysis…
    </div>

    <div v-else-if="error" class="jra-error">
      {{ error }}
    </div>

    <div v-else-if="!divers.length || !judges.length" class="jra-empty">
      No scored dives to analyse.
    </div>

    <!-- Synchro: three sub-tables, one per WA role group (Exec A
         / Exec B / Sync). Same-role judges only compared to
         same-role judges; each sub-table's "Actual" column is
         the rank derived from that role's totals alone. -->
    <template v-else-if="synchroSegments && synchroSegments.length">
      <div v-for="seg in synchroSegments" :key="seg.role"
           :class="['jra-segment', `jra-segment-${seg.role}`]">
        <div class="jra-segment-head">{{ seg.label }}</div>
        <div class="jra-scroll">
          <table class="jra-table">
            <thead>
              <tr>
                <th class="jra-th jra-th-diver">Pair</th>
                <th class="jra-th jra-th-actual"
                    v-tip.fixed="`Rank by this sub-panel's trimmed total — ${seg.label}`">Actual</th>
                <th v-for="j in seg.judges" :key="j.judge_id"
                    class="jra-th jra-th-judge"
                    v-tip.fixed="`J${j.judge_number} — ${j.full_name || ''}${j.country_code ? ' · ' + j.country_code : ''}`">
                  <span class="jra-judge-num">J{{ j.judge_number }}</span>
                  <span class="jra-judge-name">{{ j.full_name || '' }}</span>
                  <span v-if="j.country_code" class="jra-judge-cc">{{ j.country_code }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in segmentRows(seg)"
                  :key="(row.diver.team_id || row.diver.competitor_id) + '-' + seg.role"
                  class="jra-row">
                <td class="jra-td jra-td-diver">
                  <div class="jra-diver-name">
                    <RouterLink v-if="row.diver.competitor_id"
                                :to="`/profile/${row.diver.competitor_id}`"
                                class="jra-diver-link">{{ row.diver.full_name }}</RouterLink>
                    <template v-if="row.diver.partner_name">
                      <span class="jra-diver-amp">&amp;</span>
                      <RouterLink v-if="row.diver.partner_id"
                                  :to="`/profile/${row.diver.partner_id}`"
                                  class="jra-diver-link">{{ row.diver.partner_name }}</RouterLink>
                      <template v-else>{{ row.diver.partner_name }}</template>
                    </template>
                    <span v-if="row.diver.country_code" class="jra-diver-cc">{{ row.diver.country_code }}</span>
                  </div>
                  <div v-if="row.diver.club_name" class="jra-diver-club">{{ row.diver.club_name }}</div>
                </td>
                <td class="jra-td jra-td-actual">
                  <span class="jra-chip">
                    <span class="jra-actual-rank">{{ row.segment_actual_rank ?? '—' }}</span>
                    <span class="jra-actual-total">{{ Number(row.segment_actual_total || 0).toFixed(1) }}</span>
                  </span>
                </td>
                <td v-for="j in seg.judges" :key="j.judge_id"
                    :class="['jra-td', 'jra-td-cell',
                             outlierStrength(row.cells[j.judge_id], row.segment_actual_rank)]"
                    v-tip.fixed="segCellTip(row.diver, j, row.cells[j.judge_id], seg)">
                  <span class="jra-chip">
                    <span class="jra-cell-rank">{{ row.cells[j.judge_id]?.rank ?? '—' }}</span>
                    <span v-if="row.cells[j.judge_id] && row.cells[j.judge_id].total != null"
                          class="jra-cell-total">{{ Number(row.cells[j.judge_id].total).toFixed(1) }}</span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- Individual / team / synchro-without-recognised-panel:
         single matrix. -->
    <div v-else class="jra-scroll">
      <table class="jra-table">
        <thead>
          <tr>
            <th class="jra-th jra-th-diver">{{
              eventType === 'team' ? 'Team' :
              eventType === 'synchro_pair' ? 'Pair' : 'Diver'
            }}</th>
            <th class="jra-th jra-th-actual" v-tip.fixed="'Official panel-trimmed standings'">Actual</th>
            <th
              v-for="j in judges"
              :key="j.judge_id"
              class="jra-th jra-th-judge"
              v-tip.fixed="`J${j.judge_number} — ${j.full_name || ''}${j.country_code ? ' · ' + j.country_code : ''}`">
              <span class="jra-judge-num">J{{ j.judge_number }}</span>
              <span class="jra-judge-name">{{ j.full_name || '' }}</span>
              <span v-if="j.country_code" class="jra-judge-cc">{{ j.country_code }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in (divers || [])"
              :key="d.team_id || d.competitor_id"
              class="jra-row">
            <td class="jra-td jra-td-diver">
              <div class="jra-diver-name">
                <RouterLink v-if="d.competitor_id && !d.team_id"
                            :to="`/profile/${d.competitor_id}`"
                            class="jra-diver-link">{{ d.full_name }}</RouterLink>
                <template v-else>{{ d.full_name }}</template>
                <template v-if="d.partner_name">
                  <span class="jra-diver-amp">&amp;</span>
                  <RouterLink v-if="d.partner_id"
                              :to="`/profile/${d.partner_id}`"
                              class="jra-diver-link">{{ d.partner_name }}</RouterLink>
                  <template v-else>{{ d.partner_name }}</template>
                </template>
                <span v-if="d.country_code" class="jra-diver-cc">{{ d.country_code }}</span>
              </div>
              <div v-if="d.club_name" class="jra-diver-club">{{ d.club_name }}</div>
            </td>
            <td class="jra-td jra-td-actual" v-tip.fixed="actualTip(d)">
              <span class="jra-chip">
                <span class="jra-actual-rank">{{ d.actual_rank }}</span>
                <span class="jra-actual-total">{{ Number(d.actual_total).toFixed(1) }}</span>
              </span>
            </td>
            <td
              v-for="(pj, idx) in d.per_judge"
              :key="judges[idx]?.judge_id || idx"
              :class="['jra-td', 'jra-td-cell',
                       outlierStrength(pj, d.actual_rank)]"
              v-tip.fixed="cellTip(d, judges[idx], pj)">
              <span class="jra-chip">
                <span class="jra-cell-rank">{{ pj?.rank ?? '—' }}</span>
                <span v-if="pj?.judge_total != null"
                      class="jra-cell-total">{{ Number(pj.judge_total).toFixed(1) }}</span>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.jra-root {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.jra-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.jra-title-block { display: flex; flex-direction: column; gap: 0.25rem; flex: 1 1 320px; }
.jra-title {
  font-family: var(--font-display, inherit);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--cyan, #06b6d4);
}
.jra-subtitle {
  font-size: 12px;
  color: var(--text-3, #94a3b8);
  line-height: 1.4;
  max-width: 60ch;
}
.jra-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
.jra-btn {
  font-family: var(--font-display, inherit);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 0.4rem 0.9rem;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid rgba(6, 182, 212, 0.4);
  background: rgba(6, 182, 212, 0.08);
  color: var(--cyan, #06b6d4);
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}
.jra-btn:hover {
  background: var(--cyan, #06b6d4);
  color: var(--bg, #0f172a);
}
.jra-skeleton, .jra-error, .jra-empty {
  padding: 1rem;
  text-align: center;
  font-size: 13px;
  color: var(--text-3, #94a3b8);
  background: var(--surface-2);
  border-radius: var(--radius-sm, 4px);
}
.jra-error { color: var(--amber, #f59e0b); }
.jra-scroll {
  /* Wide events (11-judge panels) overflow a narrow viewport;
     allow horizontal scroll rather than collapsing the table or
     wrapping cells unreadably. */
  overflow-x: auto;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: var(--radius-sm, 4px);
}
.jra-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.jra-th, .jra-td {
  padding: 0.5rem 0.6rem;
  text-align: center;
  vertical-align: middle;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}
.jra-th {
  font-family: var(--font-display, inherit);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cyan, #06b6d4);
  background: var(--surface-2);
  position: sticky;
  top: 0;
}
.jra-th-diver { text-align: start; min-width: 180px; }
.jra-th-actual { min-width: 70px; }
.jra-th-judge {
  display: table-cell;
  min-width: 56px;
  line-height: 1.2;
}
.jra-judge-num { display: block; color: var(--cyan, #06b6d4); font-size: 11px; }
.jra-judge-name {
  display: block;
  font-size: 9px;
  font-weight: 400;
  color: var(--text-3, #94a3b8);
  letter-spacing: 0.03em;
  text-transform: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12ch;
  /* Centre the capped-width name block under the J# label (a bare
     max-width block left-aligns in the cell otherwise). */
  margin-inline: auto;
}
.jra-judge-cc {
  display: block;
  font-size: 9px;
  color: var(--text-4, #64748b);
  letter-spacing: 0.05em;
}
.jra-td-diver { text-align: start; }
.jra-diver-name {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-weight: 600;
  color: var(--text-1, #f1f5f9);
}
.jra-diver-link { color: inherit; text-decoration: none; }
.jra-diver-link:hover { color: var(--cyan, #06b6d4); }
.jra-diver-cc {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-3, #94a3b8);
}
.jra-diver-club {
  font-size: 10px;
  color: var(--text-4, #64748b);
  margin-top: 0.1rem;
}
.jra-td-actual {
  /* Stays display: table-cell (from .jra-td) so it lands under the
     ACTUAL header; the inner .jra-chip carries the rank + total on a
     shared baseline, centred by the inherited text-align. */
  font-weight: 600;
  color: var(--text-1, #f1f5f9);
}
/* Score chip, same visual vocabulary as the Control Room / Scoreboard
   .j-score / .hist-score chips: prominent dark text on a subtle
   filled surface, bordered, tabular figures. Lives on an INNER span
   so the <td> stays display: table-cell and the judge columns keep
   their grid alignment. The flex `gap` gives us the rank↔total
   spacing (replacing the old per-element margin-inline-end hack). */
.jra-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  padding: 0.12rem 0.45rem;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}
.jra-actual-rank { font-size: 14px; }
.jra-actual-total {
  font-size: 10px;
  color: var(--text-3, #94a3b8);
  font-weight: 400;
}
.jra-td-cell {
  font-weight: 500;
  color: var(--text-2, #cbd5e1);
  cursor: default;
  /* MUST stay display: table-cell (inherited from .jra-td) so each
     judge's cell lands under its own J# column header. A previous
     display: inline-flex here pulled the cells out of the table grid,
     bunching every judge's score on the left instead of in its
     column. Rank + total render as inline spans on a shared baseline,
     centred by the inherited text-align. */
}
.jra-cell-rank {
  font-size: 14px;
  font-weight: 700;
  color: inherit;
}
.jra-cell-total {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-3, #94a3b8);
}
/* Outliers: the <td> carries the outlier class, we tint the inner
   .jra-chip so the disagreement reads as a coloured score chip.
   Theme-aware via the accent family (marine blue, dark-on-light,
   light-on-dark) instead of a hardcoded cyan: soft fill for ±1
   (routine disagreement), stronger fill + heavier weight for ≥2
   (the kind that reshuffles the podium). */
.jra-outlier-mild .jra-chip {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.jra-outlier-strong .jra-chip {
  background: var(--accent-soft-2);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 800;
}
.jra-outlier-mild .jra-chip .jra-cell-total,
.jra-outlier-strong .jra-chip .jra-cell-total {
  color: var(--accent);
}
.jra-diver-amp { color: var(--cyan, #06b6d4); margin: 0 0.2em; font-weight: 400; }

/* Synchro-segmented sub-tables. Each role gets its own card
   with a coloured heading so the viewer can scan the three
   sub-panels at a glance. */
.jra-segment {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.9rem;
}
.jra-segment-head {
  font-family: var(--font-display, inherit);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  padding: 0.4rem 0.6rem;
  border-inline-start: 3px solid var(--cyan, #06b6d4);
  background: rgba(6, 182, 212, 0.08);
  color: var(--text-1, #f1f5f9);
}
.jra-segment-a .jra-segment-head    { border-color: var(--role-admin-fg);   background: var(--role-admin-bg);   color: var(--role-admin-fg); }
.jra-segment-b .jra-segment-head    { border-color: var(--role-manager-fg); background: var(--role-manager-bg); color: var(--role-manager-fg); }
.jra-segment-sync .jra-segment-head { border-color: var(--role-diver-fg);   background: var(--role-diver-bg);   color: var(--role-diver-fg); }
.jra-row:hover .jra-td { background: rgba(148, 163, 184, 0.05); }
/* On hover, deepen the outlier chip's accent tint (theme-aware via
   the accent family) rather than the old hardcoded cyan. */
.jra-row:hover .jra-outlier-mild .jra-chip {
  background: var(--accent-soft-2);
  border-color: var(--accent);
}
.jra-row:hover .jra-outlier-strong .jra-chip {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--fg-on-accent);
}
.jra-row:hover .jra-outlier-strong .jra-chip .jra-cell-total {
  color: var(--fg-on-accent);
}

/* =========================================================
   Mobile: sticky pair column + tighter cells.

   The matrix has one column per judge (typically 5, 7, 9, or
   11), which can't all fit on a phone. With overflow-x: auto
   already in place, the table is horizontally scrollable, but
   if the user can't see the row label (pair / diver) while
   they scroll judges, the data is meaningless.

   Stick the first two columns (PAIR + ACTUAL) to the left
   edge so they stay visible while the user swipes through the
   judge columns. Same pattern Google Sheets / Numbers uses for
   wide spreadsheets on phones.
   ========================================================= */
@media (max-width: 720px) {
  /* Keep the score-cell <td>s as native table-cell so the
     `position: sticky` columns below stay in the table-row column
     flow (a flex/inline-flex td would drop out and stack the four
     cells vertically in one visual column). The rank + total now
     live inside the inner `.jra-chip` (inline-flex) which centres
     them on a shared baseline regardless of the cell's display
     mode, so no per-span inline/margin overrides are needed here. */
  .jra-td-actual,
  .jra-td-cell {
    display: table-cell;
    text-align: center;
    vertical-align: middle;
  }

  .jra-scroll {
    /* Hint at scrollable content with a subtle shadow on the
       right edge that fades as the user scrolls. */
    background-image:
      linear-gradient(to right, var(--surface, #0f172a) 30%, rgba(15, 23, 42, 0)),
      linear-gradient(to left,  var(--surface, #0f172a) 30%, rgba(15, 23, 42, 0)),
      linear-gradient(to right, rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0)),
      linear-gradient(to left,  rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0));
    background-position: left center, right center, left center, right center;
    background-repeat: no-repeat;
    background-color: var(--surface, #0f172a);
    background-size: 20px 100%, 20px 100%, 8px 100%, 8px 100%;
    background-attachment: local, local, scroll, scroll;
    -webkit-overflow-scrolling: touch;
  }
  .jra-table {
    font-size: 11px;
    /* border-collapse: collapse breaks `position: sticky` on
       table cells in Chrome and Safari (the sticky cells lose
       their borders and sometimes don't repaint on scroll).
       Switch to separate + zero spacing on mobile: visually
       identical, but sticky behaves. */
    border-collapse: separate;
    border-spacing: 0;
  }
  .jra-th, .jra-td {
    padding: 0.4rem 0.45rem;
    /* With border-collapse: separate we need to put the
       horizontal border on each cell rather than the table. */
    border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  }

  /* Pair / diver column, pinned to the left edge so the row
     label is always visible during horizontal scroll. */
  .jra-th-diver,
  .jra-td-diver {
    position: sticky;
    inset-inline-start: 0;
    z-index: 2;
    background: var(--surface, #0f172a);
    min-width: 130px;
    max-width: 140px;
    box-shadow: 2px 0 6px rgba(0, 0, 0, 0.35);
  }
  /* Header row is also vertically sticky already; combine both
     sticky positions on the corner cell. */
  thead .jra-th-diver { z-index: 3; }

  /* ACTUAL column, pinned right after PAIR so the user sees
     both "who" and "official rank" before the per-judge cells.
     left value matches PAIR's min-width above. */
  .jra-th-actual,
  .jra-td-actual {
    position: sticky;
    inset-inline-start: 130px;
    z-index: 2;
    background: var(--surface, #0f172a);
    min-width: 54px;
    box-shadow: 2px 0 6px rgba(0, 0, 0, 0.35);
  }
  thead .jra-th-actual { z-index: 3; }

  /* Judge columns, give back some space taken by the wider
     pair column. */
  .jra-th-judge { min-width: 48px; }
  .jra-judge-name { font-size: 8px; max-width: 8ch; }
  .jra-judge-cc   { font-size: 8px; }
  .jra-judge-num  { font-size: 10px; }
  .jra-actual-rank { font-size: 12px; }
  .jra-actual-total,
  .jra-cell-total { font-size: 9px; }

  /* Tighten the pair name so it stays inside the 140px column.
     Names wrap rather than truncate, the user needs the full
     name visible to read the row. */
  .jra-diver-name {
    flex-wrap: wrap;
    gap: 0.2rem;
    font-size: 11px;
    line-height: 1.2;
  }
  .jra-diver-club { display: none; }
  .jra-diver-cc   { font-size: 9px; }
}

/* Even tighter on iPhone-SE class viewports, drop the pair
   column to 110px and pull ACTUAL in alongside. */
@media (max-width: 400px) {
  .jra-th-diver,
  .jra-td-diver { min-width: 110px; max-width: 120px; }
  .jra-th-actual,
  .jra-td-actual { inset-inline-start: 110px; min-width: 46px; }
}
</style>
