<script setup>
// Manager editor for an event's scratch / no-show penalty fees. One flat
// FeeEditor per kind, backed by /api/events/:id/penalty-fee?kind=… . The
// kind rides extraPayload so the PUT lands on the right penalty
// fee_definition. Admins issue these against entrants in the Penalties
// panel; this just sets the price.
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const { t } = useI18n()
const props = defineProps({ eventId: { type: String, required: true } })

const KINDS = [
  { key: 'scratch', labelKey: 'payments.penalty_editor.kind_scratch' },
  { key: 'no_show', labelKey: 'payments.penalty_editor.kind_no_show' },
]
const active = ref('scratch')
const activeLabel = computed(() => {
  const kind = KINDS.find(k => k.key === active.value)
  return kind ? t(kind.labelKey) : ''
})
const loadUrl = computed(() => `/api/events/${props.eventId}/penalty-fee?kind=${active.value}`)
const saveUrl = computed(() => `/api/events/${props.eventId}/penalty-fee`)
</script>

<template>
  <section class="penalty-fees">
    <h3>{{ t('payments.penalty_editor.title') }}</h3>
    <p class="hint">{{ t('payments.penalty_editor.hint') }}</p>
    <div class="kind-tabs" role="tablist">
      <button
        v-for="k in KINDS"
        :key="k.key"
        type="button"
        role="tab"
        :aria-selected="active === k.key"
        :class="['kind-tab', { active: active === k.key }]"
        @click="active = k.key"
      >{{ t(k.labelKey) }}</button>
    </div>
    <FeeEditor
      :key="active"
      flat
      :title="t('payments.penalty_editor.fee_title', { label: activeLabel })"
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
