<script setup>
// SetupStage (P7) — the pre-meet stage for an Upcoming event: the
// readiness checklist (what's blocking go-live, from /api/events/:id/
// readiness) PLUS the one workflow-step action that drives the meet to
// live (check-in -> randomise -> sign-off -> start), reusing the
// P2-migrated modals. Mutates the shared event object's workflow stamps
// so the V2 stage derivation (orderWorkflowState) advances in place.
import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { orderWorkflowStateFor } from '@/composables/useControlStage'
import CheckInModal from '@/components/control/CheckInModal.vue'
import RandomiseDrawModal from '@/components/control/RandomiseDrawModal.vue'
import SignoffModal from '@/components/control/SignoffModal.vue'

const props = defineProps({ event: { type: Object, required: true } })
const auth = useAuthStore()

const readiness = ref(null)
const loading = ref(false)
const error = ref('')
const busy = ref(false)
const roster = ref([])

const checkInOpen = ref(false)
const randomiseOpen = ref(false)
const signoffOpen = ref(false)

const stage = computed(() => orderWorkflowStateFor(props.event))
const stepLabel = computed(
  () =>
    ({
      'check-in': '✓ Check In Divers',
      random: '🎲 Randomise Dive Order',
      'sign-off': '📋 Referee Sign Off',
      start: '▶ Start Event',
    })[stage.value] || '',
)

async function loadReadiness() {
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

async function loadRoster() {
  try {
    const r = await auth.apiFetch(`/api/events/${props.event.id}/roster`)
    roster.value = Array.isArray(r) ? r : []
  } catch {
    roster.value = []
  }
}

async function startEvent() {
  busy.value = true
  try {
    await auth.apiFetch(`/api/events/${props.event.id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Live' }),
    })
    props.event.status = 'Live' // -> workflowMode flips to meet (Live)
  } catch (err) {
    error.value = err?.message || 'Failed to start event'
  } finally {
    busy.value = false
  }
}

async function runStep() {
  const s = stage.value
  if (s === 'check-in') checkInOpen.value = true
  else if (s === 'random') {
    await loadRoster()
    randomiseOpen.value = true
  } else if (s === 'sign-off') signoffOpen.value = true
  else if (s === 'start') await startEvent()
}

function onCheckInConfirmed(patch) {
  if (patch) Object.assign(props.event, patch)
  checkInOpen.value = false
  loadReadiness()
}
function onRandomised() {
  props.event.dive_order_randomised_at = new Date().toISOString()
  props.event.dive_order_signed_off_at = null
  randomiseOpen.value = false
  loadReadiness()
}
function onSignedOff(patch) {
  if (patch && typeof patch === 'object') Object.assign(props.event, patch)
  else props.event.dive_order_signed_off_at = new Date().toISOString()
  signoffOpen.value = false
  loadReadiness()
}

watch(() => props.event?.id, loadReadiness, { immediate: true })
defineExpose({ reload: loadReadiness })
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

    <div v-if="stepLabel" class="setup-primary-slot">
      <button type="button" class="setup-primary" :disabled="busy" @click="runStep">{{ stepLabel }}</button>
    </div>

    <CheckInModal
      v-if="checkInOpen"
      :event="event"
      :workflow-state="stage"
      @close="checkInOpen = false"
      @confirmed="onCheckInConfirmed"
    />
    <RandomiseDrawModal
      v-if="randomiseOpen"
      :event="event"
      :roster="roster"
      @close="randomiseOpen = false"
      @randomised="onRandomised"
    />
    <SignoffModal
      v-if="signoffOpen"
      :event="event"
      @close="signoffOpen = false"
      @signed-off="onSignedOff"
    />
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
.setup-primary-slot { position: sticky; bottom: 0; margin-top: 1.5rem; padding-top: 1rem; background: linear-gradient(to top, var(--bg) 72%, transparent); }
.setup-primary {
  width: 100%; padding: 0.85rem 1.5rem;
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  border-radius: var(--radius); border: 1px solid var(--cyan); background: var(--cyan); color: var(--bg);
  cursor: pointer; transition: filter 0.12s;
}
.setup-primary:hover:not(:disabled) { filter: brightness(1.08); }
.setup-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
