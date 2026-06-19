<script setup>
// Left meet/event rail (P5): situational awareness + navigation, not
// action. Renders events as ordered StageRows; selecting one focuses
// the center. No fetch, no readiness recomputation.
import StageRow from '@/components/control/StageRow.vue'

defineProps({
  events: { type: Array, default: () => [] },
  selectedId: { type: [String, Number], default: '' },
  loading: { type: Boolean, default: false },
})
defineEmits(['select'])
</script>

<template>
  <nav class="stage-rail" aria-label="Meet stages">
    <div v-if="loading" class="stage-rail-loading" aria-hidden="true">
      <div v-for="i in 4" :key="i" class="stage-row-skeleton"></div>
    </div>
    <ul v-else-if="events.length" class="stage-rail-list" role="listbox" aria-label="Events">
      <StageRow
        v-for="ev in events"
        :key="ev.id"
        :event="ev"
        :selected="String(ev.id) === String(selectedId)"
        @select="$emit('select', ev.id)"
      />
    </ul>
    <p v-else class="stage-rail-empty">No events.</p>
  </nav>
</template>

<style scoped>
.stage-rail {
  border-inline-end: 1px solid var(--border);
  background: var(--surface);
  overflow-y: auto;
  padding-block: 0.5rem;
}
.stage-rail-list { list-style: none; margin: 0; padding: 0; }
.stage-rail-empty,
.stage-rail-loading { padding: 1rem 0.85rem; }
.stage-row-skeleton {
  height: 38px; margin: 0.25rem 0.5rem; border-radius: var(--radius-sm);
  background: var(--bg-3); opacity: 0.55;
}
</style>
