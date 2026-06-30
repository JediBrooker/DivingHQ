<script setup>
// Manager editor for an event's scratch / no-show penalty fees. One flat
// FeeEditor per kind, backed by /api/events/:id/penalty-fee?kind=… . The
// kind rides extraPayload so the PUT lands on the right penalty
// fee_definition. Admins issue these against entrants in the Penalties
// panel; this just sets the price.
import { ref, computed } from 'vue'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const props = defineProps({ eventId: { type: String, required: true } })

const KINDS = [
  { key: 'scratch', label: 'Scratch (withdrawal)' },
  { key: 'no_show', label: 'No-show (DNS)' },
]
const active = ref('scratch')
const activeLabel = computed(() => KINDS.find(k => k.key === active.value)?.label || '')
const loadUrl = computed(() => `/api/events/${props.eventId}/penalty-fee?kind=${active.value}`)
const saveUrl = computed(() => `/api/events/${props.eventId}/penalty-fee`)
</script>

<template>
  <section class="penalty-fees">
    <h3>Scratch / no-show penalties</h3>
    <p class="hint">
      A flat penalty you can issue against an entrant who withdraws (scratch) or
      doesn't show (no-show). Set the price here; issue charges below.
    </p>
    <div class="kind-tabs" role="tablist">
      <button
        v-for="k in KINDS"
        :key="k.key"
        type="button"
        role="tab"
        :aria-selected="active === k.key"
        :class="['kind-tab', { active: active === k.key }]"
        @click="active = k.key"
      >{{ k.label }}</button>
    </div>
    <FeeEditor
      :key="active"
      flat
      :title="`${activeLabel} penalty`"
      :load-url="loadUrl"
      :save-url="saveUrl"
      :extra-payload="{ kind: active }"
    />
  </section>
</template>

<style scoped>
.penalty-fees { display: flex; flex-direction: column; gap: .5rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.kind-tabs { display: flex; flex-wrap: wrap; gap: .4rem; }
.kind-tab {
  padding: .35rem .7rem; border: 1px solid var(--border, #ddd); border-radius: .5rem;
  background: transparent; color: var(--fg-2, #555); cursor: pointer; font-size: .85rem;
}
.kind-tab.active { background: var(--accent, #3b6); color: #fff; border-color: var(--accent, #3b6); }
</style>
