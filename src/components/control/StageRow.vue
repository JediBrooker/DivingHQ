<script setup>
// One meet/event rail row (P5): a StatusPill token + the event name +
// AT MOST ONE attention marker from the shared useAttention selector.
// A real <button> in a listbox option so keyboard + AT work. The rail
// is awareness + navigation -- never action.
import { computed } from 'vue'
import StatusPill from '@/components/StatusPill.vue'
import { attentionMarker } from '@/composables/useAttention'
import { orderWorkflowStateFor } from '@/composables/useControlStage'

const props = defineProps({
  event: { type: Object, required: true },
  selected: { type: Boolean, default: false },
})
defineEmits(['select'])

// At-most-one marker from the shared selector. The rail has no per-event
// readiness fetch, so the marker is stage-derived: a Live event shows
// 'live'; an Upcoming event with a pending pre-meet step shows
// 'next-action'. Per-event blocker counts arrive when P6/P7 wire the
// focused event's readinessItems through the same selector.
const marker = computed(() => {
  const ev = props.event
  const stage = orderWorkflowStateFor(ev)
  return attentionMarker([], [], {
    live: ev.status === 'Live',
    nextAction: ev.status === 'Upcoming' && !!stage && stage !== 'live',
  })
})
</script>

<template>
  <li role="option" :aria-selected="selected">
    <button type="button" class="stage-row" :class="{ 'is-selected': selected }" @click="$emit('select')">
      <StatusPill :status="event.status" size="sm" iconless />
      <span class="stage-row-name">{{ event.name }}</span>
      <span
        v-if="marker"
        class="stage-row-marker"
        :class="`marker-${marker.kind}`"
        :aria-label="marker.kind === 'live' ? 'Live' : 'Needs action'"
      >{{ marker.kind === 'live' ? '🔴' : '→' }}</span>
    </button>
  </li>
</template>

<style scoped>
.stage-row {
  display: flex; align-items: center; gap: 0.6rem; width: 100%;
  padding: 0.6rem 0.85rem;
  background: transparent; border: none; border-inline-start: 3px solid transparent;
  cursor: pointer; text-align: start; color: var(--text-2);
  font: inherit; transition: background 0.12s, border-color 0.12s;
}
.stage-row:hover { background: var(--bg-3); color: var(--text); }
.stage-row.is-selected {
  background: var(--bg-3); color: var(--fg);
  border-inline-start-color: var(--accent, var(--cyan));
}
.stage-row-name {
  flex: 1 1 auto; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: var(--font-display); font-weight: 600; font-size: 13px;
}
.stage-row-marker { flex-shrink: 0; font-size: 12px; }
.marker-next-action { color: var(--cyan); }
</style>
