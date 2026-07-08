<script setup>
// Admin editor for tiered athlete-membership fees. Renders one FeeEditor
// at a time for the selected tier — Standard (no tier) plus junior/senior/
// masters — each backed by /api/orgs/:orgId/membership-fee?tier=… . The
// FeeEditor's extraPayload carries the tier so the PUT lands on the right
// per-tier fee_definition (Migration 067 keys uniqueness on tier).
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const { t } = useI18n()
const props = defineProps({ orgId: { type: String, required: true } })

const TIERS = [
  { key: 'standard', labelKey: 'payments.membership_editor.tier_standard' },
  { key: 'junior', labelKey: 'payments.membership_editor.tier_junior' },
  { key: 'senior', labelKey: 'payments.membership_editor.tier_senior' },
  { key: 'masters', labelKey: 'payments.membership_editor.tier_masters' },
]
const active = ref('standard')
const activeLabel = computed(() => {
  const tier = TIERS.find(tr => tr.key === active.value)
  return tier ? t(tier.labelKey) : ''
})
// 'standard' = the single, ageless membership (tier NULL on the server).
function param(key) { return key === 'standard' ? '' : key }
function tierValue(key) { return key === 'standard' ? null : key }
const baseUrl = computed(() => `/api/orgs/${props.orgId}/membership-fee?tier=${param(active.value)}`)
</script>

<template>
  <div class="membership-tiers">
    <p class="hint">{{ t('payments.membership_editor.hint') }}</p>
    <div class="tier-tabs" role="tablist">
      <button
        v-for="tr in TIERS"
        :key="tr.key"
        type="button"
        role="tab"
        :aria-selected="active === tr.key"
        :class="['tier-tab', { active: active === tr.key }]"
        @click="active = tr.key"
      >{{ t(tr.labelKey) }}</button>
    </div>
    <FeeEditor
      :key="active"
      :title="t('payments.membership_editor.title', { label: activeLabel })"
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
