<script setup>
// Manager editor for a meet's public access purchases — spectator ticket,
// livestream access, and programme. One flat FeeEditor per kind, backed by
// /api/meets/:id/access-fee?kind=… ; the kind rides extraPayload so the PUT
// lands on the right fee_definition. Buyers purchase these from the public
// meet page.
import { ref, computed } from 'vue'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const props = defineProps({ meetId: { type: String, required: true } })

const KINDS = [
  { key: 'spectator_ticket', label: 'Spectator ticket' },
  { key: 'livestream', label: 'Livestream access' },
  { key: 'programme', label: 'Programme' },
]
const active = ref('spectator_ticket')
const activeLabel = computed(() => KINDS.find(k => k.key === active.value)?.label || '')
const loadUrl = computed(() => `/api/meets/${props.meetId}/access-fee?kind=${active.value}`)
const saveUrl = computed(() => `/api/meets/${props.meetId}/access-fee`)
</script>

<template>
  <div class="meet-access">
    <p class="hint">
      Sell spectator tickets, livestream access, and the programme for this meet.
      Set one flat price per item; spectators buy them from the meet's public page.
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
      :title="activeLabel"
      :load-url="loadUrl"
      :save-url="saveUrl"
      :extra-payload="{ kind: active }"
    />
  </div>
</template>

<style scoped>
.meet-access { display: flex; flex-direction: column; gap: .75rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.kind-tabs { display: flex; flex-wrap: wrap; gap: .4rem; }
.kind-tab {
  padding: .35rem .7rem; border: 1px solid var(--border, #ddd); border-radius: .5rem;
  background: transparent; color: var(--fg-2, #555); cursor: pointer; font-size: .85rem;
}
.kind-tab.active { background: var(--accent, #3b6); color: #fff; border-color: var(--accent, #3b6); }
</style>
