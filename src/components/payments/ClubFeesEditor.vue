<script setup>
// Federation editor for the fees it charges its CLUBS — annual
// affiliation and accreditation. One FeeEditor at a time per kind, backed
// by /api/orgs/:orgId/club-fee?kind=… . The FeeEditor's extraPayload
// carries the kind so the PUT lands on the right fee_definition scope
// (club_affiliation / club_accreditation). Clubs pay these via the club
// admin; until payments go live the editor shows the coming-soon notice
// FeeEditor already renders.
import { ref, computed } from 'vue'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const props = defineProps({ orgId: { type: String, required: true } })

const KINDS = [
  { key: 'affiliation', label: 'Annual affiliation' },
  { key: 'accreditation', label: 'Accreditation' },
]
const active = ref('affiliation')
const activeLabel = computed(() => KINDS.find(k => k.key === active.value)?.label || '')
const loadUrl = computed(() => `/api/orgs/${props.orgId}/club-fee?kind=${active.value}`)
const saveUrl = computed(() => `/api/orgs/${props.orgId}/club-fee`)
</script>

<template>
  <div class="club-fees">
    <p class="hint">
      Charge your clubs an annual affiliation fee and/or an accreditation fee.
      Each club's admin pays from the club's page; you can see who's paid in the
      Clubs list.
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
      :title="`Club ${activeLabel}`"
      :load-url="loadUrl"
      :save-url="saveUrl"
      :extra-payload="{ kind: active }"
    />
  </div>
</template>

<style scoped>
.club-fees { display: flex; flex-direction: column; gap: .75rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.kind-tabs { display: flex; flex-wrap: wrap; gap: .4rem; }
.kind-tab {
  padding: .35rem .7rem; border: 1px solid var(--border, #ddd); border-radius: .5rem;
  background: transparent; color: var(--fg-2, #555); cursor: pointer; font-size: .85rem;
}
.kind-tab.active { background: var(--accent, #3b6); color: #fff; border-color: var(--accent, #3b6); }
</style>
