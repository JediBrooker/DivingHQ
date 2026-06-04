<script setup>
// One compact event row — name + status badge + meta + arrow,
// shared by the Meet Manager and Judge panels (and Referee, which
// overrides the badge label). Global styling: .event-row,
// .event-row-<status>, .evrs-<status>, .event-row-* in
// src/styles/app.css.
//
// The default status badge mirrors the long-standing markup:
// 🔴 LIVE / 📅 / ✓. Pass `statusLabel` to override the text
// (Referee shows a bare "LIVE").
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({
  to:          { type: [String, Object], required: true },
  status:      { type: String, required: true }, // Live | Upcoming | Completed
  name:        { type: String, required: true },
  meta:        { type: String, default: '' },
  statusLabel: { type: String, default: '' },
})

const slug = computed(() => props.status.toLowerCase())
const badge = computed(() => {
  if (props.statusLabel) return props.statusLabel
  if (props.status === 'Live') return '🔴 LIVE'
  if (props.status === 'Upcoming') return '📅'
  return '✓'
})
</script>

<template>
  <RouterLink :to="to" :class="['event-row', `event-row-${slug}`]">
    <span :class="['event-row-status', `evrs-${slug}`]">{{ badge }}</span>
    <span class="event-row-name">{{ name }}</span>
    <span v-if="meta" class="event-row-meta">{{ meta }}</span>
    <span class="event-row-arrow" aria-hidden="true">→</span>
  </RouterLink>
</template>
