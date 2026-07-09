<script setup>
defineProps({
  // Array of { dive_code, position, height, attempts, avg_score,
  // best_score }, from analytics.frequent_dives.
  data: { type: Array, default: () => [] },
})
</script>

<template>
  <div class="card">
    <div class="card-head">Go-To Dives</div>
    <div v-if="!data?.length" class="empty-mini">No dives recorded yet.</div>
    <div v-else class="pb-scroll">
      <table class="pb-table">
        <thead>
          <tr>
            <th>Dive</th>
            <th>Pos</th>
            <th>Height</th>
            <th>Attempts</th>
            <th>Avg</th>
            <th>Best</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in data" :key="f.dive_code + f.position + f.height">
            <td class="mono strong">{{ f.dive_code }}</td>
            <td class="mono">{{ f.position }}</td>
            <td class="mono">{{ f.height }}m</td>
            <td class="mono dim">{{ f.attempts }}</td>
            <td class="mono">{{ Number(f.avg_score).toFixed(1) }}</td>
            <td class="mono strong cyan">{{ Number(f.best_score).toFixed(1) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
/* Same scroll wrap as PersonalBests, 6 columns fit at 360px
   only because every cell except the code is short. Heads up,
   the "Attempts" header still overflows on the narrowest phones. */
.pb-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
@media (max-width: 600px) {
  .pb-scroll .pb-table { min-width: 400px; }
}
</style>
