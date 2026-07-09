<script setup>
import { ref } from 'vue'
import { fmtDate } from '@/lib/format'
import { annotateJudgeRows, scoreCategory } from '@/composables/useScoreTrim.js'
import { placeOrdinal, placeColor } from '@/lib/profile-helpers'

const props = defineProps({
  // Array of { event_id, event_name, created_at, rank, field_size,
  // total, dives: [...] }. From analytics.recent_form. Pass `null`
  // (not []) while analytics is still loading, that's the gotcha
  // that lets us tell "still loading" apart from "actually empty".
  data: { type: Array, default: null },
  // The diver whose profile is being viewed, used for the
  // score-sheet download link.
  targetId: { type: [String, Number], default: null },
  // When true, the parent's /analytics request is still in flight
  // and `data` may still be null, renders the "Loading…" line.
  loading: { type: Boolean, default: false },
})

// State that's local to Recent Form: click a meet row to expand
// the per-dive breakdown with each judge's raw score.
const expandedMeet = ref(null)
function toggleMeet(eventId) {
  expandedMeet.value = expandedMeet.value === eventId ? null : eventId
}

// Trim algorithm + score-category lookup live in
// src/composables/useScoreTrim.js, kept in one place so the live
// scoreboard, archive, and this widget all agree on what's dropped/kept.
function annotateJudges(judges, numJudges, eventType) {
  return annotateJudgeRows(judges, numJudges, eventType)
}
function scoreClass(s) {
  const cat = scoreCategory(Number(s))
  return cat ? `qs-${cat}` : ''
}
</script>

