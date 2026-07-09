<script setup>
import { computed } from 'vue'
import { fmtDate } from '@/lib/format'
import { placeOrdinal, placeColor } from '@/lib/profile-helpers'

const props = defineProps({
  // Array of { event_id, event_name, event_type, total_score,
  // final_rank, created_at, partner_name?, team_name? }. FYI this
  // comes from /profile (profile.score_trend), not /analytics.
  data: { type: Array, default: () => [] },
})

const trendChart = computed(() => {
  if (!props.data?.length) return null
  const points = props.data.map(t => Number(t.total_score))
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const range = max - min || 1
  const w = 600
  const h = 120
  const stepX = points.length > 1 ? w / (points.length - 1) : 0
  const coords = points.map((p, i) => {
    const x = i * stepX
    const y = h - ((p - min) / range) * (h - 16) - 8
    return { x, y, value: p }
  })
  const path = coords.map((c, i) => (i === 0 ? `M ${c.x} ${c.y}` : `L ${c.x} ${c.y}`)).join(' ')
  return { path, coords, w, h, max, min }
})
</script>

<template>
  <div class="card">
    <div class="card-head">Score Trend</div>
    <div v-if="!data?.length" class="empty-mini">No completed meets yet.</div>
    <template v-else>
      <svg
        v-if="trendChart"
        :viewBox="`0 0 ${trendChart.w} ${trendChart.h}`"
        preserveAspectRatio="none"
        class="trend-chart"
      >
        <path :d="trendChart.path" fill="none" stroke="var(--cyan)" stroke-width="2" />
        <circle
          v-for="(c, i) in trendChart.coords"
          :key="i"
          :cx="c.x" :cy="c.y" r="3"
          fill="var(--cyan)"
        >
          <title>{{ data[i].event_name }} — {{ Number(c.value).toFixed(1) }}</title>
        </circle>
      </svg>
      <div class="trend-list">
        <div v-for="t in data" :key="t.event_id" class="trend-row">
          <span class="trend-date">{{ fmtDate(t.created_at) }}</span>
          <span class="trend-name">
            {{ t.event_name }}
            <span v-if="t.event_type === 'synchro_pair'" class="trend-synchro">SYNCHRO</span>
            <span v-else-if="t.event_type === 'team'" class="trend-team-badge">TEAM</span>
            <span v-if="t.partner_name" class="trend-partner">with {{ t.partner_name }}</span>
            <span v-if="t.team_name" class="trend-partner">on {{ t.team_name }}</span>
          </span>
          <span :class="['trend-place', placeColor(t.final_rank)]">{{ placeOrdinal(t.final_rank) }}</span>
          <span class="trend-total">{{ Number(t.total_score).toFixed(2) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.trend-chart { width: 100%; height: 120px; display: block; margin-bottom: 1rem; }

.trend-list { display: flex; flex-direction: column; }
.trend-row {
  display: grid; grid-template-columns: 110px 1fr auto auto;
  align-items: center; gap: 0.75rem; padding: 0.5rem 0;
  border-top: 1px solid var(--border); font-size: 13px;
}
.trend-row:first-child { border-top: none; }
.trend-date { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.trend-name { font-family: var(--font-display); color: var(--text); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trend-synchro {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.4);
  border-radius: 3px; padding: 0.1rem 0.4rem; margin-inline-start: 0.4rem;
}
.trend-team-badge {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; color: var(--role-admin-fg);
  background: rgba(139,92,246,0.10); border: 1px solid rgba(139,92,246,0.45);
  border-radius: 3px; padding: 0.1rem 0.4rem; margin-inline-start: 0.4rem;
}
.trend-partner { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-inline-start: 0.4rem; }
.trend-place { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); padding: 0.1rem 0.4rem; border-radius: 3px; border: 1px solid var(--border); background: var(--bg-2); }
.trend-place.place-gold   { color: #f59e0b; border-color: rgba(234,179,8,0.4); background: rgba(234,179,8,0.06); }
.trend-place.place-silver { color: #94a3b8; border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.06); }
.trend-place.place-bronze { color: #92400e; border-color: rgba(180,83,9,0.4); background: rgba(180,83,9,0.06); }
.trend-total { font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--cyan); }

/* Phone (≤600px): the four fixed-ish columns cant fit at
   360px (date + name + place + total + gaps ≈ 320px before
   ellipsis). Collapse to a two-row layout: date+place+total
   on top, full-width name underneath so synchro/team badges
   and partner names don't get clipped. */
@media (max-width: 600px) {
  .trend-row {
    grid-template-columns: auto 1fr auto;
    grid-template-areas:
      "date  place total"
      "name  name  name";
    gap: 0.35rem 0.5rem;
    padding: 0.55rem 0;
    font-size: 12px;
  }
  .trend-date  { grid-area: date; }
  .trend-place { grid-area: place; justify-self: end; }
  .trend-total { grid-area: total; font-size: 13px; }
  .trend-name  { grid-area: name; white-space: normal; }
  .trend-chart { height: 90px; margin-bottom: 0.6rem; }
  .trend-partner { display: block; margin-inline-start: 0; margin-top: 0.15rem; }
}

@media print {
  .trend-place, .trend-total { color: #000 !important; }
}
</style>
