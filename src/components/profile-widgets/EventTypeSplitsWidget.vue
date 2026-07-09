<script setup>
defineProps({
  // Array of { event_type, meets, dives, avg_dive_score,
  // best_single_dive, avg_meet_total, best_meet_total }
  // pulled from analytics.event_type_splits.
  data: { type: Array, default: () => [] },
})
</script>

<template>
  <div class="card">
    <div class="card-head">Synchro vs Individual</div>
    <div v-if="!data?.length" class="empty-mini">
      No events to compare yet.
    </div>
    <div v-else class="pb-scroll">
      <table class="pb-table">
        <thead>
          <tr>
            <th>Event type</th>
            <th>Meets</th>
            <th>Dives</th>
            <th>Avg dive</th>
            <th>Best dive</th>
            <th>Avg meet</th>
            <th>Best meet</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in data" :key="r.event_type">
            <td class="strong">
              {{ r.event_type === 'synchro_pair' ? 'Synchro'
               : r.event_type === 'team' ? 'Team'
               : r.event_type === 'individual' ? 'Individual'
               : r.event_type }}
            </td>
            <td class="mono dim">{{ r.meets }}</td>
            <td class="mono dim">{{ r.dives }}</td>
            <td class="mono">{{ r.avg_dive_score != null ? Number(r.avg_dive_score).toFixed(1) : '—' }}</td>
            <td class="mono cyan strong">{{ r.best_single_dive != null ? Number(r.best_single_dive).toFixed(1) : '—' }}</td>
            <td class="mono">{{ r.avg_meet_total != null ? Number(r.avg_meet_total).toFixed(1) : '—' }}</td>
            <td class="mono cyan strong">{{ r.best_meet_total != null ? Number(r.best_meet_total).toFixed(1) : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.pb-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
@media (max-width: 600px) {
  .pb-scroll .pb-table { min-width: 520px; }
}
</style>
