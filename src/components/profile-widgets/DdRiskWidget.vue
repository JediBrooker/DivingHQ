<script setup>
defineProps({
  // { avg_dd, max_dd, avg_score_at_highest_dd, attempts_at_highest_dd }
  // from analytics.dd_risk.
  data: { type: Object, default: null },
})
</script>

<template>
  <div class="card">
    <div class="card-head">DD Risk Profile</div>
    <div v-if="!data?.avg_dd" class="empty-mini">Not enough data yet.</div>
    <div v-else class="dd-risk-row">
      <div class="dd-cell">
        <div class="dd-num">{{ Number(data.avg_dd).toFixed(2) }}</div>
        <div class="dd-lbl">Avg DD attempted</div>
      </div>
      <div class="dd-cell">
        <div class="dd-num cyan">{{ Number(data.max_dd).toFixed(1) }}</div>
        <div class="dd-lbl">Max DD attempted</div>
      </div>
      <div class="dd-cell">
        <div class="dd-num">
          {{ data.avg_score_at_highest_dd != null
             ? Number(data.avg_score_at_highest_dd).toFixed(1)
             : '—' }}
        </div>
        <div class="dd-lbl">Avg score at top DDs</div>
        <div class="dd-meta" v-if="data.attempts_at_highest_dd">
          {{ data.attempts_at_highest_dd }} attempts ≥ {{ Number(data.max_dd - 0.3).toFixed(1) }}
        </div>
      </div>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.dd-risk-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.6rem;
}
.dd-cell {
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0.875rem 1rem;
  text-align: center;
}
.dd-num {
  font-family: var(--font-display); font-size: 32px; font-weight: 900;
  font-style: italic; line-height: 1; color: var(--text);
}
.dd-num.cyan { color: var(--cyan); }
.dd-lbl {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  margin-top: 0.4rem;
}
.dd-meta {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  margin-top: 0.3rem;
}
/* Phone (≤600px): 3 cells at 140px each = 420px before gaps,
   so the grid wraps to 2-1 on most phones. Dropping the minimum
   lets all three cells sit side-by-side at 360px, and we trim the
   big 32px numerals so the label doesn't clip. */
@media (max-width: 600px) {
  .dd-risk-row {
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
  }
  .dd-cell { padding: 0.65rem 0.45rem; }
  .dd-num  { font-size: 22px; }
  .dd-lbl  { font-size: 9px; letter-spacing: 0.12em; margin-top: 0.3rem; }
  .dd-meta { font-size: 9.5px; }
}

@media print {
  .dd-num { color: #000 !important; }
  .dd-lbl { color: #555 !important; }
}
</style>
