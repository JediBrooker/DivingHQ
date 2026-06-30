<script setup>
// Federation editor for per-role official/coach accreditation fees. One
// FeeEditor (flat mode) per role, backed by /api/orgs/:orgId/official-fee
// ?role_type=… . The role rides extraPayload so the PUT lands on the right
// official_accreditation fee_definition. Accreditation is a flat per-role
// price (not member-tiered), so FeeEditor runs in flat mode.
import { ref, computed } from 'vue'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const props = defineProps({ orgId: { type: String, required: true } })

const ROLES = [
  { key: 'judge', label: 'Judge' },
  { key: 'referee', label: 'Referee' },
  { key: 'coach', label: 'Coach' },
  { key: 'meet_manager', label: 'Meet manager' },
]
const active = ref('judge')
const activeLabel = computed(() => ROLES.find(r => r.key === active.value)?.label || '')
const loadUrl = computed(() => `/api/orgs/${props.orgId}/official-fee?role_type=${active.value}`)
const saveUrl = computed(() => `/api/orgs/${props.orgId}/official-fee`)
</script>

<template>
  <div class="official-fees">
    <p class="hint">
      Charge officials and coaches an annual accreditation fee per role. Each
      person pays from their Accreditation page; set one flat price per role.
    </p>
    <div class="role-tabs" role="tablist">
      <button
        v-for="r in ROLES"
        :key="r.key"
        type="button"
        role="tab"
        :aria-selected="active === r.key"
        :class="['role-tab', { active: active === r.key }]"
        @click="active = r.key"
      >{{ r.label }}</button>
    </div>
    <FeeEditor
      :key="active"
      flat
      :title="`${activeLabel} accreditation`"
      :load-url="loadUrl"
      :save-url="saveUrl"
      :extra-payload="{ role_type: active }"
    />
  </div>
</template>

<style scoped>
.official-fees { display: flex; flex-direction: column; gap: .75rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.role-tabs { display: flex; flex-wrap: wrap; gap: .4rem; }
.role-tab {
  padding: .35rem .7rem; border: 1px solid var(--border, #ddd); border-radius: .5rem;
  background: transparent; color: var(--fg-2, #555); cursor: pointer; font-size: .85rem;
}
.role-tab.active { background: var(--accent, #3b6); color: #fff; border-color: var(--accent, #3b6); }
</style>
