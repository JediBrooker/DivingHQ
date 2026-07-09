<script setup>
// Admin editor for a meet's registration fee, optionally priced per
// discipline. Mirrors MembershipFeeEditor's tabs. Backed by
// /api/meets/:id/fees(/config); the FeeEditor's extraPayload carries the
// discipline so each tab saves its own per-discipline fee_definition.
import { ref, computed } from 'vue'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const props = defineProps({ meetId: { type: String, required: true } })

const DISCIPLINES = [
  { key: 'all', label: 'All entries' },
  { key: '1m', label: '1m springboard' },
  { key: '3m', label: '3m springboard' },
  { key: 'platform', label: 'Platform' },
  { key: 'synchro_3m', label: 'Synchro 3m' },
  { key: 'synchro_platform', label: 'Synchro platform' },
]
const active = ref('all')
const activeLabel = computed(() => DISCIPLINES.find(d => d.key === active.value)?.label || '')
// 'all' = one fee for any entry (discipline NULL on the server).
function param(key) { return key === 'all' ? '' : key }
function disciplineValue(key) { return key === 'all' ? null : key }
const loadUrl = computed(() => `/api/meets/${props.meetId}/fees/config?discipline=${param(active.value)}`)
const saveUrl = computed(() => `/api/meets/${props.meetId}/fees`)
</script>

<template>
  <div class="meet-fees">
    <p class="hint">
      Charge a fee to register for this meet — one price for all entries, or
      different prices per discipline. Athletes see the price that applies to them.
    </p>
    <div class="disc-tabs" role="tablist">
      <button
        v-for="d in DISCIPLINES"
        :key="d.key"
        type="button"
        role="tab"
        :aria-selected="active === d.key"
        :class="['disc-tab', { active: active === d.key }]"
        @click="active = d.key"
      >{{ d.label }}</button>
    </div>
    <FeeEditor
      :key="active"
      :title="`Meet registration — ${activeLabel}`"
      :load-url="loadUrl"
      :save-url="saveUrl"
      :extra-payload="{ discipline: disciplineValue(active) }"
    />
  </div>
</template>

<style scoped>
.meet-fees { display: flex; flex-direction: column; gap: .75rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.disc-tabs { display: flex; flex-wrap: wrap; gap: .4rem; }
.disc-tab {
  padding: .35rem .7rem; border: 1px solid var(--border, #ddd); border-radius: .5rem;
  background: transparent; color: var(--fg-2, #555); cursor: pointer; font-size: .85rem;
}
.disc-tab.active { background: var(--accent, #3b6); color: #fff; border-color: var(--accent, #3b6); }
</style>
