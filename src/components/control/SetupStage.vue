<script setup>
// SetupStage (P7) — the pre-meet readiness for an Upcoming event: what's
// blocking go-live, read from the server's canonical readiness
// (/api/events/:id/readiness -> lib/workflow.js buildReadinessFromRow,
// the same source the dashboard workflow_actions use). Read-only here;
// the workflow-step actions (check-in / randomise / sign-off / start,
// reusing the P2-migrated modals) land in the next slice.
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({ event: { type: Object, required: true } })
const auth = useAuthStore()

const readiness = ref(null)
const loading = ref(false)
const error = ref('')

async function load() {
  if (!props.event?.id) return
  loading.value = true
  error.value = ''
  try {
    readiness.value = await auth.apiFetch(`/api/events/${props.event.id}/readiness`)
  } catch (err) {
    error.value = err?.message || 'Failed to load readiness'
    readiness.value = null
  } finally {
    loading.value = false
  }
}

watch(() => props.event?.id, load, { immediate: true })
defineExpose({ reload: load })
</script>

<template>
  <div class="setup-stage">
    <p v-if="loading" class="setup-msg">Loading readiness…</p>
    <p v-else-if="error" class="setup-msg setup-error">{{ error }}</p>
    <template v-else-if="readiness">
      <div class="setup-head">
        <span class="setup-status" :class="readiness.ready ? 'is-ready' : 'is-blocked'">
          {{ readiness.ready
              ? 'Ready to go live'
              : `${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? '' : 's'}` }}
        </span>
        <span v-if="readiness.next_action" class="setup-next">Next: {{ readiness.next_action.label }}</span>
      </div>
      <ul class="setup-checklist" aria-label="Pre-meet readiness">
        <li v-for="s in readiness.steps" :key="s.key" class="setup-step" :class="{ done: s.done }">
          <span class="setup-step-mark" aria-hidden="true">{{ s.done ? '✓' : '○' }}</span>
          <span class="setup-step-label">{{ s.label }}</span>
          <span v-if="!s.done && s.hint" class="setup-step-hint">{{ s.hint }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.setup-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
.setup-status {
  font-family: var(--font-display); font-size: 11px; font-weight: 800; letter-spacing: 0.12em;
  padding: 0.2rem 0.6rem; border-radius: 999px;
}
.setup-status.is-ready { color: var(--green); background: rgba(16, 185, 129, 0.12); }
.setup-status.is-blocked { color: var(--amber); background: rgba(245, 158, 11, 0.12); }
.setup-next { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.setup-checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.setup-step {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.6rem 0.85rem; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-3); color: var(--text-2); font-family: var(--font-mono); font-size: 13px;
}
.setup-step.done { color: var(--text-3); border-color: rgba(16, 185, 129, 0.3); }
.setup-step-mark { font-size: 14px; }
.setup-step.done .setup-step-mark { color: var(--green); }
.setup-step-label { flex: 1; }
.setup-step-hint { font-size: 11px; color: var(--text-3); }
.setup-msg { padding: 2rem; text-align: center; color: var(--text-3); font-family: var(--font-mono); }
.setup-error { color: var(--red); }
</style>
