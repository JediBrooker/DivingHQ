<script setup>
import { barWidth } from '@/lib/profile-helpers'

defineProps({
  // { my_avg_dd, peer_avg_dd, my_avg_score, peer_avg_score,
  //   my_max_dd, peer_max_dd, my_dives, peer_dives }.
  // From analytics.compare_peers.
  data: { type: Object, default: null },
  // Org name for the card header
  orgName: { type: String, default: '' },
})
</script>

<template>
  <div v-if="data" class="card">
    <div class="card-head">Compare to Peers ({{ orgName }})</div>
    <div v-if="!data.peer_dives" class="empty-mini">
      No peer dives in this date range yet.
    </div>
    <div v-else class="compare-grid">
      <div class="compare-row">
        <span class="compare-lbl">Avg DD attempted</span>
        <div class="compare-bars">
          <div class="compare-bar compare-me"
               :style="{ width: barWidth(data.my_avg_dd, [
                 { v: data.my_avg_dd },
                 { v: data.peer_avg_dd }
               ], 'v') + '%' }"></div>
          <div class="compare-bar compare-peer"
               :style="{ width: barWidth(data.peer_avg_dd, [
                 { v: data.my_avg_dd },
                 { v: data.peer_avg_dd }
               ], 'v') + '%' }"></div>
        </div>
        <span class="compare-vals">
          <span class="compare-me-text">You {{ data.my_avg_dd != null ? Number(data.my_avg_dd).toFixed(2) : '—' }}</span>
          <span class="compare-peer-text">Peers {{ data.peer_avg_dd != null ? Number(data.peer_avg_dd).toFixed(2) : '—' }}</span>
        </span>
      </div>
      <div class="compare-row">
        <span class="compare-lbl">Avg dive total</span>
        <div class="compare-bars">
          <div class="compare-bar compare-me"
               :style="{ width: barWidth(data.my_avg_score, [
                 { v: data.my_avg_score },
                 { v: data.peer_avg_score }
               ], 'v') + '%' }"></div>
          <div class="compare-bar compare-peer"
               :style="{ width: barWidth(data.peer_avg_score, [
                 { v: data.my_avg_score },
                 { v: data.peer_avg_score }
               ], 'v') + '%' }"></div>
        </div>
        <span class="compare-vals">
          <span class="compare-me-text">You {{ data.my_avg_score != null ? Number(data.my_avg_score).toFixed(1) : '—' }}</span>
          <span class="compare-peer-text">Peers {{ data.peer_avg_score != null ? Number(data.peer_avg_score).toFixed(1) : '—' }}</span>
        </span>
      </div>
      <div class="compare-row">
        <span class="compare-lbl">Max DD attempted</span>
        <div class="compare-bars">
          <div class="compare-bar compare-me"
               :style="{ width: barWidth(data.my_max_dd, [
                 { v: data.my_max_dd },
                 { v: data.peer_max_dd }
               ], 'v') + '%' }"></div>
          <div class="compare-bar compare-peer"
               :style="{ width: barWidth(data.peer_max_dd, [
                 { v: data.my_max_dd },
                 { v: data.peer_max_dd }
               ], 'v') + '%' }"></div>
        </div>
        <span class="compare-vals">
          <span class="compare-me-text">You {{ data.my_max_dd != null ? Number(data.my_max_dd).toFixed(1) : '—' }}</span>
          <span class="compare-peer-text">Peers {{ data.peer_max_dd != null ? Number(data.peer_max_dd).toFixed(1) : '—' }}</span>
        </span>
      </div>
    </div>
    <p v-if="data.peer_dives" class="widget-hint">
      Sample: {{ data.my_dives }} of your dives vs. {{ data.peer_dives }} peer dives.
    </p>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.compare-grid { display: flex; flex-direction: column; gap: 0.7rem; }
.compare-row {
  display: grid;
  grid-template-columns: 140px 1fr 200px;
  align-items: center; gap: 0.6rem;
}
.compare-lbl {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3);
}
.compare-bars {
  display: flex; flex-direction: column; gap: 3px;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 4px; padding: 4px; min-height: 28px;
}
.compare-bar { height: 8px; border-radius: 3px; transition: width 0.2s; min-width: 1px; }
.compare-bar.compare-me   { background: linear-gradient(90deg, var(--cyan), #0891b2); }
.compare-bar.compare-peer { background: linear-gradient(90deg, #64748b, #475569); }
.compare-vals {
  display: flex; flex-direction: column; gap: 2px;
  font-family: var(--font-mono); font-size: 11px;
}
.compare-me-text   { color: var(--cyan); font-weight: 700; }
.compare-peer-text { color: var(--text-3); }

/* Phone (≤600px): 140px label + 200px values eats 340px of
   the 360px viewport before we even get to the bars. Stack to
   a single column, bars full-width, values inline beneath. */
@media (max-width: 600px) {
  .compare-row {
    grid-template-columns: 1fr;
    gap: 0.3rem;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border);
  }
  .compare-row:first-child { border-top: none; padding-top: 0.1rem; }
  .compare-vals {
    flex-direction: row; justify-content: space-between;
    gap: 0.6rem;
  }
}

@media print {
  .compare-me-text { color: #000 !important; }
}
</style>
