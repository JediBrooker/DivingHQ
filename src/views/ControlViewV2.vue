<script setup>
// ControlViewV2 — the flag-gated Stage-Rail Control Room shell (P5).
//
// Parallel to the UNTOUCHED ControlView.vue (the instant rollback). This
// phase stands up the FRAME only: a meet/event RAIL + a CENTER
// mode-switch (Setup / Live / Review, plus a Recovery cross-cut) + a
// drawer stub. Exactly one mode renders per stage, chosen by the shared
// useControlStage derivation. The mode bodies are placeholders here;
// P6 (Live) / P7 (Setup + Recovery) / P8 (Review + drawer) rebuild the
// real panels into them. Live score handling + the concurrent-pool
// per-event live-state map is the next P5 slice.
//
// Resolved only when VITE_CONTROL_V2_ENABLED === '1' (router resolver);
// same /control URL, same ?event= deep-link, same role gate + AppShell.
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useControlStage } from '@/composables/useControlStage'
import StageRail from '@/components/control/StageRail.vue'
import StatusPill from '@/components/StatusPill.vue'

const route = useRoute()
const auth = useAuthStore()

const events = ref([])
const selectedEventId = ref('')
const loading = ref(true)
const loadError = ref('')
const stageTitleEl = ref(null)

const currentEvent = computed(
  () => events.value.find((e) => String(e.id) === String(selectedEventId.value)) || null,
)
const { workflowMode, orderWorkflowState } = useControlStage(currentEvent)

// Recovery is the one explicit cross-cutting mode (offer-not-seize);
// P7 fills it. Off by default so the center always shows the stage mode.
const recoveryOpen = ref(false)
const centerMode = computed(() => (recoveryOpen.value ? 'recovery' : workflowMode.value))

async function selectEvent(id) {
  selectedEventId.value = String(id)
  // Roving focus rail -> center heading (a11y: the selection moves focus
  // into the focused stage, not back to the top of the rail).
  await nextTick()
  stageTitleEl.value?.focus()
}

onMounted(async () => {
  try {
    events.value = await auth.apiFetch('/api/events')
  } catch (err) {
    loadError.value = err?.message || 'Failed to load events'
  } finally {
    loading.value = false
  }
  // Honour /control?event=<id> (same deep-link contract as V1).
  const q = route.query.event
  if (q != null && events.value.some((e) => String(e.id) === String(q))) {
    selectedEventId.value = String(q)
  }
})
</script>

<template>
  <div class="cv2">
    <StageRail
      :events="events"
      :selected-id="selectedEventId"
      :loading="loading"
      @select="selectEvent"
    />

    <section class="cv2-center" aria-label="Current stage">
      <p v-if="loadError" class="cv2-msg cv2-error">{{ loadError }}</p>
      <p v-else-if="loading" class="cv2-msg">Loading…</p>
      <p v-else-if="!currentEvent" class="cv2-msg">Pick a stage from the rail to begin.</p>

      <div v-else class="cv2-stage" :data-mode="centerMode">
        <header class="cv2-stage-head">
          <StatusPill :status="currentEvent.status" size="md" />
          <h1 ref="stageTitleEl" tabindex="-1" class="cv2-stage-title">{{ currentEvent.name }}</h1>
        </header>

        <!-- Center mode-switch: EXACTLY ONE mode per stage. The bodies
             are placeholders; P6-P8 rebuild the real panels here. -->
        <section v-if="centerMode === 'setup'" class="cv2-mode" aria-label="Setup">
          <p class="cv2-mode-note">Setup — pre-meet workflow. (Built in P7.)</p>
          <p class="cv2-mode-state">Next step: {{ orderWorkflowState || '—' }}</p>
        </section>
        <section v-else-if="centerMode === 'meet'" class="cv2-mode" aria-label="Live">
          <p class="cv2-mode-note">Live — active diver, scores, queue. (Built in P6.)</p>
        </section>
        <section v-else-if="centerMode === 'review'" class="cv2-mode" aria-label="Review">
          <p class="cv2-mode-note">Review — standings, judge ranking, recap. (Built in P8.)</p>
        </section>
        <section v-else class="cv2-mode" aria-label="Recovery">
          <p class="cv2-mode-note">Recovery — hold, correction, withdraw, offline/conflict. (Built in P7.)</p>
        </section>
      </div>
    </section>

    <!-- Drawer stub — broadcast handoff / reserves / audit / sponsor;
         lazy-mounted in P8. Closed by default. -->
    <aside class="cv2-drawer" aria-label="Secondary actions" hidden></aside>
  </div>
</template>

<style scoped>
.cv2 { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100%; }
.cv2-center { padding: 1.5rem 2rem; min-width: 0; }
.cv2-stage-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; }
.cv2-stage-title {
  margin: 0; font-family: var(--font-display); font-size: 24px; font-weight: 700;
  color: var(--fg); outline: none;
}
.cv2-mode {
  padding: 1.5rem; border: 1px dashed var(--border-2);
  border-radius: var(--radius-lg); color: var(--text-2);
}
.cv2-mode-note { margin: 0 0 0.4rem; font-family: var(--font-mono); font-size: 13px; }
.cv2-mode-state { margin: 0; font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.cv2-msg { padding: 3rem; text-align: center; color: var(--text-3); font-family: var(--font-mono); }
.cv2-error { color: var(--red); }
@media (max-width: 860px) {
  .cv2 { grid-template-columns: 1fr; }
}
</style>
