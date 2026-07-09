<script setup>
defineProps({
  // Array of { dive_code, position, height, dd, best_total,
  // attempts, event_name }. Comes from profile.personal_bests.
  data: { type: Array, default: () => [] },
})
</script>

<template>
  <div class="card">
    <div class="card-head">Personal Bests by Dive</div>
    <div v-if="!data?.length" class="empty-mini">No dives recorded yet.</div>
    <div v-else class="pb-scroll">
      <table class="pb-table">
        <thead>
          <tr>
            <th>Dive</th>
            <th>Pos</th>
            <th>Height</th>
            <th>DD</th>
            <th>Best</th>
            <th>Attempts</th>
            <th>At Meet</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pb in data" :key="pb.dive_code + pb.position + pb.height">
            <td class="mono strong">{{ pb.dive_code }}</td>
            <td class="mono">{{ pb.position }}</td>
            <td class="mono">{{ pb.height }}m</td>
            <td class="mono cyan">{{ Number(pb.dd).toFixed(1) }}</td>
            <td class="mono strong">{{ Number(pb.best_total).toFixed(1) }}</td>
            <td class="mono dim">{{ pb.attempts }}</td>
            <td class="dim">{{ pb.event_name }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
/* Scroll wrap lets the 7-column table overflow horizontally
   on phones instead of crushing the "At Meet" name column. */
.pb-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
@media (max-width: 600px) {
  .pb-scroll .pb-table { min-width: 540px; }
}
</style>
