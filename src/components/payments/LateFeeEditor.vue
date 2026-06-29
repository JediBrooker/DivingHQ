<script setup>
// Manager editor for an event's LATE-ENTRY surcharge — a flat fee added to
// the entry fee once a chosen deadline passes. A trigger dropdown picks the
// moment (entries close / dive list locks); the wrapped FeeEditor handles
// the amount + windows and carries the trigger through extraPayload so the
// PUT lands on the late_entry fee_definition. Backed by
// /api/events/:id/late-fee(/config).
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const props = defineProps({ eventId: { type: String, required: true } })
const auth = useAuthStore()

const TRIGGERS = [
  { key: 'entries_close_at', label: 'Once entries close' },
  { key: 'dive_list_locks_at', label: 'Once the dive list locks' },
]
const trigger = ref('entries_close_at')
const ready = ref(false)

onMounted(async () => {
  // Seed the dropdown from any saved late fee so the manager sees the
  // current trigger; FeeEditor loads the amount/variants itself.
  try {
    const r = await auth.apiFetch(`/api/events/${props.eventId}/late-fee/config`)
    if (r.fee?.late_fee_trigger) trigger.value = r.fee.late_fee_trigger
  } catch { /* keep the default trigger */ }
  finally { ready.value = true }
})
</script>

<template>
  <section class="late-fee">
    <h3>Late entry fee</h3>
    <p class="hint">A surcharge added to the entry fee once the deadline below has passed. Divers are shown it up front so they can pay early to avoid it.</p>
    <div class="trigger-row">
      <label class="trigger-label" for="late-trigger">Charge it:</label>
      <select id="late-trigger" class="trigger-select" v-model="trigger">
        <option v-for="t in TRIGGERS" :key="t.key" :value="t.key">{{ t.label }}</option>
      </select>
    </div>
    <FeeEditor
      v-if="ready"
      title="Late entry fee"
      :load-url="`/api/events/${eventId}/late-fee/config`"
      :save-url="`/api/events/${eventId}/late-fee`"
      :extra-payload="{ late_fee_trigger: trigger }"
    />
  </section>
</template>

<style scoped>
.late-fee { display: flex; flex-direction: column; gap: .5rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.trigger-row { display: flex; align-items: center; gap: .5rem; }
.trigger-label { font-size: .85rem; color: var(--fg-2, #555); }
.trigger-select {
  padding: .35rem .6rem; border: 1px solid var(--border, #ddd); border-radius: .5rem;
  background: transparent; color: var(--fg, #222); font-size: .85rem;
}
</style>
