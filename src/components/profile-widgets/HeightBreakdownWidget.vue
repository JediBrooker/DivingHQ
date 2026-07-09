<script setup>
import { barWidth } from '@/lib/profile-helpers'

defineProps({
  // Array of { height, avg_score, best_score, dive_count },
  // comes from analytics.height_breakdown. Null while it's loading.
  data: { type: Array, default: null },
})
</script>

<template>
  <div class="card">
    <div class="card-head">Height Breakdown</div>
    <div v-if="!data" class="empty-mini">Loading…</div>
    <div v-else-if="!data.length" class="empty-mini">No dives by height yet.</div>
    <div v-else class="bar-list">
      <div v-for="h in data" :key="h.height" class="bar-row">
        <span class="bar-label">{{ h.height }}m</span>
        <div class="bar-track">
          <div class="bar-fill" :style="{
            width: barWidth(h.avg_score, data, 'avg_score') + '%',
          }"></div>
        </div>
        <span class="bar-value">avg {{ Number(h.avg_score).toFixed(1) }}</span>
        <span class="bar-meta">best {{ Number(h.best_score).toFixed(1) }} · {{ h.dive_count }} dives</span>
      </div>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.bar-list { display: flex; flex-direction: column; gap: 0.5rem; }
.bar-row {
  display: grid;
  grid-template-columns: 70px 1fr 80px 100px;
  align-items: center; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 12px;
}
.bar-label {
  font-family: var(--font-display); font-weight: 700;
  color: var(--text-2); letter-spacing: 0.1em;
}
.bar-track {
  height: 16px; background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 4px; overflow: hidden;
}
.bar-fill {
  height: 100%; background: linear-gradient(90deg, var(--cyan), #0891b2);
  transition: width 0.2s;
}
.bar-value { color: var(--text); font-weight: 700; }
.bar-meta  { color: var(--text-3); font-size: 11px; }

/* Phone (≤600px): 250px of fixed columns squeezes the bar down
   to ~80px at a 360 viewport. Two-row layout (label + bar on
   top, value + meta on a second mono line) keeps the bar long
   enough to read without losing any of the data. */
@media (max-width: 600px) {
  .bar-row {
    grid-template-columns: auto 1fr;
    grid-template-areas:
      "label bar"
      "value meta";
    column-gap: 0.6rem; row-gap: 0.25rem;
    font-size: 11.5px;
  }
  .bar-label { grid-area: label; }
  .bar-track { grid-area: bar; }
  .bar-value { grid-area: value; }
  .bar-meta  { grid-area: meta; text-align: end; }
}

@media print {
  .bar-fill { background: #555 !important; }
}
</style>