<template>
  <div class="card">
    <div class="card-head">Recent Form</div>
    <div v-if="loading && !data" class="empty-mini">Loading…</div>
    <div v-else-if="!data?.length" class="empty-mini">No completed meets yet.</div>
    <div v-else class="trend-list">
      <template v-for="r in data" :key="r.event_id">
        <div
          class="trend-row trend-row-clickable"
          :class="{ 'is-expanded': expandedMeet === r.event_id }"
          @click="toggleMeet(r.event_id)"
        >
          <span class="trend-chevron">
            {{ expandedMeet === r.event_id ? '▾' : '▸' }}
          </span>
          <span class="trend-date">{{ fmtDate(r.created_at) }}</span>
          <span class="trend-name">{{ r.event_name }}</span>
          <span :class="['trend-place', placeColor(r.rank)]">
            {{ placeOrdinal(r.rank) }} <span class="dim">/ {{ r.field_size }}</span>
          </span>
          <span class="trend-total">{{ Number(r.total).toFixed(1) }}</span>
        </div>
        <div v-if="expandedMeet === r.event_id" class="dive-breakdown">
          <div v-if="!r.dives?.length" class="empty-mini">No dives recorded.</div>
          <table v-else class="dive-table">
            <thead>
              <tr>
                <th>Rd</th>
                <th>Dive</th>
                <th>Pos</th>
                <th>Ht</th>
                <th>DD</th>
                <th>Judges</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in r.dives" :key="d.round_number">
                <td class="mono dim">{{ d.round_number }}</td>
                <td class="mono strong">{{ d.dive_code || '—' }}</td>
                <td class="mono">{{ d.position || '—' }}</td>
                <td class="mono">{{ d.height ? d.height + 'm' : '—' }}</td>
                <td class="mono cyan">{{ d.dd != null ? Number(d.dd).toFixed(1) : '—' }}</td>
                <td class="judge-strip">
                  <span
                    v-for="j in annotateJudges(d.judges, d.number_of_judges, d.event_type)"
                    :key="j.judge_number"
                    :class="['j-chip', scoreClass(j.score), { 'j-dropped': j.dropped }]"
                    v-tip="`Judge ${j.judge_number}` + (j.dropped ? ' (dropped)' : '')"
                  >
                    {{ Number(j.score).toFixed(1) }}
                  </span>
                </td>
                <td class="mono strong cyan">{{ Number(d.dive_total).toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
          <div class="dive-breakdown-actions">
            <a :href="`/api/events/${r.event_id}/divers/${targetId}/score-sheet.pdf`"
               target="_blank" rel="noopener"
               class="btn btn-ghost btn-sm">📄 Download score sheet</a>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.trend-list { display: flex; flex-direction: column; }
.trend-row {
  display: grid; grid-template-columns: 110px 1fr auto auto;
  align-items: center; gap: 0.75rem; padding: 0.5rem 0;
  border-top: 1px solid var(--border); font-size: 13px;
}
.trend-row:first-child { border-top: none; }
.trend-date { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.trend-name {
  font-family: var(--font-display); color: var(--text); font-weight: 500;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.trend-place {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  padding: 0.1rem 0.4rem; border-radius: 3px;
  border: 1px solid var(--border); background: var(--bg-2);
}
.trend-place.place-gold   { color: #f59e0b; border-color: rgba(234,179,8,0.4); background: rgba(234,179,8,0.06); }
.trend-place.place-silver { color: #94a3b8; border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.06); }
.trend-place.place-bronze { color: #92400e; border-color: rgba(180,83,9,0.4); background: rgba(180,83,9,0.06); }
.trend-total { font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--cyan); }

/* Clickable variant, adds the chevron + hover state. */
.trend-row-clickable {
  grid-template-columns: 16px 110px 1fr auto auto;
  cursor: pointer;
  transition: background 0.1s;
}
.trend-row-clickable:hover { background: var(--bg-3); }
.trend-row-clickable.is-expanded { background: var(--bg-3); }
.trend-chevron {
  font-family: var(--font-mono); color: var(--text-3); font-size: 11px;
  transition: color 0.1s;
}
.trend-row-clickable:hover .trend-chevron { color: var(--cyan); }

.dive-breakdown {
  padding-block: 0.5rem 0.75rem;
  padding-inline: 1.5rem 0.5rem;
  border-top: 1px dashed var(--border);
  background: var(--bg-3);
}
.dive-breakdown-actions {
  display: flex; justify-content: flex-end;
  margin-top: 0.5rem;
}
.dive-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dive-table th {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  text-align: start; padding: 0.4rem 0.4rem;
  border-bottom: 1px solid var(--border);
}
.dive-table td { padding: 0.4rem 0.4rem; border-bottom: 1px solid var(--border); }
.dive-table tr:last-child td { border-bottom: none; }
.dive-table td.mono   { font-family: var(--font-mono); font-size: 12px; }
.dive-table td.strong { font-weight: 700; color: var(--text); }
.dive-table td.cyan   { color: var(--cyan); }
.dive-table td.dim    { color: var(--text-3); }

.judge-strip { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.j-chip {
  display: inline-block;
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  padding: 0.15rem 0.4rem; border-radius: 3px;
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text);
  min-width: 30px; text-align: center;
}
.j-chip.j-dropped { text-decoration: line-through; opacity: 0.55; }
/* Per-category chip backgrounds, match the live scoreboard. */
.j-chip.qs-failed         { background: rgba(239,68,68,0.18);   border-color: rgba(239,68,68,0.45);   color: #fecaca; }
.j-chip.qs-very-deficient { background: rgba(251,146,60,0.18);  border-color: rgba(251,146,60,0.45);  color: #fed7aa; }
.j-chip.qs-deficient      { background: rgba(251,191,36,0.18);  border-color: rgba(251,191,36,0.45);  color: #fde68a; }
.j-chip.qs-satisfactory   { background: rgba(71,85,105,0.30);   border-color: rgba(71,85,105,0.55);   color: var(--text-2); }
.j-chip.qs-good           { background: rgba(6,182,212,0.18);   border-color: rgba(6,182,212,0.45);   color: #a5f3fc; }
.j-chip.qs-very-good      { background: rgba(16,185,129,0.18);  border-color: rgba(16,185,129,0.45);  color: #a7f3d0; }
.j-chip.qs-excellent      { background: rgba(236,72,153,0.18);  border-color: rgba(236,72,153,0.45);  color: #fbcfe8; }

/* phone (≤600px): collapse the trend row (chevron + date +
   name + place + total) onto two rows so the meet name has
   room to breathe. Expanded dive table gets a horizontal
   scroll wrap so the 7 cols don't overflow the card. */
@media (max-width: 600px) {
  .trend-row {
    grid-template-columns: auto 1fr auto;
    grid-template-areas:
      "date  place total"
      "name  name  name";
    gap: 0.3rem 0.5rem;
    padding: 0.55rem 0;
    font-size: 12px;
  }
  .trend-row-clickable {
    grid-template-columns: 14px auto 1fr auto;
    grid-template-areas:
      "chev date  place total"
      "chev name  name  name";
  }
  .trend-chevron { grid-area: chev; align-self: center; }
  .trend-date    { grid-area: date; }
  .trend-name    { grid-area: name; white-space: normal; }
  .trend-place   { grid-area: place; justify-self: end; }
  .trend-total   { grid-area: total; font-size: 13px; }

  /* Expanded breakdown: the inner dive table has 7 columns, so
     just let it scroll horizontally instead of squeezing
     everything into the card width. */
  .dive-breakdown {
    padding: 0.5rem 0.4rem 0.6rem;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .dive-table { font-size: 11px; min-width: 480px; }
  .dive-table th { font-size: 8.5px; padding: 0.35rem 0.3rem; }
  .dive-table td { padding: 0.35rem 0.3rem; }
  .j-chip { font-size: 10px; min-width: 26px; padding: 0.1rem 0.3rem; }
}

@media print {
  .trend-place, .trend-total { color: #000 !important; }
}
</style>
