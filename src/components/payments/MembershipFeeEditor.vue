<script setup>
// Admin editor for tiered athlete-membership fees. Renders one FeeEditor
// at a time for the selected tier — Standard (no tier) plus junior/senior/
// masters — each backed by /api/orgs/:orgId/membership-fee?tier=… . The
// FeeEditor's extraPayload carries the tier so the PUT lands on the right
// per-tier fee_definition (Migration 067 keys uniqueness on tier).
import { ref, computed } from 'vue'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const props = defineProps({ orgId: { type: String, required: true } })

const TIERS = [
  { key: 'standard', label: 'Standard (all ages)' },
  { key: 'junior', label: 'Junior' },
  { key: 'senior', label: 'Senior' },
  { key: 'masters', label: 'Masters' },
]
const active = ref('standard')
const activeLabel = computed(() => TIERS.find(t => t.key === active.value)?.label || '')
// 'standard' = the single, ageless membership (tier NULL on the server).
function param(key) { return key === 'standard' ? '' : key }
function tierValue(key) { return key === 'standard' ? null : key }
const baseUrl = computed(() => `/api/orgs/${props.orgId}/membership-fee?tier=${param(active.value)}`)
</script>

<template>
  <div class="membership-tiers">
    <p class="hint">
      Set one Standard price, or different prices per age tier. Athletes are shown
      the tier that applies to them.
    </p>
    <div class="tier-tabs" role="tablist">
      <button
        v-for="tr in TIERS"
        :key="tr.key"
        type="button"
        role="tab"
        :aria-selected="active === tr.key"
        :class="['tier-tab', { active: active === tr.key }]"
        @click="active = tr.key"
      >{{ tr.label }}</button>
    </div>
    <FeeEditor
      :key="active"
      :title="`Membership — ${activeLabel}`"
      :show-membership-period="true"
      :load-url="baseUrl"
      :save-url="baseUrl"
      :extra-payload="{ tier: tierValue(active) }"
    />
  </div>
</template>

<style scoped>
.membership-tiers { display: flex; flex-direction: column; gap: .75rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.tier-tabs { display: flex; flex-wrap: wrap; gap: .4rem; }
.tier-tab {
  padding: .35rem .7rem; border: 1px solid var(--border, #ddd); border-radius: .5rem;
  background: transparent; color: var(--fg-2, #555); cursor: pointer; font-size: .85rem;
}
.tier-tab.active { background: var(--accent, #3b6); color: #fff; border-color: var(--accent, #3b6); }
</style>
