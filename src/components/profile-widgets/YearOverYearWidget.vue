<script setup>
const props = defineProps({
  // Array of { year, meets, avg_meet_total, best_meet_total,
  // wins, podiums }. Sorted newest first.
  // Comes from analytics.year_over_year.
  data: { type: Array, default: () => [] },
})

// Year-over-year delta, compares row[i] to row[i+1] (list is
// sorted newest first). Returns "+12.3%" / "-4.5%" / "—".
function yoyDelta(list, i) {
  const cur  = Number(list[i]?.avg_meet_total)
  const prev = Number(list[i + 1]?.avg_meet_total)
  if (!cur || !prev) return null
  return ((cur - prev) / prev) * 100
}
function yoyDeltaText(i) {
  const d = yoyDelta(props.data, i)
  if (d == null) return '—'
  const sign = d >= 0 ? '+' : ''
  return `${sign}${d.toFixed(1)}%`
}
function yoyDeltaClass(i) {
  const d = yoyDelta(props.data, i)
  if (d == null) return 'dim'
  if (d > 1) return 'yoy-up'
  if (d < -1) return 'yoy-down'
  return ''
}
</script>

<template>
  <div class="card">
    <div class="card-head">Year-over-Year</div>
    <div v-if="!data?.length" class="empty-mini">
      Need at least one completed meet.
    </div>
    <div v-else class="pb-scroll">
      <table class="pb-table">
        <thead>
          <tr>
            <th>Year</th>
            <th>Meets</th>
            <th>Avg meet</th>
            <th>Best meet</th>
            <th>Wins</th>
            <th>Podiums</th>
            <th>Δ vs prev</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(y, i) in data" :key="y.year">
            <td class="mono strong">{{ y.year }}</td>
            <td class="mono dim">{{ y.meets }}</td>
            <td class="mono">{{ y.avg_meet_total != null ? Number(y.avg_meet_total).toFixed(1) : '—' }}</td>
            <td class="mono cyan strong">{{ y.best_meet_total != null ? Number(y.best_meet_total).toFixed(1) : '—' }}</td>
            <td class="mono">{{ y.wins }}</td>
            <td class="mono">{{ y.podiums }}</td>
            <td class="mono" :class="yoyDeltaClass(i)">
              {{ yoyDeltaText(i) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.yoy-up   { color: #10b981; font-weight: 700; }
.yoy-down { color: #ef4444; font-weight: 700; }

/* Phone (≤600px): 7 columns won't fit at 360px even after the
   shared cell-padding shrink, so we allow horizontal scroll
   inside the card instead of truncating the year list. */
.pb-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
@media (max-width: 600px) {
  .pb-scroll .pb-table { min-width: 480px; }
}
</style>
