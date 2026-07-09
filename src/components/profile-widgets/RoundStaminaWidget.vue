<script setup>
import { computed } from 'vue'
import { barWidth } from '@/lib/profile-helpers'

const props = defineProps({
  // Array of { round_number, avg_score, dive_count }.
  // Comes from analytics.round_stamina, null while it's loading.
  data: { type: Array, default: null },
})

// one-line insight, flags it if scores drop off in later rounds
const staminaInsight = computed(() => {
  const r = props.data || []
  if (r.length < 2) return ''
  const first = Number(r[0].avg_score) || 0
  const last  = Number(r[r.length - 1].avg_score) || 0
  if (first === 0) return ''
  const delta = ((last - first) / first) * 100
  if (delta > 5)  return `📈 You finish strong: round ${r[r.length - 1].round_number} averages ${delta.toFixed(0)}% higher than round 1.`
  if (delta < -5) return `📉 You fade in later rounds: round ${r[r.length - 1].round_number} averages ${Math.abs(delta).toFixed(0)}% below round 1.`
  return `Even pacing across rounds (Δ ${delta.toFixed(1)}% from R1 to R${r[r.length - 1].round_number}).`
})
</script>

<template>
  <div class="card">
    <div class="card-head">Round-by-Round Form</div>
    <div v-if="!data" class="empty-mini">Loading…</div>
    <div v-else-if="!data.length" class="empty-mini">No rounds completed yet.</div>
    <div v-else class="bar-list">
      <div v-for="r in data" :key="r.round_number" class="bar-row">
        <span class="bar-label">Round {{ r.round_number }}</span>
        <div class="bar-track">
          <div class="bar-fill" :style="{
            width: barWidth(r.avg_score, data, 'avg_score') + '%',
          }"></div>
        </div>
        <span class="bar-value">{{ Number(r.avg_score).toFixed(1) }}</span>
        <span class="bar-meta">{{ r.dive_count }} dives</span>
      </div>
    </div>
    <p v-if="data && data.length > 1" class="widget-hint">
      {{ staminaInsight }}
    </p>
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

/* Phone (≤600px): same two-row layout as HeightBreakdown, so
   the bar still has a usable width at 360px. */
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
