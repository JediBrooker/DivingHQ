<script setup>
import { computed } from 'vue'

const props = defineProps({
  // { total, failed, very_deficient, deficient, satisfactory,
  // good, very_good, excellent }, from analytics.quality_mix.
  // Null while it's loading.
  data: { type: Object, default: null },
})

// World Aquatics category buckets, kept in display order. Mirrors the
// colour classes the live scoreboard chips already use.
const qualityBuckets = computed(() => {
  const q = props.data || {}
  return [
    { id: 'failed',         label: 'Failed (0)',             count: q.failed         || 0 },
    { id: 'very_deficient', label: 'Very Deficient (≤2.0)',  count: q.very_deficient || 0 },
    { id: 'deficient',      label: 'Deficient (≤4.5)',       count: q.deficient      || 0 },
    { id: 'satisfactory',   label: 'Satisfactory (≤6.5)',    count: q.satisfactory   || 0 },
    { id: 'good',           label: 'Good (≤8.0)',            count: q.good           || 0 },
    { id: 'very_good',      label: 'Very Good (≤9.5)',       count: q.very_good      || 0 },
    { id: 'excellent',      label: 'Excellent (10)',         count: q.excellent      || 0 },
  ]
})
</script>

<template>
  <div class="card">
    <div class="card-head">Score Quality Mix</div>
    <div v-if="!data || !data.total" class="empty-mini">No judge scores yet.</div>
    <template v-else>
      <div class="quality-bar">
        <div v-for="b in qualityBuckets" :key="b.id"
             :class="['quality-seg', `quality-${b.id}`]"
             :style="{ width: (b.count / data.total * 100) + '%' }"
             v-tip="`${b.label}: ${b.count} (${(b.count / data.total * 100).toFixed(1)}%)`"></div>
      </div>
      <div class="quality-legend">
        <div v-for="b in qualityBuckets" :key="b.id" class="quality-legend-row">
          <span :class="['quality-dot', `quality-${b.id}`]"></span>
          <span class="quality-name">{{ b.label }}</span>
          <span class="quality-count">{{ b.count }}</span>
          <span class="quality-pct">{{ data.total ? (b.count / data.total * 100).toFixed(1) : 0 }}%</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.quality-bar {
  display: flex; height: 28px; border-radius: var(--radius-sm);
  overflow: hidden; border: 1px solid var(--border);
}
.quality-seg { transition: width 0.2s; min-width: 1px; }
.quality-seg.quality-failed         { background: #ef4444; }
.quality-seg.quality-very_deficient { background: #fb923c; }
.quality-seg.quality-deficient      { background: #fbbf24; }
.quality-seg.quality-satisfactory   { background: #475569; }
.quality-seg.quality-good           { background: #06b6d4; }
.quality-seg.quality-very_good      { background: #10b981; }
.quality-seg.quality-excellent      { background: #ec4899; }

.quality-legend { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.75rem; }
.quality-legend-row {
  display: grid; grid-template-columns: 14px 1fr auto auto;
  align-items: center; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2);
}
.quality-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.quality-dot.quality-failed         { background: #ef4444; }
.quality-dot.quality-very_deficient { background: #fb923c; }
.quality-dot.quality-deficient      { background: #fbbf24; }
.quality-dot.quality-satisfactory   { background: #475569; }
.quality-dot.quality-good           { background: #06b6d4; }
.quality-dot.quality-very_good      { background: #10b981; }
.quality-dot.quality-excellent      { background: #ec4899; }
.quality-name  { color: var(--text-2); }
.quality-count { font-weight: 700; color: var(--text); }
.quality-pct   { color: var(--text-3); width: 48px; text-align: end; }

/* Phone (≤600px): legend rows are already auto-sized after
   the dot column, but the labels ("Unsat. (≤4.5)") get tight here.
   Shrinking the percent column and font keeps all four cells
   fitting in a single row at 360px. */
@media (max-width: 600px) {
  .quality-bar { height: 22px; }
  .quality-legend-row {
    grid-template-columns: 12px 1fr auto auto;
    gap: 0.45rem;
    font-size: 11px;
  }
  .quality-pct { width: 42px; }
}

@media print {
  .quality-seg.quality-failed         { background: #c0392b !important; }
  .quality-seg.quality-very_deficient { background: #e67e22 !important; }
  .quality-seg.quality-deficient      { background: #f1c40f !important; }
  .quality-seg.quality-satisfactory   { background: #7f8c8d !important; }
  .quality-seg.quality-good           { background: #16a085 !important; }
  .quality-seg.quality-very_good      { background: #27ae60 !important; }
  .quality-seg.quality-excellent      { background: #8e44ad !important; }
}
</style>
